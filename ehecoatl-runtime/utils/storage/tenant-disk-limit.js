// utils/storage/tenant-disk-limit.js


'use strict';

const path = require(`node:path`);
const parseBytes = require(`@/utils/parse-bytes`);

const DEFAULT_TRACKED_PATHS = Object.freeze([`.ehecoatl/.cache`, `.ehecoatl/log`, `.ehecoatl/.spool`]);

async function enforceTenantDiskLimit({
  storage,
  projectRoute,
  middlewareStackRuntimeConfig,
  pendingWriteBytes = 0,
  contextLabel = `tenant_disk_limit`
}) {
  const policy = resolveDiskLimitPolicy({ projectRoute, middlewareStackRuntimeConfig });
  if (!policy.enabled) {
    return {
      allowed: true,
      enforced: false,
      reason: `disabled`
    };
  }

  const usageBefore = await collectTrackedUsage({
    storage,
    rootFolder: resolveRouteRootFolder(projectRoute),
    trackedPaths: policy.trackedPaths
  });
  const projectedBytes = usageBefore.totalBytes + pendingWriteBytes;
  if (projectedBytes <= policy.maxBytes) {
    return {
      allowed: true,
      enforced: true,
      reason: `within_limit`,
      usageBeforeBytes: usageBefore.totalBytes,
      usageAfterBytes: usageBefore.totalBytes,
      maxBytes: policy.maxBytes,
      cleanedBytes: 0
    };
  }

  let cleanedBytes = 0;
  if (policy.cleanupFirst) {
    const targetBytes = Math.max(0, Math.floor(policy.maxBytes * policy.cleanupTargetRatio));
    const bytesNeeded = Math.max(0, projectedBytes - targetBytes);
    if (bytesNeeded > 0) {
      cleanedBytes = await cleanupOldestTrackedFiles({
        storage,
        files: usageBefore.files,
        bytesNeeded
      });
    }
  }

  const usageAfter = await collectTrackedUsage({
    storage,
    rootFolder: resolveRouteRootFolder(projectRoute),
    trackedPaths: policy.trackedPaths
  });
  const projectedAfterBytes = usageAfter.totalBytes + pendingWriteBytes;
  const allowed = projectedAfterBytes <= policy.maxBytes;

  if (!allowed) {
    console.warn(
      `[${contextLabel}] tenant hostname=${projectRoute.origin.hostname} root=${projectRoute.folders.rootFolder} blocked ` +
      `usageBeforeBytes=${usageBefore.totalBytes} usageAfterBytes=${usageAfter.totalBytes} ` +
      `pendingWriteBytes=${pendingWriteBytes} maxBytes=${policy.maxBytes} cleanedBytes=${cleanedBytes}`
    );
  }

  return {
    allowed,
    enforced: true,
    reason: allowed ? `cleanup_recovered` : `limit_exceeded`,
    usageBeforeBytes: usageBefore.totalBytes,
    usageAfterBytes: usageAfter.totalBytes,
    maxBytes: policy.maxBytes,
    cleanedBytes
  };
}

function resolveDiskLimitPolicy({
  projectRoute,
  middlewareStackRuntimeConfig
}) {
  const globalConfig = middlewareStackRuntimeConfig?.diskLimit ?? {};
  const tenantConfig = projectRoute?.diskLimit ?? {};

  const globalEnabled = globalConfig.enabled === true;
  const tenantEnabled = tenantConfig.enabled;
  const enabled = tenantEnabled === false
    ? false
    : (tenantEnabled === true || globalEnabled);
  if (!enabled) {
    return {
      enabled: false,
      maxBytes: null,
      trackedPaths: [...DEFAULT_TRACKED_PATHS],
      cleanupFirst: false,
      cleanupTargetRatio: 1
    };
  }

  const resolvedMaxBytes = normalizeBytes(
    tenantConfig.maxBytes
      ?? projectRoute?.diskLimitBytes
      ?? globalConfig.defaultMaxBytes
      ?? globalConfig.maxBytes
  );

  const trackedPaths = normalizeTrackedPaths(
    tenantConfig.trackedPaths
      ?? globalConfig.trackedPaths
      ?? DEFAULT_TRACKED_PATHS
  );

  return {
    enabled: Number.isFinite(resolvedMaxBytes) && resolvedMaxBytes > 0,
    maxBytes: resolvedMaxBytes,
    trackedPaths,
    cleanupFirst: tenantConfig.cleanupFirst ?? globalConfig.cleanupFirst ?? true,
    cleanupTargetRatio: normalizeCleanupRatio(
      tenantConfig.cleanupTargetRatio
      ?? globalConfig.cleanupTargetRatio
      ?? 0.9
    )
  };
}

async function collectTrackedUsage({
  storage,
  rootFolder,
  trackedPaths
}) {
  const files = [];
  if (!rootFolder) {
    return {
      totalBytes: 0,
      files
    };
  }

  for (const trackedPath of trackedPaths) {
    const absolutePath = path.join(rootFolder, trackedPath);
    const exists = await pathExists(storage, absolutePath);
    if (!exists) continue;
    const nestedFiles = await collectFilesRecursively(storage, absolutePath);
    files.push(...nestedFiles);
  }

  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return {
    totalBytes,
    files
  };
}

function resolveRouteRootFolder(projectRoute) {
  return projectRoute?.folders?.rootFolder
    ?? projectRoute?.rootFolder
    ?? null;
}

async function collectFilesRecursively(storage, directoryPath) {
  const files = [];
  const stack = [directoryPath];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    const entries = await storage.listEntries(currentPath) ?? [];
    for (const entry of entries) {
      if (entry?.isDirectory?.()) {
        stack.push(path.join(currentPath, entry.name));
        continue;
      }
      if (!entry?.isFile?.()) continue;
      const filePath = path.join(currentPath, entry.name);
      const stats = await storage.fileStat(filePath).catch(() => null);
      const sizeBytes = Number(stats?.size ?? 0);
      const mtimeMs = Number(stats?.mtimeMs ?? 0);
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) continue;
      files.push({
        path: filePath,
        sizeBytes,
        mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0
      });
    }
  }

  return files;
}

async function cleanupOldestTrackedFiles({
  storage,
  files,
  bytesNeeded
}) {
  if (!Array.isArray(files) || files.length === 0) return 0;
  let cleanedBytes = 0;
  const ordered = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const file of ordered) {
    if (cleanedBytes >= bytesNeeded) break;
    const deleted = await storage.deleteFile(file.path).catch(() => false);
    if (!deleted) continue;
    cleanedBytes += file.sizeBytes;
  }

  return cleanedBytes;
}

async function pathExists(storage, targetPath) {
  if (typeof storage?.fileExists !== `function`) return false;
  try {
    return await storage.fileExists(targetPath);
  } catch {
    return false;
  }
}

function normalizeBytes(value) {
  if (typeof value === `number` && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === `string`) {
    try {
      return parseBytes(value);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeTrackedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return [...DEFAULT_TRACKED_PATHS];
  return [...new Set(
    paths
      .map((entry) => String(entry ?? ``).trim())
      .filter((entry) => entry.length > 0 && !entry.startsWith(`/`) && !entry.includes(`..`))
  )];
}

function normalizeCleanupRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.9;
  if (numeric <= 0) return 0.1;
  if (numeric >= 1) return 1;
  return numeric;
}

module.exports = Object.freeze({
  enforceTenantDiskLimit,
  resolveDiskLimitPolicy
});
