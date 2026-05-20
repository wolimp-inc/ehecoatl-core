'use strict';

const path = require(`node:path`);

async function createStaticAssetInternalRedirect(middlewareContext, assetPath) {
  const normalizedAssetPath = String(assetPath ?? ``).trim();
  if (!normalizedAssetPath) return null;
  if (!await fileExists(middlewareContext, normalizedAssetPath)) return null;

  const assetsRoot = path.resolve(String(middlewareContext?.projectRoute?.folders?.assetsRootFolder ?? ``).trim());
  const projectRoot = path.resolve(String(
    middlewareContext?.projectRoute?.folders?.projectRootFolder
      ?? middlewareContext?.projectRoute?.folders?.tenantRootFolder
      ?? ``
  ).trim());
  if (!assetsRoot || !projectRoot) return null;

  const resolvedAssetPath = path.resolve(normalizedAssetPath);
  if (!isInsideRoot(resolvedAssetPath, assetsRoot)) {
    return null;
  }
  if (!isInsideRoot(resolvedAssetPath, projectRoot)) {
    return null;
  }

  const relativeToProject = path.relative(projectRoot, resolvedAssetPath).replaceAll(path.sep, path.posix.sep);
  return Object.freeze({
    __ehecoatlBodyKind: `nginx-internal-redirect`,
    uri: path.posix.join(`/_ehecoatl_internal/static`, relativeToProject)
  });
}

async function createResponseCacheInternalRedirect(middlewareContext, cachePath) {
  const normalizedCachePath = String(cachePath ?? ``).trim();
  if (!normalizedCachePath) return null;
  if (!await fileExists(middlewareContext, normalizedCachePath)) return null;

  const rootFolder = path.resolve(String(middlewareContext?.projectRoute?.folders?.rootFolder ?? ``).trim());
  if (!rootFolder) return null;

  const cacheRoot = path.resolve(rootFolder, `.ehecoatl`, `.cache`);
  const resolvedCachePath = path.resolve(normalizedCachePath);
  if (!isInsideRoot(resolvedCachePath, cacheRoot)) {
    return null;
  }

  const relativeToCache = path.relative(cacheRoot, resolvedCachePath).replaceAll(path.sep, path.posix.sep);
  return Object.freeze({
    __ehecoatlBodyKind: `nginx-internal-redirect`,
    uri: path.posix.join(`/_ehecoatl_internal/cache`, relativeToCache)
  });
}

async function fileExists(middlewareContext, filePath) {
  return await middlewareContext?.services?.storage?.fileExists?.(filePath).catch(() => false) ?? false;
}

function isInsideRoot(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false;
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

module.exports = Object.freeze({
  createStaticAssetInternalRedirect,
  createResponseCacheInternalRedirect
});
