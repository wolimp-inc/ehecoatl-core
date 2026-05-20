// utils/process-labels.js


'use strict';

const { getProcessLabel } = require(`../contracts/utils`);

function normalizeOpaqueId(value, fieldName) {
  const normalized = String(value ?? ``).trim().toLowerCase();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function buildTenantTransportLabel({
  tenantId
}) {
  return getProcessLabel(`projectScope`, `transport`, {
    tenant_id: normalizeOpaqueId(tenantId, `tenantId`)
  });
}

function parseTenantTransportLabel(label) {
  if (typeof label !== `string`) return null;
  const prefix = label.startsWith(`e_project_transport_`)
    ? `e_project_transport_`
    : label.startsWith(`e_transport_`)
      ? `e_transport_`
      : null;
  if (!prefix) return null;
  const tenantId = label.slice(prefix.length).trim().toLowerCase();
  if (!tenantId) return null;
  return { tenantId };
}

function buildIsolatedRuntimeLabel({
  tenantId,
  appId
}) {
  return getProcessLabel(`appScope`, `isolatedRuntime`, {
    tenant_id: normalizeOpaqueId(tenantId, `tenantId`),
    app_id: normalizeOpaqueId(appId, `appId`)
  });
}

function parseIsolatedRuntimeLabel(label) {
  if (typeof label !== `string` || !label.startsWith(`e_app_`)) return null;
  const identity = label.slice(`e_app_`.length);
  const separatorIndex = identity.indexOf(`_`);
  if (separatorIndex < 1) return null;
  const tenantId = identity.slice(0, separatorIndex).trim().toLowerCase();
  const appId = identity.slice(separatorIndex + 1).trim().toLowerCase();
  if (!tenantId || !appId) return null;
  return { tenantId, appId };
}

module.exports = {
  buildTenantTransportLabel,
  parseTenantTransportLabel,
  buildIsolatedRuntimeLabel,
  parseIsolatedRuntimeLabel
};

Object.freeze(module.exports);
