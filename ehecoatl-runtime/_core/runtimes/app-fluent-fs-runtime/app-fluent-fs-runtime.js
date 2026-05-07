'use strict';

const path = require(`node:path`);
const FsPathBuilder = require(`./fs-path-builder`);
const {
  resolveScopeFallbackPathSync,
  buildTargetPath,
  normalizeFolderPath,
  normalizePathPart,
  normalizeSegments
} = require(`@/utils/fs/resolve-scope-fallback-path`);

/** App-facing fluent filesystem facade with app-local first resolution and tenant-shared fallback. */
class AppFluentFsRuntime {
  storageService;
  appRootFolder;
  tenantSharedRootFolder;
  resolutionCache;
  resolutionCacheTtlMs;

  constructor(kernelContext, {
    appRootFolder = null,
    tenantSharedRootFolder = null,
    resolutionCacheTtlMs = 30_000
  } = {}) {
    this.storageService = kernelContext?.useCases?.storageService ?? null;
    this.appRootFolder = normalizeFolderPath(appRootFolder);
    this.tenantSharedRootFolder = normalizeFolderPath(tenantSharedRootFolder);
    this.resolutionCache = new Map();
    this.resolutionCacheTtlMs = Number.isFinite(resolutionCacheTtlMs) && resolutionCacheTtlMs > 0
      ? resolutionCacheTtlMs
      : 30_000;

    Object.freeze(this);
    return createRuntimeProxy(this);
  }

  getRootBuilder(rootName) {
    const rootDescriptor = ROOT_DESCRIPTORS[rootName] ?? null;
    if (!rootDescriptor) return null;

    return FsPathBuilder.create(
      this,
      rootName,
      buildScopedRoot(this.appRootFolder, rootDescriptor.primarySegment),
      buildScopedRoot(this.tenantSharedRootFolder, rootDescriptor.fallbackSegment)
    );
  }

  resolveTarget({
    rootName,
    primaryRootFolder,
    fallbackRootFolder = null,
    segments = [],
    filename = ``
  } = {}) {
    const normalizedSegments = normalizeSegments(segments);
    const normalizedFilename = normalizePathPart(filename);
    const lookupKey = buildLookupKey({
      rootName,
      segments: normalizedSegments,
      filename: normalizedFilename
    });
    const now = Date.now();
    const cachedEntry = this.resolutionCache.get(lookupKey) ?? null;

    if (cachedEntry && cachedEntry.expiresAt > now) {
      return cachedEntry;
    }

    const resolvedTarget = resolveScopeFallbackPathSync({
      primaryRootFolder,
      fallbackRootFolder,
      segments: normalizedSegments,
      filename: normalizedFilename,
      existsSync: (targetPath) => {
        try {
          return this.storageService?.fileExistsSync?.(targetPath) === true;
        } catch (error) {
          if (error?.code === `ENOENT`) return false;
          throw error;
        }
      }
    });

    const resolvedEntry = Object.freeze({
      lookupKey,
      scope: resolvedTarget.scope,
      path: resolvedTarget.path,
      expiresAt: now + this.resolutionCacheTtlMs
    });

    this.resolutionCache.set(lookupKey, resolvedEntry);
    return resolvedEntry;
  }

  refreshResolvedTarget({
    lookupKey,
    scope,
    path: resolvedPath
  } = {}) {
    const normalizedLookupKey = String(lookupKey ?? ``).trim();
    const normalizedScope = scope === `shared` ? `shared` : `app`;
    const normalizedPath = typeof resolvedPath === `string`
      ? resolvedPath.trim()
      : ``;

    if (!normalizedLookupKey || !normalizedPath) return null;

    const refreshedEntry = Object.freeze({
      lookupKey: normalizedLookupKey,
      scope: normalizedScope,
      path: normalizedPath,
      expiresAt: Date.now() + this.resolutionCacheTtlMs
    });

    this.resolutionCache.set(normalizedLookupKey, refreshedEntry);
    return refreshedEntry;
  }
}

module.exports = AppFluentFsRuntime;
Object.freeze(module.exports);

const ROOT_DESCRIPTORS = Object.freeze({
  app: Object.freeze({
    primarySegment: `app`,
    fallbackSegment: `app`
  }),
  storage: Object.freeze({
    primarySegment: `storage`,
    fallbackSegment: null
  }),
  assets: Object.freeze({
    primarySegment: `assets`,
    fallbackSegment: `assets`
  })
});

function createRuntimeProxy(runtime) {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (typeof property === `symbol`) {
        return Reflect.get(target, property, receiver);
      }

      const rootName = String(property ?? ``).trim();
      if (rootName && ROOT_DESCRIPTORS[rootName]) {
        return target.getRootBuilder(rootName);
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === `function`
        ? value.bind(target)
        : value;
    }
  });
}

function buildScopedRoot(baseRoot, childSegment) {
  const normalizedBaseRoot = normalizeFolderPath(baseRoot);
  const normalizedChildSegment = normalizePathPart(childSegment);

  if (!normalizedBaseRoot) return ``;
  if (!normalizedChildSegment) return normalizedBaseRoot;
  return path.join(normalizedBaseRoot, normalizedChildSegment);
}
function buildLookupKey({
  rootName,
  segments = [],
  filename = ``
} = {}) {
  return [
    normalizePathPart(rootName),
    ...normalizeSegments(segments),
    normalizePathPart(filename)
  ].filter(Boolean).join(`:`);
}
