'use strict';

const path = require(`node:path`);
const normalizeI18nSourceEntry = require(`@/utils/i18n/normalize-i18n-source-entry`);

function resolveRenderableContentType(assetPath) {
  const normalizedPath = String(assetPath ?? ``).trim().toLowerCase();
  if (normalizedPath.endsWith(`.e.htm`) || normalizedPath.endsWith(`.e.html`)) {
    return `text/html; charset=utf-8`;
  }
  if (normalizedPath.endsWith(`.e.txt`)) {
    return `text/plain; charset=utf-8`;
  }
  return null;
}

function resolveI18nSourcePaths(rootFolder, entries = [], {
  entryLabel = `Route i18n`
} = {}) {
  const normalizedRoot = normalizeRootFolder(rootFolder, entryLabel);
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  if (!normalizedRoot || normalizedEntries.length === 0) {
    return [];
  }

  return normalizedEntries.map((relativePath) => (
    resolveRelativePathWithinRoot(normalizedRoot, normalizeI18nSourceEntry(relativePath, {
      entryLabel
    }), {
      entryLabel
    })
  ));
}

async function resolveActionRenderTemplatePath({
  projectRoute,
  storage,
  template
}) {
  const primaryRootFolder = normalizeRootFolder(
    projectRoute?.folders?.assetsRootFolder ?? null,
    `render.template assets root`
  );
  const fallbackRootFolder = normalizeRootFolder(
    projectRoute?.folders?.assetsSharedRootFolder ?? null,
    `render.template shared assets root`
  );
  const primaryPath = resolveRelativePathWithinRoot(primaryRootFolder, template, {
    entryLabel: `render.template`
  });
  const fallbackPath = fallbackRootFolder
    ? resolveRelativePathWithinRoot(fallbackRootFolder, template, {
      entryLabel: `render.template`
    })
    : null;

  if (await fileExists(storage, primaryPath)) {
    return Object.freeze({
      scope: `app`,
      path: primaryPath,
      primaryPath,
      fallbackPath
    });
  }

  if (fallbackPath && await fileExists(storage, fallbackPath)) {
    return Object.freeze({
      scope: `shared`,
      path: fallbackPath,
      primaryPath,
      fallbackPath
    });
  }

  return Object.freeze({
    scope: `app`,
    path: primaryPath,
    primaryPath,
    fallbackPath
  });
}

function resolveRelativePathWithinRoot(rootFolder, relativePath, {
  entryLabel = `path`
} = {}) {
  const normalizedRoot = normalizeRootFolder(rootFolder, entryLabel);
  const normalizedRelativePath = String(relativePath ?? ``).trim();
  if (!normalizedRelativePath || path.isAbsolute(normalizedRelativePath)) {
    throw new Error(`${entryLabel} must be a non-empty relative path`);
  }

  const resolvedPath = path.resolve(normalizedRoot, normalizedRelativePath);
  if (
    resolvedPath !== normalizedRoot &&
    !resolvedPath.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    throw new Error(`${entryLabel} escapes root: ${normalizedRelativePath}`);
  }

  return resolvedPath;
}

function normalizeRootFolder(rootFolder, entryLabel) {
  const normalizedRoot = String(rootFolder ?? ``).trim();
  if (!normalizedRoot) {
    throw new Error(`${entryLabel} root folder is required`);
  }
  return path.resolve(normalizedRoot);
}

async function fileExists(storage, targetPath) {
  if (!targetPath) return false;
  return await storage?.fileExists?.(targetPath).catch(() => false) ?? false;
}

module.exports = Object.freeze({
  resolveRenderableContentType,
  resolveI18nSourcePaths,
  resolveActionRenderTemplatePath
});
