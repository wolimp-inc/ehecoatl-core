// test/proxied-request-canonicalization.test.js

'use strict';

require(`../utils/register-module-aliases`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);

const RequestData = require(`@/_core/runtimes/ingress-runtime/execution/request-data`);
const TenantRoute = require(`@/_core/runtimes/ingress-runtime/execution/tenant-route`);
const httpHandler = require(`@/builtin-extensions/adapters/inbound/ingress-runtime/uws/http-handler`);

function createMockUwsResponse() {
  return {
    status: null,
    headers: null,
    body: null,
    abortedHandler: null,
    cork(fn) { fn(); },
    onAborted(fn) { this.abortedHandler = fn; },
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
      this.body = body;
      return this;
    }
  };
}

test(`RequestData preserves custom headers while using canonical proxy metadata`, () => {
  const requestData = new RequestData({
    method: `get`,
    url: `tenant.test/hello`,
    hostname: `tenant.test`,
    protocol: `https`,
    port: `443`,
    path: `/hello`,
    query: `foo=bar&foo=baz`,
    headers: {
      host: `tenant.test`,
      cookie: `session=abc123; theme=amber`,
      'x-custom-header': `custom-value`,
      'x-forwarded-host': `tenant.test`
    },
    ip: `203.0.113.10`
  });

  assert.equal(requestData.method, `GET`);
  assert.equal(requestData.hostname, `tenant.test`);
  assert.equal(requestData.protocol, `https`);
  assert.equal(requestData.port, 443);
  assert.equal(requestData.path, `/hello`);
  assert.deepEqual(requestData.query, {
    foo: [`bar`, `baz`]
  });
  assert.equal(requestData.headers.host, `tenant.test`);
  assert.equal(requestData.headers[`x-custom-header`], `custom-value`);
  assert.deepEqual(requestData.cookie, {
    session: `abc123`,
    theme: `amber`
  });
});

test(`http handler canonicalizes request data from forwarded proxy headers`, async () => {
  const res = createMockUwsResponse();
  const req = {
    forEach(callback) {
      callback(`host`, `127.0.0.1`);
      callback(`cookie`, `session=abc123; theme=amber`);
      callback(`x-custom-header`, `custom-value`);
      callback(`x-forwarded-host`, `tenant.test`);
      callback(`x-forwarded-proto`, `https`);
      callback(`x-forwarded-port`, `443`);
      callback(`x-forwarded-method`, `GET`);
      callback(`x-forwarded-uri`, `//proxy-path///`);
      callback(`x-forwarded-query`, `foo=bar&foo=baz&hello=world`);
      callback(`x-forwarded-for`, `203.0.113.10, 127.0.0.1`);
      callback(`x-real-ip`, `203.0.113.10`);
    },
    getQuery() {
      return ``;
    },
    getMethod() {
      return `GET`;
    },
    getUrl() {
      return `/raw-path-that-should-not-be-used`;
    }
  };

  const executionContext = {
    req,
    res,
    ip: `10.0.0.5`,
    requestData: null,
    projectRoute: null,
    responseData: { status: 200, headers: {}, body: `ok` },
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
    async run() {},
    async setupRequestData(data) {
      this.requestData = new RequestData(data);
    },
    async runHttpMiddlewareStack() {
      this.responseData.body = `ok`;
    },
    async end() {},
    isAborted() {
      return false;
    },
    abort() {}
  };

  executionContext.directorHelper = {
    async resolveRoute() {
      executionContext.projectRoute = {
        methodsAvailable: [`GET`],
        methods: [`GET`],
        contentTypes: null,
        session: false,
        allowsHostMethod(method) {
          return this.methodsAvailable.includes(method);
        },
        allowsMethod(method) {
          return this.methods.includes(method);
        },
        allowsContentType() {
          return true;
        },
        isRedirect() {
          return false;
        }
      };
    }
  };

  await httpHandler.handle(executionContext);

  assert.equal(executionContext.ip, `203.0.113.10`);
  assert.equal(executionContext.requestData.method, `GET`);
  assert.equal(executionContext.requestData.hostname, `tenant.test`);
  assert.equal(executionContext.requestData.protocol, `https`);
  assert.equal(executionContext.requestData.port, 443);
  assert.equal(executionContext.requestData.path, `/proxy-path`);
  assert.equal(executionContext.requestData.url, `tenant.test/proxy-path`);
  assert.deepEqual(executionContext.requestData.query, {
    foo: [`bar`, `baz`],
    hello: `world`
  });
  assert.equal(executionContext.requestData.headers.host, `tenant.test`);
  assert.equal(executionContext.requestData.headers[`x-custom-header`], `custom-value`);
  assert.deepEqual(executionContext.requestData.cookie, {
    session: `abc123`,
    theme: `amber`
  });
  assert.equal(res.status, `200 OK`);
});

test(`http handler rejects proxied requests missing required forwarded headers`, async () => {
  const res = createMockUwsResponse();
  const req = {
    forEach(callback) {
      callback(`host`, `tenant.test`);
      callback(`x-forwarded-host`, `tenant.test`);
      callback(`x-forwarded-proto`, `http`);
      callback(`x-forwarded-port`, `80`);
      callback(`x-forwarded-uri`, `/hello`);
      callback(`x-forwarded-query`, ``);
      callback(`x-forwarded-for`, `203.0.113.10`);
    },
    getQuery() {
      return ``;
    },
    getMethod() {
      return `GET`;
    },
    getUrl() {
      return `/hello`;
    }
  };

  const executionContext = {
    req,
    res,
    requestData: null,
    projectRoute: null,
    responseData: { status: 200, headers: {}, body: null },
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
    async run() {},
    async setupRequestData(data) {
      this.requestData = data;
    },
    async runHttpMiddlewareStack() {},
    async end() {},
    isAborted() {
      return false;
    },
    abort() {}
  };

  executionContext.directorHelper = {
    async resolveRoute() {
      throw new Error(`resolveRoute should not be called`);
    }
  };

  await httpHandler.handle(executionContext);

  assert.equal(executionContext.requestData, null);
  assert.equal(res.status, `400 Bad Request`);
  assert.equal(res.body, `Bad Request`);
});

test(`http handler prefixes root-relative redirects in path routing mode`, async () => {
  const res = createMockUwsResponse();
  const executionContext = createRedirectExecutionContext({
    res,
    redirectLocation: `/htm/index.htm`,
    domainRoutingMode: `path`,
    appName: `app1`
  });

  await httpHandler.handle(executionContext);

  assert.equal(res.status, `302 Found`);
  assert.equal(res.headers.Location, `/app1/htm/index.htm`);
});

test(`http handler prefixes root-relative redirects from normalized tenant routes`, async () => {
  const res = createMockUwsResponse();
  const executionContext = createRedirectExecutionContext({
    res,
    redirectLocation: `/htm/index.htm`,
    domainRoutingMode: `path`,
    appName: `app1`,
    useProjectRoute: true
  });

  await httpHandler.handle(executionContext);

  assert.equal(res.status, `302 Found`);
  assert.equal(res.headers.Location, `/app1/htm/index.htm`);
});

test(`http handler does not double-prefix app redirects in path routing mode`, async () => {
  const res = createMockUwsResponse();
  const executionContext = createRedirectExecutionContext({
    res,
    redirectLocation: `/app1/htm/index.htm`,
    domainRoutingMode: `path`,
    appName: `app1`
  });

  await httpHandler.handle(executionContext);

  assert.equal(res.status, `302 Found`);
  assert.equal(res.headers.Location, `/app1/htm/index.htm`);
});

test(`http handler leaves external and non-path-mode redirects unchanged`, async () => {
  for (const redirectLocation of [`https://example.com`, `//cdn.example.com/file.js`]) {
    const res = createMockUwsResponse();
    const executionContext = createRedirectExecutionContext({
      res,
      redirectLocation,
      domainRoutingMode: `path`,
      appName: `app1`
    });

    await httpHandler.handle(executionContext);

    assert.equal(res.headers.Location, redirectLocation);
  }

  const res = createMockUwsResponse();
  const executionContext = createRedirectExecutionContext({
    res,
    redirectLocation: `/htm/index.htm`,
    domainRoutingMode: `subdomain`,
    appName: `app1`
  });

  await httpHandler.handle(executionContext);

  assert.equal(res.headers.Location, `/htm/index.htm`);
});

function createRedirectExecutionContext({
  res,
  redirectLocation,
  domainRoutingMode,
  appName,
  useProjectRoute = false
}) {
  const req = {
    forEach(callback) {
      callback(`x-forwarded-host`, `tenant.test`);
      callback(`x-forwarded-proto`, `https`);
      callback(`x-forwarded-port`, `443`);
      callback(`x-forwarded-method`, `GET`);
      callback(`x-forwarded-uri`, `/app1`);
      callback(`x-forwarded-query`, ``);
      callback(`x-forwarded-for`, `203.0.113.10`);
    },
    getQuery() {
      return ``;
    },
    getMethod() {
      return `GET`;
    },
    getUrl() {
      return `/app1`;
    }
  };

  const executionContext = {
    req,
    res,
    requestData: null,
    projectRoute: null,
    responseData: { status: 200, headers: {}, body: null },
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
    async run() {},
    async setupRequestData(data) {
      this.requestData = new RequestData(data);
    },
    async runHttpMiddlewareStack() {},
    async end() {},
    isAborted() {
      return false;
    },
    abort() {}
  };

  executionContext.directorHelper = {
    async resolveRoute() {
      const routeData = {
        domainRoutingMode,
        origin: {
          appName
        },
        target: {
          redirect: {
            status: 302,
            location: redirectLocation
          }
        },
        isRedirect() {
          return true;
        }
      };
      executionContext.projectRoute = useProjectRoute
        ? new TenantRoute(routeData)
        : routeData;
    }
  };

  return executionContext;
}
