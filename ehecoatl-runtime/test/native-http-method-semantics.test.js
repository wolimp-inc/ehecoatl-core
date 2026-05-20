'use strict';

require(`module-alias/register`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);

const RequestData = require(`@/_core/runtimes/ingress-runtime/execution/request-data`);
const TenantRoute = require(`@/_core/runtimes/ingress-runtime/execution/tenant-route`);
const httpHandler = require(`@/builtin-extensions/adapters/inbound/ingress-runtime/uws/http-handler`);

function createMockUwsResponse() {
  return {
    status: null,
    headers: {},
    body: undefined,
    abortedHandler: null,
    cork(callback) {
      callback();
      return this;
    },
    onAborted(handler) {
      this.abortedHandler = handler;
      return this;
    },
    writeStatus(status) {
      this.status = status;
      return this;
    },
    writeHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
    end(body) {
      this.body = body;
      return this;
    }
  };
}

function createForwardedRequest({
  method = `GET`,
  path = `/hello`,
  headers = {}
} = {}) {
  const forwardedHeaders = {
    host: `tenant.test`,
    'x-forwarded-host': `tenant.test`,
    'x-forwarded-proto': `http`,
    'x-forwarded-port': `80`,
    'x-forwarded-method': method,
    'x-forwarded-uri': path,
    'x-forwarded-query': ``,
    'x-forwarded-for': `203.0.113.10`,
    ...headers
  };

  return {
    forEach(callback) {
      for (const [key, value] of Object.entries(forwardedHeaders)) {
        callback(key, value);
      }
    },
    getQuery() {
      return ``;
    },
    getMethod() {
      return method;
    },
    getUrl() {
      return path;
    }
  };
}

function createRoute({
  methods = [`GET`],
  methodsAvailable = [`GET`],
  cors = null
} = {}) {
  return new TenantRoute({
    pointsTo: `run > hello@index`,
    methods,
    methodsAvailable,
    cors,
    origin: {
      hostname: `tenant.test`,
      domain: `example.test`,
      appName: `www`,
      tenantId: `aaaaaaaaaaaa`,
      appId: `bbbbbbbbbbbb`
    },
    folders: {
      rootFolder: `/tmp/app`,
      actionsRootFolder: `/tmp/app/app/http/actions`,
      assetsRootFolder: `/tmp/app/assets`,
      httpMiddlewaresRootFolder: `/tmp/app/app/http/middlewares`,
      wsMiddlewaresRootFolder: `/tmp/app/app/ws/middlewares`,
      routesRootFolder: `/tmp/app/routes`
    }
  });
}

function createExecutionContext({
  route,
  req,
  res = createMockUwsResponse(),
  middlewareImpl = async function defaultMiddleware(executionContext) {
    executionContext.responseData.body = `ok`;
  }
}) {
  const state = {
    middlewareRuns: 0,
    ended: 0
  };

  const executionContext = {
    req,
    res,
    requestData: null,
    projectRoute: null,
    responseData: {
      status: 200,
      headers: {},
      body: null,
      cookie: null
    },
    meta: {
      requestKind: null
    },
    hooks: {
      REQUEST: {
        GET_COOKIE: { BEFORE: `get-cookie.before`, AFTER: `get-cookie.after`, ERROR: `get-cookie.error` },
        BODY: { START: `body.start`, END: `body.end`, ERROR: `body.error` },
        BREAK: `request.break`,
        ERROR: `request.error`
      },
      RESPONSE: {
        WRITE: { START: `write.start`, END: `write.end`, BREAK: `write.break`, ERROR: `write.error` }
      }
    },
    async run() { },
    async setupRequestData(data) {
      this.requestData = new RequestData(data);
    },
    async runHttpMiddlewareStack() {
      state.middlewareRuns += 1;
      await middlewareImpl(this);
    },
    async end() {
      state.ended += 1;
    },
    isAborted() {
      return false;
    },
    abort() { }
  };

  executionContext.directorHelper = {
    async resolveRoute() {
      executionContext.projectRoute = route;
    }
  };

  return {
    executionContext,
    res,
    state
  };
}

test(`tenant route exposes effective methods and blocks CONNECT and TRACE by default`, () => {
  const route = createRoute({
    methods: [`GET`, `TRACE`, `CONNECT`],
    methodsAvailable: [`GET`, `TRACE`, `CONNECT`]
  });

  assert.deepEqual(route.methods, [`GET`]);
  assert.deepEqual(route.methodsAvailable, [`GET`]);
  assert.deepEqual(route.effectiveMethods, [`GET`, `HEAD`, `OPTIONS`]);
  assert.deepEqual(route.effectiveHostMethods, [`GET`, `HEAD`, `OPTIONS`]);
  assert.equal(route.allowsMethod(`HEAD`), true);
  assert.equal(route.allowsMethod(`TRACE`), false);
  assert.equal(route.allowsHostMethod(`CONNECT`), false);
  assert.equal(route.allowHeader(), `GET, HEAD, OPTIONS`);
});

test(`HEAD requests run middleware and finish without sending a response body`, async () => {
  const route = createRoute();
  const req = createForwardedRequest({
    method: `HEAD`
  });
  const { executionContext, res, state } = createExecutionContext({
    route,
    req,
    middlewareImpl: async (context) => {
      context.responseData.headers[`X-Handled-By`] = `middleware`;
      context.responseData.body = `hello from middleware`;
    }
  });

  await httpHandler.handle(executionContext);

  assert.equal(state.middlewareRuns, 1);
  assert.equal(res.status, `200 OK`);
  assert.equal(res.headers[`X-Handled-By`], `middleware`);
  assert.equal(res.body, undefined);
  assert.equal(executionContext.meta.requestKind, `head`);
});

test(`OPTIONS requests are answered natively before middleware with an Allow header`, async () => {
  const route = createRoute({
    methods: [`GET`],
    methodsAvailable: [`GET`]
  });
  const req = createForwardedRequest({
    method: `OPTIONS`
  });
  const { executionContext, res, state } = createExecutionContext({
    route,
    req,
    middlewareImpl: async () => {
      throw new Error(`middleware should not run for native preflight`);
    }
  });

  await httpHandler.handle(executionContext);

  assert.equal(state.middlewareRuns, 0);
  assert.equal(res.status, `204 No Content`);
  assert.equal(res.headers.Allow, `GET, HEAD, OPTIONS`);
  assert.equal(res.body, undefined);
  assert.equal(executionContext.meta.requestKind, `preflight`);
});

test(`OPTIONS preflight applies route CORS headers when the origin is allowed`, async () => {
  const route = createRoute({
    methods: [`POST`],
    methodsAvailable: [`POST`],
    cors: [`http://allowed.example.test`]
  });
  const req = createForwardedRequest({
    method: `OPTIONS`,
    headers: {
      origin: `http://allowed.example.test`,
      'access-control-request-method': `POST`,
      'access-control-request-headers': `content-type, x-csrf-token`
    }
  });
  const { executionContext, res, state } = createExecutionContext({
    route,
    req
  });

  await httpHandler.handle(executionContext);

  assert.equal(state.middlewareRuns, 0);
  assert.equal(res.status, `204 No Content`);
  assert.equal(res.headers.Allow, `POST, OPTIONS`);
  assert.equal(res.headers[`Access-Control-Allow-Origin`], `http://allowed.example.test`);
  assert.equal(res.headers[`Access-Control-Allow-Methods`], `POST, OPTIONS`);
  assert.equal(res.headers[`Access-Control-Allow-Headers`], `content-type, x-csrf-token`);
  assert.equal(res.headers[`Access-Control-Allow-Credentials`], `true`);
  assert.equal(res.headers.Vary, `Origin`);
});

test(`OPTIONS preflight returns 403 when the origin is not allowed by route CORS policy`, async () => {
  const route = createRoute({
    methods: [`GET`],
    methodsAvailable: [`GET`],
    cors: null
  });
  const req = createForwardedRequest({
    method: `OPTIONS`,
    headers: {
      origin: `http://blocked.example.test`,
      'access-control-request-method': `GET`
    }
  });
  const { executionContext, res, state } = createExecutionContext({
    route,
    req
  });

  await httpHandler.handle(executionContext);

  assert.equal(state.middlewareRuns, 0);
  assert.equal(res.status, `403 Forbidden`);
  assert.equal(res.headers.Allow, `GET, HEAD, OPTIONS`);
  assert.equal(res.headers[`Content-Type`], `application/json`);
  assert.equal(res.body, JSON.stringify({
    success: false,
    error: `cors_blocked`,
    origin: `http://blocked.example.test`
  }));
});

test(`OPTIONS preflight returns 405 when Access-Control-Request-Method is not allowed`, async () => {
  const route = createRoute({
    methods: [`GET`],
    methodsAvailable: [`GET`],
    cors: [`http://allowed.example.test`]
  });
  const req = createForwardedRequest({
    method: `OPTIONS`,
    headers: {
      origin: `http://allowed.example.test`,
      'access-control-request-method': `POST`
    }
  });
  const { executionContext, res, state } = createExecutionContext({
    route,
    req
  });

  await httpHandler.handle(executionContext);

  assert.equal(state.middlewareRuns, 0);
  assert.equal(res.status, `405 Method Not Allowed`);
  assert.equal(res.headers.Allow, `GET, HEAD, OPTIONS`);
  assert.equal(res.body, `Method Not Allowed`);
});

test(`TRACE and CONNECT requests are blocked even if declared in route config`, async () => {
  for (const method of [`TRACE`, `CONNECT`]) {
    const route = createRoute({
      methods: [`GET`, method],
      methodsAvailable: [`GET`, method]
    });
    const req = createForwardedRequest({
      method
    });
    const { executionContext, res, state } = createExecutionContext({
      route,
      req
    });

    await httpHandler.handle(executionContext);

    assert.equal(state.middlewareRuns, 0);
    assert.equal(res.status, `405 Method Not Allowed`);
    assert.equal(res.headers.Allow, `GET, HEAD, OPTIONS`);
    assert.equal(res.body, `Method Not Allowed`);
  }
});
