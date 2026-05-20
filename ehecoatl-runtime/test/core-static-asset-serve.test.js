// test/core-static-asset-serve.test.js


'use strict';

require(`module-alias/register`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);
const { Readable } = require(`node:stream`);

const runMiddleware = require(`@/builtin-extensions/middlewares/http/core-static-asset-serve`);

test(`core-static-asset-serve renders compatible .e.html assets through eRendererRuntime`, async () => {
  const executionContext = createExecutionContext({
    projectRoute: {
      isStaticAsset: () => true,
      assetPath: () => `/tmp/app/assets/page.e.html`,
      i18n: [`default.json`],
      folders: {
        rootFolder: `/tmp/app`
      }
    },
    services: {
      storage: {
        async fileExists() { return true; }
      },
      eRendererRuntime: {
        isCompatibleTemplate: (targetPath) => targetPath.endsWith(`.e.html`),
        async renderView(template, i18nJSONSources, renderContextSeed) {
          assert.equal(template, `/tmp/app/assets/page.e.html`);
          assert.deepEqual(i18nJSONSources, [`/tmp/app/assets/i18n/default.json`]);
          assert.equal(renderContextSeed.request.method, `GET`);
          assert.equal(renderContextSeed.session.userId, `user_1`);
          assert.equal(renderContextSeed.route, executionContext.projectRoute);
          return Readable.from([`<h1>Hello</h1>`]);
        }
      }
    }
  });

  let nextCalled = false;
  await runMiddleware(executionContext, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(executionContext.responseData.headers[`Content-Type`], `text/html; charset=utf-8`);
  assert.equal(typeof executionContext.responseData.body.pipe, `function`);
});

test(`core-static-asset-serve ignores route i18n for non-compatible assets`, async () => {
  const executionContext = createExecutionContext({
    projectRoute: {
      isStaticAsset: () => true,
      assetPath: () => `/tmp/app/assets/page.html`,
      i18n: [`default.json`],
      folders: {
        rootFolder: `/tmp/app`,
        tenantRootFolder: `/tmp/app`,
        assetsRootFolder: `/tmp/app/assets`
      }
    },
    services: {
      storage: {
        async fileExists() { return true; }
      },
      eRendererRuntime: {
        isCompatibleTemplate: () => false,
        async renderView() {
          throw new Error(`should not render`);
        }
      }
    }
  });

  let nextCalled = false;
  await runMiddleware(executionContext, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(executionContext.responseData.body.__ehecoatlBodyKind, `nginx-internal-redirect`);
});

function createExecutionContext({
  projectRoute,
  services
}) {
  return {
    projectRoute,
    services,
    responseData: {
      status: 200,
      headers: {}
    },
    requestData: {
      method: `GET`,
      url: `https://www.example.test/page`
    },
    sessionData: {
      userId: `user_1`
    },
    setStatus(status) {
      this.responseData.status = status;
    },
    setBody(body) {
      this.responseData.body = body;
    },
    setHeader(key, value) {
      this.responseData.headers[key] = value;
    }
  };
}
