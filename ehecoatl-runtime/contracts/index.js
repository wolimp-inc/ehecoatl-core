// ehecoatl-runtime/contracts/index.js


'use strict';


const { serviceInstallRoot, user, group } = require(`./context.js`);

const appendContracts = {
  layers: {
    internalScope: require(`./layers/internal-scope.contract.js`),
    supervisionScope: require(`./layers/supervision-scope.contract.js`),
    projectScope: require(`./layers/project-scope.contract.js`),
    tenantScope: require(`./layers/tenant-scope.contract.js`),
    appScope: require(`./layers/app-scope.contract.js`),
  },
  snapshots: {
    tenant: require(`./snapshots/tenant.snapshot.contract.js`),
    app: require(`./snapshots/app.snapshot.contract.js`),
  }
};

const cliSpecsFromLayers = Array.from(new Set(
  Object.values(appendContracts.layers)
    .flatMap((layerContract) => layerContract?.CLI?.SPECS ?? [])
));

module.exports = {
  ABOUT: {
    label: `Ehecoatl Service Contract`,
    description: `Human-readable service source of truth organized into layers and reusable contracts`,
    contractClass: `SERVICE`,
  },
  CLI: {
    path: `${serviceInstallRoot}/cli/`,
    SPECS: cliSpecsFromLayers,
  },
  SETUP: {
    IDENTITIES: {
      internalRuntime: {
        user: user.internalUser,
        group: user.internalUser,
        login: {
          shell: `/usr/sbin/nologin`,
          home: null
        }
      },
      supervisorScopeUser: {
        user: user.supervisorUser,
        group: group.superScope,
        login: {
          shell: `/usr/sbin/nologin`,
          home: null
        }
      }
    }
  },
  PROCESS_DEFAULTS: {
    managedProcess: true,
    restart: `always`,
    stopSignal: `SIGTERM`,
    stopTimeoutSeconds: 30
  },
  SNAPSHOTS: Object.freeze({
    tenant: appendContracts.snapshots.tenant,
    app: appendContracts.snapshots.app
  }),
  LAYERS: Object.freeze({
    internalScope: appendContracts.layers.internalScope,
    supervisionScope: appendContracts.layers.supervisionScope,
    projectScope: appendContracts.layers.projectScope,
    tenantScope: appendContracts.layers.tenantScope,
    appScope: appendContracts.layers.appScope
  }),
  LAYER_ISOLATION_CHAIN: [`appScope`, `projectScope`, `tenantScope`, `supervisionScope`, `internalScope`]
};
