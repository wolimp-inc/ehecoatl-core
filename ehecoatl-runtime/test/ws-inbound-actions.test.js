'use strict';

require(`module-alias/register`);

const path = require(`node:path`);
const fs = require(`node:fs`);
const os = require(`node:os`);
const test = require(`node:test`);
const assert = require(`node:assert/strict`);

const MiddlewareStackRuntime = require(`@/_core/runtimes/middleware-stack-runtime`);
const TenantRoute = require(`@/_core/runtimes/ingress-runtime/execution/tenant-route`);
const {
  handleIsolatedWsActionRequest
} = require(`@/bootstrap/process-isolated-runtime`);

test(`ws inbound message pipeline validates query-style syntax, normalizes repeated params, and auto-replies on non-null return`, async () => {
  const rpcCalls = [];
  const sentReplies = [];
  const runtime = createWsMessageRuntime({
    resolver: {
      getTenantMiddlewares() {
        return { http: {}, ws: {} };
      },
      async loadAppMiddlewares() {
        return { http: {}, ws: {} };
      }
    }
  });

  const result = await runtime.runWsMessageMiddlewareStack({
    projectRoute: createWsTenantRoute({
      wsActionsAvailable: [`hello@index`]
    }),
    sessionData: {
      auth: {
        username: `alice`
      }
    },
    services: {
      rpc: {
        async askDetailed(payload) {
          rpcCalls.push(payload);
          return {
            data: {
              success: true,
              result: {
                ok: true,
                params: payload.data.wsMessageData.params
              }
            }
          };
        }
      }
    },
    sendToSender: async (message) => {
      sentReplies.push(message);
      return { success: true };
    },
    wsMessageData: {
      raw: `hello@index?name=Alice&tag=one&tag=two`,
      isBinary: false,
      channelId: `bbbbbbbbbbbb:/ws`,
      clientId: `client-1`
    }
  });

  assert.equal(result.discarded, false);
  assert.equal(result.replySent, true);
  assert.deepEqual(result.wsMessageData.params, {
    name: `Alice`,
    tag: [`one`, `two`]
  });
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].question, `tenantWsAction`);
  assert.deepEqual(sentReplies, [{
    ok: true,
    params: {
      name: `Alice`,
      tag: [`one`, `two`]
    }
  }]);
});

test(`ws inbound message pipeline discards binary, malformed, and unauthorized actions before dispatch`, async () => {
  const runtime = createWsMessageRuntime();
  const cases = [
    {
      raw: Buffer.from(`ignored`),
      isBinary: true,
      reason: `binary_payload_not_supported`
    },
    {
      raw: `goodbye@index`,
      isBinary: false,
      reason: `unsupported_action`
    },
    {
      raw: `hello@index?bad=%E0%A4%A`,
      isBinary: false,
      reason: `invalid_query_encoding`
    },
    {
      raw: `hello@index`,
      isBinary: false,
      wsActionsAvailable: null,
      reason: `ws_actions_unavailable`
    }
  ];

  for (const testCase of cases) {
    const rpcCalls = [];
    const result = await runtime.runWsMessageMiddlewareStack({
      projectRoute: createWsTenantRoute({
        wsActionsAvailable: testCase.wsActionsAvailable === undefined
          ? [`hello@index`]
          : testCase.wsActionsAvailable
      }),
      services: {
        rpc: {
          async askDetailed(payload) {
            rpcCalls.push(payload);
            return {
              data: {
                success: true,
                result: { unexpected: true }
              }
            };
          }
        }
      },
      sendToSender: async () => ({ success: true }),
      wsMessageData: {
        raw: testCase.raw,
        isBinary: testCase.isBinary,
        channelId: `bbbbbbbbbbbb:/ws`,
        clientId: `client-1`
      }
    });

    assert.equal(result.discarded, true);
    assert.equal(result.discardReason, testCase.reason);
    assert.equal(rpcCalls.length, 0);
  }
});

test(`ws inbound message pipeline runs optional app ws-message middleware before dispatch`, async () => {
  const runtime = createWsMessageRuntime({
    resolver: {
      getTenantMiddlewares() {
        return { http: {}, ws: {} };
      },
      async loadAppMiddlewares() {
        return {
          http: {},
          ws: {
            'ws-message': async (context, next) => {
              context.wsMessageData = {
                ...context.wsMessageData,
                params: {
                  ...context.wsMessageData.params,
                  injected: `yes`
                }
              };
              await next();
            }
          }
        };
      }
    }
  });

  const sentReplies = [];
  const result = await runtime.runWsMessageMiddlewareStack({
    projectRoute: createWsTenantRoute({
      wsActionsAvailable: [`hello@index`]
    }),
    services: {
      rpc: {
        async askDetailed(payload) {
          return {
            data: {
              success: true,
              result: payload.data.wsMessageData.params
            }
          };
        }
      }
    },
    sendToSender: async (message) => {
      sentReplies.push(message);
      return { success: true };
    },
    wsMessageData: {
      raw: `hello@index?room=lobby`,
      isBinary: false,
      channelId: `bbbbbbbbbbbb:/ws`,
      clientId: `client-1`
    }
  });

  assert.equal(result.discarded, false);
  assert.deepEqual(sentReplies, [{
    room: `lobby`,
    injected: `yes`
  }]);
});

test(`isolated runtime resolves ws actions from app ws actions folder and explicit services.ws sends can return null`, async () => {
  const sendCalls = [];
  const testAppRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-ws-action-app-`));
  const wsActionsRoot = path.join(testAppRoot, `app`, `ws`, `actions`);
  fs.mkdirSync(wsActionsRoot, { recursive: true });
  fs.writeFileSync(path.join(wsActionsRoot, `post-data.js`), `
'use strict';

exports.index = async function index({ services, wsMessageData }) {
  await services.ws.sendMessage({
    channelId: wsMessageData.channelId,
    clientId: wsMessageData.clientId,
    message: {
      type: 'post-data',
      actionTarget: wsMessageData.actionTarget,
      params: wsMessageData.params
    }
  });
  return null;
};
`, `utf8`);

  const result = await handleIsolatedWsActionRequest({
    projectRoute: createWsTenantRoute({
      rootFolder: testAppRoot,
      folders: {
        rootFolder: testAppRoot,
        wsActionsRootFolder: wsActionsRoot
      }
    }),
    sessionData: {
      auth: {
        username: `alice`
      }
    },
    wsMessageData: {
      actionTarget: `post-data@index`,
      params: {
        mode: `send`,
        note: `hello`
      },
      channelId: `bbbbbbbbbbbb:/ws`,
      clientId: `client-1`
    },
    appRoot: testAppRoot,
    isolatedLabel: `isolated-test`,
    isolatedApp: null,
    appTopology: null,
    services: {
      ws: {
        async sendMessage(payload) {
          sendCalls.push(payload);
          return { success: true };
        },
        async broadcastMessage() {
          throw new Error(`not expected`);
        }
      }
    },
    actionCache: new Map()
  });

  assert.deepEqual(result, {
    success: true,
    result: null,
    sessionData: {
      auth: {
        username: `alice`
      }
    }
  });
  assert.equal(sendCalls.length, 1);
  assert.deepEqual(sendCalls[0], {
    channelId: `bbbbbbbbbbbb:/ws`,
    clientId: `client-1`,
    message: {
      type: `post-data`,
      actionTarget: `post-data@index`,
      params: {
        mode: `send`,
        note: `hello`
      }
    }
  });
});

function createWsMessageRuntime({
  resolver = null
} = {}) {
  return new MiddlewareStackRuntime({
    config: {
      adapters: {
        middlewareStackRuntime: {
          question: {
            tenantWsAction: `tenantWsAction`
          }
        }
      }
    },
    pluginOrchestrator: {
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
              ERROR: `MIDDLEWARE_ERROR`
            }
          }
        }
      },
      async run() {}
    },
    useCases: {
      middlewareStackResolver: resolver ?? {
        getTenantMiddlewares() {
          return { http: {}, ws: {} };
        },
        async loadAppMiddlewares() {
          return { http: {}, ws: {} };
        }
      }
    }
  });
}

function createWsTenantRoute({
  wsActionsAvailable = null,
  rootFolder = `/tmp/app`,
  folders = {}
} = {}) {
  const effectiveFolders = {
    rootFolder,
    wsActionsRootFolder: path.join(rootFolder, `app`, `ws`, `actions`),
    wsMiddlewaresRootFolder: path.join(rootFolder, `app`, `ws`, `middlewares`),
    ...folders
  };

  return new TenantRoute({
    wsActionsAvailable,
    origin: {
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`,
      appName: `www`,
      hostname: `www.example.test`
    },
    upgrade: {
      enabled: true,
      transport: [`websocket`],
      wsActionsAvailable
    },
    folders: effectiveFolders
  });
}
