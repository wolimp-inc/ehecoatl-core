// utils/observability/tenant-report-writer.js


'use strict';

const fs = require(`node:fs`);
const fsPromises = require(`node:fs/promises`);
const path = require(`node:path`);
const { renderLayerPath } = require(`@/contracts/utils`);

const defaultOptions = Object.freeze({
  enabled: false,
  flushIntervalMs: 5000
});

const STATUS_CLASSES = Object.freeze([`2xx`, `3xx`, `4xx`, `5xx`, `other`]);

/**
 * Creates an async tenant-level request quality reporter with in-memory aggregation and periodic flush.
 * @param {{
 * enabled?: boolean,
 * flushIntervalMs?: number
 * }} options
 */
function createTenantReportWriter(options = {}) {
  const config = {
    ...defaultOptions,
    ...(options ?? {})
  };
  const stateByTenant = new Map();
  const writeTasks = new Map();
  let flushTimer = null;

  if (config.enabled === true) {
    const flushIntervalMs = Number(config.flushIntervalMs);
    if (Number.isFinite(flushIntervalMs) && flushIntervalMs > 0) {
      flushTimer = setInterval(() => {
        flushAll().catch(() => { });
      }, flushIntervalMs);
      flushTimer.unref?.();
    }
  }

  function observeRequest(executionContext) {
    if (config.enabled !== true) return;
    const projectRoute = executionContext?.projectRoute;
    const tenantHost = String(projectRoute?.origin?.hostname ?? ``).trim();
    const tenantRoot = String(projectRoute?.folders?.rootFolder ?? ``).trim();
    const reportPath = resolveTenantReportPath(projectRoute, tenantRoot);
    if (!tenantHost || !tenantRoot || !reportPath) return;

    const key = `${tenantHost}:${tenantRoot}`;
    const nowISO = new Date().toISOString();
    let tenantState = stateByTenant.get(key);
    if (!tenantState) {
      tenantState = createTenantState({ tenantHost, tenantRoot, reportPath, nowISO });
      stateByTenant.set(key, tenantState);
    } else {
      tenantState.reportPath = reportPath;
    }

    const statusClass = classifyStatus(executionContext?.responseData?.status);
    const latencyProfile = String(executionContext?.meta?.latencyProfile ?? `default`);
    const latencyClass = String(executionContext?.meta?.latencyClass ?? `unknown`);
    const durationMs = Number(executionContext?.meta?.duration);

    tenantState.totals.requests += 1;
    tenantState.totals.byStatusClass[statusClass] += 1;
    tenantState.latency.byProfile[latencyProfile] = (tenantState.latency.byProfile[latencyProfile] ?? 0) + 1;
    tenantState.latency.byClass[latencyClass] = (tenantState.latency.byClass[latencyClass] ?? 0) + 1;

    if (Number.isFinite(durationMs) && durationMs >= 0) {
      tenantState.latency.duration.count += 1;
      tenantState.latency.duration.totalMs += durationMs;
      tenantState.latency.duration.avgMs = Math.round((tenantState.latency.duration.totalMs / tenantState.latency.duration.count) * 1000) / 1000;
      tenantState.latency.duration.maxMs = Math.max(tenantState.latency.duration.maxMs, durationMs);
      tenantState.latency.duration.minMs = Math.min(tenantState.latency.duration.minMs, durationMs);
    }

    tenantState.lastUpdatedAt = nowISO;
    tenantState.dirty = true;
  }

  async function flushAll() {
    if (config.enabled !== true) return;
    const flushTasks = [];
    for (const [key] of stateByTenant) {
      flushTasks.push(flushTenant(key));
    }
    await Promise.all(flushTasks);
  }

  async function close() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    await flushAll().catch(() => { });
    while (writeTasks.size > 0) {
      await Promise.all([...writeTasks.values()]).catch(() => { });
    }
  }

  async function flushTenant(tenantKey) {
    const tenantState = stateByTenant.get(tenantKey);
    if (!tenantState) return;

    const runningTask = writeTasks.get(tenantKey);
    if (runningTask) {
      tenantState.flushQueued = true;
      return runningTask;
    }
    if (!tenantState.dirty) return;

    const task = (async () => {
      tenantState.dirty = false;
      const payload = buildReportPayload(tenantState);

      let writeFailed = false;
      try {
        await writeJsonAtomic(tenantState.reportPath, payload);
      } catch {
        writeFailed = true;
        tenantState.dirty = true;
      } finally {
        const flushQueued = tenantState.flushQueued;
        tenantState.flushQueued = false;
        writeTasks.delete(tenantKey);
        if (flushQueued && !writeFailed) {
          await flushTenant(tenantKey);
        }
      }
    })();

    writeTasks.set(tenantKey, task);
    return task;
  }

  return Object.freeze({
    observeRequest,
    flushAll,
    close
  });
}

function resolveTenantReportPath(projectRoute, appRootFolder) {
  const origin = projectRoute?.origin ?? {};
  const currentAppRoot = String(appRootFolder ?? ``).trim();
  const tenantId = String(origin.tenantId ?? ``).trim();
  const appId = String(origin.appId ?? ``).trim();
  const tenantDomain = String(origin.domain ?? ``).trim();
  const appName = String(origin.appName ?? ``).trim();
  if (!currentAppRoot || !tenantId || !appId || !tenantDomain || !appName) return null;

  const variables = {
    tenant_id: tenantId,
    app_id: appId,
    tenant_domain: tenantDomain,
    app_name: appName
  };
  const contractAppRoot = renderLayerPath(`appScope`, `RUNTIME`, `root`, variables);
  const contractReportPath = renderLayerPath(`appScope`, `LOGS`, `report`, variables);
  const reportRelativePath = path.relative(contractAppRoot, contractReportPath);
  if (!reportRelativePath || reportRelativePath.startsWith(`..`) || path.isAbsolute(reportRelativePath)) return null;

  return path.join(currentAppRoot, reportRelativePath);
}

function createTenantState({ tenantHost, tenantRoot, reportPath, nowISO }) {
  return {
    tenantHost,
    tenantRoot,
    reportPath,
    windowStartedAt: nowISO,
    lastUpdatedAt: nowISO,
    totals: {
      requests: 0,
      byStatusClass: STATUS_CLASSES.reduce((acc, key) => {
        acc[key] = 0;
        return acc;
      }, {})
    },
    latency: {
      byProfile: {},
      byClass: {},
      duration: {
        count: 0,
        totalMs: 0,
        avgMs: 0,
        minMs: Number.POSITIVE_INFINITY,
        maxMs: 0
      }
    },
    quality: {
      compliance: null
    },
    dirty: false,
    flushQueued: false
  };
}

function buildReportPayload(tenantState) {
  const duration = tenantState.latency.duration;
  const minMs = duration.count > 0 ? duration.minMs : 0;
  const maxMs = duration.count > 0 ? duration.maxMs : 0;

  return {
    meta: {
      version: 1
    },
    tenantHost: tenantState.tenantHost,
    windowStartedAt: tenantState.windowStartedAt,
    lastUpdatedAt: tenantState.lastUpdatedAt,
    totals: {
      requests: tenantState.totals.requests,
      byStatusClass: tenantState.totals.byStatusClass
    },
    latency: {
      byProfile: tenantState.latency.byProfile,
      byClass: tenantState.latency.byClass,
      duration: {
        count: duration.count,
        totalMs: duration.totalMs,
        avgMs: duration.avgMs,
        minMs,
        maxMs
      }
    },
    quality: tenantState.quality
  };
}

function classifyStatus(status) {
  const numeric = Number(status);
  if (!Number.isInteger(numeric) || numeric <= 0) return `other`;
  const classKey = `${Math.floor(numeric / 100)}xx`;
  if (STATUS_CLASSES.includes(classKey)) return classKey;
  return `other`;
}

async function writeJsonAtomic(targetPath, payload) {
  const targetDir = path.dirname(targetPath);
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;

  await fsPromises.mkdir(targetDir, { recursive: true });
  try {
    await fsPromises.writeFile(tempPath, serialized, `utf8`);
    await fsPromises.rename(tempPath, targetPath);
  } finally {
    if (fs.existsSync(tempPath)) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => { });
    }
  }
}

module.exports = Object.freeze({
  createTenantReportWriter
});
