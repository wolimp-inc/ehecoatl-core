'use strict';

require(`module-alias/register`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);

const staticAssetMiddleware = require(`@middleware/http/core-static-asset-serve`);
const responseCacheResolverMiddleware = require(`@middleware/http/core-response-cache-resolver`);
const writeHttpResponse = require(`@/builtin-extensions/adapters/inbound/ingress-runtime/uws/http-write-response`);

test(`static asset middleware emits nginx internal redirect for files inside assets root`, async () => {
  let body = null;
  const executionContext = {
    projectRoute: {
      folders: {
        tenantRootFolder: `/tmp/tenant`,
        rootFolder: `/tmp/tenant/app`,
        assetsRootFolder: `/tmp/tenant/app/assets`
      },
      isStaticAsset() {
        return true;
      },
      assetPath() {
        return `/tmp/tenant/app/assets/htm/index.htm`;
      }
    },
    services: {
      storage: {
        async fileExists(filePath) {
          return filePath === `/tmp/tenant/app/assets/htm/index.htm`;
        }
      }
    },
    setBody(value) {
      body = value;
    },
    setHeader() {},
    setStatus() {}
  };

  const continueMiddlewareStack = await staticAssetMiddleware(executionContext);

  assert.equal(continueMiddlewareStack, false);
  assert.deepEqual(body, {
    __ehecoatlBodyKind: `nginx-internal-redirect`,
    uri: `/_ehecoatl_internal/static/app/assets/htm/index.htm`
  });
});

test(`static asset middleware rejects asset paths outside the assets root`, async () => {
  const responseData = {
    status: 200,
    headers: {},
    body: null
  };
  const executionContext = {
    projectRoute: {
      folders: {
        tenantRootFolder: `/tmp/tenant`,
        rootFolder: `/tmp/tenant/app`,
        assetsRootFolder: `/tmp/tenant/app/assets`
      },
      isStaticAsset() {
        return true;
      },
      assetPath() {
        return `/tmp/tenant/other/file.txt`;
      }
    },
    services: {
      storage: {
        async fileExists(filePath) {
          return filePath === `/tmp/tenant/other/file.txt`;
        }
      }
    },
    setBody(value) {
      responseData.body = value;
    },
    setHeader(key, value) {
      responseData.headers[key] = value;
    },
    setStatus(status) {
      responseData.status = status;
    }
  };

  const continueMiddlewareStack = await staticAssetMiddleware(executionContext);

  assert.equal(continueMiddlewareStack, false);
  assert.equal(responseData.status, 404);
  assert.match(String(responseData.body), /Static asset route resolved/);
});

test(`response cache resolver emits nginx internal redirect for cache hits inside the tenant cache root`, async () => {
  let body = null;
  const middlewareContext = {
    projectRoute: {
      cache: 60,
      folders: {
        rootFolder: `/tmp/tenant`
      },
      isStaticAsset() {
        return false;
      }
    },
    requestData: {
      url: `tenant.test/hello`
    },
    services: {
      cache: {
        async get() {
          return `/tmp/tenant/.ehecoatl/.cache/tenant.test_hello.json`;
        }
      },
      storage: {
        async fileExists(filePath) {
          return filePath === `/tmp/tenant/.ehecoatl/.cache/tenant.test_hello.json`;
        }
      }
    },
    meta: {},
    setBody(value) {
      body = value;
    }
  };

  const continueMiddlewareStack = await responseCacheResolverMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, false);
  assert.deepEqual(body, {
    __ehecoatlBodyKind: `nginx-internal-redirect`,
    uri: `/_ehecoatl_internal/cache/tenant.test_hello.json`
  });
  assert.equal(middlewareContext.meta.cached, true);
});

test(`http write response translates nginx internal redirect instruction into X-Accel-Redirect`, async () => {
  const headersWritten = {};
  let statusWritten = null;
  let endedBody = undefined;
  const executionContext = {
    meta: {},
    requestData: null,
    responseData: {
      status: 200,
      headers: {
        'Content-Type': `text/html`,
        'X-Accel-Redirect': `/should-be-ignored`
      },
      body: {
        __ehecoatlBodyKind: `nginx-internal-redirect`,
        uri: `/_ehecoatl_internal/static/app/assets/htm/index.htm`
      }
    },
    res: {
      cork(fn) { fn(); },
      writeStatus(value) {
        statusWritten = value;
        return this;
      },
      writeHeader(key, value) {
        headersWritten[key] = value;
        return this;
      },
      end(value) {
        endedBody = value;
      }
    },
    hooks: {
      RESPONSE: {
        WRITE: { START: `write.start`, END: `write.end`, BREAK: `write.break`, ERROR: `write.error` }
      }
    },
    async run() {},
    isAborted() {
      return false;
    }
  };

  await writeHttpResponse(executionContext);

  assert.equal(statusWritten, `200 OK`);
  assert.equal(headersWritten[`X-Accel-Redirect`], `/_ehecoatl_internal/static/app/assets/htm/index.htm`);
  assert.equal(headersWritten[`Content-Type`], `text/html`);
  assert.equal(endedBody, undefined);
});
