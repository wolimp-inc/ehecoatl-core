// _core/runtimes/ingress-runtime/director-runtime-resolver.js


'use strict';


const IngressRuntime = require(`@/_core/runtimes/ingress-runtime`);
const ProjectRoute = require(`@/_core/runtimes/ingress-runtime/execution/project-route`);
const { runAsyncCacheTask } = require(`@/utils/cache/cache-async`);

/** Transport-side RPC resolver that bridges request execution with director-process services. */
class DirectorRuntimeResolver {

  question;
  cache;
  rpc;
  plugin;
  routeCacheTTL;
  routeMissTTL;
  scanActiveCacheKey;
  asyncCacheTimeoutMs;
  transportTenantId;

  /**
   * Captures transport-side service references used to talk to the director process.
   * @param {IngressRuntime} ingressRuntime
   */
  constructor(ingressRuntime) {
    const projectDirectoryResolverConfig = ingressRuntime.projectDirectoryResolverConfig
      ?? ingressRuntime.tenantDirectoryResolverConfig
      ?? {};
    const requestUriRoutingRuntimeConfig = ingressRuntime.requestUriRoutingRuntimeConfig
      ?? {};
    this.question = ingressRuntime.config.question;
    this.cache = ingressRuntime.services.cache;
    this.rpc = ingressRuntime.services.rpc;
    this.plugin = ingressRuntime.plugin;
    this.routeCacheTTL = ingressRuntime.routeCacheTTL ?? null;
    this.routeMissTTL = requestUriRoutingRuntimeConfig.routeMissTTL
      ?? ingressRuntime.config?.routeMissTTL
      ?? 5000;
    this.scanActiveCacheKey = projectDirectoryResolverConfig.scanActiveCacheKey ?? null;
    this.asyncCacheTimeoutMs = requestUriRoutingRuntimeConfig.asyncCacheTimeoutMs ?? 500;
    this.transportTenantId = process.argv[2] ?? null;

    Object.freeze(this);
  }

  /** Sends a generic RPC question to the director process. */
  async ask(question, data, executionContext = null) {
    return await this.rpc.ask({
      question,
      data,
      internalMeta: buildRequestInternalMeta(executionContext),
      target: `director`
    });
  }

  /**
   * This method resolves url tenancy for further
   * treatment and handle
   */
  /** Resolves and caches the project route for the current execution context URL. */
  async resolveRoute(executionContext, {
    routeType = null
  } = {}) {
    let projectRoute = null;
    const plugin = this.plugin;
    const { hooks } = plugin;
    const { BEFORE, AFTER, ERROR } = hooks.TRANSPORT.REQUEST.GET_ROUTER;
    await plugin.run(BEFORE, executionContext, ERROR);

    const { url } = executionContext.requestData;
    const forcedAppId = executionContext?.meta?.forcedAppId ?? null;
    const tenantId = executionContext?.projectRoute?.tenantId ?? this.transportTenantId;
    const routeCacheScope = buildRouteCacheScope({ url, tenantId, forcedAppId, routeType });
    const missCacheKey = `urlRouteMiss:${routeCacheScope}`;
    const routeCacheKey = `urlRouteData:${routeCacheScope}`;
    const scanActive = await this.#isScanActive();

    if (!scanActive) {
      const cachedMiss = await this.cache.get(missCacheKey, null);
      if (cachedMiss) {
        await plugin.run(AFTER, executionContext, ERROR);
        return null;
      }

      const cachedData = await this.cache.get(routeCacheKey, null);
      if (cachedData) {
        projectRoute = JSON.parse(cachedData);
      }
    }

    if (!projectRoute) {
      // IF NOT FOUND, ask director to resolve route.
      projectRoute = await this.rpc.ask({
        question: this.question.requestUriRoutingRuntime,
        target: `director`,
        data: { url, tenantId, forcedAppId, routeType },
        internalMeta: buildRequestInternalMeta(executionContext)
      });
      if (projectRoute?.success === false && projectRoute?.error) {
        const routeResolutionError = new Error(projectRoute.error);
        routeResolutionError.code = projectRoute.code ?? `ROUTE_RESOLUTION_FAILED`;
        throw routeResolutionError;
      }
      if (!scanActive) {
        if (projectRoute) {
          this.#cacheRouteData(routeCacheKey, projectRoute);
        } else {
          this.#cacheRouteMiss(missCacheKey);
        }
      }
    }
    console.log(
      `[director-runtime-resolver.resolveRoute] url=${url ?? `null`} resolved=${projectRoute ? `yes` : `no`} hostname=${projectRoute?.origin?.hostname ?? `null`} appURL=${projectRoute?.origin?.appURL ?? `null`} target=director`
    );
    if (projectRoute) {
      projectRoute = new ProjectRoute(projectRoute);
    }
    await plugin.run(AFTER, executionContext, ERROR);
    return projectRoute;
  }

  /** Reads a shared object from cache storage by key. */
  async getObject(key, defaultValue = {}) {
    const answer = await this.rpc.ask({
      question: this.question.getSharedObject,
      target: `director`,
      data: { key }
    });
    return answer ?? defaultValue;
  }

  /** Persists a shared object into cache storage by key and TTL. */
  async setObject(key, value, ttl) {
    const answer = await this.rpc.ask({
      question: this.question.setSharedObject,
      target: `director`,
      data: { key, value, ttl }
    });
    return answer;
  }

  /** Checks the shared scan-active marker to decide if route-cache reads should be bypassed. */
  async #isScanActive() {
    if (!this.scanActiveCacheKey) return false;

    const marker = await this.cache.get(this.scanActiveCacheKey, null).catch(() => null);
    return Boolean(marker);
  }

  /** Persists one positive route-match cache entry asynchronously. */
  #cacheRouteData(cacheKey, projectRoute) {
    runAsyncCacheTask({
      channel: `route_cache`,
      operation: `set_route_data`,
      timeoutMs: this.asyncCacheTimeoutMs,
      details: { cacheKey },
      execute: async () => {
        await this.cache.set(
          cacheKey,
          JSON.stringify(projectRoute),
          this.routeCacheTTL ?? undefined
        );
      }
    });
  }

  /** Persists one negative route-match cache entry asynchronously. */
  #cacheRouteMiss(cacheKey) {
    runAsyncCacheTask({
      channel: `route_cache`,
      operation: `set_route_miss`,
      timeoutMs: this.asyncCacheTimeoutMs,
      details: { cacheKey },
      execute: async () => {
        await this.cache.set(cacheKey, `1`, this.routeMissTTL);
      }
    });
  }
}

function buildRequestInternalMeta(executionContext) {
  const requestId = executionContext?.meta?.requestId
    ?? executionContext?.requestData?.requestId
    ?? null;
  const correlationId = executionContext?.meta?.correlationId
    ?? requestId;
  if (!requestId && !correlationId) return undefined;
  return {
    requestId,
    correlationId
  };
}

function buildRouteCacheScope({
  url,
  tenantId = null,
  forcedAppId = null,
  routeType = null
}) {
  return JSON.stringify({
    url: String(url ?? ``),
    tenantId: tenantId ? String(tenantId) : null,
    forcedAppId: forcedAppId ? String(forcedAppId) : null,
    routeType: routeType ? String(routeType) : null
  });
}

module.exports = DirectorRuntimeResolver;
Object.freeze(module.exports);
