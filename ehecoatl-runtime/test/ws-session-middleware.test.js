'use strict';

const test = require(`node:test`);
const assert = require(`node:assert/strict`);
const path = require(`node:path`);
const Module = require(`node:module`);

installLocalAliasResolver();

const TenantRoute = require(`../_core/runtimes/ingress-runtime/execution/tenant-route`);
const wsMessageSessionMiddleware = require(`../builtin-extensions/project-kits/test/shared/app/ws/middlewares/ws-message`);

test(`ws-message middleware loads persisted session data and sessionData.set marks the session dirty`, async () => {
  const cache = createMemoryCache();
  const syncCalls = [];
  await cache.set(
    `tenant-session:aaaaaaaaaaaa:bbbbbbbbbbbb:session-1`,
    JSON.stringify({ greeting: `hello` })
  );

  const context = createWsMiddlewareContext({
    cache,
    sessionId: `session-1`,
    syncSessionSnapshot(payload) {
      syncCalls.push(payload);
    }
  });

  await wsMessageSessionMiddleware(context, async () => {
    assert.equal(context.sessionData.get(`greeting`), `hello`);
    context.sessionData.set(`counter`, 1);
  });

  assert.equal(
    JSON.parse(cache.store.get(`tenant-session:aaaaaaaaaaaa:bbbbbbbbbbbb:session-1`)).counter,
    1
  );
  assert.deepEqual(syncCalls[0], {
    sessionId: `session-1`,
    sessionData: {
      greeting: `hello`,
      counter: 1
    }
  });
});

test(`ws-message middleware can create and persist a session for the active websocket connection`, async () => {
  const cache = createMemoryCache();
  const syncCalls = [];
  const context = createWsMiddlewareContext({
    cache,
    sessionId: null,
    generateSessionId() {
      return `generated-session`;
    },
    syncSessionSnapshot(payload) {
      syncCalls.push(payload);
    }
  });

  await wsMessageSessionMiddleware(context, async () => {
    context.sessionData.set(`role`, `admin`);
  });

  assert.deepEqual(syncCalls[0], {
    sessionId: `generated-session`,
    sessionData: {
      role: `admin`
    }
  });
  assert.deepEqual(
    JSON.parse(cache.store.get(`tenant-session:aaaaaaaaaaaa:bbbbbbbbbbbb:generated-session`)),
    { role: `admin` }
  );
});

function createWsMiddlewareContext({
  cache = createMemoryCache(),
  sessionId = null,
  generateSessionId = () => `session-generated`,
  syncSessionSnapshot = () => {}
} = {}) {
  return {
    projectRoute: new TenantRoute({
      pointsTo: `run > hello@index`,
      origin: {
        hostname: `www.example.test`,
        domain: `example.test`,
        appName: `www`,
        tenantId: `aaaaaaaaaaaa`,
        appId: `bbbbbbbbbbbb`
      },
      folders: {
        rootFolder: `/tmp/app`
      }
    }),
    sessionData: {},
    services: {
      cache,
      generateSessionId,
      syncSessionSnapshot
    },
    wsMessageData: {
      metadata: {
        sessionId,
        headers: sessionId
          ? { cookie: `session=${sessionId}` }
          : {}
      }
    }
  };
}

function createMemoryCache() {
  const store = new Map();
  return {
    store,
    async get(key, defaultValue = null) {
      return store.has(key) ? store.get(key) : defaultValue;
    },
    async set(key, value) {
      store.set(key, value);
      return true;
    },
    async delete(key) {
      return store.delete(key);
    }
  };
}

function installLocalAliasResolver() {
  if (global.__EHECOATL_LOCAL_ALIAS_RESOLVER__) return;
  global.__EHECOATL_LOCAL_ALIAS_RESOLVER__ = true;

  const projectRoot = path.resolve(__dirname, `..`);
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function patchedResolveFilename(request, parent, ...rest) {
    if (typeof request === `string` && request.startsWith(`@/`)) {
      request = path.join(projectRoot, request.slice(2));
    } else if (typeof request === `string` && request.startsWith(`@middleware/`)) {
      request = path.join(projectRoot, `builtin-extensions`, `middlewares`, request.slice(`@middleware/`.length));
    }
    return originalResolveFilename.call(this, request, parent, ...rest);
  };
}
