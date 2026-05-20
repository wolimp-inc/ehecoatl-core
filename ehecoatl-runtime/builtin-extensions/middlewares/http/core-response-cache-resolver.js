'use strict';

const path = require(`path`);
const { pipeline } = require(`node:stream/promises`);
const { runAsyncCacheTask } = require(`@/utils/cache/cache-async`);
const {
  normalizeRouteCachePolicy,
  clampRouteCacheTtl
} = require(`@/utils/http/route-cache-policy`);
const { enforceTenantDiskLimit } = require(`@/utils/storage/tenant-disk-limit`);
const { createResponseCacheInternalRedirect } = require(`./_static-stream-support`);

module.exports = async function runMiddleware(middlewareContext, next) {
  const forward = createFlowController(next);
  const { projectRoute, services, requestData } = middlewareContext;
  const { cache } = services;
  const requestUrl = String(requestData?.url ?? ``);
  const requestId = middlewareContext.meta?.requestId ?? null;
  const traceMeta = {
    requestId,
    url: requestUrl || null,
    route: projectRoute?.pointsTo ?? null
  };

  if (projectRoute.isStaticAsset()) {
    return forward.continue();
  }
  if (!isExplicitCacheRoute(projectRoute)) {
    return forward.continue();
  }

  const cacheKey = `validResponseCache:${requestUrl}`;
  const cachePath = await cache.get(cacheKey, null);
  if (cachePath) {
    logCacheTrace(`hit`, {
      ...traceMeta,
      cacheKey,
      cachePath
    });
    const internalRedirect = await createResponseCacheInternalRedirect(middlewareContext, cachePath);
    if (internalRedirect) {
      middlewareContext.setBody(internalRedirect);
      if (middlewareContext.meta) {
        middlewareContext.meta.cached = true;
      }
      return forward.break();
    }
    logCacheTrace(`stale-hit`, {
      ...traceMeta,
      cacheKey,
      cachePath
    });
    if (typeof cache.delete === `function`) {
      await cache.delete(cacheKey);
    }
    return forward.continue();
  }

  logCacheTrace(`miss`, {
    ...traceMeta,
    cacheKey
  });

  const queueLabel = cacheKey;
  const maxConcurrent = 1;
  const waitTimeoutMs = 10000;
  const task = await askDirector(middlewareContext, `queue`, {
    queueLabel,
    maxConcurrent,
    waitTimeoutMs
  });
  logCacheTrace(`queue-result`, {
    ...traceMeta,
    cacheKey,
    queueLabel,
    waitTimeoutMs,
    task: summarizeTask(task)
  });
  if (task?.success === false) {
    return forward.continue();
  }
  if (task && !task.first) {
    logCacheTrace(`queue-wait-finished`, {
      ...traceMeta,
      cacheKey,
      queueLabel,
      task: summarizeTask(task)
    });
    await askDirector(middlewareContext, `dequeue`, {
      queueLabel,
      taskId: task.taskId
    });
    return module.exports(middlewareContext, next);
  }

  const continueResult = await forward.continue();
  const materializationResult = await materializeResponseCache(middlewareContext);
  if (task?.taskId) {
    if (materializationResult?.releaseQueueInline) {
      await releaseQueueTask(middlewareContext, {
        traceMeta,
        queueLabel,
        taskId: task.taskId
      });
    } else {
      middlewareContext.addFinishCallback(() => {
        return releaseQueueTask(middlewareContext, {
          traceMeta,
          queueLabel,
          taskId: task.taskId
        });
      });
    }
  }
  return continueResult;
};

function createFlowController(next) {
  const hasNext = typeof next === `function`;
  return Object.freeze({
    continue: () => hasNext ? next() : true,
    break: () => hasNext ? undefined : false
  });
}

function askDirector(middlewareContext, question, data) {
  if (typeof middlewareContext?.askDirector === `function`) {
    return middlewareContext.askDirector(question, data);
  }
  if (typeof middlewareContext?.askManager === `function`) {
    return middlewareContext.askManager(question, data);
  }
  throw new Error(`middleware-context requires askDirector for cache queue coordination`);
}

function resolveRouteCachePolicy(projectRoute) {
  return normalizeRouteCachePolicy(projectRoute?.cache);
}

async function materializeResponseCache(middlewareContext) {
  const requestUrl = String(middlewareContext.requestData?.url ?? ``);
  const requestId = middlewareContext.meta?.requestId ?? null;
  const traceMeta = {
    requestId,
    url: requestUrl || null,
    route: middlewareContext.projectRoute?.pointsTo ?? null
  };
  if (!isCacheableRoute(middlewareContext)) {
    logCacheTrace(`materialize-skip`, {
      ...traceMeta,
      reason: `not-cacheable`
    });
    return;
  }

  const cacheArtifactPath = resolveCacheArtifactPath(middlewareContext);
  if (!cacheArtifactPath) {
    logCacheTrace(`materialize-skip`, {
      ...traceMeta,
      reason: `no-cache-artifact-path`
    });
    return;
  }

  const responseBody = middlewareContext.getBody();
  const body = isReadableStreamBody(responseBody)
    ? responseBody
    : serializeCacheBody(responseBody);
  if (body == null) {
    logCacheTrace(`materialize-skip`, {
      ...traceMeta,
      reason: `empty-body`
    });
    return;
  }
  const pendingWriteBytes = resolveBodyBytes(body, middlewareContext.getHeaders());

  const diskLimitResult = await enforceTenantDiskLimit({
    storage: middlewareContext.services.storage,
    projectRoute: middlewareContext.projectRoute,
    middlewareStackRuntimeConfig: middlewareContext.middlewareStackRuntimeConfig,
    pendingWriteBytes,
    contextLabel: `response_cache_disk_limit`
  });
  if (!diskLimitResult.allowed) {
    logCacheTrace(`materialize-skip`, {
      ...traceMeta,
      reason: `disk-limit-blocked`,
      pendingWriteBytes
    });
    return;
  }

  const asyncTimeoutMs = Number(
    middlewareContext.middlewareStackRuntimeConfig?.responseCacheAsyncTimeoutMs
      ?? 1500
  );
  const cachePolicy = resolveRouteCachePolicy(middlewareContext.projectRoute);
  const cacheTtl = clampRouteCacheTtl(
    cachePolicy,
    middlewareContext.middlewareStackRuntimeConfig?.maxResponseCacheTTL
  );
  if (isReadableStreamBody(body)) {
    return await materializeStreamResponseCache(middlewareContext, {
      traceMeta,
      cacheArtifactPath,
      cacheTtl,
      pendingWriteBytes
    });
  }
  logCacheTrace(`materialize-start`, {
    ...traceMeta,
    cacheArtifactPath,
    cacheTtl: cacheTtl ?? null,
    pendingWriteBytes,
    asyncTimeoutMs
  });
  runAsyncCacheTask({
    channel: `response_cache`,
    operation: `materialize`,
    timeoutMs: asyncTimeoutMs,
    details: { url: middlewareContext.requestData?.url ?? null, cacheArtifactPath },
    execute: async () => {
      await middlewareContext.services.storage.createFolder(path.dirname(cacheArtifactPath));
      await middlewareContext.services.storage.writeFile(cacheArtifactPath, body);
      await middlewareContext.services.cache.set(
        `validResponseCache:${middlewareContext.requestData.url}`,
        cacheArtifactPath,
        cacheTtl
      );
      logCacheTrace(`materialize-done`, {
        ...traceMeta,
        cacheArtifactPath,
        cacheTtl: cacheTtl ?? null,
        pendingWriteBytes
      });
    }
  });
  return { releaseQueueInline: false };
}

function isCacheableRoute(middlewareContext) {
  const { projectRoute, requestData } = middlewareContext;
  const cachePolicy = resolveRouteCachePolicy(projectRoute);
  if (!projectRoute?.target?.run?.action) return false;
  if (cachePolicy.internalTtlMs == null) return false;
  if (projectRoute.session) return false;
  if ([`GET`, `HEAD`].includes(requestData?.method ?? `GET`) === false) return false;
  if (middlewareContext.getStatus() && middlewareContext.getStatus() !== 200) return false;
  if (middlewareContext.getCookies()) return false;

  const body = middlewareContext.getBody();
  if (body == null) return false;
  return true;
}

function serializeCacheBody(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === `string`) return body;
  if (body && typeof body === `object`) return JSON.stringify(body);
  if (body == null) return null;
  return String(body);
}

function resolveCacheArtifactPath(middlewareContext) {
  const { projectRoute, requestData } = middlewareContext;
  const basePath = projectRoute.getCacheFilePath(requestData.url);
  if (!basePath) return null;

  const headerContentType = findHeader(middlewareContext.getHeaders(), `content-type`);
  const extension = resolveExtension(headerContentType, middlewareContext.getBody());
  return `${basePath}${extension}`;
}

function findHeader(headers = {}, key) {
  const expected = String(key).toLowerCase();
  const entry = Object.entries(headers).find(([headerName]) => headerName.toLowerCase() === expected);
  return entry?.[1] ?? null;
}

function resolveExtension(contentType, body) {
  if (typeof contentType === `string`) {
    const normalized = contentType.toLowerCase();
    if (normalized.includes(`application/json`)) return `.json`;
    if (normalized.includes(`text/html`)) return `.html`;
    if (normalized.includes(`text/plain`)) return `.txt`;
    if (normalized.includes(`text/css`)) return `.css`;
    if (normalized.includes(`javascript`)) return `.js`;
    if (normalized.includes(`image/svg+xml`)) return `.svg`;
  }

  if (body && typeof body === `object` && !Buffer.isBuffer(body)) return `.json`;
  return `.txt`;
}

function resolveBodyBytes(body, headers = {}) {
  if (isReadableStreamBody(body)) {
    const contentLength = findHeader(headers, `content-length`);
    const normalizedLength = Number(contentLength);
    if (Number.isFinite(normalizedLength) && normalizedLength >= 0) {
      return normalizedLength;
    }
    return 0;
  }
  if (Buffer.isBuffer(body)) return body.byteLength;
  return Buffer.byteLength(String(body));
}

function isExplicitCacheRoute(projectRoute) {
  return resolveRouteCachePolicy(projectRoute).internalTtlMs != null;
}

async function releaseQueueTask(middlewareContext, {
  traceMeta,
  queueLabel,
  taskId
}) {
  try {
    const result = await askDirector(middlewareContext, `dequeue`, {
      queueLabel,
      taskId
    });
    logCacheTrace(`dequeue-result`, {
      ...traceMeta,
      queueLabel,
      taskId,
      result
    });
    return result;
  } catch (error) {
    logCacheTrace(`dequeue-error`, {
      ...traceMeta,
      queueLabel,
      taskId,
      error: error?.message ?? String(error)
    });
    throw error;
  }
}

function summarizeTask(task) {
  if (!task || typeof task !== `object`) return task ?? null;
  return {
    success: task.success ?? null,
    first: task.first ?? null,
    taskId: task.taskId ?? null,
    reason: task.reason ?? null,
    queueLabel: task.queueLabel ?? null
  };
}

function logCacheTrace(event, details = {}) {
  console.log(`[response-cache] ${event} ${JSON.stringify(details)}`);
}

async function materializeStreamResponseCache(middlewareContext, {
  traceMeta,
  cacheArtifactPath,
  cacheTtl,
  pendingWriteBytes
}) {
  const body = middlewareContext.getBody();
  logCacheTrace(`materialize-start`, {
    ...traceMeta,
    cacheArtifactPath,
    cacheTtl: cacheTtl ?? null,
    pendingWriteBytes,
    mode: `stream`
  });

  await middlewareContext.services.storage.createFolder(path.dirname(cacheArtifactPath));
  const writeStream = await middlewareContext.services.storage.writeStream(cacheArtifactPath);

  try {
    await pipeline(body, writeStream);
    await middlewareContext.services.cache.set(
      `validResponseCache:${middlewareContext.requestData.url}`,
      cacheArtifactPath,
      cacheTtl
    );
  } catch (error) {
    await middlewareContext.services.storage.deleteFile?.(cacheArtifactPath).catch(() => false);
    logCacheTrace(`materialize-error`, {
      ...traceMeta,
      cacheArtifactPath,
      mode: `stream`,
      error: error?.message ?? String(error)
    });
    throw error;
  }

  const replacementBody = await createResponseCacheInternalRedirect(middlewareContext, cacheArtifactPath)
    ?? createStorageStreamBody(cacheArtifactPath);
  middlewareContext.setBody(replacementBody);

  logCacheTrace(`materialize-done`, {
    ...traceMeta,
    cacheArtifactPath,
    cacheTtl: cacheTtl ?? null,
    pendingWriteBytes,
    mode: `stream`
  });
  return { releaseQueueInline: true };
}

function isReadableStreamBody(body) {
  return Boolean(body && typeof body.pipe === `function`);
}

function createStorageStreamBody(filePath) {
  return Object.freeze({
    __ehecoatlBodyKind: `storage-stream`,
    path: filePath
  });
}
