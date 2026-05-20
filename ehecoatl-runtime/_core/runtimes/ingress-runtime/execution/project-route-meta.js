// _core/runtimes/ingress-runtime/execution/project-route-meta.js


'use strict';


const { normalizeRouteRunTarget } = require(`@/utils/tenancy/route-run-target`);
const { DEFAULT_REDIRECT_STATUS, parseRouteTargetString } = require(`@/utils/tenancy/route-target`);
const { normalizeDeclaredMethods } = require(`@/utils/http/http-method-policy`);
const normalizeI18nSourceEntry = require(`@/utils/i18n/normalize-i18n-source-entry`);

const LEGACY_ROUTE_TARGET_KEYS = Object.freeze([`run`, `asset`, `redirect`, `status`]);
const LEGACY_ROUTE_CONFIG_KEYS = Object.freeze([
  `resource`,
  `action`,
  `contentType`,
  `content-types`,
  `uploadPath`,
  `uploadTypes`,
  `diskLimit`,
  `diskLimitBytes`,
  `hostname`,
  `appURL`,
  `domain`,
  `appName`,
  `tenantRootFolder`,
  `rootFolder`,
  `actionsRootFolder`,
  `httpActionsRootFolder`,
  `wsActionsRootFolder`,
  `assetsRootFolder`,
  `httpSharedActionsRootFolder`,
  `wsSharedActionsRootFolder`,
  `assetsSharedRootFolder`,
  `httpMiddlewaresRootFolder`,
  `wsMiddlewaresRootFolder`,
  `routesRootFolder`,
  `httpRoutesRootFolder`,
  `wsRoutesRootFolder`
]);

class ProjectRouteMeta {
  constructor(params = {}) {
    let normalizedParams = normalizeProjectRouteMetaParams(params);
    let {
      pointsTo,

      i18n,
      target,
      middleware,
      authScope,
      wsActionsAvailable,
      cors,

      cache,
      session,

      methods = null,
      methodsAvailable = null,
      contentTypes,
      upload,
      maxInputBytes,
      upgrade,

      params: routeParams,
      view: routeView,
      origin,
      domainRoutingMode,
      folders
    } = normalizedParams;

    this.pointsTo = typeof pointsTo === `string` && pointsTo.trim() ? pointsTo.trim() : null;
    this.i18n = normalizeI18n(i18n);
    this.target = freezeTarget(target);
    this.middleware = Object.freeze(normalizeMiddlewareLabels(middleware));
    this.authScope = freezeScalarOrArray(authScope);
    this.wsActionsAvailable = normalizeStringArray(wsActionsAvailable);
    this.cors = normalizeStringArray(cors);

    this.cache = cache;
    this.session = session;

    this.methodsAvailable = Object.freeze(normalizeMethods(methodsAvailable));
    this.methods = Object.freeze(normalizeMethods(methods));
    this.contentTypes = normalizeContentTypes(contentTypes);
    this.upload = freezeUpload(upload);
    this.maxInputBytes = maxInputBytes;
    this.upgrade = freezeUpgrade(upgrade);

    this.params = freezeParams(routeParams);
    this.view = freezeView(routeView);
    this.origin = freezeOrigin(origin);
    this.domainRoutingMode = normalizeOptionalString(domainRoutingMode);
    this.folders = freezeFolders(folders);

    Object.freeze(this);
  }

  static normalizeRouteConfig(routeValue, routePath = null) {
    if (!isPlainObject(routeValue)) {
      throw new Error(`Route "${routePath ?? `unknown`}" must resolve to a JSON object`);
    }

    const legacyKeys = [
      ...LEGACY_ROUTE_TARGET_KEYS,
      ...LEGACY_ROUTE_CONFIG_KEYS
    ].filter((key) => Object.prototype.hasOwnProperty.call(routeValue, key));
    if (legacyKeys.length > 0) {
      throw new Error(
        `Route "${routePath ?? `unknown`}" uses legacy target fields (${legacyKeys.join(`, `)}); use "pointsTo" only`
      );
    }
    if (!isTargetlessUpgradeRoute(routeValue)
      && (typeof routeValue.pointsTo !== `string` || !routeValue.pointsTo.trim())) {
      throw new Error(`Route "${routePath ?? `unknown`}" must define a non-empty "pointsTo" string`);
    }

    return normalizeProjectRouteMetaParams(routeValue);
  }
}

function normalizeProjectRouteMetaParams(params) {
  let normalizedParams = { ...params };
  const parsedTarget = shouldParsePointsTo(normalizedParams)
    ? parseRouteTargetString(normalizedParams.pointsTo)
    : null;

  if (parsedTarget) {
    normalizedParams = {
      ...normalizedParams,
      pointsTo: parsedTarget.pointsTo,
      target: parsedTarget.target
    };
  }

  const normalizedTarget = resolveTarget(normalizedParams);

  const contentTypes = resolveContentTypes(normalizedParams);
  const middleware = resolveMiddleware(normalizedParams);
  const authScope = resolveAuthScope(normalizedParams);
  const wsActionsAvailable = resolveWsActionsAvailable(normalizedParams);
  const cors = resolveCors(normalizedParams);
  const upload = resolveUpload(normalizedParams);
  const origin = resolveOrigin(normalizedParams);
  const folders = resolveFolders(normalizedParams, origin, upload);
  const upgrade = resolveUpgrade(normalizedParams, wsActionsAvailable);
  const routeParams = resolveParams(normalizedParams);
  const routeView = resolveView(normalizedParams);

  return {
    ...normalizedParams,
    contentTypes,
    middleware,
    authScope,
    wsActionsAvailable,
    cors,
    upload,
    upgrade,
    params: routeParams,
    view: routeView,
    origin,
    folders,
    target: normalizedTarget
  };
}

function shouldParsePointsTo(params) {
  if (typeof params?.pointsTo !== `string` || !params.pointsTo.trim()) return false;
  return !isPlainObject(params?.target) || !params.target.type || !params.target.value;
}

function isPlainObject(value) {
  return value != null && typeof value === `object` && !Array.isArray(value);
}

function normalizeMethods(methods) {
  return [...normalizeDeclaredMethods(methods)];
}

function normalizeContentTypes(contentTypes) {
  if (!Array.isArray(contentTypes)) return null;

  return Object.freeze([...new Set(
    contentTypes
      .map((contentType) => normalizeContentType(contentType))
      .filter(Boolean)
  )]);
}

function normalizeRunGroup({
  run,
  targetType,
  targetValue,
  call
}) {
  if (isPlainObject(run)) {
    const resource = normalizeResourceIdentifier(run.resource);
    const action = normalizeActionIdentifier(run.action) ?? `index`;
    if (!resource) return null;
    return Object.freeze({ resource, action });
  }

  const runSource = typeof run === `string` && run.trim()
    ? run
    : (targetType === `run` ? targetValue : null);
  const target = normalizeRouteRunTarget({ run: runSource, call });
  if (!target.run || !target.resource || !target.action) return null;
  return Object.freeze({
    resource: target.resource,
    action: target.action
  });
}

function resolveTarget(params) {
  const normalizedTarget = isPlainObject(params?.target) ? params.target : {};
  const targetType = typeof normalizedTarget.type === `string` && normalizedTarget.type.trim()
    ? normalizedTarget.type.trim()
    : null;
  const targetValue = typeof normalizedTarget.value === `string` && normalizedTarget.value.trim()
    ? normalizedTarget.value.trim()
    : null;
  const run = normalizeRunGroup({
    run: normalizedTarget.run,
    targetType,
    targetValue,
    call: params.call
  });
  const assetPath = typeof normalizedTarget?.asset?.path === `string` && normalizedTarget.asset.path.trim()
    ? normalizedTarget.asset.path.trim()
    : (targetType === `asset` ? targetValue : null);
  const redirectLocation = typeof normalizedTarget?.redirect?.location === `string` && normalizedTarget.redirect.location.trim()
    ? normalizedTarget.redirect.location.trim()
    : (targetType === `redirect` ? targetValue : null);
  const redirectStatus = Number.isFinite(normalizedTarget?.redirect?.status)
    ? normalizedTarget.redirect.status
    : (targetType === `redirect` ? DEFAULT_REDIRECT_STATUS : null);

  return {
    type: targetType,
    value: targetValue,
    asset: assetPath ? { path: assetPath } : null,
    run,
    redirect: redirectLocation ? { location: redirectLocation, status: redirectStatus } : null
  };
}

function resolveContentTypes(params) {
  if (Object.prototype.hasOwnProperty.call(params, `contentTypes`)) {
    return params.contentTypes;
  }
  if (Object.prototype.hasOwnProperty.call(params, `content-types`)) {
    return params[`content-types`];
  }
  return null;
}

function resolveMiddleware(params) {
  if (Object.prototype.hasOwnProperty.call(params, `middleware`)) {
    return params.middleware;
  }
  if (Object.prototype.hasOwnProperty.call(params, `middlewares`)) {
    return params.middlewares;
  }
  return null;
}

function resolveAuthScope(params) {
  if (Object.prototype.hasOwnProperty.call(params, `authScope`)) {
    return params.authScope;
  }
  return null;
}

function resolveWsActionsAvailable(params) {
  if (Object.prototype.hasOwnProperty.call(params, `wsActionsAvailable`)) {
    return params.wsActionsAvailable;
  }
  if (Object.prototype.hasOwnProperty.call(params, `actionsAvailable`)) {
    return params.actionsAvailable;
  }
  return null;
}

function resolveCors(params) {
  if (Object.prototype.hasOwnProperty.call(params, `cors`)) {
    return params.cors;
  }
  return null;
}

function resolveParams(params) {
  if (!isPlainObject(params?.params)) return {};
  return Object.fromEntries(
    Object.entries(params.params)
      .map(([key, value]) => [String(key ?? ``).trim(), value == null ? `` : String(value)])
      .filter(([key]) => Boolean(key))
  );
}

function resolveView(params) {
  if (!isPlainObject(params?.view)) return {};
  return { ...params.view };
}

function normalizeI18n(i18n) {
  if (i18n == null) return null;
  if (!Array.isArray(i18n)) {
    throw new Error(`Route "i18n" must be an array of relative JSON paths`);
  }

  const normalized = i18n
    .map((entry) => normalizeI18nSourceEntry(entry, {
      entryLabel: `Route i18n`
    }))
    .filter(Boolean);

  return normalized.length > 0
    ? Object.freeze(normalized)
    : null;
}

function resolveUpload(params) {
  const upload = isPlainObject(params?.upload) ? params.upload : {};
  return {
    uploadPath: upload.uploadPath ?? params.uploadPath ?? null,
    uploadTypes: upload.uploadTypes ?? params.uploadTypes ?? null,
    diskLimit: upload.diskLimit ?? params.diskLimit ?? null,
    diskLimitBytes: upload.diskLimitBytes ?? params.diskLimitBytes ?? null
  };
}

function resolveOrigin(params) {
  const origin = isPlainObject(params?.origin) ? params.origin : {};
  return {
    hostname: origin.hostname ?? params.hostname ?? params.host ?? null,
    appURL: origin.appURL ?? params.appURL ?? null,
    domain: origin.domain ?? params.domain ?? null,
    appName: origin.appName ?? params.appName ?? null,
    projectId: origin.projectId ?? params.projectId ?? origin.tenantId ?? params.tenantId ?? null,
    projectDomain: origin.projectDomain ?? params.projectDomain ?? origin.tenantDomain ?? params.tenantDomain ?? origin.domain ?? params.domain ?? null,
    projectRoot: origin.projectRoot ?? params.projectRoot ?? origin.tenantRoot ?? params.tenantRoot ?? params.tenantRootFolder ?? null,
    tenantId: origin.tenantId ?? params.tenantId ?? null,
    tenantDomain: origin.tenantDomain ?? params.tenantDomain ?? origin.domain ?? params.domain ?? null,
    tenantRoot: origin.tenantRoot ?? params.tenantRoot ?? params.tenantRootFolder ?? null,
    appId: origin.appId ?? params.appId ?? null
  };
}

function resolveFolders(params, origin, upload) {
  const folders = isPlainObject(params?.folders) ? params.folders : {};
  const rootFolder = folders.rootFolder ?? params.rootFolder ?? null;
  const projectRootFolder = folders.projectRootFolder ?? params.projectRootFolder ?? folders.tenantRootFolder ?? params.tenantRootFolder ?? null;
  const tenantRootFolder = folders.tenantRootFolder ?? params.tenantRootFolder ?? projectRootFolder;
  return {
    projectRootFolder,
    tenantRootFolder,
    rootFolder,
    actionsRootFolder: folders.actionsRootFolder
      ?? params.actionsRootFolder
      ?? folders.httpActionsRootFolder
      ?? params.httpActionsRootFolder
      ?? (rootFolder ? `${rootFolder}/app/http/actions` : null),
    httpActionsRootFolder: folders.httpActionsRootFolder
      ?? params.httpActionsRootFolder
      ?? folders.actionsRootFolder
      ?? params.actionsRootFolder
      ?? (rootFolder ? `${rootFolder}/app/http/actions` : null),
    wsActionsRootFolder: folders.wsActionsRootFolder
      ?? params.wsActionsRootFolder
      ?? (rootFolder ? `${rootFolder}/app/ws/actions` : null),
    assetsRootFolder: folders.assetsRootFolder ?? params.assetsRootFolder ?? (rootFolder ? `${rootFolder}/assets` : null),
    httpSharedActionsRootFolder: folders.httpSharedActionsRootFolder ?? params.httpSharedActionsRootFolder ?? null,
    wsSharedActionsRootFolder: folders.wsSharedActionsRootFolder ?? params.wsSharedActionsRootFolder ?? null,
    assetsSharedRootFolder: folders.assetsSharedRootFolder ?? params.assetsSharedRootFolder ?? null,
    httpMiddlewaresRootFolder: folders.httpMiddlewaresRootFolder ?? params.httpMiddlewaresRootFolder ?? null,
    wsMiddlewaresRootFolder: folders.wsMiddlewaresRootFolder ?? params.wsMiddlewaresRootFolder ?? null,
    routesRootFolder: folders.routesRootFolder ?? params.routesRootFolder ?? (rootFolder ? `${rootFolder}/routes` : null),
    httpRoutesRootFolder: folders.httpRoutesRootFolder
      ?? params.httpRoutesRootFolder
      ?? (rootFolder ? `${rootFolder}/routes/http` : null),
    wsRoutesRootFolder: folders.wsRoutesRootFolder
      ?? params.wsRoutesRootFolder
      ?? (rootFolder ? `${rootFolder}/routes/ws` : null)
  };
}

function resolveUpgrade(params, wsActionsAvailable = null) {
  const upgrade = isPlainObject(params?.upgrade) ? params.upgrade : {};
  const enabled = upgrade.enabled === true
    || isTargetlessUpgradeRoute(params);
  if (!enabled) return null;

  const transport = normalizeTransportList(
    upgrade.transport ?? params.transport ?? [`websocket`]
  );

  return {
    enabled: true,
    transport,
    authScope: upgrade.authScope ?? params.authScope ?? null,
    wsActionsAvailable: normalizeStringArray(
      upgrade.wsActionsAvailable
      ?? upgrade.actionsAvailable
      ?? wsActionsAvailable
      ?? null
    ),
    room: upgrade.room ?? params.room ?? null,
    description: upgrade.description ?? params.description ?? null
  };
}

function freezeRun(run) {
  return run ? Object.freeze({ ...run }) : null;
}

function freezeTarget(target) {
  const normalizedTarget = isPlainObject(target) ? target : {};
  return Object.freeze({
    type: normalizedTarget.type ?? null,
    value: normalizedTarget.value ?? null,
    asset: normalizedTarget.asset?.path
      ? Object.freeze({ path: normalizedTarget.asset.path })
      : null,
    run: freezeRun(normalizedTarget.run),
    redirect: normalizedTarget.redirect?.location
      ? Object.freeze({
        location: normalizedTarget.redirect.location,
        status: Number.isFinite(normalizedTarget.redirect.status)
          ? normalizedTarget.redirect.status
          : DEFAULT_REDIRECT_STATUS
      })
      : null
  });
}

function freezeUpload(upload) {
  return Object.freeze({
    uploadPath: upload?.uploadPath ?? null,
    uploadTypes: Array.isArray(upload?.uploadTypes) ? Object.freeze([...upload.uploadTypes]) : (upload?.uploadTypes ?? null),
    diskLimit: upload?.diskLimit ?? null,
    diskLimitBytes: upload?.diskLimitBytes ?? null
  });
}

function freezeParams(params) {
  if (!isPlainObject(params)) return Object.freeze({});
  return Object.freeze({ ...params });
}

function freezeView(view) {
  if (!isPlainObject(view)) return Object.freeze({});
  return Object.freeze({ ...view });
}

function freezeUpgrade(upgrade) {
  if (!upgrade?.enabled) return null;

  return Object.freeze({
    enabled: true,
    transport: Object.freeze([...(upgrade.transport ?? [`websocket`])]),
    authScope: freezeScalarOrArray(upgrade.authScope),
    wsActionsAvailable: Array.isArray(upgrade.wsActionsAvailable)
      ? Object.freeze([...upgrade.wsActionsAvailable])
      : (upgrade.wsActionsAvailable ?? null),
    room: upgrade.room ?? null,
    description: upgrade.description ?? null
  });
}

function freezeOrigin(origin) {
  return Object.freeze({
    hostname: origin?.hostname ?? null,
    appURL: origin?.appURL ?? null,
    domain: origin?.domain ?? null,
    appName: origin?.appName ?? null,
    projectId: origin?.projectId ?? origin?.tenantId ?? null,
    projectDomain: origin?.projectDomain ?? origin?.tenantDomain ?? origin?.domain ?? null,
    projectRoot: origin?.projectRoot ?? origin?.tenantRoot ?? null,
    tenantId: origin?.tenantId ?? null,
    tenantDomain: origin?.tenantDomain ?? origin?.domain ?? null,
    tenantRoot: origin?.tenantRoot ?? null,
    appId: origin?.appId ?? null
  });
}

function normalizeMiddlewareLabels(middleware) {
  const labels = Array.isArray(middleware)
    ? middleware
    : (middleware == null ? [] : [middleware]);

  return labels
    .map((label) => String(label ?? ``).trim())
    .filter(Boolean);
}

function normalizeTransportList(transport) {
  const normalized = normalizeStringArray(transport);
  return normalized ?? Object.freeze([`websocket`]);
}

function normalizeStringArray(value) {
  if (value == null) return null;
  const list = Array.isArray(value) ? value : [value];
  const normalized = list
    .map((entry) => String(entry ?? ``).trim())
    .filter(Boolean);
  return normalized.length > 0
    ? Object.freeze([...new Set(normalized)])
    : null;
}

function normalizeOptionalString(value) {
  const normalized = String(value ?? ``).trim().toLowerCase();
  return normalized || null;
}

function freezeScalarOrArray(value) {
  if (Array.isArray(value)) return Object.freeze([...value]);
  return value ?? null;
}

function isTargetlessUpgradeRoute(routeValue) {
  if (!isPlainObject(routeValue)) return false;
  if (routeValue?.upgrade?.enabled === true) return true;
  if (Array.isArray(routeValue.transport)
    && routeValue.transport.some((entry) => String(entry ?? ``).trim().toLowerCase() === `websocket`)) {
    return true;
  }
  return Object.prototype.hasOwnProperty.call(routeValue, `authScope`)
    || Object.prototype.hasOwnProperty.call(routeValue, `wsActionsAvailable`)
    || Object.prototype.hasOwnProperty.call(routeValue, `actionsAvailable`)
    || Object.prototype.hasOwnProperty.call(routeValue, `room`);
}

function freezeFolders(folders) {
  return Object.freeze({
    projectRootFolder: folders?.projectRootFolder ?? folders?.tenantRootFolder ?? null,
    tenantRootFolder: folders?.tenantRootFolder ?? null,
    rootFolder: folders?.rootFolder ?? null,
    actionsRootFolder: folders?.actionsRootFolder ?? null,
    httpActionsRootFolder: folders?.httpActionsRootFolder ?? null,
    wsActionsRootFolder: folders?.wsActionsRootFolder ?? null,
    assetsRootFolder: folders?.assetsRootFolder ?? null,
    httpSharedActionsRootFolder: folders?.httpSharedActionsRootFolder ?? null,
    wsSharedActionsRootFolder: folders?.wsSharedActionsRootFolder ?? null,
    assetsSharedRootFolder: folders?.assetsSharedRootFolder ?? null,
    httpMiddlewaresRootFolder: folders?.httpMiddlewaresRootFolder ?? null,
    wsMiddlewaresRootFolder: folders?.wsMiddlewaresRootFolder ?? null,
    routesRootFolder: folders?.routesRootFolder ?? null,
    httpRoutesRootFolder: folders?.httpRoutesRootFolder ?? null,
    wsRoutesRootFolder: folders?.wsRoutesRootFolder ?? null
  });
}

function normalizeResourceIdentifier(resource) {
  const normalized = String(resource ?? ``).trim().replaceAll(`\\`, `/`);
  if (!normalized) return null;
  return normalized
    .replace(/^actions\//, ``)
    .replace(/\.js$/i, ``)
    .replace(/^\/+/, ``)
    .replace(/\/+/g, `/`)
    .trim() || null;
}

function normalizeActionIdentifier(action) {
  const normalized = String(action ?? ``).trim();
  return normalized || null;
}

function normalizeContentType(contentType) {
  return String(contentType ?? ``)
    .split(`;`)[0]
    .trim()
    .toLowerCase();
}

module.exports = ProjectRouteMeta;
Object.freeze(module.exports);
