'use strict';

const path = require(`node:path`);

function buildTenantSourceRenderModel(source) {
  const kind = normalizeKind(source?.kind);
  const tenantId = String(source?.projectId ?? source?.tenantId ?? ``).trim();
  const tenantDomain = String(source?.projectDomain ?? source?.tenantDomain ?? ``).trim().toLowerCase();
  const domain = String(source?.domain ?? tenantDomain).trim().toLowerCase();
  if (!tenantId || !tenantDomain || !domain) {
    throw new Error(`Nginx project source requires projectId/projectDomain and domain; legacy tenantId/tenantDomain are still accepted`);
  }

  const httpPort = Number(source?.internalProxy?.httpPort);
  const wsPort = Number(source?.internalProxy?.wsPort);
  if (!Number.isInteger(httpPort) || !Number.isInteger(wsPort)) {
    throw new Error(`Nginx tenant source requires internalProxy.httpPort and internalProxy.wsPort`);
  }

  const tenantRoot = String(source?.projectRoot ?? source?.tenantRoot ?? ``).trim();
  const serviceRoot = tenantRoot ? path.join(tenantRoot, `.ehecoatl`) : null;
  const logsRoot = serviceRoot ? path.join(serviceRoot, `log`) : null;
  const effectiveTls = normalizeEffectiveTls(source?.effectiveTls);
  const exactHostOnly = ![`project-primary`, `project-alias`, `tenant-primary`, `tenant-alias`].includes(kind);
  const serverNames = exactHostOnly
    ? domain
    : [domain, `*.${domain}`].join(` `);
  const forcedAppId = kind.startsWith(`app-`)
    ? String(source?.forcedAppId ?? ``).trim().toLowerCase()
    : ``;
  const pathModeApps = normalizePathModeApps(source?.apps);

  return Object.freeze({
    kind,
    tenantId,
    tenantDomain,
    domain,
    tenantRoot,
    cacheRoot: serviceRoot ? path.join(serviceRoot, `.cache`) : null,
    serverNames,
    hostname: domain,
    hostnameSupplemental: exactHostOnly ? `` : `*.${domain}`,
    httpPort,
    wsPort,
    wsPathPrefix: `/ws`,
    pathModeApps,
    httpUpstreamHost: `127.0.0.1`,
    wsUpstreamHost: `127.0.0.1`,
    forcedAppId,
    proxyTargetHeader: `X-Ehecoatl-Target-App-Id`,
    tlsMode: effectiveTls.mode,
    tlsCertPath: effectiveTls.certPath,
    tlsKeyPath: effectiveTls.keyPath,
    httpRedirectToHttps: effectiveTls.httpRedirectToHttps,
    httpsEnabled: effectiveTls.httpsEnabled,
    accessLogPath: logsRoot ? path.join(logsRoot, `nginx.access.log`) : ``,
    errorLogPath: logsRoot ? path.join(logsRoot, `nginx.error.log`) : ``,
    limitReqZoneName: `ehecoatl_req_${sanitizeDomainToken(domain)}`,
    limitReqZoneSize: `10m`,
    limitReqRate: `10r/s`,
    limitReqBurst: `20`,
    limitReqMode: `nodelay`,
    limitConnZoneName: `ehecoatl_conn_${sanitizeDomainToken(domain)}`,
    limitConnZoneSize: `10m`,
    limitConnPerIp: `20`
  });
}

function renderTenantTemplate(templateContent, source) {
  const model = buildTenantSourceRenderModel(source);
  const replacements = new Map([
    [`{{TENANT_ID}}`, model.tenantId],
    [`{{TENANT_DOMAIN}}`, model.tenantDomain],
    [`{{SERVER_NAMES}}`, model.serverNames],
    [`{{HTTP_UPSTREAM_HOST}}`, model.httpUpstreamHost],
    [`{{HTTP_UPSTREAM_PORT}}`, String(model.httpPort)],
    [`{{WS_UPSTREAM_HOST}}`, model.wsUpstreamHost],
    [`{{WS_UPSTREAM_PORT}}`, String(model.wsPort)],
    [`@t(tenant_id)`, model.tenantId],
    [`@t(tenant_root)`, model.tenantRoot],
    [`@t(cache_root)`, model.cacheRoot],
    [`@t(hostname)`, model.hostname],
    [`@t(hostname_www)`, model.hostnameSupplemental],
    [`@t(http_ingress_port)`, String(model.httpPort)],
    [`@t(ws_ingress_port)`, String(model.wsPort)],
    [`@t(ws_path_prefix)`, model.wsPathPrefix],
    [`@t(limit_req_zone_name)`, model.limitReqZoneName],
    [`@t(limit_req_zone_size)`, model.limitReqZoneSize],
    [`@t(limit_req_rate)`, model.limitReqRate],
    [`@t(limit_req_burst)`, model.limitReqBurst],
    [`@t(limit_req_mode)`, model.limitReqMode],
    [`@t(limit_conn_zone_name)`, model.limitConnZoneName],
    [`@t(limit_conn_zone_size)`, model.limitConnZoneSize],
    [`@t(limit_conn_per_ip)`, model.limitConnPerIp],
    [`@t(tls_cert_path)`, model.tlsCertPath],
    [`@t(tls_key_path)`, model.tlsKeyPath],
    [`@t(access_log_path)`, model.accessLogPath],
    [`@t(error_log_path)`, model.errorLogPath]
  ]);

  let rendered = String(templateContent ?? ``);
  for (const [token, value] of replacements.entries()) {
    rendered = rendered.split(token).join(value ?? ``);
  }

  rendered = rendered.replace(/server_name\s+[^;]+;/g, `server_name ${model.serverNames};`);
  rendered = rendered.replaceAll(BASE_PROXY_HEADER_BLOCK, createProxyHeaderBlock(model));

  if (!model.httpRedirectToHttps) {
    rendered = rendered.replace(
      `    return 301 https://$host$request_uri;`,
      createHttpProxyBlock(model)
    );
  }

  rendered = injectPathModeWebSocketProxyBlocks(rendered, model);

  if (!model.httpsEnabled) {
    rendered = rendered.replace(/\nserver\s*\{\n\s*listen 443 ssl http2;[\s\S]*?\n\}\s*$/m, `\n`);
  }

  return rendered;
}

module.exports = {
  buildTenantSourceRenderModel,
  renderTenantTemplate
};

Object.freeze(module.exports);

function normalizeKind(kind) {
  const normalized = String(kind ?? `project-primary`).trim().toLowerCase();
  if ([`project-primary`, `project-alias`, `tenant-primary`, `tenant-alias`, `app-alias`, `app-default-root`, `app-default-domain`, `app-domain`].includes(normalized)) {
    return normalized;
  }
  return `project-primary`;
}

function normalizeEffectiveTls(effectiveTls) {
  const normalizedMode = String(effectiveTls?.mode ?? `none`).trim().toLowerCase();
  const certPath = String(effectiveTls?.certPath ?? ``).trim();
  const keyPath = String(effectiveTls?.keyPath ?? ``).trim();
  const httpsEnabled = Boolean(effectiveTls?.httpsEnabled && certPath && keyPath);

  return Object.freeze({
    mode: normalizedMode || `none`,
    certPath,
    keyPath,
    httpsEnabled,
    httpRedirectToHttps: Boolean(effectiveTls?.httpRedirectToHttps && httpsEnabled)
  });
}

function createInternalLocations(model) {
  return [
    `    location ^~ /_ehecoatl_internal/static/ {`,
    `        internal;`,
    `        alias ${model.tenantRoot}/;`,
    `    }`,
    ``,
    `    location ^~ /_ehecoatl_internal/cache/ {`,
    `        internal;`,
    `        alias ${model.cacheRoot}/;`,
    `    }`
  ].join(`\n`);
}

function createProxyHeaderBlock(model, {
  forwardedUri = `$uri`
} = {}) {
  const targetAppHeader = model.forcedAppId
    ? `        proxy_set_header ${model.proxyTargetHeader} ${model.forcedAppId};`
    : `        proxy_set_header ${model.proxyTargetHeader} "";`;

  return [
    `        proxy_set_header Host $host;`,
    `        proxy_set_header X-Real-IP $remote_addr;`,
    `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `        proxy_set_header X-Forwarded-Proto $scheme;`,
    `        proxy_set_header X-Forwarded-Host $host;`,
    `        proxy_set_header X-Forwarded-Port $server_port;`,
    `        proxy_set_header X-Forwarded-Method $request_method;`,
    `        proxy_set_header X-Forwarded-Uri ${forwardedUri};`,
    `        proxy_set_header X-Forwarded-Query $args;`,
    targetAppHeader
  ].join(`\n`);
}

function createProxyHeaderBlockForApp(model, app) {
  return createProxyHeaderBlock({
    ...model,
    forcedAppId: app.appId
  }, {
    forwardedUri: app.forwardedUri ?? `$uri`
  });
}

const BASE_PROXY_HEADER_BLOCK = [
  `        proxy_set_header Host $host;`,
  `        proxy_set_header X-Real-IP $remote_addr;`,
  `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
  `        proxy_set_header X-Forwarded-Proto $scheme;`,
  `        proxy_set_header X-Forwarded-Host $host;`,
  `        proxy_set_header X-Forwarded-Port $server_port;`,
  `        proxy_set_header X-Forwarded-Method $request_method;`,
  `        proxy_set_header X-Forwarded-Uri $uri;`,
  `        proxy_set_header X-Forwarded-Query $args;`
].join(`\n`);

function createHttpProxyBlock(model) {
  return [
    createInternalLocations(model),
    ``,
    createPathModeWebSocketProxyBlocks(model),
    ``,
    `    location = ${model.wsPathPrefix} {`,
    `        proxy_pass http://${model.wsUpstreamHost}:${model.wsPort};`,
    `        proxy_http_version 1.1;`,
    `        proxy_buffering off;`,
    `        proxy_request_buffering off;`,
    ``,
    createProxyHeaderBlock(model),
    ``,
    `        proxy_set_header Upgrade $http_upgrade;`,
    `        proxy_set_header Connection "upgrade";`,
    ``,
    `        proxy_read_timeout 600s;`,
    `        proxy_send_timeout 600s;`,
    `    }`,
    ``,
    `    location ^~ ${model.wsPathPrefix}/ {`,
    `        proxy_pass http://${model.wsUpstreamHost}:${model.wsPort};`,
    `        proxy_http_version 1.1;`,
    `        proxy_buffering off;`,
    `        proxy_request_buffering off;`,
    ``,
    createProxyHeaderBlock(model),
    ``,
    `        proxy_set_header Upgrade $http_upgrade;`,
    `        proxy_set_header Connection "upgrade";`,
    ``,
    `        proxy_read_timeout 600s;`,
    `        proxy_send_timeout 600s;`,
    `    }`,
    ``,
    `    location ~ ^(.+?)/+$ {`,
    `        return 308 $scheme://$host$1$is_args$args;`,
    `    }`,
    ``,
    `    location / {`,
    `        proxy_pass http://${model.httpUpstreamHost}:${model.httpPort};`,
    `        proxy_http_version 1.1;`,
    `        proxy_buffering on;`,
    `        proxy_request_buffering on;`,
    ``,
    createProxyHeaderBlock(model),
    ``,
    `        proxy_read_timeout 300s;`,
    `        proxy_send_timeout 300s;`,
    `    }`
  ].join(`\n`);
}

function createPathModeWebSocketProxyBlocks(model) {
  if (!Array.isArray(model.pathModeApps) || model.pathModeApps.length === 0) {
    return ``;
  }

  return model.pathModeApps
    .map((app) => createPathModeWebSocketProxyBlock(model, app))
    .filter(Boolean)
    .join(`\n\n`);
}

function injectPathModeWebSocketProxyBlocks(rendered, model) {
  const appWebSocketBlocks = createPathModeWebSocketProxyBlocks(model);
  if (!appWebSocketBlocks) return rendered;

  return String(rendered ?? ``).replace(
    new RegExp(`\\n    location\\s+${escapeNginxRegex(model.wsPathPrefix)}\\s*\\{`, `g`),
    `\n${appWebSocketBlocks}\n\n    location ${model.wsPathPrefix} {`
  );
}

function createPathModeWebSocketProxyBlock(model, app) {
  const appPrefix = `/${app.appName}`;
  return [
    `    location = ${appPrefix}${model.wsPathPrefix} {`,
    `        proxy_pass http://${model.wsUpstreamHost}:${model.wsPort};`,
    `        proxy_http_version 1.1;`,
    `        proxy_buffering off;`,
    `        proxy_request_buffering off;`,
    ``,
    createProxyHeaderBlockForApp(model, {
      ...app,
      forwardedUri: model.wsPathPrefix
    }),
    ``,
    `        proxy_set_header Upgrade $http_upgrade;`,
    `        proxy_set_header Connection "upgrade";`,
    ``,
    `        proxy_read_timeout 600s;`,
    `        proxy_send_timeout 600s;`,
    `    }`,
    ``,
    `    location ~ ^${escapeNginxRegex(appPrefix)}${escapeNginxRegex(model.wsPathPrefix)}(?<ehecoatl_ws_suffix>/.*)$ {`,
    `        proxy_pass http://${model.wsUpstreamHost}:${model.wsPort};`,
    `        proxy_http_version 1.1;`,
    `        proxy_buffering off;`,
    `        proxy_request_buffering off;`,
    ``,
    createProxyHeaderBlockForApp(model, {
      ...app,
      forwardedUri: `${model.wsPathPrefix}$ehecoatl_ws_suffix`
    }),
    ``,
    `        proxy_set_header Upgrade $http_upgrade;`,
    `        proxy_set_header Connection "upgrade";`,
    ``,
    `        proxy_read_timeout 600s;`,
    `        proxy_send_timeout 600s;`,
    `    }`
  ].join(`\n`);
}

function normalizePathModeApps(apps) {
  if (!Array.isArray(apps)) return Object.freeze([]);
  const normalized = [];
  const seen = new Set();

  for (const app of apps) {
    const appId = String(app?.appId ?? ``).trim().toLowerCase();
    const appName = String(app?.appName ?? ``).trim().toLowerCase();
    if (!appId || !appName || seen.has(appName)) continue;
    seen.add(appName);
    normalized.push(Object.freeze({ appId, appName }));
  }

  return Object.freeze(normalized);
}

function escapeNginxRegex(value) {
  return String(value ?? ``).replace(/[.*+?^${}()|[\]\\]/g, `\\$&`);
}

function sanitizeDomainToken(domain) {
  const normalized = String(domain ?? ``).trim().toLowerCase();
  const sanitized = normalized
    .replace(/[^a-z0-9]+/g, `_`)
    .replace(/^_+|_+$/g, ``);
  return sanitized || `host`;
}
