'use strict';

const DEFAULT_RUNTIME_NETWORK_CONFIG = Object.freeze({
  defaultWanBlock: true,
  wanOpenApps: Object.freeze([]),
  openLocalPorts: Object.freeze([])
});

function normalizeRuntimeNetworkConfig(config = {}) {
  const networkConfig = config?.runtime?.network ?? {};
  if (!networkConfig || typeof networkConfig !== `object` || Array.isArray(networkConfig)) {
    throw new Error(`runtime.network must be an object`);
  }

  const defaultWanBlock = networkConfig.defaultWanBlock ?? DEFAULT_RUNTIME_NETWORK_CONFIG.defaultWanBlock;
  if (typeof defaultWanBlock !== `boolean`) {
    throw new Error(`runtime.network.defaultWanBlock must be a boolean`);
  }

  return Object.freeze({
    defaultWanBlock,
    wanOpenApps: normalizeWanOpenApps(networkConfig.wanOpenApps ?? DEFAULT_RUNTIME_NETWORK_CONFIG.wanOpenApps),
    openLocalPorts: normalizeOpenLocalPorts(networkConfig.openLocalPorts ?? DEFAULT_RUNTIME_NETWORK_CONFIG.openLocalPorts)
  });
}

function normalizeOpenLocalPorts(openLocalPorts) {
  if (!Array.isArray(openLocalPorts)) {
    throw new Error(`runtime.network.openLocalPorts must be an array`);
  }

  const ports = openLocalPorts.map((value) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`runtime.network.openLocalPorts entries must be integers between 1 and 65535`);
    }
    return port;
  });

  return Object.freeze([...new Set(ports)].sort((left, right) => left - right));
}

function normalizeWanOpenApps(wanOpenApps) {
  if (!Array.isArray(wanOpenApps)) {
    throw new Error(`runtime.network.wanOpenApps must be an array`);
  }

  const selectors = wanOpenApps.map((value) => normalizeWanOpenAppSelector(value));
  return Object.freeze([...new Set(selectors)].sort());
}

function normalizeWanOpenAppSelector(value) {
  if (typeof value !== `string`) {
    throw new Error(`runtime.network.wanOpenApps entries must be strings in appName@tenantDomain format`);
  }

  const selector = value.trim();
  const separatorIndex = selector.indexOf(`@`);
  if (
    separatorIndex <= 0
    || separatorIndex !== selector.lastIndexOf(`@`)
    || separatorIndex === selector.length - 1
  ) {
    throw new Error(`runtime.network.wanOpenApps entries must use appName@tenantDomain format`);
  }

  const appName = selector.slice(0, separatorIndex).trim();
  const tenantDomain = selector.slice(separatorIndex + 1).trim().toLowerCase();
  if (!appName || !tenantDomain || /\s/.test(appName) || /\s/.test(tenantDomain) || !tenantDomain.includes(`.`)) {
    throw new Error(`runtime.network.wanOpenApps entries must use appName@tenantDomain format`);
  }

  return `${appName}@${tenantDomain}`;
}

function isWanOpenApp(networkConfig, appSelector) {
  if (!appSelector) return false;
  const normalizedSelector = normalizeRuntimeAppSelector(appSelector);
  return networkConfig.wanOpenApps.includes(normalizedSelector);
}

function normalizeRuntimeAppSelector(value) {
  if (typeof value !== `string`) return ``;
  const selector = value.trim();
  const separatorIndex = selector.indexOf(`@`);
  if (
    separatorIndex <= 0
    || separatorIndex !== selector.lastIndexOf(`@`)
    || separatorIndex === selector.length - 1
  ) {
    return selector;
  }

  return `${selector.slice(0, separatorIndex).trim()}@${selector.slice(separatorIndex + 1).trim().toLowerCase()}`;
}

module.exports = {
  DEFAULT_RUNTIME_NETWORK_CONFIG,
  isWanOpenApp,
  normalizeOpenLocalPorts,
  normalizeRuntimeNetworkConfig,
  normalizeRuntimeAppSelector,
  normalizeWanOpenApps,
  normalizeWanOpenAppSelector
};

Object.freeze(module.exports);
