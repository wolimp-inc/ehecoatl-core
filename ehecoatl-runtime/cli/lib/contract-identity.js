'use strict';

const path = require(`node:path`);

const {
  getLayerContract,
  renderLayerPathEntry,
  getRenderedProcessIdentity,
  renderTemplate
} = require(path.join(__dirname, `..`, `..`, `contracts`, `utils.js`));

function buildVariables({
  tenantId = null,
  appId = null,
  tenantDomain = null,
  appName = null,
  installId = null
} = {}) {
  return Object.freeze({
    tenant_id: tenantId ?? null,
    app_id: appId ?? null,
    tenant_domain: tenantDomain ?? null,
    app_name: appName ?? null,
    install_id: installId ?? null
  });
}

function renderOptionalTemplate(value, variables = {}) {
  if (value == null) return null;
  if (typeof value !== `string`) return value;
  return value.includes(`{`) ? renderTemplate(value, variables) : value;
}

function getRenderedPathDefaults(layerKey, variables = {}) {
  const layer = getLayerContract(layerKey);
  if (!layer) return null;

  const defaults = layer.PATH_DEFAULTS ?? {};
  return Object.freeze({
    owner: renderOptionalTemplate(defaults.owner ?? null, variables),
    group: renderOptionalTemplate(defaults.group ?? null, variables),
    mode: defaults.mode ?? null,
    recursive: defaults.recursive ?? null
  });
}

function getRenderedShellIdentity(layerKey, variables = {}) {
  const layer = getLayerContract(layerKey);
  if (!layer) return null;

  const identity = layer?.ACTORS?.SHELL?.identity ?? null;
  if (!identity) return null;

  return Object.freeze({
    user: renderOptionalTemplate(identity.user ?? null, variables),
    group: renderOptionalTemplate(identity.group ?? null, variables)
  });
}

function getRenderedTenantFilesystemIdentity(tenantId, tenantDomain = null) {
  return getRenderedPathDefaults(`projectScope`, buildVariables({ tenantId, tenantDomain }));
}

function getRenderedLegacyTenantFilesystemIdentity(tenantId, tenantDomain = null) {
  return getRenderedPathDefaults(`tenantScope`, buildVariables({ tenantId, tenantDomain }));
}

function getRenderedAppFilesystemIdentity(tenantId, appId, tenantDomain = null, appName = null) {
  return getRenderedPathDefaults(`appScope`, buildVariables({ tenantId, appId, tenantDomain, appName }));
}

function getRenderedScopeShellIdentity(layerKey, {
  tenantId = null,
  appId = null,
  tenantDomain = null,
  appName = null,
  installId = null
} = {}) {
  return getRenderedShellIdentity(layerKey, buildVariables({ tenantId, appId, tenantDomain, appName, installId }));
}

function getRenderedScopeProcessIdentity(layerKey, processKey, {
  tenantId = null,
  appId = null,
  tenantDomain = null,
  appName = null,
  installId = null
} = {}) {
  return getRenderedProcessIdentity(layerKey, processKey, buildVariables({ tenantId, appId, tenantDomain, appName, installId }));
}

function getRenderedScopePathEntry(layerKey, category, item, {
  tenantId = null,
  appId = null,
  tenantDomain = null,
  appName = null,
  installId = null
} = {}) {
  return renderLayerPathEntry(layerKey, category, item, buildVariables({ tenantId, appId, tenantDomain, appName, installId }));
}

module.exports = {
  buildVariables,
  getRenderedLegacyTenantFilesystemIdentity,
  getRenderedAppFilesystemIdentity,
  getRenderedPathDefaults,
  getRenderedScopePathEntry,
  getRenderedScopeProcessIdentity,
  getRenderedScopeShellIdentity,
  getRenderedShellIdentity,
  getRenderedTenantFilesystemIdentity
};

Object.freeze(module.exports);
