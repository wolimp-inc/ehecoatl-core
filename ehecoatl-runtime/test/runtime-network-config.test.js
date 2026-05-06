'use strict';

require(`module-alias/register`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);

const defaultConfig = require(`@/config/default.config`);
const {
  isWanOpenApp,
  normalizeRuntimeNetworkConfig
} = require(`@/utils/config/runtime-network-config`);

test(`default config exposes canonical runtime.network settings`, () => {
  assert.deepEqual(defaultConfig.runtime.network, {
    defaultWanBlock: true,
    wanOpenApps: [],
    openLocalPorts: [6379, 3306]
  });
  assert.equal(Object.hasOwn(defaultConfig.runtime, `openlocalports`), false);
});

test(`runtime network config validates and normalizes ports and app selectors`, () => {
  const network = normalizeRuntimeNetworkConfig({
    runtime: {
      network: {
        defaultWanBlock: true,
        wanOpenApps: [`www@Example.COM`, `www@example.com`],
        openLocalPorts: [15010, `6379`, 15010]
      }
    }
  });

  assert.deepEqual(network.openLocalPorts, [6379, 15010]);
  assert.deepEqual(network.wanOpenApps, [`www@example.com`]);
  assert.equal(isWanOpenApp(network, `www@EXAMPLE.com`), true);
});

test(`runtime network config rejects invalid values`, () => {
  assert.throws(
    () => normalizeRuntimeNetworkConfig({ runtime: { network: { defaultWanBlock: `true` } } }),
    /defaultWanBlock must be a boolean/
  );
  assert.throws(
    () => normalizeRuntimeNetworkConfig({ runtime: { network: { openLocalPorts: [0] } } }),
    /openLocalPorts entries must be integers/
  );
  assert.throws(
    () => normalizeRuntimeNetworkConfig({ runtime: { network: { wanOpenApps: [`www.example.com`] } } }),
    /wanOpenApps entries must use appName@tenantDomain format/
  );
});
