// adapters/inbound/project-route-matcher-compiler/default-routing-v1.js


'use strict';

const ProjectRouteMatcherCompilerPort = require(`@/_core/_ports/inbound/project-route-matcher-compiler-port`);
const ProjectRouteMeta = require(`@/_core/runtimes/ingress-runtime/execution/project-route-meta`);
const projectRoutesCompiler = require(`@/utils/tenancy/project-routes-compiler`);
const normalizeCanonicalRoutePath = require(`@/utils/tenancy/normalize-route-path`);

ProjectRouteMatcherCompilerPort.compileRoutesAdapter = async function compileRoutesAdapter({
  routesAvailable
}) {
  const flattenedRoutes = {};
  const flattenedRouteSources = new Map();
  flattenRoutes(
    routesAvailable,
    ``,
    ``,
    flattenedRoutes,
    flattenedRouteSources
  );
  const normalizedRoutes = Object.keys(flattenedRoutes).length > 0
    ? flattenedRoutes
    : null;

  return {
    routesAvailable: normalizedRoutes,
    compiledRoutes: normalizedRoutes ? projectRoutesCompiler(normalizedRoutes) : []
  };
};

module.exports = ProjectRouteMatcherCompilerPort;
Object.freeze(module.exports);

function flattenRoutes(
  routeMap,
  prefixPath,
  prefixSourcePath,
  flattenedRoutes,
  flattenedRouteSources,
  inheritedConfig = null
) {
  if (!isPlainObject(routeMap)) return;

  for (const [routePath, routeValue] of Object.entries(routeMap)) {
    if (!String(routePath ?? ``).startsWith(`/`)) continue;
    const fullPath = combineRoutePath(prefixPath, routePath);
    const fullSourcePath = combineSourcePath(prefixSourcePath, routePath);
    const ownConfig = extractOwnConfig(routeValue);
    const effectiveConfig = mergeRouteConfigs(ownConfig, inheritedConfig);
    const childRouteEntries = resolveChildRouteEntries(routeValue, fullSourcePath);
    const hasChildren = childRouteEntries.length > 0;

    if (!hasChildren || hasConcreteSelfRoute(routeValue)) {
      registerFlattenedRoute({
        fullPath,
        sourcePath: fullSourcePath,
        routeValue: effectiveConfig,
        flattenedRoutes,
        flattenedRouteSources
      });
    }

    if (hasChildren) {
      flattenRoutes(
        Object.fromEntries(childRouteEntries),
        fullPath,
        fullSourcePath,
        flattenedRoutes,
        flattenedRouteSources,
        effectiveConfig
      );
    }
  }
}

function combineRoutePath(prefixPath, routePath) {
  return normalizeRoutePathShared(`${String(prefixPath ?? ``).trim()}${String(routePath ?? ``).trim()}`);
}

function combineSourcePath(prefixPath, routePath) {
  const prefix = String(prefixPath ?? ``).trim();
  const route = String(routePath ?? ``).trim();
  const combined = prefix || route
    ? `${prefix}${route}`
    : route;
  return combined.replace(/\/{2,}/g, `/`) || `/`;
}

function isPlainObject(value) {
  return value != null && typeof value === `object` && !Array.isArray(value);
}

function normalizeRouteDefinition(routeValue, routePath) {
  return ProjectRouteMeta.normalizeRouteConfig(routeValue, routePath);
}

function resolveChildRouteEntries(routeValue, sourcePath) {
  if (!isPlainObject(routeValue)) return [];

  const entries = [];
  const seenCanonicalPaths = new Map();
  const explicitRoutes = isPlainObject(routeValue.routes) ? routeValue.routes : {};
  const implicitEntries = Object.entries(routeValue)
    .filter(([childKey]) => String(childKey ?? ``).startsWith(`/`));
  const explicitEntries = Object.entries(explicitRoutes)
    .filter(([childKey]) => String(childKey ?? ``).startsWith(`/`));

  for (const [childKey, childValue] of [...implicitEntries, ...explicitEntries]) {
    const normalizedChildPath = normalizeRoutePathShared(childKey);
    const previousChildSource = seenCanonicalPaths.get(normalizedChildPath) ?? null;
    const childSourcePath = combineSourcePath(sourcePath, childKey);
    if (previousChildSource) {
      throw new Error(
        `Duplicate canonical route "${combineRoutePath(sourcePath, childKey)}" declared by both "${previousChildSource}" and "${childSourcePath}"`
      );
    }

    seenCanonicalPaths.set(normalizedChildPath, childSourcePath);
    entries.push([childKey, childValue]);
  }

  return entries;
}

function extractOwnConfig(routeValue) {
  if (!isPlainObject(routeValue)) return routeValue;

  return Object.fromEntries(
    Object.entries(routeValue)
      .filter(([key]) => key !== `routes` && !String(key ?? ``).startsWith(`/`))
  );
}

function hasConcreteSelfRoute(routeValue) {
  if (!isPlainObject(routeValue)) return false;
  if (typeof routeValue.pointsTo === `string` && routeValue.pointsTo.trim()) return true;

  const target = routeValue.target;
  if (isPlainObject(target)) {
    if (typeof target.type === `string` && target.type.trim()) return true;
    if (typeof target.value === `string` && target.value.trim()) return true;
    if (typeof target.asset?.path === `string` && target.asset.path.trim()) return true;
    if (typeof target.redirect?.location === `string` && target.redirect.location.trim()) return true;
    if (isPlainObject(target.run)) return true;
  }

  return false;
}

function registerFlattenedRoute({
  fullPath,
  sourcePath,
  routeValue,
  flattenedRoutes,
  flattenedRouteSources
}) {
  const normalizedFullPath = normalizeRoutePathShared(fullPath);
  const previousSource = flattenedRouteSources.get(normalizedFullPath) ?? null;
  if (previousSource) {
    throw new Error(
      `Duplicate canonical route "${normalizedFullPath}" declared by both "${previousSource}" and "${sourcePath}"`
    );
  }

  flattenedRoutes[normalizedFullPath] = normalizeRouteDefinition(routeValue, normalizedFullPath);
  flattenedRouteSources.set(normalizedFullPath, sourcePath);
}

function mergeRouteConfigs(childConfig, parentConfig) {
  if (!isPlainObject(childConfig)) {
    return cloneValue(resolveMergedValue(childConfig, parentConfig));
  }

  const merged = {};
  const keys = new Set([
    ...Object.keys(parentConfig ?? {}),
    ...Object.keys(childConfig ?? {})
  ]);

  for (const key of keys) {
    merged[key] = cloneValue(resolveMergedValue(childConfig?.[key], parentConfig?.[key]));
  }

  return merged;
}

function resolveMergedValue(childValue, parentValue) {
  if (childValue == null) {
    return parentValue;
  }

  if (Array.isArray(childValue)) {
    const parentArray = Array.isArray(parentValue) ? parentValue : [];
    return dedupeArray([...childValue, ...parentArray]);
  }

  if (isPlainObject(childValue)) {
    const parentObject = isPlainObject(parentValue) ? parentValue : {};
    return mergeRouteConfigs(childValue, parentObject);
  }

  return childValue;
}

function dedupeArray(values) {
  const seen = new Set();
  const deduped = [];

  for (const value of values) {
    const marker = buildValueMarker(value);
    if (seen.has(marker)) continue;
    seen.add(marker);
    deduped.push(value);
  }

  return deduped;
}

function buildValueMarker(value) {
  if (value == null) return String(value);
  if (typeof value === `object`) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return `${typeof value}:${String(value)}`;
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)])
    );
  }
  return value;
}

function normalizeRoutePathShared(value) {
  return normalizeCanonicalRoutePath(value);
}
