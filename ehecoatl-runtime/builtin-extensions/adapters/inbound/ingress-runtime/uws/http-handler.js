// adapters/inbound/ingress-runtime/uws/uws-http-handler.js


'use strict';


const readBody = require(`./http-read-body`);
const writeResponse = require(`./http-write-response`);
const {
  corkIfAvailable,
  toStatusLine,
  writeUwsResponseHead
} = require(`@/utils/http/http-response-write`);
const {
  getOriginHeader,
  isCrossOriginRequest,
  isOriginAllowed,
  buildCorsHeaders,
  buildCorsBlockedResponse,
  resolveRequestedPreflightMethod
} = require(`@/utils/http/cors-policy`);
const {
  isMethodBlocked,
} = require(`@/utils/http/http-method-policy`);
const normalizeRoutePath = require(`@/utils/tenancy/normalize-route-path`);
const { createTenantFacingErrorResponse } = require(`@/utils/http/tenant-facing-error-response`);
const createRateLimiterHttp = require(`@/utils/limiter/request-limiter-http`);
const { resolveRequestCorrelationId } = require(`@/utils/observability/request-correlation-id`);
const dataMethods = [`POST`, `PATCH`, `PUT`, `DELETE`];
const STATUS_TEXT = Object.freeze({
  400: `Bad Request`,
  401: `Unauthorized`,
  403: `Forbidden`,
  405: `Method Not Allowed`,
  413: `Payload Too Large`,
  415: `Unsupported Media Type`,
  422: `Unprocessable Content`,
  500: `Internal Server Error`
});

module.exports.setup = function ({
  httpApp,
  getClientIp,
  createExecutionContext,
  ingressRuntimeConfig
}) {
  const ingressLimiter = ingressRuntimeConfig?.limiter ?? {};
  const httpLimiter = createRateLimiterHttp({
    capacity: ingressLimiter.capacity ?? 20,
    refillRateSeconds: ingressLimiter.time ?? 5
  });
  httpApp.any("/*", async (res, req) => {
    const ip = getClientIp(req, res);
    httpLimiter(ip, res, async () => {
      const executionContext = createExecutionContext({ res, req, ip });
      const { run, hooks } = executionContext;
      const { REQUEST } = hooks;
      await run(REQUEST.LIMITER.BEFORE);
      await run(REQUEST.LIMITER.AFTER);
      await this.handle(executionContext);
      await executionContext.end();
    });
  });
}


/** @param {import('@/_core/runtimes/ingress-runtime/execution/execution-context')} executionContext  */
module.exports.handle = async function (executionContext) {
  const { res, req, directorHelper } = executionContext;
  const { run, hooks } = executionContext;

  res.onAborted(() => executionContext.abort());

  await run(hooks.REQUEST.GET_COOKIE.BEFORE);
  try {
    const headers = extractHeaders(req);
    const correlation = resolveRequestCorrelationId(headers);
    const proxiedRequest = normalizeProxiedRequest(headers);
    executionContext.ip = proxiedRequest.ip;
    if (executionContext.meta) {
      executionContext.meta.forcedAppId = proxiedRequest.forcedAppId ?? null;
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
    if (executionContext.meta) {
      executionContext.meta.requestId = correlation.requestId;
      executionContext.meta.correlationId = correlation.correlationId;
      if (proxiedRequest.method === `HEAD`) {
        executionContext.meta.requestKind = `head`;
      }
    }
    await run(hooks.REQUEST.GET_COOKIE.AFTER);
  } catch (error) {
    await run(hooks.REQUEST.GET_COOKIE.ERROR);
    if (error?.statusCode === 400) {
      executionContext.responseData.status = 400;
      executionContext.responseData.body = STATUS_TEXT[400];
      executionContext.responseData.headers = {
        ...(executionContext.responseData.headers ?? {}),
        'Content-Type': `text/plain; charset=utf-8`
      };
      await writeResponse(executionContext);
      return true;
    }
    throw error;
  }

  if (dataMethods.includes(executionContext.requestData?.method ?? `GET`)) {
    readBody.primeBufferedBody(executionContext);
  }

  try {
    await directorHelper.resolveRoute();
  } catch (error) {
    console.error(`[uws-http-handler] route resolution failed`, {
      url: executionContext.requestData?.url ?? null,
      host: executionContext.requestData?.headers?.host ?? null,
      error: error?.stack ?? error?.message ?? error
    });
    await writeInternalError(executionContext);
    return true;
  }

  if (!executionContext.projectRoute) {
    executionContext.responseData.status = 404;
    executionContext.responseData.body = `Not Found`;
    await writeResponse(executionContext);
    return true;
  }

  if (executionContext.projectRoute.isRedirect()) {
    executionContext.responseData.status = executionContext.projectRoute.target?.redirect?.status ?? 302;
    executionContext.responseData.headers = {
      ...(executionContext.responseData.headers ?? {}),
      Location: normalizeRedirectLocationForRoute(
        executionContext.projectRoute.target?.redirect?.location,
        executionContext.projectRoute
      )
    };
    await writeResponse(executionContext);
    return true;
  }

  const requestMethod = executionContext.requestData?.method ?? `GET`;
  const routeValidationFailure = validateRouteRequest(executionContext);
  if (routeValidationFailure) {
    executionContext.responseData.status = routeValidationFailure.status;
    executionContext.responseData.body = routeValidationFailure.body;
    executionContext.responseData.headers = {
      ...(executionContext.responseData.headers ?? {}),
      'Content-Type': `text/plain; charset=utf-8`,
      ...(routeValidationFailure.headers ?? {})
    };
    await writeResponse(executionContext);
    return true;
  }

  if (requestMethod === `OPTIONS`) {
    const preflightResponse = buildPreflightResponse(executionContext);
    executionContext.responseData.status = preflightResponse.status;
    executionContext.responseData.body = preflightResponse.body;
    executionContext.responseData.headers = {
      ...(executionContext.responseData.headers ?? {}),
      ...(preflightResponse.headers ?? {})
    };
    if (executionContext.meta) {
      executionContext.meta.requestKind = `preflight`;
    }
    await writeResponse(executionContext);
    return true;
  }

  if (dataMethods.includes(requestMethod)) {
    const bodyReadStartedAt = Date.now();
    await run(hooks.REQUEST.BODY.START);
    if (executionContext.isAborted()) {
      await writeResponse(executionContext);
      return true;
    }
    try {
      await readBody(executionContext);
      await run(hooks.REQUEST.BODY.END);
      await runMiddlewareStack(executionContext);
    } catch (e) {
      await run(hooks.REQUEST.BODY.ERROR);
      await writeBodyReadFailure(executionContext, e);
    } finally {
      if (executionContext.meta) {
        executionContext.meta.bodyReadMs = Date.now() - bodyReadStartedAt;
      }
    }
  } else {
    await runMiddlewareStack(executionContext);
  }

  return true;
};

module.exports._internal = Object.freeze({
  extractHeaders,
  normalizeProxiedRequest,
  validateRouteRequest
});

/** @param {import('@/_core/runtimes/ingress-runtime/execution/execution-context')} executionContext  */
async function runMiddlewareStack(executionContext) {
  const { res } = executionContext;
  const { run, hooks } = executionContext;

  if (executionContext.isAborted()) {
    await run(hooks.REQUEST.BREAK);
    return;
  }
  try {
    await executionContext.runHttpMiddlewareStack();

    if (executionContext.isAborted()) {
      await run(hooks.REQUEST.BREAK);
      return;
    }

    await writeResponse(executionContext);
  } catch (error) {
    console.error(`[uws-http-handler] middleware stack failed`, {
      url: executionContext.requestData?.url ?? null,
      host: executionContext.requestData?.headers?.host ?? null,
      error: error?.stack ?? error?.message ?? error
    });
    await run(hooks.REQUEST.ERROR);
    if (!executionContext.isAborted()) {
      const response = createTenantFacingErrorResponse({
        status: 500,
        productionBody: STATUS_TEXT[500],
        nonProductionBody: `Request execution failed in this non-production environment. See runtime logs for details.`
      });
      corkIfAvailable(res, () => {
        writeUwsResponseHead(res, {
          status: response.status,
          headers: response.headers
        });
        res.end(response.body);
      });
    }
  }

  return true;
}

/*
 * Helpers
 */

function extractHeaders(req) {
  const headers = {};
  req.forEach((key, value) => {
    headers[String(key).toLowerCase()] = value;
  });
  return headers;
}

function normalizeProxiedRequest(headers = {}) {
  const forcedAppId = normalizeOptionalInternalAppId(headers[`x-ehecoatl-target-app-id`]);
  const hostname = normalizeRequiredForwardedValue(headers[`x-forwarded-host`], `X-Forwarded-Host`)
    .replace(/:\d+$/, ``)
    .toLowerCase();
  const protocol = normalizeRequiredForwardedValue(headers[`x-forwarded-proto`], `X-Forwarded-Proto`).toLowerCase();
  const port = normalizePortHeader(normalizeRequiredForwardedValue(headers[`x-forwarded-port`], `X-Forwarded-Port`));
  const method = normalizeRequiredForwardedValue(headers[`x-forwarded-method`], `X-Forwarded-Method`).toUpperCase();
  const path = normalizePathHeader(normalizeRequiredForwardedValue(headers[`x-forwarded-uri`], `X-Forwarded-Uri`));
  const queryString = normalizeQueryHeader(headers[`x-forwarded-query`]);
  const ip = normalizeForwardedIp(headers);

  const normalizedHeaders = {
    ...headers,
    host: hostname,
    [`x-forwarded-host`]: hostname,
    [`x-forwarded-proto`]: protocol,
    [`x-forwarded-port`]: String(port),
    [`x-forwarded-method`]: method,
    [`x-forwarded-uri`]: path,
    [`x-forwarded-query`]: queryString
  };
  delete normalizedHeaders[`x-ehecoatl-target-app-id`];

  return Object.freeze({
    method,
    hostname,
    protocol,
    port,
    path,
    queryString,
    ip,
    url: `${hostname}${path}`,
    headers: Object.freeze(normalizedHeaders),
    forcedAppId
  });
}

function normalizeRequiredForwardedValue(value, headerName) {
  const normalized = String(value ?? ``).split(`,`)[0].trim();
  if (!normalized) {
    const error = new Error(`Missing required proxied header ${headerName}`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeQueryHeader(value) {
  const normalized = String(value ?? ``).trim();
  if (!normalized) return ``;
  return normalized.startsWith(`?`) ? normalized.slice(1) : normalized;
}

function normalizePathHeader(value) {
  const normalized = String(value ?? ``).trim();
  return normalizeRoutePath(normalized || `/`);
}

function normalizePortHeader(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`Invalid proxied port header`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function normalizeForwardedIp(headers = {}) {
  const forwardedFor = String(headers[`x-forwarded-for`] ?? ``).split(`,`)[0].trim();
  if (forwardedFor) return forwardedFor;

  const realIp = String(headers[`x-real-ip`] ?? ``).trim();
  if (realIp) return realIp;

  const error = new Error(`Missing required proxied header X-Forwarded-For`);
  error.statusCode = 400;
  throw error;
}

function normalizeRedirectLocationForRoute(location, projectRoute) {
  const normalizedLocation = String(location ?? ``).trim();
  if (!shouldPrefixRedirectLocation(normalizedLocation, projectRoute)) {
    return location;
  }

  const appPrefix = `/${String(projectRoute?.origin?.appName ?? ``).trim().toLowerCase()}`;
  if (normalizedLocation === appPrefix || normalizedLocation.startsWith(`${appPrefix}/`)) {
    return normalizedLocation;
  }

  return `${appPrefix}${normalizedLocation}`;
}

function shouldPrefixRedirectLocation(location, projectRoute) {
  if (!location.startsWith(`/`)) return false;
  if (location.startsWith(`//`)) return false;
  const domainRoutingMode = String(projectRoute?.domainRoutingMode ?? projectRoute?.meta?.domainRoutingMode ?? ``).trim().toLowerCase();
  if (domainRoutingMode !== `path`) return false;
  const appName = String(projectRoute?.origin?.appName ?? ``).trim();
  return Boolean(appName);
}

function normalizeOptionalInternalAppId(value) {
  const normalized = String(value ?? ``).trim().toLowerCase();
  return normalized || null;
}

function validateRouteRequest(executionContext) {
  const { requestData, projectRoute } = executionContext;
  const requestMethod = requestData?.method ?? `GET`;

  if (isMethodBlocked(requestMethod)) {
    return {
      status: 405,
      body: STATUS_TEXT[405],
      headers: {
        Allow: projectRoute.allowHeader()
      }
    };
  }

  if (!projectRoute.allowsHostMethod(requestMethod)) {
    return {
      status: 405,
      body: STATUS_TEXT[405],
      headers: {
        Allow: projectRoute.hostAllowHeader()
      }
    };
  }

  if (!projectRoute.allowsMethod(requestMethod)) {
    return {
      status: 405,
      body: STATUS_TEXT[405],
      headers: {
        Allow: projectRoute.allowHeader()
      }
    };
  }

  if (!shouldValidateContentType(requestData, projectRoute)) {
    return null;
  }

  const requestContentType = requestData?.headers?.[`content-type`] ?? ``;
  if (projectRoute.allowsContentType(requestContentType)) {
    return null;
  }

  return {
    status: 415,
    body: STATUS_TEXT[415]
  };
}

function buildPreflightResponse(executionContext) {
  const allowHeader = executionContext.projectRoute.allowHeader();
  const baseHeaders = {
    Allow: allowHeader
  };
  const origin = getOriginHeader(executionContext);
  const requestedMethod = resolveRequestedPreflightMethod(executionContext);

  if (!origin || !isCrossOriginRequest(executionContext)) {
    return {
      status: 204,
      body: null,
      headers: baseHeaders
    };
  }

  if (!isOriginAllowed(executionContext, origin)) {
    const blockedResponse = buildCorsBlockedResponse(executionContext, origin);
    return {
      status: blockedResponse.status,
      body: blockedResponse.body,
      headers: {
        ...baseHeaders,
        ...(blockedResponse.headers ?? {})
      }
    };
  }

  if (
    requestedMethod
    && (
      !executionContext.projectRoute.allowsHostMethod(requestedMethod)
      || !executionContext.projectRoute.allowsMethod(requestedMethod)
    )
  ) {
    return {
      status: 405,
      body: STATUS_TEXT[405],
      headers: {
        ...baseHeaders,
        'Content-Type': `text/plain; charset=utf-8`
      }
    };
  }

  return {
    status: 204,
    body: null,
    headers: {
      ...baseHeaders,
      ...buildCorsHeaders(executionContext, origin)
    }
  };
}

function shouldValidateContentType(requestData, projectRoute) {
  if (!Array.isArray(projectRoute.contentTypes)) return false;

  const headers = requestData?.headers ?? {};
  if (String(headers[`content-type`] ?? ``).trim()) return true;

  const contentLength = Number(headers[`content-length`]);
  if (Number.isFinite(contentLength) && contentLength > 0) return true;

  return String(headers[`transfer-encoding`] ?? ``).trim().length > 0;
}

async function writeBodyReadFailure(executionContext, error) {
  if (executionContext.isAborted()) return;

  const { res } = executionContext;
  const { status, body } = normalizeBodyReadError(error);
  corkIfAvailable(res, () => {
    writeUwsResponseHead(res, {
      status,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
    res.end(body);
  });
}

function normalizeBodyReadError(error) {
  const normalizedString = normalizeStatusString(
    typeof error === `string`
      ? error
      : error?.message
  );
  if (normalizedString) {
    return createTenantFacingErrorResponse({
      status: normalizedString.status,
      productionBody: normalizedString.body,
      nonProductionBody: `Request body validation failed in this non-production environment.`,
      nonProductionDetails: [
        `Reason: ${normalizedString.body}`
      ]
    });
  }

  if (error instanceof SyntaxError) {
    return createTenantFacingErrorResponse({
      status: 400,
      productionBody: STATUS_TEXT[400],
      nonProductionBody: `Request body validation failed in this non-production environment.`,
      nonProductionDetails: [
        `Reason: invalid JSON body`,
        `Detail: ${error.message}`
      ]
    });
  }

  return createTenantFacingErrorResponse({
    status: 500,
    productionBody: STATUS_TEXT[500],
    nonProductionBody: `Request body validation failed in this non-production environment.`,
    nonProductionDetails: [
      `Reason: unexpected body-read failure`,
      ...(error?.message ? [`Detail: ${error.message}`] : [])
    ]
  });
}

function normalizeStatusString(value) {
  if (typeof value !== `string`) return null;
  const match = toStatusLine(value).match(/^(\d{3})\s+(.+)$/);
  if (!match) return null;

  const status = Number(match[1]);
  const body = match[2].trim();
  if (!Number.isInteger(status)) return null;

  return {
    status,
    body: body || (STATUS_TEXT[status] ?? STATUS_TEXT[500])
  };
}

async function writeInternalError(executionContext) {
  if (executionContext.isAborted()) return;

  const response = createTenantFacingErrorResponse({
    status: 500,
    productionBody: STATUS_TEXT[500],
    nonProductionBody: `Request routing failed in this non-production environment. See runtime logs for details.`
  });
  executionContext.responseData.status = response.status;
  executionContext.responseData.body = response.body;
  executionContext.responseData.headers = {
    ...(executionContext.responseData.headers ?? {}),
    ...(response.headers ?? {})
  };

  await writeResponse(executionContext);
}
