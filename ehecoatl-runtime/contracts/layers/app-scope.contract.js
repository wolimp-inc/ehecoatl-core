// ehecoatl-runtime/contracts/layers/app-scope.contract.js


'use strict';


const { service, serviceInstallRoot, projectAppRoot, group, user } = require(`../context.js`);
const cliSpecApp = require(`../cli-specs/cli.spec.app.js`);

module.exports = {
  ABOUT: {
    label: `App Scope Layer Contract`,
    description: `Per-app scope runtime execution directives`,
    contractClass: `SERVICE.LAYER`,
  },
  CLI: {
    path: `${serviceInstallRoot}/cli`,
    SPECS: [cliSpecApp],
  },
  PATH_DEFAULTS: { path: null, owner: user.appUser, group: group.appScope, mode: `2775`, recursive: true },
  PATHS: {
    LOGS: {
      boot: [`${projectAppRoot}/.ehecoatl/log/boot`],
      error: [`${projectAppRoot}/.ehecoatl/log/error`],
      debug: [`${projectAppRoot}/.ehecoatl/log/debug`, null, null, `2777`],
      report: [`${projectAppRoot}/.ehecoatl/log/debug/report.json`, null, null, `0665`, false, `file`],
    },
    RUNTIME: {
      root: [`${projectAppRoot}`],
      storage: [`${projectAppRoot}/storage/`],
      logs: [`${projectAppRoot}/storage/logs`],
      backups: [`${projectAppRoot}/storage/backups`],
      uploads: [`${projectAppRoot}/storage/uploads`, null, null, `2777`],
      cache: [`${projectAppRoot}/storage/cache`],

      internal: [`${projectAppRoot}/storage/.${service}`],
      internalArtifacts: [`${projectAppRoot}/storage/.${service}/artifacts`],
      internalTmp: [`${projectAppRoot}/storage/.${service}/tmp`],
    },
    OVERRIDES: {
      config: [`${projectAppRoot}/config`, null, null, `2755`, true],
      routes: [`${projectAppRoot}/routes`, null, null, `2755`, true],
      plugins: [`${projectAppRoot}/plugins`],
    },
    RESOURCES: {
      app: [`${projectAppRoot}/app`],
      utils: [`${projectAppRoot}/app/utils`],
      scripts: [`${projectAppRoot}/app/scripts`],
      httpMiddlewares: [`${projectAppRoot}/app/http/middlewares`],
      wsMiddlewares: [`${projectAppRoot}/app/ws/middlewares`],
      assets: [`${projectAppRoot}/assets`],
      assetStatic: [`${projectAppRoot}/assets/static`, null, null, `2775`],
    }
  },
  ACTORS: {
    SHELL: {
      identity: {
        user: user.appUser,
        group: group.appScope
      },
      umask: "027",
      login: {
        shell: `/usr/sbin/nologin`,
        home: projectAppRoot
      },
      cli: {
        paths: [`${serviceInstallRoot}/cli`]
      }
    },
    PROCESSES: {
      isolatedRuntime: {
        description: `Per-project isolated runtime process`,
        identity: {
          key: `isolatedRuntime`,
          label: `e_app_{tenant_id}_{app_id}`,
          user: user.appUser,
          group: group.projectScope,
          secondGroup: group.superScope,
          thirdGroup: group.internalScope
        },
        bootstrap: {
          entry: `${serviceInstallRoot}/bootstrap/process-isolated-runtime`,
          useCasesRequired: [
            `pluginRuntime`, //NEW
            `storageService`,
            `appFluentFsRuntime`,
            `sharedCacheService`,
            `rpcEndpoint`,
            `appRpcRuntime`,
            `wsAppRuntime`
          ]
        }
      }
    }
  },
  ACCESS: {
  }
};
