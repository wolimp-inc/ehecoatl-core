'use strict';

const test = require(`node:test`);
const assert = require(`node:assert/strict`);
const fs = require(`node:fs`);
const os = require(`node:os`);
const path = require(`node:path`);
const { Readable } = require(`node:stream`);
const Module = require(`node:module`);

installLocalAliasResolver();

const runMiddleware = require(`../builtin-extensions/middlewares/http/core-tenant-action`);
const { resolveI18nSourcePaths } = require(`../builtin-extensions/middlewares/http/_template-render-support`);

test(`core-tenant-action renders action templates with app/shared asset fallback and merged i18n/view`, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-action-render-`));
  const appRoot = path.join(tempRoot, `app-root`);
  const appAssetsRoot = path.join(appRoot, `assets`);
  const sharedAssetsRoot = path.join(tempRoot, `shared-assets`);
  fs.mkdirSync(path.join(appRoot, `assets`, `i18n`, `shared`), { recursive: true });
  fs.mkdirSync(path.join(appRoot, `assets`, `i18n`), { recursive: true });
  fs.mkdirSync(path.join(sharedAssetsRoot, `static`, `htm`), { recursive: true });
  fs.writeFileSync(path.join(sharedAssetsRoot, `static`, `htm`, `page.e.htm`), `<h1>{{view.title}}</h1>`, `utf8`);
  fs.writeFileSync(path.join(appRoot, `assets`, `i18n`, `shared`, `common.json`), `{"shared":"yes"}`, `utf8`);
  fs.writeFileSync(path.join(appRoot, `assets`, `i18n`, `page.override.json`), `{"override":"yes"}`, `utf8`);

  const middlewareContext = createMiddlewareContext({
    projectRoute: {
      target: { run: { resource: `actions/example.js`, action: `index` } },
      origin: { hostname: `tenant.test`, domain: `tenant.test`, appName: `www` },
      i18n: [`shared/common.json`],
      folders: {
        rootFolder: appRoot,
        assetsRootFolder: appAssetsRoot,
        assetsSharedRootFolder: sharedAssetsRoot
      }
    },
    requestData: {
      method: `GET`,
      url: `tenant.test/action/template`,
      path: `/action/template`,
      hostname: `tenant.test`
    },
    sessionData: {
      userId: `user_1`
    },
    viewData: {
      fromMiddleware: `middleware-value`,
      title: `middleware-title`
    },
    services: {
      storage: {
        async fileExists(targetPath) {
          return fs.existsSync(targetPath);
        }
      },
      eRendererRuntime: {
        async renderView(templatePath, i18nJSONSources, renderContextSeed) {
          assert.equal(templatePath, path.join(sharedAssetsRoot, `static`, `htm`, `page.e.htm`));
          assert.deepEqual(i18nJSONSources, [
            path.join(appRoot, `assets`, `i18n`, `shared`, `common.json`),
            path.join(appRoot, `assets`, `i18n`, `page.override.json`)
          ]);
          assert.equal(renderContextSeed.request.path, `/action/template`);
          assert.equal(renderContextSeed.session.userId, `user_1`);
          assert.equal(renderContextSeed.route.origin.appName, `www`);
          assert.deepEqual(renderContextSeed.view, {
            fromMiddleware: `middleware-value`,
            title: `action-title`
          });
          return Readable.from([`<h1>ok</h1>`]);
        }
      },
      rpc: {
        async ask() {
          return {
            status: 200,
            headers: {
              'X-Render-Mode': `action`
            },
            cookie: {
              traceId: {
                value: `abc123`,
                path: `/`
              }
            },
            render: {
              template: `static/htm/page.e.htm`,
              view: {
                title: `action-title`
              },
              i18n: [
                `page.override.json`
              ]
            }
          };
        }
      }
    }
  });

  const continueMiddlewareStack = await runMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, true);
  assert.equal(middlewareContext.responseData.status, 200);
  assert.equal(middlewareContext.responseData.headers[`Content-Type`], `text/html; charset=utf-8`);
  assert.equal(middlewareContext.responseData.headers[`X-Render-Mode`], `action`);
  assert.deepEqual(middlewareContext.responseData.cookie.traceId, {
    value: `abc123`,
    path: `/`
  });
  assert.equal(typeof middlewareContext.responseData.body.pipe, `function`);
});

test(`template render support normalizes canonical and bare i18n entries under assets/i18n`, () => {
  assert.deepEqual(
    resolveI18nSourcePaths(`/tmp/app-root`, [
      `assets/i18n/shared/common.json`,
      `page.override.json`
    ], {
      entryLabel: `render.i18n`
    }),
    [
      `/tmp/app-root/assets/i18n/shared/common.json`,
      `/tmp/app-root/assets/i18n/page.override.json`
    ]
  );
});

test(`core-tenant-action rejects action responses that define both body and render`, async () => {
  const middlewareContext = createMiddlewareContext({
    projectRoute: {
      target: { run: { resource: `actions/example.js`, action: `index` } },
      origin: { hostname: `tenant.test`, domain: `tenant.test`, appName: `www` },
      folders: {
        rootFolder: `/tmp/app-root`,
        assetsRootFolder: `/tmp/app-root/assets`,
        assetsSharedRootFolder: `/tmp/shared-assets`
      }
    },
    services: {
      rpc: {
        async ask() {
          return {
            status: 200,
            body: `plain-body`,
            render: {
              template: `static/htm/page.e.htm`
            }
          };
        }
      },
      eRendererRuntime: {
        async renderView() {
          throw new Error(`renderer should not be reached`);
        }
      }
    }
  });

  const continueMiddlewareStack = await runMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, true);
  assert.equal(middlewareContext.responseData.status, 500);
  assert.match(String(middlewareContext.responseData.body), /invalid response/i);
});

test(`core-tenant-action returns not found when the action render template is missing`, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-action-render-missing-`));
  const appRoot = path.join(tempRoot, `app-root`);
  const appAssetsRoot = path.join(appRoot, `assets`);
  fs.mkdirSync(appAssetsRoot, { recursive: true });

  const middlewareContext = createMiddlewareContext({
    projectRoute: {
      target: { run: { resource: `actions/example.js`, action: `index` } },
      origin: { hostname: `tenant.test`, domain: `tenant.test`, appName: `www` },
      folders: {
        rootFolder: appRoot,
        assetsRootFolder: appAssetsRoot,
        assetsSharedRootFolder: path.join(tempRoot, `shared-assets`)
      }
    },
    services: {
      storage: {
        async fileExists(targetPath) {
          return fs.existsSync(targetPath);
        }
      },
      eRendererRuntime: {
        async renderView() {
          throw new Error(`renderer should not be reached`);
        }
      },
      rpc: {
        async ask() {
          return {
            render: {
              template: `static/htm/missing.e.htm`
            }
          };
        }
      }
    }
  });

  const continueMiddlewareStack = await runMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, true);
  assert.equal(middlewareContext.responseData.status, 404);
  assert.match(String(middlewareContext.responseData.body), /render target was not found/i);
});

test(`core-tenant-action rejects escaping render paths safely`, async () => {
  const middlewareContext = createMiddlewareContext({
    projectRoute: {
      target: { run: { resource: `actions/example.js`, action: `index` } },
      origin: { hostname: `tenant.test`, domain: `tenant.test`, appName: `www` },
      folders: {
        rootFolder: `/tmp/app-root`,
        assetsRootFolder: `/tmp/app-root/assets`,
        assetsSharedRootFolder: `/tmp/shared-assets`
      }
    },
    services: {
      storage: {
        async fileExists() {
          return false;
        }
      },
      eRendererRuntime: {
        async renderView() {
          throw new Error(`renderer should not be reached`);
        }
      },
      rpc: {
        async ask() {
          return {
            render: {
              template: `../escape.e.htm`
            }
          };
        }
      }
    }
  });

  const continueMiddlewareStack = await runMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, true);
  assert.equal(middlewareContext.responseData.status, 500);
  assert.match(String(middlewareContext.responseData.body), /render configuration is invalid/i);
});

test(`core-tenant-action preserves existing body-only responses`, async () => {
  const middlewareContext = createMiddlewareContext({
    projectRoute: {
      target: { run: { resource: `actions/example.js`, action: `index` } },
      origin: { hostname: `tenant.test`, domain: `tenant.test`, appName: `www` },
      folders: {
        rootFolder: `/tmp/app-root`,
        assetsRootFolder: `/tmp/app-root/assets`,
        assetsSharedRootFolder: `/tmp/shared-assets`
      }
    },
    services: {
      rpc: {
        async ask() {
          return {
            status: 201,
            headers: {
              'Content-Type': `application/json`
            },
            body: {
              success: true
            }
          };
        }
      }
    }
  });

  const continueMiddlewareStack = await runMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, true);
  assert.equal(middlewareContext.responseData.status, 201);
  assert.deepEqual(middlewareContext.responseData.body, {
    success: true
  });
  assert.equal(middlewareContext.responseData.headers[`Content-Type`], `application/json`);
});

function createMiddlewareContext({
  projectRoute,
  requestData = {
    method: `GET`,
    url: `tenant.test/example`,
    path: `/example`,
    hostname: `tenant.test`
  },
  sessionData = {},
  viewData = {},
  services = {}
}) {
  return {
    projectRoute,
    requestData,
    sessionData,
    viewData,
    services,
    meta: {},
    responseData: {
      status: 200,
      body: null,
      headers: {},
      cookie: {}
    },
    setStatus(status) {
      this.responseData.status = status;
    },
    setBody(body) {
      this.responseData.body = body;
    },
    setHeader(key, value) {
      this.responseData.headers[key] = value;
    },
    setCookie(key, value) {
      this.responseData.cookie[key] = value;
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
    } else if (typeof request === `string` && request.startsWith(`@adapter/`)) {
      request = path.join(projectRoot, `builtin-extensions`, `adapters`, request.slice(`@adapter/`.length));
    }
    return originalResolveFilename.call(this, request, parent, ...rest);
  };
}
