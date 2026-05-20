// ehecoatl-runtime/contracts/layers/supervision-scope.contract.js


'use strict';


const {
  serviceInstallRoot,
  serviceOverrideRoot,
  serviceProjectsRoot,
  serviceTenantsRoot,
  serviceLibRoot,
  serviceLogRoot,
  serviceSrvRoot,
  group,
  user
} = require(`../context.js`);
const cliSpecCore = require(`../cli-specs/cli.spec.core.js`);

module.exports = {
  ABOUT: {
    label: `Supervision Scope Layer Contract`,
    description: `Packaged supervision-scope paths, shell entrypoints, and supervision directives`,
    contractClass: `SERVICE.LAYER`,
  },
  CLI: {
    path: `${serviceInstallRoot}/cli`,
    SPECS: [
      cliSpecCore,
    ],
  },
  PATH_DEFAULTS: { path: null, owner: user.internalUser, group: group.superScope, mode: `2770`, recursive: true },
  PATHS: {
    LOGS: {
      log: [`${serviceLogRoot}`, null, null, `0775`],
      boot: [`${serviceLogRoot}/boot`, null, null, `0775`],
      tests: [`${serviceLogRoot}/tests`, null, null, `0775`],
      error: [`${serviceLogRoot}/error`, null, null, `0775`]
    },
    RUNTIME: {
      projects: [`${serviceProjectsRoot}`, null, null, `0711`, false],
      tenants: [`${serviceTenantsRoot}`, null, null, `0711`, false],
      lib: [`${serviceLibRoot}`, null, null, `0750`],
      ssl: [`${serviceLibRoot}/ssl`, null, null, `0750`],
      registry: [`${serviceLibRoot}/registry`, null, null, `0750`],
      managedLogins: [`${serviceLibRoot}/registry/managed-logins`, null, null, `0750`],
      rpc: [`${serviceLibRoot}/rpc`, null, null, `2770`]
    },
    OVERRIDES: {
      etc: [`${serviceOverrideRoot}`, null, null, `0755`, false],
      config: [`${serviceOverrideRoot}/config`],
    },
    EXTENSIONS: {
      srv: [`${serviceSrvRoot}`],
      customPlugins: [`${serviceSrvRoot}/plugins`],
      customAppKits: [`${serviceSrvRoot}/app-kits`],
      customAdapters: [`${serviceSrvRoot}/adapters`],
      customProjectKits: [`${serviceSrvRoot}/project-kits`],
      customTenantKits: [`${serviceSrvRoot}/tenant-kits`],
      customMiddlewares: [`${serviceSrvRoot}/middlewares`],
    }
  },
  ACTORS: {
    SHELL: {
      identity: {
        user: user.supervisorUser,
        group: group.superScope
      },
      umask: "027",
      login: {
        shell: `/usr/sbin/nologin`,
        home: serviceSrvRoot
      },
    },
    PROCESSES: {
      main: {
        description: `Primary root runtime supervisor for the Supervision Scope layer. This process is forked by the launcher, owns the shared supervisor tree, and boots only the director during initial startup.`,
        identity: {
          key: `main`,
          label: `main`,
          user: user.internalUser,
          group: group.internalScope,
          secondGroup: group.superScope
        },
        bootstrap: {
          entry: `${serviceInstallRoot}/bootstrap/process-main`,
          useCasesRequired: [
            `rpcRouter`,
            `pluginOrchestrator`, //NEW
            `watchdogOrchestrator`,
            `processForkRuntime`,
            `netFirewallOrchestrator`, // NEW !!! (ANALYZE)
          ]
        }
      },
      director: {
        description: `Director process for scan, tenant registry persistence, route compilation, and reconciliation of tenantScope and appScope child processes.`,
        identity: {
          key: `director`,
          label: `director`,
          user: user.internalUser,
          group: group.directorScope,
          secondGroup: group.superScope,
          thirdGroup: group.internalScope
        },
        bootstrap: {
          entry: `${serviceInstallRoot}/bootstrap/process-director`,
          useCasesRequired: [
            `pluginRuntime`, //NEW
            `storageService`,
            `webServerService`,
            `sharedCacheService`,
            `rpcEndpoint`,
            `queueBroker`,
            `middlewareStackResolver`, //NEW
            `tenantRegistryResolver`, //NEW
            `tenantRouteMatcherCompiler`,
            `tenantDirectoryResolver`,
            `requestUriRoutingRuntime`
          ]
        }
      }
    }
  },
  ACCESS: {

  }
};
