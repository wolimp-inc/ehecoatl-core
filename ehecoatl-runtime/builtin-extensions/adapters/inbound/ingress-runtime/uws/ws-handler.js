'use strict';

const { randomUUID } = require(`node:crypto`);
const httpHandler = require(`./http-handler`);
const writeResponse = require(`./http-write-response`);
const { resolveRequestCorrelationId } = require(`@/utils/observability/request-correlation-id`);

module.exports.setup = function ({
  app,
  getClientIp,
  wsHubManager,
  createExecutionContext
}) {
  app.ws(`/*`, {
    compression: 0,
    idleTimeout: 120,
    maxBackpressure: 1024 * 1024,
    maxPayloadLength: 16 * 1024 * 1024,
    upgrade(res, req, context) {
      return module.exports.handleUpgrade({
        res,
        req,
        context,
        getClientIp,
        createExecutionContext
      });
    },
    open(ws) {
      const userData = resolveWsUserData(ws);
      if (!userData?.clientId || !userData?.channelId) return false;
      return wsHubManager?.openClient?.({
        channelId: userData.channelId,
        clientId: userData.clientId,
        ws,
        metadata: userData.metadata ?? userData
      }) ?? false;
    },
    message(ws, message, isBinary) {
      const userData = resolveWsUserData(ws);
      if (!userData?.clientId || !userData?.channelId) return false;
      return wsHubManager?.receiveMessage?.({
        channelId: userData.channelId,
        clientId: userData.clientId,
        message,
        isBinary,
        metadata: userData.metadata ?? userData
      }) ?? false;
    },
    close(ws, code, message) {
      const userData = resolveWsUserData(ws);
      if (!userData?.clientId || !userData?.channelId) return false;
      return wsHubManager?.closeClient?.({
        channelId: userData.channelId,
        clientId: userData.clientId,
        code,
        reason: message,
        metadata: userData.metadata ?? userData
      }) ?? false;
    }
  });
};

module.exports.handleUpgrade = async function ({
  res,
  req,
  context,
  getClientIp,
  createExecutionContext
}) {
  const ip = typeof getClientIp === `function` ? getClientIp(req, res) : null;
  const upgradeHeaders = captureUpgradeHeaders(req);
  const executionContext = createExecutionContext({ res, req, ip });

  res.onAborted(() => executionContext.abort());

  try {
    await setupUpgradeRequestData(executionContext);
    await executionContext.directorHelper.resolveRoute({ routeType: `ws-upgrade` });

    if (!executionContext.projectRoute || !executionContext.projectRoute.isWsUpgradeRoute()) {
      executionContext.responseData.status = 404;
      executionContext.responseData.body = `Not Found`;
      await writeResponse(executionContext);
      return false;
    }

    const routeValidationFailure = httpHandler._internal.validateRouteRequest(executionContext);
    if (routeValidationFailure) {
      executionContext.responseData.status = routeValidationFailure.status;
      executionContext.responseData.body = routeValidationFailure.body;
      executionContext.responseData.headers = {
        ...(executionContext.responseData.headers ?? {}),
        'Content-Type': `text/plain; charset=utf-8`,
        ...(routeValidationFailure.headers ?? {})
      };
      await writeResponse(executionContext);
      return false;
    }

    await executionContext.runWsUpgradeMiddlewareStack();
    if (executionContext.isAborted()) {
      return false;
    }

    if ((executionContext.responseData.status ?? 200) !== 200) {
      await writeResponse(executionContext);
      return false;
    }

    const clientId = randomUUID();
    const channelId = buildChannelId(executionContext.projectRoute, executionContext.requestData);
    if (!clientId || !channelId) {
      executionContext.responseData.status = 500;
      executionContext.responseData.body = `WebSocket route is missing runtime identity`;
      executionContext.responseData.headers = {
        ...(executionContext.responseData.headers ?? {}),
        'Content-Type': `text/plain; charset=utf-8`
      };
      await writeResponse(executionContext);
      return false;
    }

    res.upgrade(
      {
        clientId,
        channelId,
        metadata: Object.freeze({
          headers: executionContext.requestData?.headers ?? httpHandler._internal.extractHeaders(req),
          ip: executionContext.ip,
          context,
          tenantId: executionContext.projectRoute?.origin?.tenantId ?? null,
          appId: executionContext.projectRoute?.origin?.appId ?? null,
          appName: executionContext.projectRoute?.origin?.appName ?? null,
          hostname: executionContext.requestData?.hostname ?? null,
          path: executionContext.requestData?.path ?? null,
          url: executionContext.requestData?.url ?? null,
          sessionId: executionContext.requestData?.cookie?.session ?? null,
          sessionData: sanitizeJsonCompatible(executionContext.sessionData ?? {}),
          route: buildWsRouteSnapshot(executionContext.projectRoute)
        })
      },
      upgradeHeaders.key,
      upgradeHeaders.protocol,
      upgradeHeaders.extensions,
      context
    );
    return true;
  } catch (error) {
    console.error(`[uws-ws-handler] upgrade failed`, {
      url: executionContext.requestData?.url ?? null,
      host: executionContext.requestData?.headers?.host ?? null,
      error: error?.stack ?? error?.message ?? error
    });
    if (!executionContext.isAborted()) {
      executionContext.responseData.status = 500;
      executionContext.responseData.body = `Internal Server Error`;
      executionContext.responseData.headers = {
        ...(executionContext.responseData.headers ?? {}),
        'Content-Type': `text/plain; charset=utf-8`
      };
      await writeResponse(executionContext);
    }
    return false;
  } finally {
    await executionContext.end();
  }
};

function buildChannelId(projectRoute, requestData) {
  const appId = projectRoute?.origin?.appId ?? null;
  const path = typeof requestData?.path === `string` && requestData.path.trim()
    ? requestData.path.trim()
    : `/`;
  if (!appId || typeof appId !== `string`) return null;
  return `${appId}:${path.startsWith(`/`) ? path : `/${path}`}`;
}

function resolveWsUserData(ws) {
  if (!ws) return null;
  if (typeof ws.getUserData === `function`) {
    return ws.getUserData();
  }
  return ws.userData ?? ws._userData ?? null;
}

async function setupUpgradeRequestData(executionContext) {
  const headers = httpHandler._internal.extractHeaders(executionContext.req);
  const correlation = resolveRequestCorrelationId(headers);
  const proxiedRequest = httpHandler._internal.normalizeProxiedRequest(headers);

  executionContext.ip = proxiedRequest.ip;
  if (executionContext.meta) {
    executionContext.meta.forcedAppId = proxiedRequest.forcedAppId ?? null;
    executionContext.meta.requestId = correlation.requestId;
    executionContext.meta.correlationId = correlation.correlationId;
    executionContext.meta.requestKind = `ws-upgrade`;
  }

  await executionContext.setupRequestData({
    requestId: correlation.requestId,
    body: null,
    url: proxiedRequest.url,
    hostname: proxiedRequest.hostname,
    protocol: proxiedRequest.protocol,
    port: proxiedRequest.port,
    path: proxiedRequest.path,
    query: proxiedRequest.queryString,
    method: proxiedRequest.method,
    headers: proxiedRequest.headers,
    ip: proxiedRequest.ip
  });
}

function captureUpgradeHeaders(req) {
  return Object.freeze({
    key: req.getHeader(`sec-websocket-key`),
    protocol: req.getHeader(`sec-websocket-protocol`),
    extensions: req.getHeader(`sec-websocket-extensions`)
  });
}

function buildWsRouteSnapshot(projectRoute) {
  if (!projectRoute || typeof projectRoute !== `object`) return null;
  return Object.freeze({
    pointsTo: projectRoute.pointsTo ?? null,
    target: sanitizeJsonCompatible(projectRoute.target ?? null),
    params: sanitizeJsonCompatible(projectRoute.params ?? {}),
    view: sanitizeJsonCompatible(projectRoute.view ?? {}),
    middleware: Array.isArray(projectRoute.middleware) ? Object.freeze([...projectRoute.middleware]) : Object.freeze([]),
    authScope: sanitizeJsonCompatible(projectRoute.authScope ?? null),
    wsActionsAvailable: Array.isArray(projectRoute.wsActionsAvailable)
      ? Object.freeze([...projectRoute.wsActionsAvailable])
      : (projectRoute.wsActionsAvailable ?? null),
    cors: Array.isArray(projectRoute.cors) ? Object.freeze([...projectRoute.cors]) : (projectRoute.cors ?? null),
    origin: sanitizeJsonCompatible(projectRoute.origin ?? {}),
    folders: sanitizeJsonCompatible(projectRoute.folders ?? {}),
    upgrade: sanitizeJsonCompatible(projectRoute.upgrade ?? null)
  });
}

function sanitizeJsonCompatible(value) {
  if (value == null) return value ?? null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

Object.freeze(module.exports);
