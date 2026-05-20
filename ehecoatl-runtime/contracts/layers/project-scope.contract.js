// ehecoatl-runtime/contracts/layers/project-scope.contract.js


'use strict';


const { service, serviceInstallRoot, projectRoot, user, group } = require(`../context.js`);
const cliSpecProject = require(`../cli-specs/cli.spec.project.js`);

module.exports = {
  ABOUT: {
    label: `Project Scope Layer Contract`,
    description: `Project-level scope, shared routing overrides, and transport directives`,
    contractClass: `SERVICE.LAYER`,
  },
  CLI: {
    path: `${serviceInstallRoot}/cli`,
    SPECS: [cliSpecProject],
  },
  PATH_DEFAULTS: { path: null, owner: user.projectUser, group: group.projectScope, mode: `2770`, recursive: true, type: `directory` },
  PATHS: {
    LOGS: {
      root: [`${projectRoot}/.${service}/log`],
      error: [`${projectRoot}/.${service}/log/error`],
      boot: [`${projectRoot}/.${service}/log/boot`]
    },
    RUNTIME: {
      config: [`${projectRoot}/config.json`, null, null, `2755`, true, `file`],
      root: [`${projectRoot}/.${service}`, null, null, `2775`],
      lib: [`${projectRoot}/.${service}/lib`, null, null, `2775`],
      cache: [`${projectRoot}/.${service}/.cache`, null, null, `2775`],
      ssl: [`${projectRoot}/.${service}/ssl`, null, null, `2775`],
      backups: [`${projectRoot}/.${service}/backups`, null, null, `2775`]
    },
    OVERRIDES: {
      config: [`${projectRoot}/shared/config`, null, null, `2755`, true],
      routes: [`${projectRoot}/shared/routes`, null, null, `2755`, true],
      plugins: [`${projectRoot}/shared/plugins`],
    },
    SHARED: {
      root: [`${projectRoot}/shared/`],
      app: [`${projectRoot}/shared/app`],
      utils: [`${projectRoot}/shared/app/utils`],
      scripts: [`${projectRoot}/shared/app/scripts`],
      httpActions: [`${projectRoot}/shared/app/http/actions`],
      wsActions: [`${projectRoot}/shared/app/ws/actions`],
      assets: [`${projectRoot}/shared/assets`],
      assetStatic: [`${projectRoot}/shared/assets/static`, null, null, `2775`],
      httpMiddlewares: [`${projectRoot}/shared/app/http/middlewares`],
      wsMiddlewares: [`${projectRoot}/shared/app/ws/middlewares`],
    }
  },
  ACTORS: {
    SHELL: {
      identity: {
        user: user.projectUser,
        group: group.projectScope
      },
      umask: "027",
      login: {
        shell: `/usr/sbin/nologin`,
        home: projectRoot
      },
      cli: {
        paths: [`${serviceInstallRoot}/cli`]
      }
    },
    PROCESSES: {
      transport: {
        description: `Ingress transport and socket-facing process, one per project`,
        identity: {
          key: `transport`,
          label: `e_project_transport_{tenant_id}`,
          user: user.projectUser,
          group: group.projectScope,
          secondGroup: group.superScope,
          thirdGroup: group.internalScope
        },
        bootstrap: {
          entry: `${serviceInstallRoot}/bootstrap/process-transport`,
          useCasesRequired: [
            `pluginRuntime`, //NEW
            `storageService`,
            `sharedCacheService`,
            `i18nCompiler`,
            `eRendererRuntime`,
            `rpcEndpoint`,
            `middlewareStackResolver`,
            `middlewareStackRuntime`,
            `ingressRuntime`,
            `middlewarePipelineRuntime`, //NEW
          ]
        }
      }
    }
  },
  ACCESS: {
  }
};
