// _core/runtimes/request-uri-routing-runtime/request-uri-routing-runtime.js


'use strict';

const path = require(`path`);
const AdaptableUseCase = require(`@/_core/_ports/adaptable-use-case`);

class RequestUriRoutingRuntime extends AdaptableUseCase {
  config;
  storageService;
  sharedCacheService;
  directoryResolver;
  localCache;
  invalidationPrefixes;

  constructor(kernelContext) {
    super(kernelContext.config._adapters.requestUriRoutingRuntime);
    this.config = kernelContext.config.adapters.requestUriRoutingRuntime ?? {};
    this.storageService = kernelContext.useCases.storageService;
    this.sharedCacheService = kernelContext.useCases.sharedCacheService;
    this.directoryResolver = kernelContext.useCases.projectDirectoryResolver ?? kernelContext.useCases.tenantDirectoryResolver;
    this.localCache = new Map();
    this.invalidationPrefixes = Object.freeze([
      `urlRouteData:`,
      `urlRouteMiss:`,
      `validResponseCache:`
    ]);

    Object.freeze(this);
  }

  async matchRoute({ url, tenantId = null, forcedAppId = null, routeType = null }) {
    const cacheKey = buildRouteCacheKey({ url, tenantId, forcedAppId, routeType });
    const cached = this.localCache.get(cacheKey);
    const ttl = this.config.routeMatchTTL ?? 60 * 1000;
    if (cached && Date.now() < cached.validUntil) {
      return cached.projectRoute;
    }

    const registry = this.directoryResolver.getRegistry();
    const routeMatchData = await this.adapter.matchRouteAdapter({
      url,
      tenantId,
      forcedAppId,
      routeType,
      registry,
      defaultAppName: this.config.defaultAppName ?? `www`
    });
    const cachedData = {
      projectRoute: routeMatchData,
      validUntil: Date.now() + ttl
    };
    this.localCache.set(cacheKey, cachedData);
    return routeMatchData;
  }

  handleRegistryUpdate() {
    this.localCache.clear();
  }

  async invalidateSharedCaches() {
    await Promise.all(
      this.invalidationPrefixes.map((prefix) => this.sharedCacheService.deleteByPrefix(prefix))
    );
  }

  async cleanupInvalidResponseCacheArtifacts() {
    let removed = 0;
    const registry = this.directoryResolver.getRegistry();
    const activeHosts = [...(registry?.hosts?.values?.() ?? [])];
    for (const routeDataObject of activeHosts) {
      removed += await this.#cleanupTenantResponseCacheArtifacts(routeDataObject.rootFolder);
    }
    return removed;
  }

  async destroy() {
    this.localCache.clear();
  }

  async #cleanupTenantResponseCacheArtifacts(rootFolder) {
    const cacheFolder = path.join(rootFolder, `.ehecoatl`, `.cache`);
    if (!await this.#pathExists(cacheFolder)) {
      return 0;
    }

    const entries = await this.storageService.listEntries(cacheFolder) ?? [];
    let removed = 0;

    for (const entry of entries) {
      if (!entry?.isFile?.()) continue;
      const decodedUrl = decodeResponseCacheUrlFromFileName(entry.name);
      if (!decodedUrl) continue;

      const artifactPath = path.join(cacheFolder, entry.name);
      const cacheKey = `validResponseCache:${decodedUrl}`;
      const activeArtifactPath = await this.sharedCacheService.get(cacheKey, null);
      if (activeArtifactPath === artifactPath) continue;

      const deleted = await this.storageService.deleteFile(artifactPath);
      if (deleted) {
        removed += 1;
      }
    }

    return removed;
  }

  async #pathExists(targetPath) {
    try {
      return await this.storageService.fileExists(targetPath);
    } catch {
      return false;
    }
  }
}

function decodeResponseCacheUrlFromFileName(fileName) {
  if (typeof fileName !== `string`) return null;
  if (!fileName.startsWith(`[`) || !fileName.includes(`]_`)) return null;
  const withoutExtension = fileName.replace(/\.[^.]+$/, ``);
  return withoutExtension.replace(/^\[/, ``).replace(/\]_\[/g, `/`).replace(/\]$/, ``);
}

function buildRouteCacheKey({
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

module.exports = RequestUriRoutingRuntime;
Object.freeze(module.exports);
