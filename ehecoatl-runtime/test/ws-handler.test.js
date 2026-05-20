'use strict';

require(`module-alias/register`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);

const RequestData = require(`@/_core/runtimes/ingress-runtime/execution/request-data`);
const TenantRoute = require(`@/_core/runtimes/ingress-runtime/execution/tenant-route`);
const wsHandler = require(`@/builtin-extensions/adapters/inbound/ingress-runtime/uws/ws-handler`);

test(`ws handler upgrades after route resolution and websocket middleware stack returns status 200`, async () => {
  const req = createMockUpgradeRequest();
  const res = createMockUpgradeResponse();
  const routeCalls = [];
  const executionContext = createExecutionContext({
    req,
    res,
    projectRoute: createWsTenantRoute(),
    sessionData: {
      auth: {
        username: `alice`,
        scopes: [`admin`]
      }
    },
    async onResolveRoute(params) {
      routeCalls.push(params);
    },
    async onRunWsUpgradeMiddlewareStack() {
      this.responseData.status = 200;
    }
  });

  const upgraded = await wsHandler.handleUpgrade({
    res,
    req,
    context: { socket: true },
    getClientIp() {
      return `198.51.100.10`;
    },
    createExecutionContext() {
      return executionContext;
    }
  });

  assert.equal(upgraded, true);
  assert.deepEqual(routeCalls, [{ routeType: `ws-upgrade` }]);
  assert.equal(executionContext.requestData.hostname, `ws.example.com`);
  assert.equal(executionContext.requestData.method, `GET`);
  assert.equal(res.upgradeCalled, true);
  assert.equal(typeof res.upgradePayload.userData.clientId, `string`);
  assert.equal(res.upgradePayload.userData.channelId, `bbbbbbbbbbbb:/ws`);
  assert.equal(res.upgradePayload.userData.metadata.appId, `bbbbbbbbbbbb`);
  assert.deepEqual(res.upgradePayload.userData.metadata.sessionData, {
    auth: {
      username: `alice`,
      scopes: [`admin`]
    }
  });
  assert.deepEqual(res.upgradePayload.userData.metadata.route.params, { slug: `lobby` });
  assert.deepEqual(res.upgradePayload.userData.metadata.route.view, { roomName: `Lobby` });
  assert.deepEqual(res.upgradePayload.userData.metadata.route.wsActionsAvailable, [`hello@index`, `post-data@index`]);
  assert.equal(res.upgradePayload.userData.metadata.route.folders.wsActionsRootFolder, `/tmp/app/app/ws/actions`);
  assert.equal(res.status, null);
});

test(`ws handler writes http response and skips upgrade when websocket middleware stack rejects`, async () => {
  const req = createMockUpgradeRequest();
  const res = createMockUpgradeResponse();
  const executionContext = createExecutionContext({
    req,
    res,
    projectRoute: createWsTenantRoute(),
    async onRunWsUpgradeMiddlewareStack() {
      this.responseData.status = 403;
      this.responseData.body = `Forbidden`;
      this.responseData.headers[`Content-Type`] = `text/plain; charset=utf-8`;
    }
  });

  const upgraded = await wsHandler.handleUpgrade({
    res,
    req,
    context: { socket: true },
    getClientIp() {
      return `198.51.100.10`;
    },
    createExecutionContext() {
      return executionContext;
    }
  });

  assert.equal(upgraded, false);
  assert.equal(res.upgradeCalled, false);
  assert.equal(res.status, `403 Forbidden`);
  assert.equal(res.body, `Forbidden`);
});

test(`ws handler setup delegates open message and close lifecycle to ws hub manager`, async () => {
  const calls = [];
  const app = {
    ws(_pattern, handlers) {
      this.handlers = handlers;
    }
  };
  const wsHubManager = {
    async openClient(payload) {
      calls.push([`open`, payload]);
      return { success: true };
    },
    async receiveMessage(payload) {
      calls.push([`message`, payload]);
      return { success: true };
    },
    async closeClient(payload) {
      calls.push([`close`, payload]);
      return { success: true };
    }
  };

  wsHandler.setup({
    app,
    getClientIp() {
      return `198.51.100.10`;
    },
    wsHubManager,
    createExecutionContext() {
      throw new Error(`not expected`);
    }
  });

  const ws = {
    getUserData() {
      return {
        clientId: `client-1`,
        channelId: `bbbbbbbbbbbb:/ws`,
        metadata: {
          tenantId: `aaaaaaaaaaaa`,
          appId: `bbbbbbbbbbbb`
        }
      };
    },
    send() {}
  };

  await app.handlers.open(ws);
  await app.handlers.message(ws, Buffer.from(`hello`), false);
  await app.handlers.close(ws, 1000, Buffer.from(`bye`));

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0][1], {
    channelId: `bbbbbbbbbbbb:/ws`,
    clientId: `client-1`,
    ws,
    metadata: {
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`
    }
  });
  assert.equal(calls[1][1].channelId, `bbbbbbbbbbbb:/ws`);
  assert.equal(calls[1][1].clientId, `client-1`);
  assert.equal(Buffer.isBuffer(calls[1][1].message), true);
  assert.equal(calls[2][1].code, 1000);
});

function createExecutionContext({
  req,
  res,
  projectRoute,
  sessionData = {},
  onResolveRoute = null,
  onRunWsUpgradeMiddlewareStack = null
}) {
  const executionContext = {
    req,
    res,
    ip: null,
    requestData: null,
    projectRoute: null,
    responseData: {
      status: 200,
      body: null,
      headers: {}
    },
    services: {},
    sessionData,
    meta: {},
    hooks: {
      REQUEST: {
        START: `request.start`,
        END: `request.end`,
        ERROR: `request.error`,
        BREAK: `request.break`
      },
      RESPONSE: {
        WRITE: {
          START: `write.start`,
          END: `write.end`,
          BREAK: `write.break`,
          ERROR: `write.error`
        }
      }
    },
    aborted: false,
    async run() {},
    async setupRequestData(data) {
      this.requestData = new RequestData(data);
    },
    async runWsUpgradeMiddlewareStack() {
      if (typeof onRunWsUpgradeMiddlewareStack === `function`) {
        await onRunWsUpgradeMiddlewareStack.call(this);
      }
    },
    async end() {},
    isAborted() {
      return this.aborted;
    },
    abort() {
      this.aborted = true;
    },
    directorHelper: {
      resolveRoute: async (params) => {
        if (typeof onResolveRoute === `function`) {
          await onResolveRoute.call(executionContext, params);
        }
        executionContext.projectRoute = projectRoute;
      }
    }
  };

  return executionContext;
}

function createWsTenantRoute() {
  return new TenantRoute({
    middleware: [`auth`],
    params: {
      slug: `lobby`
    },
    view: {
      roomName: `Lobby`
    },
    wsActionsAvailable: [`hello@index`, `post-data@index`],
    methodsAvailable: [`GET`],
    methods: [`GET`],
    upgrade: {
      enabled: true,
      transport: [`websocket`],
      wsActionsAvailable: [`hello@index`, `post-data@index`]
    },
    origin: {
      hostname: `ws.example.com`,
      appURL: `ws.example.com`,
      domain: `example.com`,
      appName: `www`,
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`
    },
    folders: {
      rootFolder: `/tmp/app`,
      actionsRootFolder: `/tmp/app/actions`,
      httpActionsRootFolder: `/tmp/app/app/http/actions`,
      wsActionsRootFolder: `/tmp/app/app/ws/actions`,
      assetsRootFolder: `/tmp/app/assets`,
      httpMiddlewaresRootFolder: `/tmp/app/app/http/middlewares`,
      wsMiddlewaresRootFolder: `/tmp/app/app/ws/middlewares`,
      routesRootFolder: `/tmp/app/routes`
    }
  });
}

function createMockUpgradeRequest() {
  const headers = {
    host: `127.0.0.1`,
    connection: `upgrade`,
    upgrade: `websocket`,
    'x-forwarded-host': `ws.example.com`,
    'x-forwarded-proto': `https`,
    'x-forwarded-port': `443`,
    'x-forwarded-method': `GET`,
    'x-forwarded-uri': `/ws`,
    'x-forwarded-query': ``,
    'x-forwarded-for': `198.51.100.10`,
    'sec-websocket-key': `key`,
    'sec-websocket-protocol': `chat`,
    'sec-websocket-extensions': `permessage-deflate`
  };

  return {
    forEach(callback) {
      for (const [key, value] of Object.entries(headers)) {
        callback(key, value);
      }
    },
    getHeader(key) {
      return headers[String(key).toLowerCase()] ?? headers[key] ?? ``;
    }
  };
}

function createMockUpgradeResponse() {
  return {
    status: null,
    headers: null,
    body: null,
    upgradeCalled: false,
    onAborted() {},
    cork(fn) { fn(); },
    writeStatus(status) {
      this.status = status;
      return this;
    },
    writeHeader(key, value) {
      if (!this.headers) this.headers = {};
      this.headers[key] = value;
      return this;
    },
    end(body) {
      this.body = body ?? null;
      return this;
    },
    upgrade(userData, key, protocol, extensions, context) {
      this.upgradeCalled = true;
      this.upgradePayload = { userData, key, protocol, extensions, context };
      return this;
    }
  };
}
