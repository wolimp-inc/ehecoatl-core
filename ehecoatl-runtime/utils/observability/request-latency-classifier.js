// utils/observability/request-latency-classifier.js


'use strict';

function classifyRequestLatency({
  durationMs,
  projectRoute,
  tenantRoute,
  meta,
  config
}) {
  const enabled = config?.enabled !== false;
  const numericDuration = Number(durationMs);
  if (!enabled || !Number.isFinite(numericDuration) || numericDuration < 0) {
    return null;
  }

  const profile = resolveProfile({ projectRoute: projectRoute ?? tenantRoute, meta });
  const thresholds = resolveThresholds(config, profile);
  const latencyClass = resolveLatencyClass(numericDuration, thresholds);

  return {
    profile,
    class: latencyClass,
    durationMs: numericDuration,
    thresholds
  };
}

function resolveProfile({ projectRoute, meta }) {
  if (projectRoute?.isStaticAsset?.()) return `staticAsset`;
  if (meta?.cached) return `cacheHit`;
  if (meta?.action) return `action`;
  return `default`;
}

function resolveThresholds(config, profile) {
  const profiles = config?.profiles ?? {};
  const profileThresholds = profiles?.[profile] ?? profiles?.default ?? {};

  return {
    fastMs: normalizeThreshold(profileThresholds.fastMs, 120),
    okMs: normalizeThreshold(profileThresholds.okMs, 350),
    slowMs: normalizeThreshold(profileThresholds.slowMs, 900)
  };
}

function normalizeThreshold(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return numeric;
}

function resolveLatencyClass(durationMs, thresholds) {
  if (durationMs <= thresholds.fastMs) return `fast`;
  if (durationMs <= thresholds.okMs) return `ok`;
  if (durationMs <= thresholds.slowMs) return `slow`;
  return `critical`;
}

module.exports = Object.freeze({
  classifyRequestLatency
});
