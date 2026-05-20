'use strict';

require(`module-alias/register`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);

const MiddlewareStackRuntime = require(`@/_core/runtimes/middleware-stack-runtime`);
const TenantRoute = require(`@/_core/runtimes/ingress-runtime/execution/tenant-route`);

test(`middleware-stack-runtime composes core stack order and route stack app-over-tenant resolution`, async () => {
  const executionTrace = [];
  const pluginTrace = [];
  const executionContext = createExecutionContext({
    projectRoute: createTenantRoute({
      middleware: [`web`],
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`
    })
  });

  const orchestrator = createOrchestrator({
    pluginTrace,
    resolver: {
      getCoreMiddlewareOrder() {
        return [`core-a`, `core-b`];
      },
      getCoreMiddlewares() {
        return {
          'core-a': async (context, next) => {
            executionTrace.push([`core-a-before`, typeof context.setStatus === `function`, context !== executionContext]);
            await next();
            executionTrace.push([`core-a-after`, typeof context.getHeaders === `function`, context !== executionContext]);
          },
          'core-b': async (context, next) => {
            executionTrace.push([`core-b-before`, typeof context.setStatus === `function`, context !== executionContext]);
            await next();
            executionTrace.push([`core-b-after`, typeof context.getHeaders === `function`, context !== executionContext]);
          }
        };
      },
      getTenantMiddlewares() {
        return {
          http: {
            web: async (context, next) => {
              executionTrace.push([`tenant-web`, typeof context.setStatus === `function`]);
              await next();
            }
          },
          ws: {}
        };
      },
      async loadAppMiddlewares() {
        return {
          http: {
            web: async (context, next) => {
              executionTrace.push([`app-web-before`, typeof context.setStatus === `function`, context !== executionContext]);
              await next();
              executionTrace.push([`app-web-after`, typeof context.getHeaders === `function`]);
            }
          },
          ws: {}
        };
      }
    }
  });

  await orchestrator.runHttpMiddlewareStack(executionContext);

  assert.deepEqual(executionTrace, [
    [`app-web-before`, true, true],
    [`core-a-before`, true, true],
    [`core-b-before`, true, true],
    [`core-b-after`, true, true],
    [`core-a-after`, true, true],
    [`app-web-after`, true]
  ]);
  assert.equal(executionContext.responseData.status, 200);
  assert.ok(pluginTrace.includes(`STACK_START`));
  assert.ok(pluginTrace.includes(`STACK_END`));
});

test(`middleware-stack-runtime stops after a core middleware short-circuits`, async () => {
  const executionTrace = [];
  const pluginTrace = [];
  const executionContext = createExecutionContext({
    projectRoute: createTenantRoute({
      middleware: [`web`],
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`
    })
  });

  const orchestrator = createOrchestrator({
    pluginTrace,
    resolver: {
      getCoreMiddlewareOrder() {
        return [`core-a`, `core-b`];
      },
      getCoreMiddlewares() {
        return {
          'core-a': async (context) => {
            executionTrace.push(`core-a`);
            context.setStatus(204);
          },
          'core-b': async () => {
            executionTrace.push(`core-b`);
          }
        };
      },
      getTenantMiddlewares() {
        return {
          http: {
            web: async (_, next) => {
              executionTrace.push(`tenant-web`);
              await next();
            }
          },
          ws: {}
        };
      },
      async loadAppMiddlewares() {
        return { http: {}, ws: {} };
      }
    }
  });

  await orchestrator.runHttpMiddlewareStack(executionContext);

  assert.deepEqual(executionTrace, [`tenant-web`, `core-a`]);
  assert.equal(executionContext.responseData.status, 204);
  assert.ok(pluginTrace.includes(`STACK_BREAK`));
});

test(`middleware-stack-runtime stops the unified chain when a route middleware short-circuits`, async () => {
  const executionTrace = [];
  const executionContext = createExecutionContext({
    projectRoute: createTenantRoute({
      middleware: [`web`],
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`
    })
  });

  const orchestrator = createOrchestrator({
    pluginTrace: [],
    resolver: {
      getCoreMiddlewareOrder() {
        return [`core-a`];
      },
      getCoreMiddlewares() {
        return {
          'core-a': async () => {
            executionTrace.push(`core-a`);
          }
        };
      },
      getTenantMiddlewares() {
        return { http: {}, ws: {} };
      },
      async loadAppMiddlewares() {
        return {
          http: {
            web: async (context) => {
              executionTrace.push(`route-web`);
              context.setStatus(202);
            }
          },
          ws: {}
        };
      }
    }
  });

  await orchestrator.runHttpMiddlewareStack(executionContext);

  assert.deepEqual(executionTrace, [`route-web`]);
  assert.equal(executionContext.responseData.status, 202);
});

test(`middleware-stack-runtime expands tenant middleware groups into executable route middleware chain`, async () => {
  const executionTrace = [];
  const executionContext = createExecutionContext({
    projectRoute: createTenantRoute({
      middleware: [`api`],
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`
    })
  });

  const orchestrator = createOrchestrator({
    pluginTrace: [],
    resolver: {
      getCoreMiddlewareOrder() {
        return [];
      },
      getCoreMiddlewares() {
        return {};
      },
      getTenantMiddlewares() {
        return {
          http: {
            api: [`cors`, `session`, `validate`],
            cors: async (_, next) => {
              executionTrace.push(`tenant-cors`);
              await next();
            },
            session: async (_, next) => {
              executionTrace.push(`tenant-session`);
              await next();
            },
            validate: async (_, next) => {
              executionTrace.push(`tenant-validate`);
              await next();
            }
          },
          ws: {}
        };
      },
      async loadAppMiddlewares() {
        return {
          http: {},
          ws: {}
        };
      }
    }
  });

  await orchestrator.runHttpMiddlewareStack(executionContext);

  assert.deepEqual(executionTrace, [
    `tenant-cors`,
    `tenant-session`,
    `tenant-validate`
  ]);
});

test(`middleware-stack-runtime runs websocket upgrade stack as route http middlewares then app ws-upgrade`, async () => {
  const executionTrace = [];
  const executionContext = createExecutionContext({
    projectRoute: createTenantRoute({
      middleware: [`auth`],
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`,
      upgrade: true
    })
  });

  const orchestrator = createOrchestrator({
    pluginTrace: [],
    resolver: {
      getCoreMiddlewareOrder() {
        return [`core-a`];
      },
      getCoreMiddlewares() {
        return {
          'core-a': async () => {
            executionTrace.push(`core-a`);
          }
        };
      },
      getTenantMiddlewares() {
        return {
          http: {
            auth: async (_, next) => {
              executionTrace.push(`tenant-auth`);
              await next();
            }
          },
          ws: {}
        };
      },
      async loadAppMiddlewares() {
        return {
          http: {
            auth: async (_, next) => {
              executionTrace.push(`app-auth`);
              await next();
            }
          },
          ws: {
            'ws-upgrade': async () => {
              executionTrace.push(`ws-upgrade`);
            }
          }
        };
      }
    }
  });

  await orchestrator.runWsUpgradeMiddlewareStack(executionContext);

  assert.deepEqual(executionTrace, [`app-auth`, `ws-upgrade`]);
  assert.equal(executionContext.responseData.status, 200);
});

test(`middleware-stack-runtime websocket upgrade short-circuit skips app ws-upgrade`, async () => {
  const executionTrace = [];
  const executionContext = createExecutionContext({
    projectRoute: createTenantRoute({
      middleware: [`auth`],
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`,
      upgrade: true
    })
  });

  const orchestrator = createOrchestrator({
    pluginTrace: [],
    resolver: {
      getCoreMiddlewareOrder() {
        return [];
      },
      getCoreMiddlewares() {
        return {};
      },
      getTenantMiddlewares() {
        return {
          http: {
            auth: async (context) => {
              executionTrace.push(`tenant-auth`);
              context.setStatus(401);
            }
          },
          ws: {}
        };
      },
      async loadAppMiddlewares() {
        return {
          http: {},
          ws: {
            'ws-upgrade': async () => {
              executionTrace.push(`ws-upgrade`);
            }
          }
        };
      }
    }
  });

  await orchestrator.runWsUpgradeMiddlewareStack(executionContext);

  assert.deepEqual(executionTrace, [`tenant-auth`]);
  assert.equal(executionContext.responseData.status, 401);
});

test(`middleware-stack-runtime returns 500 when middleware calls next twice`, async () => {
  const pluginTrace = [];
  const executionContext = createExecutionContext({
    projectRoute: createTenantRoute({
      middleware: null,
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`
    })
  });

  const orchestrator = createOrchestrator({
    pluginTrace,
    resolver: {
      getCoreMiddlewareOrder() {
        return [`core-a`];
      },
      getCoreMiddlewares() {
        return {
          'core-a': async (_, next) => {
            await next();
            await next();
          }
        };
      },
      getTenantMiddlewares() {
        return { http: {}, ws: {} };
      },
      async loadAppMiddlewares() {
        return { http: {}, ws: {} };
      }
    }
  });

  await orchestrator.runHttpMiddlewareStack(executionContext);

  assert.equal(executionContext.responseData.status, 500);
  assert.equal(executionContext.responseData.body, `Internal Server Middleware Stack Error`);
  assert.ok(pluginTrace.includes(`STACK_ERROR`));
});

test(`middleware-stack-runtime fails when a route middleware label cannot be resolved`, async () => {
  const pluginTrace = [];
  const executionContext = createExecutionContext({
    projectRoute: createTenantRoute({
      middleware: [`web`],
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`
    })
  });

  const orchestrator = createOrchestrator({
    pluginTrace,
    resolver: {
      getCoreMiddlewareOrder() {
        return [];
      },
      getCoreMiddlewares() {
        return {};
      },
      getTenantMiddlewares() {
        return { http: {}, ws: {} };
      },
      async loadAppMiddlewares() {
        return { http: {}, ws: {} };
      }
    }
  });

  await orchestrator.runHttpMiddlewareStack(executionContext);

  assert.equal(executionContext.responseData.status, 500);
  assert.equal(executionContext.responseData.body, `Internal Server Middleware Stack Error`);
  assert.ok(pluginTrace.includes(`STACK_ERROR`));
});

test(`tenant route normalizes middleware and middlewares into one canonical middleware array`, () => {
  const canonicalRoute = createTenantRoute({
    middleware: `web`,
    tenantId: `aaaaaaaaaaaa`,
    appId: `bbbbbbbbbbbb`
  });
  const aliasRoute = new TenantRoute({
    pointsTo: `run > hello@index`,
    middlewares: [`web`, `cors`],
    origin: {
      hostname: `www.example.com`,
      domain: `example.com`,
      appName: `www`,
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`
    },
    folders: {
      rootFolder: `/tmp/app`,
      actionsRootFolder: `/tmp/app/actions`,
      assetsRootFolder: `/tmp/app/assets`,
      httpMiddlewaresRootFolder: `/tmp/app/http/middlewares`,
      wsMiddlewaresRootFolder: `/tmp/app/ws/middlewares`,
      routesRootFolder: `/tmp/app/routes`
    }
  });

  assert.deepEqual(canonicalRoute.middleware, [`web`]);
  assert.deepEqual(aliasRoute.middleware, [`web`, `cors`]);
  assert.equal(aliasRoute.origin.tenantId, `aaaaaaaaaaaa`);
  assert.equal(aliasRoute.origin.appId, `bbbbbbbbbbbb`);
});

function createOrchestrator({
  pluginTrace,
  resolver
}) {
  const normalizedResolver = {
    ...resolver,
    async loadCoreMiddlewares(protocol = `http`) {
      if (typeof resolver?.loadCoreMiddlewares === `function`) {
        return resolver.loadCoreMiddlewares(protocol);
      }
      if (typeof resolver?.getCoreMiddlewares === `function`) {
        return resolver.getCoreMiddlewares(protocol);
      }
      return {};
    },
    async loadCoreMiddlewareOrder(protocol = `http`) {
      if (typeof resolver?.loadCoreMiddlewareOrder === `function`) {
        return resolver.loadCoreMiddlewareOrder(protocol);
      }
      if (typeof resolver?.getCoreMiddlewareOrder === `function`) {
        return resolver.getCoreMiddlewareOrder(protocol);
      }
      return [];
    },
    async loadTenantMiddlewares() {
      if (typeof resolver?.loadTenantMiddlewares === `function`) {
        return resolver.loadTenantMiddlewares();
      }
      if (typeof resolver?.getTenantMiddlewares === `function`) {
        return resolver.getTenantMiddlewares();
      }
      return { http: {}, ws: {} };
    }
  };

  const pluginOrchestrator = {
    hooks: {
      TRANSPORT: {
        MIDDLEWARE_STACK: {
          START: `STACK_START`,
          END: `STACK_END`,
          BREAK: `STACK_BREAK`,
          ERROR: `STACK_ERROR`,
          MIDDLEWARE: {
            START: `MIDDLEWARE_START`,
            END: `MIDDLEWARE_END`,
            BREAK: `MIDDLEWARE_BREAK`,
            ERROR: `MIDDLEWARE_ERROR`
          }
        }
      }
    },
    async run(hookId) {
      pluginTrace.push(hookId);
    }
  };

  return new MiddlewareStackRuntime({
    config: {
      adapters: {
        middlewareStackRuntime: {}
      }
    },
    pluginOrchestrator,
    useCases: {
      middlewareStackResolver: normalizedResolver
    }
  });
}

function createExecutionContext({
  projectRoute
}) {
  let aborted = false;
  let finishCallbacksCalled = 0;

  return {
    projectRoute,
    requestData: {
      url: `www.example.com/hello`,
      method: `GET`,
      headers: {}
    },
    responseData: {
      status: 200,
      body: null,
      headers: {}
    },
    services: {},
    sessionData: {},
    meta: {
      currentMiddlewareIndex: null,
      currentMiddlewareName: null
    },
    middlewareStackRuntimeConfig: {},
    addFinishCallback() {},
    async callFinishCallbacks() {
      finishCallbacksCalled += 1;
      return finishCallbacksCalled;
    },
    isAborted() {
      return aborted;
    },
    abort() {
      aborted = true;
    }
  };
}

function createTenantRoute({
  middleware,
  tenantId,
  appId,
  upgrade = false
}) {
  return new TenantRoute({
    ...(upgrade ? { upgrade: { enabled: true, transport: [`websocket`] } } : { pointsTo: `run > hello@index` }),
    middleware,
    origin: {
      hostname: `www.example.com`,
      appURL: `www.example.com`,
      domain: `example.com`,
      appName: `www`,
      tenantId,
      appId
    },
    folders: {
      rootFolder: `/tmp/app`,
      actionsRootFolder: `/tmp/app/actions`,
      assetsRootFolder: `/tmp/app/assets`,
      httpMiddlewaresRootFolder: `/tmp/app/http/middlewares`,
      wsMiddlewaresRootFolder: `/tmp/app/ws/middlewares`,
      routesRootFolder: `/tmp/app/routes`
    }
  });
}
