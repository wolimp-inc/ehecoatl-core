'use strict';

require(`module-alias/register`);

const fs = require(`node:fs/promises`);
const path = require(`node:path`);
const test = require(`node:test`);
const assert = require(`node:assert/strict`);

const TenantRoute = require(`@/_core/runtimes/ingress-runtime/execution/tenant-route`);
const sessionMiddleware = require(`../builtin-extensions/project-kits/test/shared/app/http/middlewares/session`);
const csrfMiddleware = require(`../builtin-extensions/project-kits/test/shared/app/http/middlewares/csrf`);
const corsMiddleware = require(`../builtin-extensions/project-kits/test/shared/app/http/middlewares/cors`);
const authMiddleware = require(`../builtin-extensions/project-kits/test/shared/app/http/middlewares/auth`);
const guestMiddleware = require(`../builtin-extensions/project-kits/test/shared/app/http/middlewares/guest`);
const authLoginAction = require(`../builtin-extensions/app-kits/test/app/http/actions/auth-login`);
const authLogoutAction = require(`../builtin-extensions/app-kits/test/app/http/actions/auth-logout`);
const authSessionAction = require(`../builtin-extensions/app-kits/test/app/http/actions/auth-session`);

const assetsRootFolder = path.join(
  __dirname,
  `..`,
  `extensions`,
  `app-kits`,
  `test`,
  `assets`
);
const appRootFolder = path.join(
  __dirname,
  `..`,
  `extensions`,
  `app-kits`,
  `test`
);

test(`tenant route metadata preserves authScope and cors arrays`, () => {
  const route = new TenantRoute({
    pointsTo: `run > hello@index`,
    authScope: [`admin`, `user_7`],
    cors: [`http://example.test`, `*`],
    origin: {
      hostname: `www.example.test`,
      domain: `example.test`,
      appName: `www`,
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`
    },
    folders: {
      rootFolder: `/tmp/app`,
      actionsRootFolder: `/tmp/app/app/http/actions`,
      assetsRootFolder,
      httpMiddlewaresRootFolder: `/tmp/app/shared/app/http/middlewares`,
      wsMiddlewaresRootFolder: `/tmp/app/app/ws/middlewares`,
      routesRootFolder: `/tmp/app/routes`
    }
  });

  assert.deepEqual(route.authScope, [`admin`, `user_7`]);
  assert.deepEqual(route.cors, [`http://example.test`, `*`]);
});

test(`session middleware with login action persists auth session and csrf token`, async () => {
  const cache = createMemoryCache();
  const context = createMiddlewareContext({
    cache,
    routePath: `/auth/login`,
    method: `POST`,
    body: {
      username: `demo`,
      password: `demo`
    }
  });

  await sessionMiddleware(context, async () => {
    const result = await authLoginAction.index({
      requestData: context.requestData,
      sessionData: context.sessionData,
      projectRoute: context.projectRoute,
      services: context.services
    });
    context.setStatus(result.status);
    context.setBody(result.body);
  });
  await context.runFinishCallbacks();

  const sessionCookie = context.responseData.cookie.session;
  assert.equal(context.responseData.status, 200);
  assert.equal(typeof sessionCookie?.value, `string`);
  const persisted = JSON.parse(cache.store.get(`tenant-session:aaaaaaaaaaaa:bbbbbbbbbbbb:${sessionCookie.value}`));
  assert.deepEqual(persisted.auth, {
    user_id: 7,
    username: `demo`,
    displayName: `Demo User`,
    scopes: [`user_7`]
  });
  assert.equal(typeof persisted.csrfToken, `string`);
  assert.equal(context.responseData.body.auth.username, `demo`);
});

test(`csrf middleware rejects unsafe requests with missing token and allows matching token`, async () => {
  const blocked = createMiddlewareContext({
    routePath: `/auth/logout`,
    method: `POST`
  });
  blocked.sessionData.csrfToken = `token-1`;

  await csrfMiddleware(blocked, async () => {
    throw new Error(`should not continue`);
  });

  assert.equal(blocked.responseData.status, 403);
  assert.equal(blocked.responseData.body.error, `csrf_invalid`);

  const allowed = createMiddlewareContext({
    routePath: `/auth/logout`,
    method: `POST`,
    headers: {
      origin: `http://www.example.test`,
      'x-csrf-token': `token-2`
    }
  });
  allowed.sessionData.csrfToken = `token-2`;
  let nextCalled = false;

  await csrfMiddleware(allowed, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test(`cors middleware blocks cross-origin routes without cors and allows configured origins`, async () => {
  const blocked = createMiddlewareContext({
    routePath: `/cors/blocked`,
    method: `GET`,
    headers: {
      origin: `http://blocked.example.test`
    },
    cors: null
  });

  await corsMiddleware(blocked, async () => {
    throw new Error(`should not continue`);
  });

  assert.equal(blocked.responseData.status, 403);
  assert.equal(blocked.responseData.body.error, `cors_blocked`);

  const allowed = createMiddlewareContext({
    routePath: `/cors/restricted`,
    method: `GET`,
    headers: {
      origin: `http://allowed.example.test`,
      'access-control-request-headers': `content-type, x-csrf-token`
    },
    cors: [`http://allowed.example.test`]
  });
  let nextCalled = false;

  await corsMiddleware(allowed, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(allowed.responseData.status, 200);
  assert.equal(allowed.responseData.headers[`Access-Control-Allow-Origin`], `http://allowed.example.test`);
  assert.equal(allowed.responseData.headers[`Access-Control-Allow-Credentials`], `true`);
});

test(`auth middleware enforces authenticated scopes and guest middleware blocks logged-in users`, async () => {
  const unauthorized = createMiddlewareContext({
    routePath: `/auth/admin`,
    method: `GET`,
    authScope: `admin`
  });

  await authMiddleware(unauthorized, async () => {
    throw new Error(`should not continue`);
  });

  assert.equal(unauthorized.responseData.status, 401);

  const forbidden = createMiddlewareContext({
    routePath: `/auth/admin`,
    method: `GET`,
    authScope: `admin`
  });
  forbidden.sessionData.auth = {
    user_id: 7,
    scopes: [`user_7`]
  };

  await authMiddleware(forbidden, async () => {
    throw new Error(`should not continue`);
  });

  assert.equal(forbidden.responseData.status, 403);

  const allowed = createMiddlewareContext({
    routePath: `/auth/private/7`,
    method: `GET`,
    authScope: `user_7`
  });
  allowed.sessionData.auth = {
    user_id: 7,
    scopes: [`user_7`, `member`]
  };
  let authNextCalled = false;

  await authMiddleware(allowed, async () => {
    authNextCalled = true;
  });

  assert.equal(authNextCalled, true);

  const guestBlocked = createMiddlewareContext({
    routePath: `/auth/login`,
    method: `POST`
  });
  guestBlocked.sessionData.auth = {
    user_id: 1,
    scopes: [`admin`]
  };

  await guestMiddleware(guestBlocked, async () => {
    throw new Error(`should not continue`);
  });

  assert.equal(guestBlocked.responseData.status, 403);
  assert.equal(guestBlocked.responseData.body.error, `guest_only`);
});

test(`logout action destroys the session and auth-session action exposes current state`, async () => {
  const cache = createMemoryCache();
  const context = createMiddlewareContext({
    cache,
    routePath: `/auth/logout`,
    method: `POST`
  });

  await sessionMiddleware(context, async () => {
    context.sessionData.setAuth({
      user_id: 1,
      username: `admin`,
      scopes: [`admin`, `user_1`]
    });
    context.sessionData.regenerateCsrfToken();
  });
  await context.runFinishCallbacks();

  const activeSessionId = context.responseData.cookie.session.value;
  assert.equal(typeof activeSessionId, `string`);

  const followup = createMiddlewareContext({
    cache,
    routePath: `/auth/logout`,
    method: `POST`,
    cookies: {
      session: activeSessionId
    }
  });

  await sessionMiddleware(followup, async () => {
    const beforeLogout = authSessionAction.index({
      requestData: followup.requestData,
      sessionData: followup.sessionData
    });
    assert.equal(beforeLogout.body.auth.username, `admin`);

    const result = authLogoutAction.index({
      sessionData: followup.sessionData
    });
    followup.setStatus(result.status);
    followup.setBody(result.body);
  });
  await followup.runFinishCallbacks();

  assert.equal(followup.responseData.status, 200);
  assert.equal(followup.responseData.cookie.session.maxAge, 0);
  assert.equal(cache.store.has(`tenant-session:aaaaaaaaaaaa:bbbbbbbbbbbb:${activeSessionId}`), false);
});

function createMiddlewareContext({
  cache = createMemoryCache(),
  storage = createStorageService(),
  routePath,
  method,
  headers = {},
  body = null,
  cookies = {},
  authScope = null,
  cors = []
}) {
  const finishCallbacks = [];
  const requestHeaders = {
    ...headers
  };
  if (Object.keys(cookies).length > 0) {
    requestHeaders.cookie = Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join(`; `);
  }

  return {
    projectRoute: new TenantRoute({
      pointsTo: `run > example@index`,
      authScope,
      cors,
      methods: [`GET`, `POST`, `OPTIONS`],
      methodsAvailable: [`GET`, `POST`, `OPTIONS`],
      origin: {
        hostname: `www.example.test`,
        domain: `example.test`,
        appName: `www`,
        tenantId: `aaaaaaaaaaaa`,
        appId: `bbbbbbbbbbbb`
      },
      folders: {
        rootFolder: appRootFolder,
        actionsRootFolder: path.join(appRootFolder, `app`, `http`, `actions`),
        assetsRootFolder,
        httpMiddlewaresRootFolder: path.join(appRootFolder, `shared`, `app`, `http`, `middlewares`),
        wsMiddlewaresRootFolder: path.join(appRootFolder, `app`, `ws`, `middlewares`),
        routesRootFolder: path.join(appRootFolder, `routes`)
      }
    }),
    requestData: {
      method,
      path: routePath,
      protocol: `http`,
      hostname: `www.example.test`,
      port: 80,
      headers: Object.fromEntries(
        Object.entries(requestHeaders).map(([key, value]) => [String(key).toLowerCase(), value])
      ),
      body,
      cookie: { ...cookies }
    },
    responseData: {
      status: 200,
      body: null,
      headers: {},
      cookie: {}
    },
    sessionData: {},
    services: {
      cache,
      storage
    },
    addFinishCallback(callback) {
      finishCallbacks.push(callback);
    },
    async runFinishCallbacks() {
      for (const callback of finishCallbacks) {
        await callback();
      }
    },
    setStatus(status) {
      this.responseData.status = status;
    },
    setBody(bodyValue) {
      this.responseData.body = bodyValue;
    },
    setHeader(key, value) {
      this.responseData.headers[key] = value;
    },
    setCookie(key, value) {
      this.responseData.cookie[key] = value;
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

function createStorageService() {
  return {
    async readFile(targetPath, encoding) {
      return fs.readFile(targetPath, encoding);
    }
  };
}
