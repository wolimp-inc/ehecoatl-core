// test/future-system-improvements.test.js


'use strict';

require(`module-alias/register`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);
const fs = require(`node:fs`);
const os = require(`node:os`);
const path = require(`node:path`);

const readBody = require(`@adapter/inbound/ingress-runtime/uws/http-read-body`);
const handleHttp = require(`@adapter/inbound/ingress-runtime/uws/http-handler`).handle;
const tenantActionMiddleware = require(`@middleware/http/core-tenant-action`);
const staticAssetServeMiddleware = require(`@middleware/http/core-static-asset-serve`);
const responseCacheResolverMiddleware = require(`@middleware/http/core-response-cache-resolver`);
const Network2ManagerResolver = require(`@/_core/runtimes/ingress-runtime/director-runtime-resolver`);
const ExecutionMetaData = require(`@/_core/runtimes/ingress-runtime/execution/execution-meta-data`);
const ExecutionContext = require(`@/_core/runtimes/ingress-runtime/execution/execution-context`);
const TenantRoute = require(`@/_core/runtimes/ingress-runtime/execution/tenant-route`);
const QueueManager = require(`@/_core/managers/queue-manager`);
const TenantDirectoryResolver = require(`@/_core/resolvers/tenant-directory-resolver`);
const TenantRouteMatcherCompiler = require(`@/_core/compilers/tenant-route-matcher-compiler`);
const RequestUriRoutingRuntime = require(`@/_core/runtimes/request-uri-routing-runtime`);
const TenantRouteMeta = require(`@/_core/runtimes/ingress-runtime/execution/tenant-route-meta`);
const RpcRuntime = require(`@/_core/runtimes/rpc-runtime`);
const SharedCacheService = require(`@/_core/services/shared-cache-service`);
const MessageSchema = require(`@/_core/runtimes/rpc-runtime/schemas/message-schema`);
const queueBrokerAdapter = require(`@adapter/inbound/queue-manager/event-memory`);
const defaultTenancyAdapter = require(`@adapter/inbound/tenant-directory-resolver/default-tenancy`);
const defaultRouteMatcherCompilerAdapter = require(`@adapter/inbound/tenant-route-matcher-compiler/default-routing-v1`);
const defaultUriRouterRuntimeAdapter = require(`@adapter/inbound/request-uri-routing-runtime/default-uri-router-runtime`);
const runtimeReporter = require(`@plugin/runtime-reporter`);
const { createHourlyFileLogger } = require(`@/utils/logger/hourly-file-logger`);
const { classifyRequestLatency } = require(`@/utils/observability/request-latency-classifier`);
const { createTenantReportWriter } = require(`@/utils/observability/tenant-report-writer`);
const { parseRouteTargetString } = require(`@/utils/tenancy/route-target`);
const { bootIsolatedAppEntrypoint, handleIsolatedActionRequest } = require(`@/bootstrap/process-isolated-runtime`);

test(`tenant action stage preserves tenant-provided failure status and body`, async () => {
  const responseData = {
    status: 200,
    body: null,
    headers: {},
    cookie: null
  };
  const middlewareContext = {
    projectRoute: { target: { run: { resource: `actions/example.js`, action: `index` } }, origin: { hostname: `tenant.test`, domain: `tenant.test`, appName: `www` } },
    requestData: { url: `tenant.test/missing` },
    sessionData: {},
    services: {
      rpc: {
        async ask() {
          return {
            success: false,
            status: 404,
            body: `Action not found`,
            headers: { 'Content-Type': `text/plain; charset=utf-8` }
          };
        }
      }
    },
    setStatus(status) {
      responseData.status = status;
    },
    setBody(body) {
      responseData.body = body;
    },
    setHeader(key, value) {
      responseData.headers[key] = value;
    },
    setCookie() {
      throw new Error(`cookie should not be set`);
    }
  };

  const continueMiddlewareStack = await tenantActionMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, true);
  assert.equal(responseData.status, 404);
  assert.equal(responseData.body, `Action not found`);
  assert.equal(responseData.headers[`Content-Type`], `text/plain; charset=utf-8`);
});

test(`tenant action stage preserves tenant-provided failure headers and cookies`, async () => {
  const responseData = {
    status: 200,
    body: null,
    headers: {},
    cookie: {}
  };
  const middlewareContext = {
    projectRoute: { target: { run: { resource: `actions/example.js`, action: `index` } }, origin: { hostname: `tenant.test`, domain: `tenant.test`, appName: `www` } },
    requestData: { url: `tenant.test/failure` },
    sessionData: {},
    services: {
      rpc: {
        async ask() {
          return {
            success: false,
            status: 500,
            body: `Tenant failure`,
            headers: { 'X-Tenant-Error': `action-failed` },
            cookie: {
              traceId: {
                value: `abc123`,
                httpOnly: true,
                path: `/`
              }
            }
          };
        }
      }
    },
    setStatus(status) {
      responseData.status = status;
    },
    setBody(body) {
      responseData.body = body;
    },
    setHeader(key, value) {
      responseData.headers[key] = value;
    },
    setCookie(key, value) {
      responseData.cookie[key] = value;
    }
  };

  const continueMiddlewareStack = await tenantActionMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, true);
  assert.equal(responseData.status, 500);
  assert.equal(responseData.body, `Tenant failure`);
  assert.equal(responseData.headers[`X-Tenant-Error`], `action-failed`);
  assert.deepEqual(responseData.cookie.traceId, {
    value: `abc123`,
    httpOnly: true,
    path: `/`
  });
});

test(`tenant action stage uses a non-production fallback body when tenant RPC fails`, async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = `development`;

  try {
    const responseData = {
      status: 200,
      body: null,
      headers: {}
    };
    const middlewareContext = {
      projectRoute: { target: { run: { resource: `actions/example.js`, action: `index` } }, origin: { hostname: `tenant.test`, domain: `tenant.test`, appName: `www` } },
      requestData: { url: `tenant.test/failure` },
      sessionData: {},
      services: {
        rpc: {
          async ask() {
            throw new Error(`tenant unavailable`);
          }
        }
      },
      setStatus(status) {
        responseData.status = status;
      },
      setBody(body) {
        responseData.body = body;
      },
      setHeader(key, value) {
        responseData.headers[key] = value;
      },
      setCookie() { }
    };

    const continueMiddlewareStack = await tenantActionMiddleware(middlewareContext);

    assert.equal(continueMiddlewareStack, false);
    assert.equal(responseData.status, 502);
    assert.equal(responseData.headers[`Content-Type`], `text/plain; charset=utf-8`);
    assert.equal(
      responseData.body,
      `Tenant action is unavailable in this non-production environment. See runtime logs for details.`
    );
  } finally {
    restoreNodeEnv(previousNodeEnv);
  }
});

test(`tenant action stage records action execution metadata from detailed RPC responses`, async () => {
  const responseData = {
    status: 200,
    body: null,
    headers: {},
    cookie: {}
  };
  const meta = new ExecutionMetaData();
  meta.requestId = `req-action-01`;
  meta.correlationId = `req-action-01`;
  let rpcRequest = null;
  const middlewareContext = {
    projectRoute: { target: { run: { resource: `actions/example.js`, action: `index` } }, origin: { hostname: `tenant.test`, domain: `tenant.test`, appName: `www` } },
    requestData: { url: `tenant.test/hello`, requestId: `req-action-01` },
    sessionData: {},
    meta,
    services: {
      rpc: {
        async askDetailed(request) {
          rpcRequest = request;
          return {
            data: {
              status: 200,
              body: `Hello from tenant`
            },
            internalMeta: {
              actionMeta: {
                coldWaitMs: 18,
                actionMs: 42
              }
            }
          };
        }
      }
    },
    setStatus(status) {
      responseData.status = status;
    },
    setBody(body) {
      responseData.body = body;
    },
    setHeader(key, value) {
      responseData.headers[key] = value;
    },
    setCookie(key, value) {
      responseData.cookie[key] = value;
    }
  };

  const continueMiddlewareStack = await tenantActionMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, true);
  assert.equal(meta.action, true);
  assert.deepEqual(rpcRequest.internalMeta, {
    requestId: `req-action-01`,
    correlationId: `req-action-01`
  });
  assert.deepEqual(meta.actionMeta, {
    coldWaitMs: 18,
    actionMs: 42
  });
  assert.equal(responseData.status, 200);
  assert.equal(responseData.body, `Hello from tenant`);
});

test(`isolated runtime action handling returns 404 when the run target module is missing`, async () => {
  const response = await handleIsolatedActionRequest({
    projectRoute: {
      run: `missing@show`,
      resource: `missing`,
      action: `show`
    },
    requestData: { url: `tenant.test/missing` },
    sessionData: {},
    appRoot: `/tmp/non-existent-tenant`,
    isolatedLabel: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb`,
    isolatedApp: null,
    services: {},
    actionCache: new Map()
  });

  assert.equal(response.success, false);
  assert.equal(response.status, 404);
  assert.equal(response.body, `Action not found`);
  assert.equal(response.error.run, `missing@show`);
  assert.equal(response.error.resource, `missing`);
  assert.equal(response.error.action, `show`);
  assert.equal(typeof response.error.error, `string`);
});

test(`isolated runtime action handling returns 500 for an invalid action handler`, async () => {
  const tempRoot = path.join(process.cwd(), `.tmp-invalid-action-handler`);
  const actionPath = path.join(tempRoot, `actions`, `invalid.js`);
  require(`fs`).mkdirSync(path.dirname(actionPath), { recursive: true });
  require(`fs`).writeFileSync(actionPath, `module.exports = { notAHandler: true };\n`);

  try {
    const response = await handleIsolatedActionRequest({
      projectRoute: {
        run: `invalid@show`,
        resource: `invalid`,
        action: `show`
      },
      requestData: { url: `tenant.test/invalid-handler` },
      sessionData: {},
      appRoot: tempRoot,
      isolatedLabel: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb`,
      isolatedApp: null,
      services: {},
      actionCache: new Map()
    });

    assert.equal(response.success, false);
    assert.equal(response.status, 500);
    assert.equal(response.body, `Invalid action handler`);
    assert.deepEqual(response.error, {
      run: `invalid@show`,
      resource: `invalid`,
      action: `show`
    });
  } finally {
    delete require.cache[require.resolve(actionPath)];
    require(`fs`).rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(`isolated runtime action handling returns 500 when action loading fails for non-missing errors`, async () => {
  const tempRoot = path.join(process.cwd(), `.tmp-action-load-failure`);
  const actionPath = path.join(tempRoot, `actions`, `broken.js`);
  require(`fs`).mkdirSync(path.dirname(actionPath), { recursive: true });
  require(`fs`).writeFileSync(actionPath, `throw new Error('broken action load');\n`);

  try {
    const response = await handleIsolatedActionRequest({
      projectRoute: {
        run: `broken@show`,
        resource: `broken`,
        action: `show`
      },
      requestData: { url: `tenant.test/broken-action` },
      sessionData: {},
      appRoot: tempRoot,
      isolatedLabel: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb`,
      isolatedApp: null,
      services: {},
      actionCache: new Map()
    });

    assert.equal(response.success, false);
    assert.equal(response.status, 500);
    assert.equal(response.body, `Action load failure`);
    assert.equal(response.error.run, `broken@show`);
    assert.equal(response.error.resource, `broken`);
    assert.equal(response.error.action, `show`);
    assert.match(response.error.error, /broken action load/);
  } finally {
    delete require.cache[require.resolve(actionPath)];
    require(`fs`).rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(`process-isolated-runtime resolves app topology from the entrypoint topology property`, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-app-topology-`));
  const entryPath = path.join(tempRoot, `index.js`);

  fs.writeFileSync(entryPath, `
'use strict';

module.exports = {
  topology({ appRoot }) {
    return {
      topology: 'custom',
      app: {
        http: {
          actions: appRoot + '/app/http/actions'
        }
      }
    };
  },
  boot({ appTopology }) {
    globalThis.__capturedAppTopology = appTopology;
  }
};
`);

  try {
    const { isolatedApp, appTopology } = await bootIsolatedAppEntrypoint({
      appRoot: tempRoot,
      appDomain: `example.com`,
      appName: `www`,
      isolatedLabel: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb`,
      services: {}
    });

    assert.equal(isolatedApp, undefined);
    assert.equal(appTopology?.topology, `custom`);
    assert.equal(appTopology?.app?.http?.actions, `${tempRoot}/app/http/actions`);
    assert.deepEqual(globalThis.__capturedAppTopology, appTopology);
  } finally {
    delete globalThis.__capturedAppTopology;
    delete require.cache[require.resolve(entryPath)];
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(`isolated runtime action handling falls back to the declared app topology actions folder`, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-topology-action-`));
  const actionPath = path.join(tempRoot, `app`, `http`, `actions`, `hello.js`);
  fs.mkdirSync(path.dirname(actionPath), { recursive: true });
  fs.writeFileSync(
    actionPath,
    `module.exports = async function hello(context) { return { status: 200, body: context.appTopology.topology }; };\n`
  );

  try {
    const response = await handleIsolatedActionRequest({
      projectRoute: {
        target: {
          run: {
            resource: `hello`,
            action: `index`
          }
        }
      },
      requestData: { url: `tenant.test/hello` },
      sessionData: {},
      appRoot: tempRoot,
      isolatedLabel: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb`,
      isolatedApp: null,
      appTopology: {
        topology: `standard`,
        app: {
          http: {
            actions: path.join(tempRoot, `app`, `http`, `actions`)
          }
        }
      },
      services: {},
      actionCache: new Map()
    });

    assert.equal(response.status, 200);
    assert.equal(response.body, `standard`);
  } finally {
    delete require.cache[require.resolve(actionPath)];
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(`tenant action stage keeps the generic upstream body in production`, async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = `production`;

  try {
    const responseData = {
      status: 200,
      body: null,
      headers: {}
    };
    const middlewareContext = {
      projectRoute: { target: { run: { resource: `actions/example.js`, action: `index` } }, origin: { hostname: `tenant.test`, domain: `tenant.test`, appName: `www` } },
      requestData: { url: `tenant.test/failure` },
      sessionData: {},
      services: {
        rpc: {
          async ask() {
            throw new Error(`tenant unavailable`);
          }
        }
      },
      setStatus(status) {
        responseData.status = status;
      },
      setBody(body) {
        responseData.body = body;
      },
      setHeader(key, value) {
        responseData.headers[key] = value;
      },
      setCookie() { }
    };

    const continueMiddlewareStack = await tenantActionMiddleware(middlewareContext);

    assert.equal(continueMiddlewareStack, false);
    assert.equal(responseData.status, 502);
    assert.equal(responseData.headers[`Content-Type`], `text/plain; charset=utf-8`);
    assert.equal(responseData.body, `Bad Gateway`);
  } finally {
    restoreNodeEnv(previousNodeEnv);
  }
});

test(`tenant action stage reports transport failure directly without retrying GET actions`, async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = `production`;

  try {
    const responseData = {
      status: 200,
      body: null,
      headers: {}
    };
    let askCalls = 0;
    const middlewareContext = {
      projectRoute: { target: { run: { resource: `actions/example.js`, action: `index` } }, origin: { hostname: `tenant.test`, domain: `tenant.test`, appName: `www` } },
      requestData: { method: `GET`, url: `tenant.test/no-retry` },
      sessionData: {},
      services: {
        rpc: {
          async askDetailed() {
            askCalls += 1;
            throw new Error(`isolated runtime exited`);
          }
        }
      },
      setStatus(status) {
        responseData.status = status;
      },
      setBody(body) {
        responseData.body = body;
      },
      setHeader(key, value) {
        responseData.headers[key] = value;
      },
      setCookie() { }
    };

    const continueMiddlewareStack = await tenantActionMiddleware(middlewareContext);

    assert.equal(continueMiddlewareStack, false);
    assert.equal(askCalls, 1);
    assert.equal(responseData.status, 502);
    assert.equal(responseData.body, `Bad Gateway`);
  } finally {
    restoreNodeEnv(previousNodeEnv);
  }
});

test(`response cache materialization persists safe public action output`, async () => {
  const writes = [];
  const cacheSets = [];
  const middlewareContext = {
    projectRoute: {
      target: {
        run: {
          action: `hello@index`
        }
      },
      cache: 60,
      session: false,
      isStaticAsset() {
        return false;
      },
      getCacheFilePath(url) {
        return `/tmp/ehecoatl-cache/${url.replace(/\//g, `_`)}`;
      }
    },
    requestData: {
      method: `GET`,
      url: `tenant.test/hello`
    },
    services: {
      storage: {
        async createFolder(folderPath) {
          writes.push({ type: `mkdir`, folderPath });
        },
        async writeFile(filePath, body) {
          writes.push({ type: `write`, filePath, body });
        }
      },
      cache: {
        async get() {
          return null;
        },
        async set(key, value, ttl) {
          cacheSets.push({ key, value, ttl });
        }
      }
    },
    async askDirector(question, payload) {
      if (question === `queue`) {
        return {
          taskId: 1,
          first: true,
          queueLabel: payload.queueLabel
        };
      }
      return { success: true };
    },
    addFinishCallback() { },
    getStatus() {
      return 200;
    },
    getBody() {
      return { ok: true };
    },
    getHeaders() {
      return {};
    },
    getCookies() {
      return null;
    }
  };

  const continueMiddlewareStack = await responseCacheResolverMiddleware(middlewareContext, async () => true);
  await flushAsyncOperations();

  assert.equal(continueMiddlewareStack, true);
  assert.deepEqual(writes, [
    {
      type: `mkdir`,
      folderPath: path.dirname(`/tmp/ehecoatl-cache/tenant.test_hello.json`)
    },
    {
      type: `write`,
      filePath: `/tmp/ehecoatl-cache/tenant.test_hello.json`,
      body: `{"ok":true}`
    }
  ]);
  assert.deepEqual(cacheSets, [
    {
      key: `validResponseCache:tenant.test/hello`,
      value: `/tmp/ehecoatl-cache/tenant.test_hello.json`,
      ttl: 60000
    }
  ]);
});

test(`response cache materialization skips non-cacheable session routes`, async () => {
  let wrote = false;
  const middlewareContext = {
    projectRoute: {
      target: {
        run: {
          action: `session@index`
        }
      },
      cache: 60,
      session: true,
      isStaticAsset() {
        return false;
      },
      getCacheFilePath() {
        return `/tmp/should-not-write`;
      }
    },
    requestData: {
      method: `GET`,
      url: `tenant.test/session`
    },
    services: {
      storage: {
        async createFolder() {
          wrote = true;
        },
        async writeFile() {
          wrote = true;
        }
      },
      cache: {
        async get() {
          return null;
        },
        async set() {
          wrote = true;
        }
      }
    },
    async askDirector(question, payload) {
      if (question === `queue`) {
        return {
          taskId: 1,
          first: true,
          queueLabel: payload.queueLabel
        };
      }
      return { success: true };
    },
    addFinishCallback() { },
    getStatus() {
      return 200;
    },
    getBody() {
      return { ok: true };
    },
    getHeaders() {
      return {};
    },
    getCookies() {
      return null;
    }
  };

  const continueMiddlewareStack = await responseCacheResolverMiddleware(middlewareContext, async () => true);

  assert.equal(continueMiddlewareStack, true);
  assert.equal(wrote, false);
});

test(`response cache materialization skips write when tenant-specific disk limit is exceeded`, async () => {
  const tenantRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-disk-limit-block-`));
  const cacheSets = [];
  const writes = [];
  const middlewareContext = {
    projectRoute: {
      host: `tenant.test`,
      rootFolder: tenantRoot,
      origin: {
        hostname: `tenant.test`
      },
      folders: {
        rootFolder: tenantRoot
      },
      target: {
        run: {
          action: `hello@index`
        }
      },
      cache: 60,
      session: false,
      diskLimitBytes: 8,
      isStaticAsset() {
        return false;
      },
      getCacheFilePath(url) {
        return path.join(tenantRoot, `cache`, `${url.replace(/\//g, `_`)}`);
      }
    },
    requestData: {
      method: `GET`,
      url: `tenant.test/hello`
    },
    middlewareStackRuntimeConfig: {
      diskLimit: {
        enabled: true,
        defaultMaxBytes: `1GB`,
        trackedPaths: [`cache`],
        cleanupFirst: false
      }
    },
    services: {
      storage: {
        async listEntries(targetPath) {
          return await fs.promises.readdir(targetPath, { withFileTypes: true });
        },
        async fileStat(targetPath) {
          return await fs.promises.stat(targetPath);
        },
        async fileExists(targetPath) {
          try {
            await fs.promises.access(targetPath, fs.constants.F_OK);
            return true;
          } catch {
            return false;
          }
        },
        async deleteFile(targetPath) {
          try {
            await fs.promises.unlink(targetPath);
            return true;
          } catch (error) {
            if (error?.code === `ENOENT`) return false;
            throw error;
          }
        },
        async createFolder(folderPath) {
          writes.push({ type: `mkdir`, folderPath });
          await fs.promises.mkdir(folderPath, { recursive: true });
        },
        async writeFile(filePath, body) {
          writes.push({ type: `write`, filePath, body });
          await fs.promises.writeFile(filePath, body, `utf8`);
        }
      },
      cache: {
        async get() {
          return null;
        },
        async set(key, value, ttl) {
          cacheSets.push({ key, value, ttl });
        }
      }
    },
    async askDirector(question, payload) {
      if (question === `queue`) {
        return {
          taskId: 1,
          first: true,
          queueLabel: payload.queueLabel
        };
      }
      return { success: true };
    },
    addFinishCallback() { },
    getStatus() {
      return 200;
    },
    getBody() {
      return `0123456789`; //10 bytes
    },
    getHeaders() {
      return {};
    },
    getCookies() {
      return null;
    }
  };

  try {
    const continueMiddlewareStack = await responseCacheResolverMiddleware(middlewareContext, async () => true);
    await flushAsyncOperations();
    assert.equal(continueMiddlewareStack, true);
    assert.deepEqual(writes, []);
    assert.deepEqual(cacheSets, []);
  } finally {
    fs.rmSync(tenantRoot, { recursive: true, force: true });
  }
});

test(`response cache materialization can cleanup tracked files and proceed within disk limit`, async () => {
  const tenantRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-disk-limit-cleanup-`));
  const cacheSets = [];
  const writes = [];
  const deleted = [];
  const staleCacheFile = path.join(tenantRoot, `cache`, `stale.txt`);
  fs.mkdirSync(path.dirname(staleCacheFile), { recursive: true });
  fs.writeFileSync(staleCacheFile, `stale-file-contents-1234567890`, `utf8`);
  const staleDate = new Date(Date.now() - 60_000);
  fs.utimesSync(staleCacheFile, staleDate, staleDate);

  const middlewareContext = {
    projectRoute: {
      host: `tenant.test`,
      rootFolder: tenantRoot,
      origin: {
        hostname: `tenant.test`
      },
      folders: {
        rootFolder: tenantRoot
      },
      target: {
        run: {
          action: `hello@index`
        }
      },
      cache: 60,
      session: false,
      diskLimit: {
        enabled: true,
        maxBytes: 24,
        trackedPaths: [`cache`],
        cleanupFirst: true,
        cleanupTargetRatio: 1
      },
      isStaticAsset() {
        return false;
      },
      getCacheFilePath(url) {
        return path.join(tenantRoot, `cache`, `${url.replace(/\//g, `_`)}`);
      }
    },
    requestData: {
      method: `GET`,
      url: `tenant.test/hello`
    },
    middlewareStackRuntimeConfig: {
      diskLimit: {
        enabled: true,
        defaultMaxBytes: `1GB`,
        trackedPaths: [`cache`],
        cleanupFirst: true
      }
    },
    services: {
      storage: {
        async listEntries(targetPath) {
          return await fs.promises.readdir(targetPath, { withFileTypes: true });
        },
        async fileStat(targetPath) {
          return await fs.promises.stat(targetPath);
        },
        async fileExists(targetPath) {
          try {
            await fs.promises.access(targetPath, fs.constants.F_OK);
            return true;
          } catch {
            return false;
          }
        },
        async deleteFile(targetPath) {
          try {
            await fs.promises.unlink(targetPath);
            deleted.push(targetPath);
            return true;
          } catch (error) {
            if (error?.code === `ENOENT`) return false;
            throw error;
          }
        },
        async createFolder(folderPath) {
          writes.push({ type: `mkdir`, folderPath });
          await fs.promises.mkdir(folderPath, { recursive: true });
        },
        async writeFile(filePath, body) {
          writes.push({ type: `write`, filePath, body });
          await fs.promises.writeFile(filePath, body, `utf8`);
        }
      },
      cache: {
        async get() {
          return null;
        },
        async set(key, value, ttl) {
          cacheSets.push({ key, value, ttl });
        }
      }
    },
    async askDirector(question, payload) {
      if (question === `queue`) {
        return {
          taskId: 1,
          first: true,
          queueLabel: payload.queueLabel
        };
      }
      return { success: true };
    },
    addFinishCallback() { },
    getStatus() {
      return 200;
    },
    getBody() {
      return `0123456789`; //10 bytes
    },
    getHeaders() {
      return {};
    },
    getCookies() {
      return null;
    }
  };

  try {
    const continueMiddlewareStack = await responseCacheResolverMiddleware(middlewareContext, async () => true);
    await flushAsyncOperations();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(continueMiddlewareStack, true);
    assert.equal(deleted.includes(staleCacheFile), true);
    assert.equal(writes.some((entry) => entry.type === `write`), true);
    assert.equal(cacheSets.length, 1);
  } finally {
    fs.rmSync(tenantRoot, { recursive: true, force: true });
  }
});

test(`route resolution writes back cache on a manager miss and reuses it on the next lookup`, async () => {
  const cacheSets = [];
  let cacheReads = 0;
  let rpcCalls = 0;
  const rpcRequests = [];
  const resolver = new Network2ManagerResolver({
    config: {
      question: {
        requestUriRoutingRuntime: `requestUriRoutingRuntime`
      },
      requestUriRoutingRuntime: {
        routeMissTTL: 5000
      }
    },
    routeCacheTTL: 60000,
    services: {
      cache: {
        async get(key) {
          cacheReads += 1;
          if (key.startsWith(`urlRouteMiss:`)) return null;
          return cacheReads === 2 ? null : JSON.stringify({
            origin: {
              hostname: `tenant.test`,
              appURL: `tenant.test`
            },
            folders: {
              rootFolder: `/tmp/tenant`
            },
            run: {
              resource: `actions/hello.js`,
              action: `index`
            }
          });
        },
        async set(key, value, ttl) {
          cacheSets.push({ key, value, ttl });
        }
      },
      rpc: {
        async ask(request) {
          rpcCalls += 1;
          rpcRequests.push(request);
          return {
            origin: {
              hostname: `tenant.test`,
              appURL: `tenant.test`
            },
            folders: {
              rootFolder: `/tmp/tenant`
            },
            run: {
              resource: `actions/hello.js`,
              action: `index`
            }
          };
        }
      }
    },
    plugin: {
      hooks: {
        TRANSPORT: {
          REQUEST: {
            GET_ROUTER: { BEFORE: 1, AFTER: 2, ERROR: 3 }
          }
        }
      },
      async run() { }
    }
  });

  const executionContext = {
    requestData: { url: `tenant.test/hello`, requestId: `req-route-01` },
    meta: { requestId: `req-route-01`, correlationId: `req-route-01` }
  };

  const firstRoute = await resolver.resolveRoute(executionContext);
  const secondRoute = await resolver.resolveRoute(executionContext);
  await flushAsyncOperations();

  assert.equal(firstRoute.origin.hostname, `tenant.test`);
  assert.equal(secondRoute.origin.hostname, `tenant.test`);
  assert.equal(rpcCalls, 1);
  assert.deepEqual(rpcRequests[0].internalMeta, {
    requestId: `req-route-01`,
    correlationId: `req-route-01`
  });
  assert.deepEqual(cacheSets, [
    {
      key: `urlRouteData:tenant.test/hello`,
      value: JSON.stringify({
        origin: {
          hostname: `tenant.test`,
          appURL: `tenant.test`
        },
        folders: {
          rootFolder: `/tmp/tenant`
        },
        run: {
          resource: `actions/hello.js`,
          action: `index`
        }
      }),
      ttl: 60000
    }
  ]);
});

test(`route resolution writes a negative route-miss cache entry after a confirmed miss`, async () => {
  const cacheSets = [];
  let rpcCalls = 0;
  const resolver = new Network2ManagerResolver({
    config: {
      question: {
        requestUriRoutingRuntime: `requestUriRoutingRuntime`
      },
      requestUriRoutingRuntime: {
        routeMissTTL: 5000
      }
    },
    routeCacheTTL: 60000,
    services: {
      cache: {
        async get() {
          return null;
        },
        async set(key, value, ttl) {
          cacheSets.push({ key, value, ttl });
        }
      },
      rpc: {
        async ask() {
          rpcCalls += 1;
          return null;
        }
      }
    },
    plugin: {
      hooks: {
        TRANSPORT: {
          REQUEST: {
            GET_ROUTER: { BEFORE: 1, AFTER: 2, ERROR: 3 }
          }
        }
      },
      async run() { }
    }
  });

  const executionContext = {
    requestData: { url: `tenant.test/missing` }
  };

  const route = await resolver.resolveRoute(executionContext);
  await flushAsyncOperations();

  assert.equal(route, null);
  assert.equal(rpcCalls, 1);
  assert.deepEqual(cacheSets, [
    {
      key: `urlRouteMiss:tenant.test/missing`,
      value: `1`,
      ttl: 5000
    }
  ]);
});

test(`route resolution short-circuits manager lookup when a negative route-miss cache entry exists`, async () => {
  let rpcCalls = 0;
  let cacheReads = 0;
  const resolver = new Network2ManagerResolver({
    config: {
      question: {
        requestUriRoutingRuntime: `requestUriRoutingRuntime`
      },
      requestUriRoutingRuntime: {
        routeMissTTL: 5000
      }
    },
    routeCacheTTL: 60000,
    services: {
      cache: {
        async get(key) {
          cacheReads += 1;
          if (key === `urlRouteMiss:tenant.test/missing`) return `1`;
          return null;
        },
        async set() {
          throw new Error(`negative hit should not write cache`);
        }
      },
      rpc: {
        async ask() {
          rpcCalls += 1;
          return {
            host: `tenant.test`,
            rootFolder: `/tmp/tenant`,
            action: `actions/hello.js`
          };
        }
      }
    },
    plugin: {
      hooks: {
        TRANSPORT: {
          REQUEST: {
            GET_ROUTER: { BEFORE: 1, AFTER: 2, ERROR: 3 }
          }
        }
      },
      async run() { }
    }
  });

  const executionContext = {
    requestData: { url: `tenant.test/missing` }
  };

  const route = await resolver.resolveRoute(executionContext);

  assert.equal(route, null);
  assert.equal(cacheReads, 1);
  assert.equal(rpcCalls, 0);
});

test(`route resolution bypasses route and miss caches while tenancy scan is active`, async () => {
  const cacheSets = [];
  const cacheReads = [];
  let rpcCalls = 0;
  const resolver = new Network2ManagerResolver({
    config: {
      question: {
        requestUriRoutingRuntime: `requestUriRoutingRuntime`
      },
      tenantDirectoryResolver: {
        scanActiveCacheKey: `tenancyScanActive`
      },
      requestUriRoutingRuntime: {
        routeMissTTL: 5000,
        asyncCacheTimeoutMs: 500
      }
    },
    routeCacheTTL: 60000,
    services: {
      cache: {
        async get(key) {
          cacheReads.push(key);
          if (key === `tenancyScanActive`) return `1`;
          if (key.startsWith(`urlRouteData:`) || key.startsWith(`urlRouteMiss:`)) {
            throw new Error(`route cache should be bypassed while scan is active`);
          }
          return null;
        },
        async set(key, value, ttl) {
          cacheSets.push({ key, value, ttl });
        }
      },
      rpc: {
        async ask() {
          rpcCalls += 1;
          return {
            host: `tenant.test`,
            rootFolder: `/tmp/tenant`,
            action: `actions/hello.js`
          };
        }
      }
    },
    plugin: {
      hooks: {
        TRANSPORT: {
          REQUEST: {
            GET_ROUTER: { BEFORE: 1, AFTER: 2, ERROR: 3 }
          }
        }
      },
      async run() { }
    }
  });

  const route = await resolver.resolveRoute({
    requestData: { url: `tenant.test/hello` }
  });
  await flushAsyncOperations();

  assert.equal(route?.origin?.hostname, `tenant.test`);
  assert.equal(rpcCalls, 1);
  assert.deepEqual(cacheReads, [`tenancyScanActive`]);
  assert.deepEqual(cacheSets, []);
});

test(`route resolution throws immediately when manager returns an explicit RPC failure`, async () => {
  let cacheSetCalled = false;
  const resolver = new Network2ManagerResolver({
    config: {
      question: {
        requestUriRoutingRuntime: `requestUriRoutingRuntime`
      },
      requestUriRoutingRuntime: {
        routeMissTTL: 5000
      }
    },
    routeCacheTTL: 60000,
    services: {
      cache: {
        async get() {
          return null;
        },
        async set() {
          cacheSetCalled = true;
        }
      },
      rpc: {
        async ask() {
          return {
            success: false,
            error: `RPC listener not ready for question "requestUriRoutingRuntime"`
          };
        }
      }
    },
    plugin: {
      hooks: {
        TRANSPORT: {
          REQUEST: {
            GET_ROUTER: { BEFORE: 1, AFTER: 2, ERROR: 3 }
          }
        }
      },
      async run() { }
    }
  });

  await assert.rejects(
    () => resolver.resolveRoute({
      requestData: { url: `tenant.test/hello` }
    }),
    /RPC listener not ready/
  );

  assert.equal(cacheSetCalled, false);
});

test(`tenant route falls back to GET when methods and methodsAvailable are omitted`, () => {
  const projectRoute = new TenantRoute({
    host: `tenant.test`,
    domain: `tenant.test`,
    appName: `www`,
    rootFolder: `/tmp/tenant`,
    pointsTo: `run > hello@index`
  });

  assert.deepEqual(projectRoute.methodsAvailable, [`GET`]);
  assert.deepEqual(projectRoute.methods, [`GET`]);
  assert.equal(projectRoute.meta.target.type, `run`);
  assert.equal(projectRoute.meta.target.value, `hello@index`);
  assert.deepEqual(projectRoute.target.run, {
    resource: `hello`,
    action: `index`
  });
  assert.equal(projectRoute.allowsHostMethod(`GET`), true);
  assert.equal(projectRoute.allowsHostMethod(`POST`), false);
  assert.equal(projectRoute.allowsMethod(`GET`), true);
  assert.equal(projectRoute.allowsMethod(`POST`), false);
});

test(`tenant route resolves static assets from the app assets tree`, () => {
  const projectRoute = new TenantRoute({
    host: `tenant.test`,
    domain: `tenant.test`,
    appName: `www`,
    rootFolder: `/tmp/tenant`,
    assetsRootFolder: `/tmp/tenant/assets`,
    pointsTo: `asset > htm/index.htm`
  });

  assert.equal(projectRoute.assetPath(), `/tmp/tenant/assets/htm/index.htm`);
  assert.equal(projectRoute.meta.target.asset.path, `htm/index.htm`);
});

test(`response cache resolver stage lets a queued consumer retry and reuse the cached artifact`, async () => {
  const calls = [];
  let cacheReads = 0;
  let body = null;
  const meta = new ExecutionMetaData();
  const middlewareContext = {
    projectRoute: {
      host: `tenant.test`,
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
          cacheReads += 1;
          return cacheReads === 1 ? null : `/tmp/tenant/.ehecoatl/.cache/cached-response.txt`;
        }
      },
      storage: {
        async fileExists(filePath) {
          return filePath === `/tmp/tenant/.ehecoatl/.cache/cached-response.txt`;
        }
      }
    },
    meta,
    async askManager(question, payload) {
      calls.push({ question, payload });
      if (question === `queue` && payload.queueLabel === `validResponseCache:tenant.test/hello`) {
        return { taskId: 7, first: false };
      }
      if (question === `dequeue`) return { success: true };
      return null;
    },
    addFinishCallback() { },
    setHeader() { },
    setBody(value) {
      body = value;
    },
    setStatus() { }
  };

  const continueMiddlewareStack = await responseCacheResolverMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, false);
  assert.deepEqual(body, {
    __ehecoatlBodyKind: `nginx-internal-redirect`,
    uri: `/_ehecoatl_internal/cache/cached-response.txt`
  });
  assert.equal(meta.cached, true);
  assert.deepEqual(calls.map((call) => call.question), [`queue`, `dequeue`]);
});

test(`response cache resolver stage clears a stale response-cache pointer when the artifact is missing`, async () => {
  const deletedKeys = [];
  const middlewareContext = {
    projectRoute: {
      host: `tenant.test`,
      cache: 60,
      folders: {
        rootFolder: `/tmp/tenant`
      },
      isStaticAsset() {
        return false;
      }
    },
    requestData: {
      url: `tenant.test/stale`
    },
    services: {
      cache: {
        async get() {
          return `/tmp/missing-cache-artifact.txt`;
        },
        async delete(key) {
          deletedKeys.push(key);
          return true;
        }
      },
      storage: {
        async fileExists() {
          return false;
        }
      }
    },
    async askManager() {
      return { success: true, taskId: 1 };
    },
    addFinishCallback() { },
    setHeader() { },
    setBody() { },
    setStatus() { }
  };

  const continueMiddlewareStack = await responseCacheResolverMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, true);
  assert.deepEqual(deletedKeys, [`validResponseCache:tenant.test/stale`]);
});

test(`response cache resolver stage returns 304 when If-Modified-Since matches cached artifact mtime`, async () => {
  const responseData = {
    status: 200,
    headers: {},
    body: `initial`
  };
  const middlewareContext = {
    projectRoute: {
      host: `tenant.test`,
      cache: 60,
      folders: {
        rootFolder: `/tmp/tenant`
      },
      isStaticAsset() {
        return false;
      }
    },
    requestData: {
      url: `tenant.test/hello`,
      headers: {
        'if-modified-since': new Date(Date.UTC(2026, 2, 23, 16, 0, 5)).toUTCString()
      }
    },
    services: {
      cache: {
        async get() {
          return `/tmp/tenant/.ehecoatl/.cache/cached-response.txt`;
        }
      },
      storage: {
        async fileExists(filePath) {
          return filePath === `/tmp/tenant/.ehecoatl/.cache/cached-response.txt`;
        }
      }
    },
    meta: new ExecutionMetaData(),
    async askManager() { return null; },
    addFinishCallback() { },
    setHeader(key, value) {
      responseData.headers[key] = value;
    },
    setBody(value) {
      responseData.body = value;
    },
    setStatus(value) {
      responseData.status = value;
    }
  };

  const continueMiddlewareStack = await responseCacheResolverMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, false);
  assert.equal(responseData.status, 200);
  assert.deepEqual(responseData.body, {
    __ehecoatlBodyKind: `nginx-internal-redirect`,
    uri: `/_ehecoatl_internal/cache/cached-response.txt`
  });
  assert.deepEqual(responseData.headers, {});
  assert.equal(middlewareContext.meta.cached, true);
});

test(`response cache resolver stage sets Last-Modified when streaming cached artifacts`, async () => {
  const responseData = {
    status: 200,
    headers: {},
    body: null
  };
  const middlewareContext = {
    projectRoute: {
      host: `tenant.test`,
      cache: 60,
      folders: {
        rootFolder: `/tmp/tenant`
      },
      isStaticAsset() {
        return false;
      }
    },
    requestData: {
      url: `tenant.test/hello`,
      headers: {}
    },
    services: {
      cache: {
        async get() {
          return `/tmp/tenant/.ehecoatl/.cache/cached-response.txt`;
        }
      },
      storage: {
        async fileExists(filePath) {
          return filePath === `/tmp/tenant/.ehecoatl/.cache/cached-response.txt`;
        }
      }
    },
    meta: new ExecutionMetaData(),
    async askManager() { return null; },
    addFinishCallback() { },
    setHeader(key, value) {
      responseData.headers[key] = value;
    },
    setBody(value) {
      responseData.body = value;
    },
    setStatus(value) {
      responseData.status = value;
    }
  };

  const continueMiddlewareStack = await responseCacheResolverMiddleware(middlewareContext);

  assert.equal(continueMiddlewareStack, false);
  assert.equal(responseData.status, 200);
  assert.deepEqual(responseData.body, {
    __ehecoatlBodyKind: `nginx-internal-redirect`,
    uri: `/_ehecoatl_internal/cache/cached-response.txt`
  });
  assert.deepEqual(responseData.headers, {});
  assert.equal(middlewareContext.meta.cached, true);
});

test(`shared cache local-memory adapter honors millisecond ttl and deleteByPrefix invalidation`, async () => {
  const prefix = `shared-cache-test:${Date.now()}:`;
  const cacheService = new SharedCacheService(createSharedCacheKernelContext());

  await cacheService.set(`${prefix}ttl`, `value`, 20);
  assert.equal(await cacheService.get(`${prefix}ttl`, null), `value`);

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(await cacheService.get(`${prefix}ttl`, null), null);

  await cacheService.set(`${prefix}a`, `A`);
  await cacheService.set(`${prefix}b`, `B`);
  const removed = await cacheService.deleteByPrefix(prefix);

  assert.equal(removed, 2);
  assert.equal(await cacheService.has(`${prefix}a`), false);
  assert.equal(await cacheService.has(`${prefix}b`), false);
});

test(`tenant directory resolver invalidates shared route and response cache prefixes after a successful scan`, async () => {
  const deletions = [];
  const kernelContext = {
    config: {
      _adapters: {
        tenantDirectoryResolver: require.resolve(`@adapter/inbound/tenant-directory-resolver/default-tenancy`),
        projectRouteMatcherCompiler: require.resolve(`@adapter/inbound/tenant-route-matcher-compiler/default-routing-v1`),
        requestUriRoutingRuntime: require.resolve(`@adapter/inbound/request-uri-routing-runtime/default-uri-router-runtime`)
      },
      tenantDirectoryResolver: {
        tenantsPath: `/tmp/tenancy-resolver-test`,
        scanIntervalMs: 300000
      },
      projectRouteMatcherCompiler: {
        adapter: `default-routing-v1`
      },
      requestUriRoutingRuntime: {
        routeMatchTTL: 60000
      }
    },
    pluginOrchestrator: {
      async run() { }
    },
    useCases: {
      storageService: createTenancyResolverStorageMock(),
      sharedCacheService: {
        async deleteByPrefix(prefix) {
          deletions.push(prefix);
          return 1;
        }
      },
      projectRouteMatcherCompiler: createTestTenantRouteMatcherCompiler()
    }
  };
  const tenantDirectoryResolver = new TenantDirectoryResolver(kernelContext);
  kernelContext.useCases.tenantDirectoryResolver = tenantDirectoryResolver;
  const requestUriRoutingRuntime = new RequestUriRoutingRuntime(kernelContext);
  tenantDirectoryResolver.attachRouteRuntime(requestUriRoutingRuntime);
  requestUriRoutingRuntime.localCache.set(`tenant.test/hello`, {
    projectRoute: { origin: { hostname: `tenant.test` } },
    validUntil: Date.now() + 1000
  });

  await tenantDirectoryResolver.runScanCycle();

  assert.equal(requestUriRoutingRuntime.localCache.size, 0);
  assert.deepEqual(deletions, [
    `urlRouteData:`,
    `urlRouteMiss:`,
    `validResponseCache:`
  ]);
});

test(`tenant route runtime asynchronously removes orphaned response-cache artifacts from tenant cache folders`, async () => {
  const deletedPaths = [];
  const storageService = createTenancyResolverResponseCacheStorageMock({
    deletedPaths
  });
  const sharedCacheService = {
    async get(key) {
      if (key === `validResponseCache:www.example.com/hello`) {
        return `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-cleanup`)}/.cache/[www.example.com]_[hello].txt`;
      }
      return null;
    },
    async deleteByPrefix() {
      return 0;
    }
  };
  const kernelContext = {
    config: {
      _adapters: {
        tenantDirectoryResolver: require.resolve(`@adapter/inbound/tenant-directory-resolver/default-tenancy`),
        projectRouteMatcherCompiler: require.resolve(`@adapter/inbound/tenant-route-matcher-compiler/default-routing-v1`),
        requestUriRoutingRuntime: require.resolve(`@adapter/inbound/request-uri-routing-runtime/default-uri-router-runtime`)
      },
      tenantDirectoryResolver: {
        tenantsPath: `/tmp/tenancy-resolver-cleanup`,
        scanIntervalMs: 300000,
        responseCacheCleanupIntervalMs: 300000
      },
      projectRouteMatcherCompiler: {
        adapter: `default-routing-v1`
      },
      requestUriRoutingRuntime: {
        routeMatchTTL: 60000
      }
    },
    pluginOrchestrator: {
      async run() { }
    },
    useCases: {
      storageService,
      sharedCacheService,
      projectRouteMatcherCompiler: createTestTenantRouteMatcherCompiler()
    }
  };
  const tenantDirectoryResolver = new TenantDirectoryResolver(kernelContext);
  kernelContext.useCases.tenantDirectoryResolver = tenantDirectoryResolver;
  const requestUriRoutingRuntime = new RequestUriRoutingRuntime(kernelContext);
  tenantDirectoryResolver.attachRouteRuntime(requestUriRoutingRuntime);
  await tenantDirectoryResolver.scanRegistry();

  const removed = await requestUriRoutingRuntime.cleanupInvalidResponseCacheArtifacts();

  assert.equal(removed, 1);
  assert.deepEqual(deletedPaths, [
    `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-cleanup`)}/.cache/[www.example.com]_[stale].txt`
  ]);
});

test(`default tenancy scan applies inline tenant aliases without duplicating disabled apps`, async () => {
  const scanSummary = await defaultTenancyAdapter.scanTenantsAdapter({
    config: {
      tenantsPath: `/tmp/tenancy-resolver-enable-rules`
    },
    storage: createTenancyResolverEnableRulesStorageMock(),
    routeMatcherCompiler: createTestTenantRouteMatcherCompiler()
  });

  const directHostRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `www.example.com/hello`,
    registry: scanSummary.registry
  });
  const fallbackHostRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `example.com/hello`,
    registry: scanSummary.registry
  });
  const disabledHostRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `api.example.com/hello`,
    registry: scanSummary.registry
  });
  const enabledAliasRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `www.alias.test/hello`,
    registry: scanSummary.registry
  });
  const aliasToDisabledHostRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `api.alias.test/hello`,
    registry: scanSummary.registry
  });
  const bareAliasFallbackRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `alias.test/hello`,
    registry: scanSummary.registry
  });

  assert.equal(directHostRoute?.origin?.hostname, `www.example.com`);
  assert.equal(directHostRoute?.origin?.appURL, `www.example.com`);
  assert.deepEqual(directHostRoute?.target?.run, { resource: `hello`, action: `index` });
  assert.equal(fallbackHostRoute?.origin?.hostname, `example.com`);
  assert.equal(fallbackHostRoute?.origin?.appURL, `www.example.com`);
  assert.equal(disabledHostRoute, null);
  assert.equal(enabledAliasRoute?.origin?.hostname, `www.alias.test`);
  assert.equal(enabledAliasRoute?.origin?.appURL, `www.example.com`);
  assert.equal(aliasToDisabledHostRoute, null);
  assert.equal(bareAliasFallbackRoute?.origin?.hostname, `alias.test`);
  assert.equal(bareAliasFallbackRoute?.origin?.appURL, `www.example.com`);
  assert.equal(scanSummary.registry.domainAliases.get(`alias.test`)?.point, `example.com`);
});

test(`default tenancy scan skips malformed app config and writes validation error file at the app root`, async () => {
  const writes = [];
  const deletes = [];
  const summary = await defaultTenancyAdapter.scanTenantsAdapter({
    config: {
      tenantsPath: `/tmp/tenancy-resolver-invalid-config`
    },
    routeMatcherCompiler: createTestTenantRouteMatcherCompiler(),
    storage: {
      async listEntries(targetPath) {
        if (targetPath === `/tmp/tenancy-resolver-invalid-config`) {
          return [createDirentMock(`tenant_aaaaaaaaaaaa`, { directory: true })];
        }
        if (targetPath === buildOpaqueTenantRoot(`/tmp/tenancy-resolver-invalid-config`)) {
          return [
            createDirentMock(`config.json`, { file: true }),
            createDirentMock(`app_bbbbbbbbbbbb`, { directory: true }),
            createDirentMock(`app_cccccccccccc`, { directory: true })
          ];
        }
        return [];
      },
      async readFile(targetPath) {
        if (targetPath === `${buildOpaqueTenantRoot(`/tmp/tenancy-resolver-invalid-config`)}/config.json`) {
          return JSON.stringify(createOpaqueTenantConfig());
        }
        if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-invalid-config`)}/config.json`) {
          return JSON.stringify(createOpaqueAppConfig({
            routesAvailable: {
              '/ok': {
                pointsTo: `run > ok@index`
              }
            }
          }));
        }
        if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-invalid-config`, `aaaaaaaaaaaa`, `cccccccccccc`)}/config.json`) {
          return `{"routesAvailable":`; // malformed json
        }
        throw new Error(`Unexpected readFile path: ${targetPath}`);
      },
      async writeFile(targetPath, content) {
        writes.push({ targetPath, content });
      },
      async deleteFile(targetPath) {
        deletes.push(targetPath);
        return true;
      }
    }
  });

  const validRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `www.example.com/ok`,
    registry: summary.registry
  });
  const invalidRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `api.example.com/ok`,
    registry: summary.registry
  });

  assert.equal(validRoute?.origin?.hostname, `www.example.com`);
  assert.equal(validRoute?.origin?.appURL, `www.example.com`);
  assert.equal(invalidRoute, null);
  assert.ok(Array.isArray(summary.invalidHosts));
  assert.equal(summary.invalidHosts.length, 1);
  assert.equal(summary.invalidHosts[0].host, `app_cccccccccccc.example.com`);
  assert.ok(String(summary.invalidHosts[0].error?.message ?? ``).length > 0);

  const errorWrite = writes.find((entry) => entry.targetPath.endsWith(`/app_cccccccccccc/config.validation.error.json`));
  assert.ok(errorWrite);
  const parsedError = JSON.parse(errorWrite.content);
  assert.equal(parsedError.host, `app_cccccccccccc.example.com`);
  assert.equal(parsedError.status, `invalid_config`);
  assert.ok(deletes.some((entry) => entry.endsWith(`/app_bbbbbbbbbbbb/config.validation.error.json`)));
});

test(`default tenancy scan reads domain config.json for path routing and per-domain defaultAppName`, async () => {
  const summary = await defaultTenancyAdapter.scanTenantsAdapter({
    config: {
      tenantsPath: `/tmp/tenancy-resolver-domain-config`
    },
    routeMatcherCompiler: createTestTenantRouteMatcherCompiler(),
    storage: {
      async listEntries(targetPath) {
        if (targetPath === `/tmp/tenancy-resolver-domain-config`) {
          return [createDirentMock(`tenant_aaaaaaaaaaaa`, { directory: true })];
        }
        if (targetPath === buildOpaqueTenantRoot(`/tmp/tenancy-resolver-domain-config`)) {
          return [
            createDirentMock(`config.json`, { file: true }),
            createDirentMock(`app_bbbbbbbbbbbb`, { directory: true }),
            createDirentMock(`app_cccccccccccc`, { directory: true })
          ];
        }
        return [];
      },
      async readFile(targetPath) {
        if (targetPath === `${buildOpaqueTenantRoot(`/tmp/tenancy-resolver-domain-config`)}/config.json`) {
          return JSON.stringify(createOpaqueTenantConfig({
            appRoutingMode: `path`,
            defaultAppName: `admin`
          }));
        }
        if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-domain-config`)}/config.json`) {
          return JSON.stringify(createOpaqueAppConfig({
            routesAvailable: {
              '/hello': {
                pointsTo: `run > hello@index`
              }
            }
          }));
        }
        if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-domain-config`, `aaaaaaaaaaaa`, `cccccccccccc`)}/config.json`) {
          return JSON.stringify(createOpaqueAppConfig({
            appId: `cccccccccccc`,
            appName: `admin`,
            routesAvailable: {
              '/': {
                pointsTo: `run > admin@index`
              },
              '/hello': {
                pointsTo: `run > admin@index`
              }
            }
          }));
        }
        throw new Error(`Unexpected readFile path: ${targetPath}`);
      }
    }
  });

  const explicitAppRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `example.com/www/hello`,
    registry: summary.registry
  });
  const fallbackRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `example.com/hello`,
    registry: summary.registry
  });
  const rootFallbackRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `example.com/`,
    registry: summary.registry
  });
  const wwwPathRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `www.example.com/hello`,
    registry: summary.registry
  });

  assert.equal(explicitAppRoute?.origin?.hostname, `example.com`);
  assert.equal(explicitAppRoute?.origin?.appURL, `example.com/www`);
  assert.equal(explicitAppRoute?.domainRoutingMode, `path`);
  assert.equal(fallbackRoute?.origin?.hostname, `example.com`);
  assert.equal(fallbackRoute?.origin?.appURL, `example.com/admin`);
  assert.equal(rootFallbackRoute?.origin?.hostname, `example.com`);
  assert.equal(rootFallbackRoute?.origin?.appURL, `example.com/admin`);
  assert.equal(wwwPathRoute?.origin?.hostname, `www.example.com`);
  assert.equal(wwwPathRoute?.origin?.appURL, `example.com/admin`);
  assert.equal(summary.invalidHosts.length, 0);
  assert.equal(summary.registry.domains.get(`example.com`)?.appRouting?.mode, `path`);
  assert.equal(summary.registry.domains.get(`example.com`)?.appRouting?.defaultAppName, `admin`);
});

test(`default tenancy scan also accepts flat domain config appRoutingMode and defaultAppName`, async () => {
  const summary = await defaultTenancyAdapter.scanTenantsAdapter({
    config: {
      tenantsPath: `/tmp/tenancy-resolver-flat-domain-config`
    },
    routeMatcherCompiler: createTestTenantRouteMatcherCompiler(),
    storage: {
      async listEntries(targetPath) {
        if (targetPath === `/tmp/tenancy-resolver-flat-domain-config`) {
          return [createDirentMock(`tenant_aaaaaaaaaaaa`, { directory: true })];
        }
        if (targetPath === buildOpaqueTenantRoot(`/tmp/tenancy-resolver-flat-domain-config`)) {
          return [
            createDirentMock(`config.json`, { file: true }),
            createDirentMock(`app_bbbbbbbbbbbb`, { directory: true }),
            createDirentMock(`app_cccccccccccc`, { directory: true })
          ];
        }
        return [];
      },
      async readFile(targetPath) {
        if (targetPath === `${buildOpaqueTenantRoot(`/tmp/tenancy-resolver-flat-domain-config`)}/config.json`) {
          return JSON.stringify({
            ...createOpaqueTenantConfig(),
            appRoutingMode: `path`,
            defaultAppName: `admin`
          });
        }
        if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-flat-domain-config`)}/config.json`) {
          return JSON.stringify(createOpaqueAppConfig({
            routesAvailable: {
              '/hello': {
                pointsTo: `run > hello@index`
              }
            }
          }));
        }
        if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-flat-domain-config`, `aaaaaaaaaaaa`, `cccccccccccc`)}/config.json`) {
          return JSON.stringify(createOpaqueAppConfig({
            appId: `cccccccccccc`,
            appName: `admin`,
            routesAvailable: {
              '/hello': {
                pointsTo: `run > admin@index`
              }
            }
          }));
        }
        throw new Error(`Unexpected readFile path: ${targetPath}`);
      }
    }
  });

  const fallbackRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `example.com/hello`,
    registry: summary.registry
  });

  assert.equal(fallbackRoute?.origin?.appURL, `example.com/admin`);
  assert.equal(summary.registry.domains.get(`example.com`)?.appRouting?.mode, `path`);
  assert.equal(summary.registry.domains.get(`example.com`)?.appRouting?.defaultAppName, `admin`);
});

test(`tenant routes resolver flattens nested prefix groups, ignores invalid keys, and normalizes duplicate slashes`, async () => {
  const resolved = await defaultRouteMatcherCompilerAdapter.compileRoutesAdapter({
    routesAvailable: {
      invalid: {
        pointsTo: `run > ignore@index`
      },
      '/api': {
        ignoredMeta: true,
        '/v1': {
          '/users': {
            pointsTo: `run > users@index`
          },
          '//posts': {
            pointsTo: `run > posts@index`
          }
        }
      },
      '/inline': {
        pointsTo: `run > inline@index`
      }
    }
  });

  assert.deepEqual(resolved.routesAvailable, {
    '/api/v1/users': {
      pointsTo: `run > users@index`,
      target: {
        type: `run`,
        value: `users@index`,
        asset: null,
        run: {
          resource: `users`,
          action: `index`
        },
        redirect: null
      },
      contentTypes: null,
      upload: {
        uploadPath: null,
        uploadTypes: null,
        diskLimit: null,
        diskLimitBytes: null
      },
      origin: {
        hostname: null,
        appURL: null,
        domain: null,
        appName: null
      },
      folders: {
        rootFolder: null,
        actionsRootFolder: null,
        assetsRootFolder: null,
        httpMiddlewaresRootFolder: null,
        wsMiddlewaresRootFolder: null,
        routesRootFolder: null
      }
    },
    '/api/v1/posts': {
      pointsTo: `run > posts@index`,
      target: {
        type: `run`,
        value: `posts@index`,
        asset: null,
        run: {
          resource: `posts`,
          action: `index`
        },
        redirect: null
      },
      contentTypes: null,
      upload: {
        uploadPath: null,
        uploadTypes: null,
        diskLimit: null,
        diskLimitBytes: null
      },
      origin: {
        hostname: null,
        appURL: null,
        domain: null,
        appName: null
      },
      folders: {
        rootFolder: null,
        actionsRootFolder: null,
        assetsRootFolder: null,
        httpMiddlewaresRootFolder: null,
        wsMiddlewaresRootFolder: null,
        routesRootFolder: null
      }
    },
    '/inline': {
      pointsTo: `run > inline@index`,
      target: {
        type: `run`,
        value: `inline@index`,
        asset: null,
        run: {
          resource: `inline`,
          action: `index`
        },
        redirect: null
      },
      contentTypes: null,
      upload: {
        uploadPath: null,
        uploadTypes: null,
        diskLimit: null,
        diskLimitBytes: null
      },
      origin: {
        hostname: null,
        appURL: null,
        domain: null,
        appName: null
      },
      folders: {
        rootFolder: null,
        actionsRootFolder: null,
        assetsRootFolder: null,
        httpMiddlewaresRootFolder: null,
        wsMiddlewaresRootFolder: null,
        routesRootFolder: null
      }
    }
  });
  assert.equal(Array.isArray(resolved.compiledRoutes), true);
  assert.equal(resolved.compiledRoutes.length, 3);
});

test(`tenant routes resolver keeps later duplicate expanded routes`, async () => {
  const resolved = await defaultRouteMatcherCompilerAdapter.compileRoutesAdapter({
    routesAvailable: {
      '/api': {
        '/users': {
          pointsTo: `run > first@index`
        }
      },
      '/api/users': {
        pointsTo: `run > second@index`
      }
    }
  });

  assert.deepEqual(resolved.routesAvailable, {
    '/api/users': {
      pointsTo: `run > second@index`,
      target: {
        type: `run`,
        value: `second@index`,
        asset: null,
        run: {
          resource: `second`,
          action: `index`
        },
        redirect: null
      },
      contentTypes: null,
      upload: {
        uploadPath: null,
        uploadTypes: null,
        diskLimit: null,
        diskLimitBytes: null
      },
      origin: {
        hostname: null,
        appURL: null,
        domain: null,
        appName: null
      },
      folders: {
        rootFolder: null,
        actionsRootFolder: null,
        assetsRootFolder: null,
        httpMiddlewaresRootFolder: null,
        wsMiddlewaresRootFolder: null,
        routesRootFolder: null
      }
    }
  });
});

test(`tenant route matcher compiler use case loads the dedicated adapter and resolves compiled routes`, async () => {
  const resolver = new TenantRouteMatcherCompiler({
    config: {
      _adapters: {
        projectRouteMatcherCompiler: require.resolve(`@adapter/inbound/tenant-route-matcher-compiler/default-routing-v1`)
      },
      projectRouteMatcherCompiler: {
        adapter: `default-routing-v1`
      }
    }
  });

  const resolved = await resolver.compileRoutes({
    '/hello': {
      pointsTo: `run > hello@index`
    }
  });

  assert.deepEqual(resolved.routesAvailable, {
    '/hello': {
      pointsTo: `run > hello@index`,
      target: {
        type: `run`,
        value: `hello@index`,
        asset: null,
        run: {
          resource: `hello`,
          action: `index`
        },
        redirect: null
      },
      contentTypes: null,
      upload: {
        uploadPath: null,
        uploadTypes: null,
        diskLimit: null,
        diskLimitBytes: null
      },
      origin: {
        hostname: null,
        appURL: null,
        domain: null,
        appName: null
      },
      folders: {
        rootFolder: null,
        actionsRootFolder: null,
        assetsRootFolder: null,
        httpMiddlewaresRootFolder: null,
        wsMiddlewaresRootFolder: null,
        routesRootFolder: null
      }
    }
  });
  assert.equal(resolved.compiledRoutes.length, 1);
});

test(`route target parser accepts flexible pointsTo spacing and redirect status codes`, () => {
  assert.deepEqual(parseRouteTargetString(`run>home@index`), {
    pointsTo: `run > home@index`,
    target: {
      type: `run`,
      value: `home@index`,
      redirect: null,
      asset: null,
      run: {
        resource: `home`,
        action: `index`
      }
    }
  });
  assert.deepEqual(parseRouteTargetString(`run     > home@index`), {
    pointsTo: `run > home@index`,
    target: {
      type: `run`,
      value: `home@index`,
      redirect: null,
      asset: null,
      run: {
        resource: `home`,
        action: `index`
      }
    }
  });
  assert.deepEqual(parseRouteTargetString(`asset > htm/index.htm`), {
    pointsTo: `asset > htm/index.htm`,
    target: {
      type: `asset`,
      value: `htm/index.htm`,
      redirect: null,
      run: null,
      asset: {
        path: `htm/index.htm`
      }
    }
  });
  assert.deepEqual(parseRouteTargetString(`redirect > /htm/index.htm`), {
    pointsTo: `redirect 302 > /htm/index.htm`,
    target: {
      type: `redirect`,
      value: `/htm/index.htm`,
      redirect: {
        location: `/htm/index.htm`,
        status: 302
      },
      run: null,
      asset: null
    }
  });
  assert.deepEqual(parseRouteTargetString(`redirect 301 > https://example.com`), {
    pointsTo: `redirect 301 > https://example.com`,
    target: {
      type: `redirect`,
      value: `https://example.com`,
      redirect: {
        location: `https://example.com`,
        status: 301
      },
      run: null,
      asset: null
    }
  });
});

test(`tenant route meta normalizes route config from pointsTo as the canonical source of truth`, () => {
  assert.deepEqual(
    TenantRouteMeta.normalizeRouteConfig({
      pointsTo: `run > hello@index`,
      cache: `no-cache`
    }, `/hello`),
    {
      pointsTo: `run > hello@index`,
      cache: `no-cache`,
      target: {
        type: `run`,
        value: `hello@index`,
        asset: null,
        run: {
          resource: `hello`,
          action: `index`
        },
        redirect: null
      },
      contentTypes: null,
      middleware: null,
      authScope: null,
      wsActionsAvailable: null,
      cors: null,
      upload: {
        uploadPath: null,
        uploadTypes: null,
        diskLimit: null,
        diskLimitBytes: null
      },
      upgrade: null,
      params: {},
      view: {},
      origin: {
        hostname: null,
        appURL: null,
        domain: null,
        appName: null,
        tenantId: null,
        appId: null
      },
      folders: {
        tenantRootFolder: null,
        rootFolder: null,
        actionsRootFolder: null,
        httpActionsRootFolder: null,
        wsActionsRootFolder: null,
        assetsRootFolder: null,
        httpSharedActionsRootFolder: null,
        wsSharedActionsRootFolder: null,
        assetsSharedRootFolder: null,
        httpMiddlewaresRootFolder: null,
        wsMiddlewaresRootFolder: null,
        routesRootFolder: null,
        httpRoutesRootFolder: null,
        wsRoutesRootFolder: null
      }
    }
  );
});

test(`tenant route meta preserves numeric-second and cache-control route cache values`, () => {
  assert.equal(
    TenantRouteMeta.normalizeRouteConfig({
      pointsTo: `run > hello@index`,
      cache: 60
    }, `/hello`).cache,
    60
  );
  assert.equal(
    TenantRouteMeta.normalizeRouteConfig({
      pointsTo: `run > hello@index`,
      cache: `public, max-age=60, stale-while-revalidate=30`
    }, `/hello`).cache,
    `public, max-age=60, stale-while-revalidate=30`
  );
});

test(`route target parser rejects malformed or legacy route targets`, async () => {
  assert.throws(() => parseRouteTargetString(`unknown > home@index`), /Unsupported route target type/);
  assert.throws(() => parseRouteTargetString(`run >`), /must match/);
  assert.throws(() => parseRouteTargetString(`redirect 418 > /teapot`), /must use one of 301, 302, 307, 308/);
  assert.throws(() => parseRouteTargetString(`run 302 > home@index`), /Only redirect targets may declare an inline status code/);

  await assert.rejects(
    () => defaultRouteMatcherCompilerAdapter.compileRoutesAdapter({
      routesAvailable: {
        '/legacy': {
          run: `legacy@index`
        }
      }
    }),
    /uses legacy target fields/
  );
});

test(`default tenancy scan merges routes folder json into routesAvailable and exposes middleware and routes roots`, async () => {
  const summary = await defaultTenancyAdapter.scanTenantsAdapter({
    config: {
      tenantsPath: `/tmp/tenancy-resolver-routes-folder`
    },
    routeMatcherCompiler: createTestTenantRouteMatcherCompiler(),
    storage: {
      async listEntries(targetPath) {
        if (targetPath === `/tmp/tenancy-resolver-routes-folder`) {
          return [createDirentMock(`tenant_aaaaaaaaaaaa`, { directory: true })];
        }
        if (targetPath === buildOpaqueTenantRoot(`/tmp/tenancy-resolver-routes-folder`)) {
          return [
            createDirentMock(`config.json`, { file: true }),
            createDirentMock(`app_bbbbbbbbbbbb`, { directory: true })
          ];
        }
        if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-routes-folder`)}/routes`) {
          return [
            createDirentMock(`base.json`, { file: true }),
            createDirentMock(`extra`, { directory: true })
          ];
        }
        if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-routes-folder`)}/routes/extra`) {
          return [createDirentMock(`nested.json`, { file: true })];
        }
        return [];
      },
      async readFile(targetPath) {
        if (targetPath === `${buildOpaqueTenantRoot(`/tmp/tenancy-resolver-routes-folder`)}/config.json`) {
          return JSON.stringify(createOpaqueTenantConfig());
        }
        if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-routes-folder`)}/config.json`) {
          return JSON.stringify(createOpaqueAppConfig({
            methodsAvailable: [`GET`, `POST`],
            routesAvailable: {
              '/inline': {
                pointsTo: `run > inline@index`
              }
            }
          }));
        }
        if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-routes-folder`)}/routes/base.json`) {
          return JSON.stringify({
            '/folder': {
              pointsTo: `run > folder@index`
            }
          });
        }
        if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-routes-folder`)}/routes/extra/nested.json`) {
          return JSON.stringify({
            routesAvailable: {
              '/nested': {
                pointsTo: `run > nested@index`
              }
            }
          });
        }
        throw new Error(`Unexpected readFile path: ${targetPath}`);
      }
    }
  });

  const inlineRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `www.example.com/inline`,
    registry: summary.registry
  });
  const folderRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `www.example.com/folder`,
    registry: summary.registry
  });
  const nestedRoute = await defaultUriRouterRuntimeAdapter.matchRouteAdapter({
    url: `www.example.com/nested`,
    registry: summary.registry
  });
  const appRecord = summary.registry.hosts.get(`www.example.com`);

  assert.deepEqual(inlineRoute?.target?.run, { resource: `inline`, action: `index` });
  assert.deepEqual(folderRoute?.target?.run, { resource: `folder`, action: `index` });
  assert.deepEqual(nestedRoute?.target?.run, { resource: `nested`, action: `index` });
  assert.equal(appRecord?.httpMiddlewaresRootFolder, `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-routes-folder`)}/app/http/middlewares`);
  assert.equal(appRecord?.wsMiddlewaresRootFolder, `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-routes-folder`)}/app/ws/middlewares`);
  assert.equal(appRecord?.routesRootFolder, `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-routes-folder`)}/routes`);
});

test(`default tenancy scan marks hosts as changed when index.js, config.json, or route file mtime changes`, async () => {
  const storage = createTenancyResolverChangeFingerprintStorageMock();
  let scanSummary = await defaultTenancyAdapter.scanTenantsAdapter({
    config: {
      tenantsPath: `/tmp/tenancy-resolver-change-fingerprint`
    },
    routeMatcherCompiler: createTestTenantRouteMatcherCompiler(),
    storage
  });

  storage.setEntrypointMtimeMs(2000);
  const entrypointSummary = await defaultTenancyAdapter.scanTenantsAdapter({
    config: {
      tenantsPath: `/tmp/tenancy-resolver-change-fingerprint`,
      registry: scanSummary.registry
    },
    routeMatcherCompiler: createTestTenantRouteMatcherCompiler(),
    storage
  });
  assert.ok(entrypointSummary.changedHosts.includes(`www.example.com`));
  scanSummary = entrypointSummary;

  storage.setHostConfigMtimeMs(3000);
  const configSummary = await defaultTenancyAdapter.scanTenantsAdapter({
    config: {
      tenantsPath: `/tmp/tenancy-resolver-change-fingerprint`,
      registry: scanSummary.registry
    },
    routeMatcherCompiler: createTestTenantRouteMatcherCompiler(),
    storage
  });
  assert.ok(configSummary.changedHosts.includes(`www.example.com`));
  scanSummary = configSummary;

  storage.setRouteFilesMtimeMs(4000);
  const routesSummary = await defaultTenancyAdapter.scanTenantsAdapter({
    config: {
      tenantsPath: `/tmp/tenancy-resolver-change-fingerprint`,
      registry: scanSummary.registry
    },
    routeMatcherCompiler: createTestTenantRouteMatcherCompiler(),
    storage
  });
  assert.ok(routesSummary.changedHosts.includes(`www.example.com`));
  assert.equal(routesSummary.registry.hosts.get(`www.example.com`)?.routeFilesMtimeMs, 4000);
});

test(`tenant directory resolver asks main to reload changed tenants and stop removed tenants after successful rescans`, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-tenancy-resolver-sync-`));
  const adapterPath = path.join(tempDir, `adapter.js`);
  fs.writeFileSync(adapterPath, [
    `'use strict';`,
    `let scanCalls = 0;`,
    `module.exports = {`,
    `  async scanTenantsAdapter() {`,
    `    scanCalls += 1;`,
    `    if (scanCalls === 1) return { initialScan: true, changedHosts: [], removedHosts: [] };`,
    `    return {`,
    `      initialScan: false,`,
    `      changedHosts: ['www.example.com'],`,
    `      removedHosts: ['api.example.com']`,
    `    };`,
    `  },`,
    `  async matchRouteAdapter() { return null; },`,
    `  async destroyAdapter() {}`,
    `};`
  ].join(`\n`));

  const asks = [];
  try {
    const tenantDirectoryResolver = new TenantDirectoryResolver({
      config: {
        _adapters: {
          tenantDirectoryResolver: adapterPath
        },
        tenantDirectoryResolver: {
          tenantsPath: `/tmp/tenancy-resolver-sync`,
          scanIntervalMs: 300000
        },
        projectRouteMatcherCompiler: {
          adapter: `default-routing-v1`
        },
        watchdogOrchestrator: {
          question: {
            reloadProcess: `reloadProcess`
          }
        },
        processForkRuntime: {
          question: {
            shutdownProcess: `shutdownProcess`
          }
        }
      },
      pluginOrchestrator: {
        async run() { }
      },
      useCases: {
        storageService: {
          async listEntries() {
            return [];
          }
        },
        sharedCacheService: {
          async deleteByPrefix() {
            return 0;
          }
        },
        projectRouteMatcherCompiler: createTestTenantRouteMatcherCompiler(),
        rpcEndpoint: {
          async ask(payload) {
            asks.push(payload);
            return { success: true };
          }
        }
      }
    });

    await tenantDirectoryResolver.runScanCycle();
    assert.deepEqual(asks, []);

    await tenantDirectoryResolver.runScanCycle();

    assert.deepEqual(asks, [
      {
        target: `main`,
        question: `reloadProcess`,
        data: {
          label: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb`,
          reason: `tenancy_scan_changed`
        }
      },
      {
        target: `main`,
        question: `shutdownProcess`,
        data: {
          label: `e_app_aaaaaaaaaaaa_cccccccccccc`,
          reason: `tenancy_scan_removed`
        }
      }
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test(`tenant directory resolver proactively ensures active tenant transports and isolated runtimes and shuts down stale process labels after scans`, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-tenancy-resolver-reconcile-`));
  const adapterPath = path.join(tempDir, `adapter.js`);
  fs.writeFileSync(adapterPath, [
    `'use strict';`,
    `module.exports = {`,
    `  async scanTenantsAdapter() {`,
    `    return {`,
    `      initialScan: false,`,
    `      changedHosts: [],`,
    `      removedHosts: [],`,
    `      activeTenants: [`,
    `        { tenantId: 'aaaaaaaaaaaa', tenantDomain: 'example.com', tenantRoot: '/tmp/tenants/tenant_aaaaaaaaaaaa' }`,
    `      ],`,
    `      activeHosts: [`,
    `        { host: 'www.example.com', tenantId: 'aaaaaaaaaaaa', appId: 'bbbbbbbbbbbb', domain: 'example.com', appName: 'www', rootFolder: '/tmp/tenants/tenant_aaaaaaaaaaaa/app_bbbbbbbbbbbb' }`,
    `      ]`,
    `    };`,
    `  },`,
    `  async matchRouteAdapter() { return null; },`,
    `  async destroyAdapter() {}`,
    `};`
  ].join(`\n`));

  const asks = [];
  try {
    const tenantDirectoryResolver = new TenantDirectoryResolver({
      config: {
        _adapters: {
          tenantDirectoryResolver: adapterPath
        },
        tenantDirectoryResolver: {
          tenantsPath: `/tmp/tenancy-resolver-reconcile`,
          scanIntervalMs: 300000,
          spawnTenantAppAfterScan: true
        },
        projectRouteMatcherCompiler: {
          adapter: `default-routing-v1`
        },
        processForkRuntime: {
          question: {
            ensureProcess: `ensureProcess`,
            listProcesses: `listProcesses`,
            shutdownProcess: `shutdownProcess`
          }
        }
      },
      pluginOrchestrator: {
        async run() { }
      },
      useCases: {
        storageService: {
          async listEntries() {
            return [];
          }
        },
        sharedCacheService: {
          async deleteByPrefix() {
            return 0;
          }
        },
        projectRouteMatcherCompiler: createTestTenantRouteMatcherCompiler(),
        rpcEndpoint: {
          async ask(payload) {
            asks.push(payload);
            if (payload.question === `listProcesses`) {
              return {
                success: true,
                processes: [
                  { label: `e_transport_aaaaaaaaaaaa`, pid: 201, state: `ready` },
                  { label: `e_transport_zzzzzzzzzzzz`, pid: 202, state: `ready` },
                  { label: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb`, pid: 101, state: `ready` },
                  { label: `e_app_aaaaaaaaaaaa_oldoldoldold`, pid: 102, state: `ready` }
                ]
              };
            }
            return { success: true };
          }
        }
      }
    });

    await tenantDirectoryResolver.runScanCycle();

    assert.deepEqual(asks, [
      {
        target: `main`,
        question: `ensureProcess`,
        data: {
          label: `e_transport_aaaaaaaaaaaa`,
          reason: `tenancy_scan_ensure`,
          processType: `transport`,
          tenantId: `aaaaaaaaaaaa`,
          tenantDomain: `example.com`,
          tenantRoot: `/tmp/tenants/tenant_aaaaaaaaaaaa`
        }
      },
      {
        target: `main`,
        question: `ensureProcess`,
        data: {
          label: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb`,
          reason: `tenancy_scan_ensure`,
          processType: `isolatedRuntime`,
          tenantId: `aaaaaaaaaaaa`,
          appId: `bbbbbbbbbbbb`,
          appDomain: `example.com`,
          appName: `www`,
          appRoot: `/tmp/tenants/tenant_aaaaaaaaaaaa/app_bbbbbbbbbbbb`
        }
      },
      {
        target: `main`,
        question: `listProcesses`,
        data: {}
      },
      {
        target: `main`,
        question: `shutdownProcess`,
        data: {
          label: `e_transport_zzzzzzzzzzzz`,
          reason: `tenancy_scan_inactive_tenant`
        }
      },
      {
        target: `main`,
        question: `shutdownProcess`,
        data: {
          label: `e_app_aaaaaaaaaaaa_oldoldoldold`,
          reason: `tenancy_scan_inactive_host`
        }
      }
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test(`isolated runtime action cache reloads an action module when the source file changes`, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-action-reload-`));
  const actionPath = path.join(tempRoot, `actions`, `hello.js`);
  fs.mkdirSync(path.dirname(actionPath), { recursive: true });
  fs.writeFileSync(
    actionPath,
    `module.exports = async function hello() { return { status: 200, body: 'first' }; };\n`
  );

  const actionCache = new Map();

  try {
    const firstResponse = await handleIsolatedActionRequest({
      projectRoute: {
        action: `actions/hello.js`
      },
      requestData: { url: `www.example.com/hello` },
      sessionData: {},
      appRoot: tempRoot,
      isolatedLabel: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb`,
      isolatedApp: null,
      services: {},
      actionCache
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(
      actionPath,
      `module.exports = async function hello() { return { status: 200, body: 'second' }; };\n`
    );
    const refreshedAt = new Date(Date.now() + 1000);
    fs.utimesSync(actionPath, refreshedAt, refreshedAt);

    const secondResponse = await handleIsolatedActionRequest({
      projectRoute: {
        action: `actions/hello.js`
      },
      requestData: { url: `www.example.com/hello` },
      sessionData: {},
      appRoot: tempRoot,
      isolatedLabel: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb`,
      isolatedApp: null,
      services: {},
      actionCache
    });

    assert.equal(firstResponse.body, `first`);
    assert.equal(secondResponse.body, `second`);
  } finally {
    if (fs.existsSync(actionPath)) {
      delete require.cache[require.resolve(actionPath)];
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(`mid queue stage returns 503 with Retry-After when the action queue is saturated`, async () => {
  const responseData = {
    status: 200,
    body: null,
    headers: {}
  };
  const middlewareContext = {
    projectRoute: { origin: { hostname: `tenant.test` }, target: { run: { resource: `actions/hello.js`, action: `index` } } },
    middlewareStackRuntimeConfig: {
      queue: {
        actionMaxConcurrent: 5,
        actionWaitTimeoutMs: 1000,
        retryAfterMs: 500
      }
    },
    async askManager() {
      return {
        success: false,
        reason: `queue_full`,
        queueLabel: `actionQueue:tenant.test`,
        maxWaiting: 1000
      };
    },
    addFinishCallback() {
      throw new Error(`finish callback should not be added`);
    },
    setHeader(key, value) {
      responseData.headers[key] = value;
    },
    setBody(value) {
      responseData.body = value;
    },
    setStatus(value) {
      responseData.status = value;
    }
  };

  const continueMiddlewareStack = await require(`@middleware/http/core-queue`)(middlewareContext);

  assert.equal(continueMiddlewareStack, false);
  assert.equal(responseData.status, 503);
  assert.equal(responseData.headers[`Content-Type`], `text/plain; charset=utf-8`);
  assert.ok(responseData.headers[`Retry-After`]);
  assert.match(responseData.body, /^Action queue is saturated in this non-production environment\./);
});

test(`mid queue stage returns 504 with Retry-After when action queue wait times out`, async () => {
  const responseData = {
    status: 200,
    body: null,
    headers: {}
  };
  const middlewareContext = {
    projectRoute: { origin: { hostname: `tenant.test` }, target: { run: { resource: `actions/hello.js`, action: `index` } } },
    middlewareStackRuntimeConfig: {
      queue: {
        actionMaxConcurrent: 5,
        actionWaitTimeoutMs: 1000,
        retryAfterMs: 500
      }
    },
    async askManager() {
      return {
        success: false,
        reason: `queue_wait_timeout`,
        queueLabel: `actionQueue:tenant.test`
      };
    },
    addFinishCallback() {
      throw new Error(`finish callback should not be added`);
    },
    setHeader(key, value) {
      responseData.headers[key] = value;
    },
    setBody(value) {
      responseData.body = value;
    },
    setStatus(value) {
      responseData.status = value;
    }
  };

  const continueMiddlewareStack = await require(`@middleware/http/core-queue`)(middlewareContext);

  assert.equal(continueMiddlewareStack, false);
  assert.equal(responseData.status, 504);
  assert.equal(responseData.headers[`Content-Type`], `text/plain; charset=utf-8`);
  assert.ok(responseData.headers[`Retry-After`]);
  assert.match(responseData.body, /^Request waited too long in the action queue for this non-production environment\./);
});

test(`mid queue stage scopes action concurrency by resolved app identity`, async () => {
  const requestedQueueLabels = [];
  const middlewareContext = {
    projectRoute: {
      origin: {
        hostname: `tenant.test`,
        tenantId: `aaaaaaaaaaaa`,
        appId: `bbbbbbbbbbbb`,
        appName: `app1`
      },
      target: { run: { resource: `actions/hello.js`, action: `index` } }
    },
    middlewareStackRuntimeConfig: {
      queue: {
        actionMaxConcurrent: 5,
        actionWaitTimeoutMs: 1000
      }
    },
    async askManager(question, payload) {
      requestedQueueLabels.push(payload.queueLabel);
      return { success: true, queueLabel: payload.queueLabel, taskId: 11 };
    },
    addFinishCallback(callback) {
      assert.equal(typeof callback, `function`);
    }
  };

  const continueMiddlewareStack = await require(`@middleware/http/core-queue`)(middlewareContext);

  assert.equal(continueMiddlewareStack, true);
  assert.deepEqual(requestedQueueLabels, [
    `actionQueue:aaaaaaaaaaaa:bbbbbbbbbbbb`
  ]);
});

test(`mid queue stage includes the app prefix when only path routing metadata is available`, async () => {
  const requestedQueueLabels = [];
  const middlewareContext = {
    projectRoute: {
      origin: {
        hostname: `tenant.test`,
        appName: `app2`,
        appURL: `tenant.test/app2`
      },
      domainRoutingMode: `path`,
      target: { run: { resource: `actions/hello.js`, action: `index` } }
    },
    middlewareStackRuntimeConfig: {
      queue: {
        actionMaxConcurrent: 5,
        actionWaitTimeoutMs: 1000
      }
    },
    async askManager(question, payload) {
      requestedQueueLabels.push(payload.queueLabel);
      return { success: true, queueLabel: payload.queueLabel, taskId: 12 };
    },
    addFinishCallback(callback) {
      assert.equal(typeof callback, `function`);
    }
  };

  const continueMiddlewareStack = await require(`@middleware/http/core-queue`)(middlewareContext);

  assert.equal(continueMiddlewareStack, true);
  assert.deepEqual(requestedQueueLabels, [
    `actionQueue:tenant.test:app2`
  ]);
});

test(`static asset serve stage returns a diagnostic static-asset miss message in non-production`, async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = `development`;

  try {
    const responseData = {
      status: 200,
      body: null,
      headers: {}
    };
    const middlewareContext = {
      projectRoute: {
        host: `tenant.test`,
        cache: `no-cache`,
        isStaticAsset() {
          return true;
        },
        assetPath() {
          return `/tmp/tenant/assets/missing.css`;
        }
      },
      requestData: {
        url: `tenant.test/missing.css`
      },
      services: {
        storage: {
          async fileExists() {
            return false;
          }
        },
        cache: {}
      },
      async askManager(question, payload) {
        if (question !== `queue`) return null;
        assert.equal(payload.queueLabel, `staticQueue:tenant.test`);
        return { success: true, taskId: 10 };
      },
      addFinishCallback() { },
      setHeader(key, value) {
        responseData.headers[key] = value;
      },
      setBody(value) {
        responseData.body = value;
      },
      setStatus(value) {
        responseData.status = value;
      }
    };

    const continueMiddlewareStack = await staticAssetServeMiddleware(middlewareContext);

    assert.equal(continueMiddlewareStack, false);
    assert.equal(responseData.status, 404);
    assert.equal(responseData.headers[`Content-Type`], `text/plain; charset=utf-8`);
    assert.equal(
      responseData.body,
      `Static asset route resolved, but the target file was not found in this non-production environment.\nAsset path: /tmp/tenant/assets/missing.css`
    );
  } finally {
    restoreNodeEnv(previousNodeEnv);
  }
});

test(`uWS handler resolves route once and writes the flow response once`, async () => {
  const counts = new Map();
  const res = createMockUwsResponse();
  const req = {
    forEach(callback) {
      callback(`host`, `tenant.test`);
      callback(`x-forwarded-host`, `tenant.test`);
      callback(`x-forwarded-proto`, `http`);
      callback(`x-forwarded-port`, `80`);
      callback(`x-forwarded-method`, `GET`);
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
    responseData: { status: 200, headers: {}, body: `ok` },
    hooks: {
      REQUEST: {
        GET_COOKIE: { BEFORE: `get-cookie.before`, AFTER: `get-cookie.after`, ERROR: `get-cookie.error` },
        GET_ROUTER: { BEFORE: `get-router.before`, AFTER: `get-router.after`, ERROR: `get-router.error` },
        BODY: { START: `body.start`, END: `body.end`, ERROR: `body.error` },
        BREAK: `request.break`,
        ERROR: `request.error`
      },
      RESPONSE: {
        WRITE: { START: `write.start`, END: `write.end`, BREAK: `write.break`, ERROR: `write.error` }
      }
    },
    async run(hookId) {
      counts.set(hookId, (counts.get(hookId) ?? 0) + 1);
    },
    async setupRequestData(data) {
      this.requestData = data;
    },
    async runHttpMiddlewareStack() {
      this.responseData.body = `ok`;
    },
    async end() { },
    isAborted() {
      return false;
    },
    abort() { }
  };
  executionContext.directorHelper = {
    async resolveRoute() {
      await executionContext.run(`get-router.before`);
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
      await executionContext.run(`get-router.after`);
    }
  };

  await handleHttp(executionContext);

  assert.equal(counts.get(`get-router.before`), 1);
  assert.equal(counts.get(`get-router.after`), 1);
  assert.equal(res.status, `200 OK`);
  assert.equal(res.body, `ok`);
});

test(`uWS handler canonicalizes request data from x-forwarded headers and preserves custom headers`, async () => {
  const res = createMockUwsResponse();
  const req = {
    forEach(callback) {
      callback(`host`, `raw.test`);
      callback(`cookie`, `session=abc123; theme=amber`);
      callback(`x-custom-header`, `custom-value`);
      callback(`x-forwarded-host`, `tenant.test`);
      callback(`x-forwarded-proto`, `https`);
      callback(`x-forwarded-port`, `443`);
      callback(`x-forwarded-method`, `GET`);
      callback(`x-forwarded-uri`, `/proxy-path`);
      callback(`x-forwarded-query`, `foo=bar&foo=baz&hello=world`);
      callback(`x-forwarded-for`, `203.0.113.10, 10.0.0.5`);
      callback(`x-real-ip`, `10.0.0.5`);
    },
    getQuery() {
      return `raw=yes`;
    },
    getMethod() {
      return `GET`;
    },
    getUrl() {
      return `/raw-path`;
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
    async run() { },
    async setupRequestData(data) {
      const RequestData = require(`@/_core/runtimes/ingress-runtime/execution/request-data`);
      this.requestData = new RequestData(data);
    },
    async runHttpMiddlewareStack() {
      this.responseData.body = `ok`;
    },
    async end() { },
    isAborted() {
      return false;
    },
    abort() { }
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

  await handleHttp(executionContext);

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

test(`uWS handler rejects requests missing required proxied headers with 400`, async () => {
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
    async run() { },
    async setupRequestData(data) {
      this.requestData = data;
    },
    async runHttpMiddlewareStack() {
      throw new Error(`middleware stack should not run`);
    },
    async end() { },
    isAborted() {
      return false;
    },
    abort() { }
  };
  executionContext.directorHelper = {
    async resolveRoute() {
      throw new Error(`route lookup should not run`);
    }
  };

  await handleHttp(executionContext);

  assert.equal(res.status, `400 Bad Request`);
  assert.equal(res.headers[`Content-Type`], `text/plain; charset=utf-8`);
  assert.equal(res.body, `Bad Request`);
});

test(`uWS handler rejects methods outside the route allowlist with 405 and Allow header`, async () => {
  const res = createMockUwsResponse();
  const req = {
    forEach(callback) {
      callback(`host`, `tenant.test`);
      callback(`x-forwarded-host`, `tenant.test`);
      callback(`x-forwarded-proto`, `http`);
      callback(`x-forwarded-port`, `80`);
      callback(`x-forwarded-method`, `POST`);
      callback(`x-forwarded-uri`, `/hello`);
      callback(`x-forwarded-query`, ``);
      callback(`x-forwarded-for`, `203.0.113.10`);
    },
    getQuery() {
      return ``;
    },
    getMethod() {
      return `POST`;
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
    async run() { },
    async setupRequestData(data) {
      this.requestData = data;
    },
    async runHttpMiddlewareStack() {
      throw new Error(`middleware stack should not run`);
    },
    async end() { },
    isAborted() {
      return false;
    },
    abort() { }
  };
  executionContext.directorHelper = {
    async resolveRoute() {
      executionContext.projectRoute = {
        methodsAvailable: [`GET`, `POST`],
        methods: [`GET`],
        contentTypes: null,
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

  await handleHttp(executionContext);

  assert.equal(res.status, `405 Method Not Allowed`);
  assert.equal(res.headers.Allow, `GET, HEAD, OPTIONS`);
  assert.equal(res.headers[`Content-Type`], `text/plain; charset=utf-8`);
  assert.equal(res.body, `Method Not Allowed`);
});

test(`uWS handler writes a diagnostic body-read validation message in non-production`, async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = `development`;

  try {
    const res = createMockUwsResponse({
      onData(handler) {
        handler(Buffer.from(`{`), true);
      }
    });
    const req = {
      forEach(callback) {
        callback(`host`, `tenant.test`);
        callback(`content-type`, `application/json`);
        callback(`content-length`, `1`);
        callback(`x-forwarded-host`, `tenant.test`);
        callback(`x-forwarded-proto`, `http`);
        callback(`x-forwarded-port`, `80`);
        callback(`x-forwarded-method`, `POST`);
        callback(`x-forwarded-uri`, `/hello`);
        callback(`x-forwarded-query`, ``);
        callback(`x-forwarded-for`, `203.0.113.10`);
      },
      getQuery() {
        return ``;
      },
      getMethod() {
        return `POST`;
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
      ingressRuntime: {
        middlewareStackRuntime: {
          config: {},
          maxInputBytes: `1MB`
        }
      },
      async run() { },
      async setupRequestData(data) {
        this.requestData = data;
      },
      async runHttpMiddlewareStack() {
        throw new Error(`middleware stack should not run`);
      },
      async end() { },
      isAborted() {
        return false;
      },
      abort() { }
    };
    executionContext.directorHelper = {
      async resolveRoute() {
        executionContext.projectRoute = {
          methodsAvailable: [`POST`],
          methods: [`POST`],
          contentTypes: [`application/json`],
          maxInputBytes: `1MB`,
          session: false,
          allowsHostMethod(method) {
            return this.methodsAvailable.includes(method);
          },
          allowsMethod(method) {
            return this.methods.includes(method);
          },
          allowsContentType(contentType) {
            return this.contentTypes.includes(String(contentType).split(`;`)[0].trim().toLowerCase());
          },
          isRedirect() {
            return false;
          }
        };
      }
    };

    await handleHttp(executionContext);

    assert.equal(res.status, `400 Bad Request`);
    assert.equal(res.headers[`Content-Type`], `text/plain; charset=utf-8`);
    assert.match(res.body, /^Request body validation failed in this non-production environment\.\nReason: invalid JSON body\nDetail: /);
  } finally {
    restoreNodeEnv(previousNodeEnv);
  }
});


test(`request latency classifier applies profile-specific thresholds`, () => {
  const classification = classifyRequestLatency({
    durationMs: 180,
    projectRoute: {
      isStaticAsset() {
        return false;
      }
    },
    meta: {
      action: true,
      cached: false
    },
    config: {
      enabled: true,
      profiles: {
        action: { fastMs: 120, okMs: 250, slowMs: 700 },
        default: { fastMs: 100, okMs: 300, slowMs: 900 }
      }
    }
  });

  assert.deepEqual(classification, {
    profile: `action`,
    class: `ok`,
    durationMs: 180,
    thresholds: {
      fastMs: 120,
      okMs: 250,
      slowMs: 700
    }
  });
});

test(`execution context finalization stores latency profile and class in meta`, async () => {
  const meta = new ExecutionMetaData();
  meta.startedAt = Date.now() - 220;
  meta.cached = true;

  const fakeExecutionContext = {
    finishCallbacks: [],
    metaFinalized: false,
    meta,
    projectRoute: {
      isStaticAsset() {
        return false;
      }
    },
    ingressRuntime: {
      middlewareStackRuntime: {
        config: {
          latencyClassification: {
            enabled: true,
            profiles: {
              cacheHit: { fastMs: 40, okMs: 140, slowMs: 500 },
              default: { fastMs: 120, okMs: 350, slowMs: 900 }
            }
          }
        }
      }
    }
  };

  ExecutionContext.prototype.finalizeMeta.call(fakeExecutionContext);

  assert.equal(Number.isFinite(meta.duration), true);
  assert.equal(meta.latencyProfile, `cacheHit`);
  assert.equal(meta.latencyClass, `slow`);
  assert.deepEqual(meta.latencyThresholds, {
    fastMs: 40,
    okMs: 140,
    slowMs: 500
  });
});

test(`execution context finish callbacks do not freeze meta before response writing`, async () => {
  const meta = new ExecutionMetaData();
  let callbackRan = false;
  const fakeExecutionContext = {
    finishCallbacks: [
      async () => {
        callbackRan = true;
      }
    ],
    meta
  };

  await ExecutionContext.prototype.callFinishCallbacks.call(fakeExecutionContext);
  meta.responseWriteMs = 17;

  assert.equal(callbackRan, true);
  assert.equal(meta.responseWriteMs, 17);
  assert.equal(Object.isFrozen(meta), false);
});

test(`uWS handler records body-read and response-write metadata for successful JSON requests`, async () => {
  const res = createMockUwsResponse({
    onData(handler) {
      handler(Buffer.from(`{"name":"ehecoatl"}`), true);
    }
  });
  const req = {
    forEach(callback) {
      callback(`host`, `tenant.test`);
      callback(`x-request-id`, `req-incoming-01`);
      callback(`content-type`, `application/json`);
      callback(`content-length`, `18`);
      callback(`x-forwarded-host`, `tenant.test`);
      callback(`x-forwarded-proto`, `http`);
      callback(`x-forwarded-port`, `80`);
      callback(`x-forwarded-method`, `POST`);
      callback(`x-forwarded-uri`, `/hello`);
      callback(`x-forwarded-query`, `foo=bar`);
      callback(`x-forwarded-for`, `203.0.113.10`);
    },
    getQuery() {
      return ``;
    },
    getMethod() {
      return `POST`;
    },
    getUrl() {
      return `/hello`;
    }
  };
  const meta = new ExecutionMetaData();
  const executionContext = {
    req,
    res,
    meta,
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
    ingressRuntime: {
      middlewareStackRuntime: {
        config: {},
        maxInputBytes: `1MB`
      }
    },
    async run() { },
    async setupRequestData(data) {
      this.requestData = data;
    },
    async runHttpMiddlewareStack() {
      this.responseData.body = { ok: true };
    },
    async end() { },
    isAborted() {
      return false;
    },
    abort() { }
  };
  executionContext.directorHelper = {
    async resolveRoute() {
      executionContext.projectRoute = {
        methodsAvailable: [`POST`],
        methods: [`POST`],
        contentTypes: [`application/json`],
        session: false,
        allowsHostMethod(method) {
          return this.methodsAvailable.includes(method);
        },
        allowsMethod(method) {
          return this.methods.includes(method);
        },
        allowsContentType(contentType) {
          return this.contentTypes.includes(String(contentType).split(`;`)[0].trim().toLowerCase());
        },
        isRedirect() {
          return false;
        }
      };
    }
  };

  await handleHttp(executionContext);

  assert.equal(Number.isFinite(meta.bodyReadMs), true);
  assert.equal(Number.isFinite(meta.responseWriteMs), true);
  assert.equal(meta.requestId, `req-incoming-01`);
  assert.equal(meta.correlationId, `req-incoming-01`);
  assert.equal(meta.action, false);
  assert.equal(meta.cached, false);
  assert.equal(executionContext.requestData.requestId, `req-incoming-01`);
  assert.deepEqual(executionContext.requestData.body, { name: `ehecoatl` });
  assert.equal(res.headers[`X-Request-Id`], `req-incoming-01`);
  assert.equal(res.status, `200 OK`);
});

test(`uWS handler primes request body capture before async route resolution for POST requests`, async () => {
  let onDataRegisteredBeforeResolve = false;
  let routeResolveStarted = false;
  const res = createMockUwsResponse({
    onData(handler) {
      onDataRegisteredBeforeResolve = !routeResolveStarted;
      setImmediate(() => handler(Buffer.from(`{"name":"ehecoatl"}`), true));
    }
  });
  const req = {
    forEach(callback) {
      callback(`host`, `tenant.test`);
      callback(`content-type`, `application/json`);
      callback(`content-length`, `18`);
      callback(`x-forwarded-host`, `tenant.test`);
      callback(`x-forwarded-proto`, `http`);
      callback(`x-forwarded-port`, `80`);
      callback(`x-forwarded-method`, `POST`);
      callback(`x-forwarded-uri`, `/hello`);
      callback(`x-forwarded-query`, ``);
      callback(`x-forwarded-for`, `203.0.113.10`);
    },
    getQuery() {
      return ``;
    },
    getMethod() {
      return `POST`;
    },
    getUrl() {
      return `/hello`;
    }
  };
  const executionContext = {
    req,
    res,
    meta: new ExecutionMetaData(),
    requestData: null,
    projectRoute: null,
    responseData: { status: 200, headers: {}, body: null },
    hooks: {
      REQUEST: {
        GET_COOKIE: { BEFORE: `get-cookie.before`, AFTER: `get-cookie.after`, ERROR: `get-cookie.error` },
        GET_ROUTER: { BEFORE: `get-router.before`, AFTER: `get-router.after`, ERROR: `get-router.error` },
        BODY: { START: `body.start`, END: `body.end`, ERROR: `body.error` },
        BREAK: `request.break`,
        ERROR: `request.error`
      },
      RESPONSE: {
        WRITE: { START: `write.start`, END: `write.end`, BREAK: `write.break`, ERROR: `write.error` }
      }
    },
    ingressRuntime: {
      middlewareStackRuntime: {
        config: {},
        maxInputBytes: `1MB`
      }
    },
    async run() { },
    async setupRequestData(data) {
      this.requestData = data;
    },
    async runHttpMiddlewareStack() {
      this.responseData.body = { ok: true };
    },
    async end() { },
    isAborted() {
      return false;
    },
    abort() { }
  };
  executionContext.directorHelper = {
    async resolveRoute() {
      routeResolveStarted = true;
      await new Promise((resolve) => setImmediate(resolve));
      executionContext.projectRoute = {
        methodsAvailable: [`POST`],
        methods: [`POST`],
        contentTypes: [`application/json`],
        session: false,
        allowsHostMethod(method) {
          return this.methodsAvailable.includes(method);
        },
        allowsMethod(method) {
          return this.methods.includes(method);
        },
        allowsContentType(contentType) {
          return this.contentTypes.includes(String(contentType).split(`;`)[0].trim().toLowerCase());
        },
        isRedirect() {
          return false;
        }
      };
    }
  };

  await handleHttp(executionContext);

  assert.equal(onDataRegisteredBeforeResolve, true);
  assert.deepEqual(executionContext.requestData.body, { name: `ehecoatl` });
  assert.equal(res.status, `200 OK`);
});

test(`uWS handler writes a non-production internal-routing message when route resolution fails`, async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousConsoleError = console.error;
  process.env.NODE_ENV = `development`;
  console.error = () => { };

  try {
    const res = createMockUwsResponse();
    const req = {
      forEach(callback) {
        callback(`host`, `tenant.test`);
        callback(`x-forwarded-host`, `tenant.test`);
        callback(`x-forwarded-proto`, `http`);
        callback(`x-forwarded-port`, `80`);
        callback(`x-forwarded-method`, `GET`);
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
      async run() { },
      async setupRequestData(data) {
        this.requestData = data;
      },
      async runHttpMiddlewareStack() {
        throw new Error(`middleware stack should not run`);
      },
      async end() { },
      isAborted() {
        return false;
      },
      abort() { }
    };
    executionContext.directorHelper = {
      async resolveRoute() {
        throw new Error(`route lookup failed`);
      }
    };

    await handleHttp(executionContext);

    assert.equal(res.status, `500 Internal Server Error`);
    assert.equal(res.headers[`Content-Type`], `text/plain; charset=utf-8`);
    assert.equal(
      res.body,
      `Request routing failed in this non-production environment. See runtime logs for details.`
    );
  } finally {
    console.error = previousConsoleError;
    restoreNodeEnv(previousNodeEnv);
  }
});

test(`uWS handler rejects methods outside the host allowlist before route checks`, async () => {
  const res = createMockUwsResponse();
  const req = {
    forEach(callback) {
      callback(`host`, `tenant.test`);
      callback(`x-forwarded-host`, `tenant.test`);
      callback(`x-forwarded-proto`, `http`);
      callback(`x-forwarded-port`, `80`);
      callback(`x-forwarded-method`, `PATCH`);
      callback(`x-forwarded-uri`, `/hello`);
      callback(`x-forwarded-query`, ``);
      callback(`x-forwarded-for`, `203.0.113.10`);
    },
    getQuery() {
      return ``;
    },
    getMethod() {
      return `PATCH`;
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
    async run() { },
    async setupRequestData(data) {
      this.requestData = data;
    },
    async runHttpMiddlewareStack() {
      throw new Error(`middleware stack should not run`);
    },
    async end() { },
    isAborted() {
      return false;
    },
    abort() { }
  };
  executionContext.directorHelper = {
    async resolveRoute() {
      executionContext.projectRoute = {
        methodsAvailable: [`GET`, `POST`],
        methods: [`GET`, `POST`, `PATCH`],
        contentTypes: null,
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

  await handleHttp(executionContext);

  assert.equal(res.status, `405 Method Not Allowed`);
  assert.equal(res.headers.Allow, `GET, HEAD, POST, OPTIONS`);
  assert.equal(res.headers[`Content-Type`], `text/plain; charset=utf-8`);
  assert.equal(res.body, `Method Not Allowed`);
});

test(`uWS handler rejects disallowed content types before body parsing`, async () => {
  const res = createMockUwsResponse();
  const req = {
    forEach(callback) {
      callback(`host`, `tenant.test`);
      callback(`content-type`, `text/plain; charset=utf-8`);
      callback(`content-length`, `5`);
      callback(`x-forwarded-host`, `tenant.test`);
      callback(`x-forwarded-proto`, `http`);
      callback(`x-forwarded-port`, `80`);
      callback(`x-forwarded-method`, `POST`);
      callback(`x-forwarded-uri`, `/hello`);
      callback(`x-forwarded-query`, ``);
      callback(`x-forwarded-for`, `203.0.113.10`);
    },
    getQuery() {
      return ``;
    },
    getMethod() {
      return `POST`;
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
    async run() { },
    async setupRequestData(data) {
      this.requestData = data;
    },
    async runHttpMiddlewareStack() {
      throw new Error(`middleware stack should not run`);
    },
    async end() { },
    isAborted() {
      return false;
    },
    abort() { }
  };
  executionContext.directorHelper = {
    async resolveRoute() {
      executionContext.projectRoute = {
        methodsAvailable: [`POST`],
        methods: [`POST`],
        contentTypes: [`application/json`],
        allowsHostMethod(method) {
          return this.methodsAvailable.includes(method);
        },
        allowsMethod(method) {
          return this.methods.includes(method);
        },
        allowsContentType(contentType) {
          return this.contentTypes.includes(String(contentType).split(`;`)[0].trim().toLowerCase());
        },
        isRedirect() {
          return false;
        }
      };
    }
  };

  await handleHttp(executionContext);

  assert.equal(res.status, `415 Unsupported Media Type`);
  assert.equal(res.headers[`Content-Type`], `text/plain; charset=utf-8`);
  assert.equal(res.body, `Unsupported Media Type`);
});

test(`queue broker reads the declared DIRECTOR.QUEUE_BROKER hook branch`, () => {
  const kernelContext = {
    config: {
      _adapters: {
        queueBroker: `@adapter/inbound/queue-manager/event-memory`
      },
      queueBroker: {
        adapter: `event-memory`,
        defaultTTL: 1000
      }
    },
    pluginOrchestrator: {
      hooks: {
        DIRECTOR: {
          QUEUE_BROKER: { QUEUE: {}, TASK: {}, ERROR: 999 }
        }
      },
      run() { }
    }
  };

  const queueBroker = new QueueManager(kernelContext);
  assert.equal(queueBroker.hooks, kernelContext.pluginOrchestrator.hooks.DIRECTOR.QUEUE_BROKER);
});

test(`event-memory queue adapter times out waiting tasks instead of leaving RPC asks hanging`, async () => {
  const firstTask = await new Promise((resolve) => {
    queueBrokerAdapter.appendToQueueAdapter({
      queueLabel: `test-timeout-queue`,
      maxConcurrent: 1,
      waitTimeoutMs: 50,
      maxWaiting: 4
    }, resolve);
  });

  const waitingTaskPromise = new Promise((resolve) => {
    queueBrokerAdapter.appendToQueueAdapter({
      queueLabel: `test-timeout-queue`,
      maxConcurrent: 1,
      waitTimeoutMs: 20,
      maxWaiting: 4
    }, resolve);
  });

  const waitingTask = await waitingTaskPromise;

  assert.equal(firstTask.success, true);
  assert.equal(waitingTask.success, false);
  assert.equal(waitingTask.reason, `queue_wait_timeout`);

  const released = queueBrokerAdapter.removeFromQueueAdapter({
    queueLabel: `test-timeout-queue`,
    taskId: firstTask.taskId
  });

  assert.equal(released, true);
});

test(`event-memory queue adapter rejects immediately when the queue is full`, async () => {
  const queueLabel = `test-full-queue`;
  const firstTask = await new Promise((resolve) => {
    queueBrokerAdapter.appendToQueueAdapter({
      queueLabel,
      maxConcurrent: 1,
      waitTimeoutMs: 50,
      maxWaiting: 1
    }, resolve);
  });

  const secondTask = await new Promise((resolve) => {
    queueBrokerAdapter.appendToQueueAdapter({
      queueLabel,
      maxConcurrent: 1,
      waitTimeoutMs: 50,
      maxWaiting: 1
    }, resolve);
  });

  assert.equal(firstTask.success, true);
  assert.equal(secondTask.success, false);
  assert.equal(secondTask.reason, `queue_full`);

  const released = queueBrokerAdapter.removeFromQueueAdapter({
    queueLabel,
    taskId: firstTask.taskId
  });

  assert.equal(released, true);
});

test(`event-memory queue adapter can remove queued and running tasks by origin`, async () => {
  const queueLabel = `test-origin-cleanup-queue`;
  const firstTask = await new Promise((resolve) => {
    queueBrokerAdapter.appendToQueueAdapter({
      queueLabel,
      origin: `engine_0`,
      maxConcurrent: 1,
      waitTimeoutMs: 1000,
      maxWaiting: 4
    }, resolve);
  });

  await new Promise((resolve) => {
    queueBrokerAdapter.appendToQueueAdapter({
      queueLabel,
      origin: `engine_0`,
      maxConcurrent: 1,
      waitTimeoutMs: 1000,
      maxWaiting: 4
    }, resolve);
    setImmediate(resolve);
  });

  const cleanup = queueBrokerAdapter.removeTasksByOriginAdapter({
    origin: `engine_0`
  });

  assert.equal(firstTask.success, true);
  assert.deepEqual(cleanup, {
    success: true,
    removed: 2,
    origin: `engine_0`
  });
});

test(`rpc endpoint askDetailed returns merged action metadata and correlation ids`, async () => {
  let endpoint = null;
  const channel = {
    sendMessage(target, payload) {
      if (!payload.answer) {
        payload.internalMeta = {
          ...(payload.internalMeta ?? {}),
          actionMeta: {
            coldWaitMs: 27
          }
        };
        setImmediate(() => {
          endpoint.onAnswerHandler(MessageSchema.createAnswer({
            payload,
            origin: target,
            data: {
              success: true,
              body: `ok`
            },
            internalMeta: {
              actionMeta: {
                actionMs: 11
              }
            }
          }));
        });
      }
      return true;
    },
    rpcStartListening() { },
    getPID() {
      return process.pid;
    }
  };
  const kernelContext = {
    config: {
      _adapters: {
        rpc: null
      },
      rpc: {
        askTimeoutMs: 100,
        answerTimeoutMs: 100
      }
    },
    pluginOrchestrator: {
      hooks: {
        SHARED: {
          RPC_ENDPOINT: {
            ASK: { BEFORE: 1, AFTER: 2, ERROR: 3 },
            ANSWER: { BEFORE: 4, AFTER: 5, ERROR: 6 },
            CHANNEL: { RECEIVE: 7, SEND: 8, TIMEOUT: 9, ERROR: 10 }
          }
        }
      },
      async run() { }
    }
  };

  endpoint = new RpcRuntime(kernelContext, { channel });
  const response = await endpoint.askDetailed({
    target: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb`,
    question: `tenantAction`,
    data: {
      projectRoute: {
        action: `actions/example.js`
      }
    },
    internalMeta: {
      requestId: `req-123`,
      correlationId: `req-123`
    }
  });

  assert.deepEqual(response.data, {
    success: true,
    body: `ok`
  });
  assert.deepEqual(response.internalMeta, {
    requestId: `req-123`,
    correlationId: `req-123`,
    actionMeta: {
      coldWaitMs: 27,
      actionMs: 11
    }
  });
});

test(`rpc endpoint answers immediately when a question arrives before its listener is registered`, async () => {
  let endpoint = null;
  const sentMessages = [];
  const channel = {
    sendMessage(target, payload) {
      sentMessages.push({ target, payload });
      if (!payload.answer) {
        setImmediate(() => endpoint.onQuestionHandler({
          ...payload,
          origin: `manager`
        }));
      } else {
        setImmediate(() => endpoint.onAnswerHandler(payload));
      }
      return true;
    },
    rpcStartListening() { },
    getPID() {
      return `engine_0`;
    }
  };
  const kernelContext = {
    config: {
      _adapters: {
        rpc: null
      },
      rpc: {
        askTimeoutMs: 100,
        answerTimeoutMs: 100
      }
    },
    pluginOrchestrator: {
      hooks: {
        SHARED: {
          RPC_ENDPOINT: {
            ASK: { BEFORE: 1, AFTER: 2, ERROR: 3 },
            ANSWER: { BEFORE: 4, AFTER: 5, ERROR: 6 },
            CHANNEL: { RECEIVE: 7, SEND: 8, TIMEOUT: 9, ERROR: 10 }
          }
        }
      },
      async run() { }
    }
  };

  endpoint = new RpcRuntime(kernelContext, { channel });
  const answer = await endpoint.ask({
    target: `director`,
    question: `requestUriRoutingRuntime`,
    data: { url: `tenant.test/hello` }
  });

  assert.deepEqual(answer, {
    success: false,
    error: `RPC listener not ready for question "requestUriRoutingRuntime"`
  });
  assert.equal(sentMessages.some((entry) => entry.payload?.answer === true), true);
});

test(`rpc endpoint can route local-main answers back through a fallback router when direct send is unavailable`, async () => {
  let endpoint = null;
  const sentMessages = [];
  const channel = {
    sendMessage(target, payload) {
      sentMessages.push({ target, payload });
      if (!payload.answer) {
        setImmediate(() => endpoint.onQuestionHandler({
          ...payload,
          origin: `manager`
        }));
        return true;
      }
      return undefined;
    },
    rpcStartListening() { },
    getPID() {
      return `main`;
    }
  };
  const kernelContext = {
    config: {
      _adapters: {
        rpc: null
      },
      rpc: {
        askTimeoutMs: 100,
        answerTimeoutMs: 100
      }
    },
    pluginOrchestrator: {
      hooks: {
        SHARED: {
          RPC_ENDPOINT: {
            ASK: { BEFORE: 1, AFTER: 2, ERROR: 3 },
            ANSWER: { BEFORE: 4, AFTER: 5, ERROR: 6 },
            CHANNEL: { RECEIVE: 7, SEND: 8, TIMEOUT: 9, ERROR: 10 }
          }
        }
      },
      async run() { }
    }
  };

  endpoint = new RpcRuntime(kernelContext, {
    channel,
    routeAnswer(target, payload) {
      assert.equal(target, `manager`);
      setImmediate(() => endpoint.onAnswerHandler(payload));
      return true;
    }
  });
  endpoint.addListener(`ensureProcess`, async () => ({ success: true }));

  const answer = await endpoint.ask({
    target: `main`,
    question: `ensureProcess`,
    data: { label: `e_app_aaaaaaaaaaaa_bbbbbbbbbbbb` }
  });

  assert.deepEqual(answer, { success: true });
  assert.equal(sentMessages.some((entry) => entry.payload?.answer === true), true);
});

test(`runtime-reporter uses supervisor heartbeat for MAIN instead of a dead main-process heartbeat hook`, async () => {
  const registrations = [];
  const executor = {
    hooks: {
      MAIN: {
        PROCESS: {
          SPAWN: 1,
          BOOTSTRAP: 2,
          READY: 3,
          SHUTDOWN: 4,
          DEAD: 5,
          CRASH: 6,
          RESTART: 7,
          ERROR: 8,
          HEARTBEAT: 9
        },
        SUPERVISOR: {
          HEARTBEAT: 10,
          BOOTSTRAP: 11,
          READY: 12,
          SHUTDOWN: 13,
          DEAD: 14,
          CRASH: 15,
          RESTART: 16,
          ERROR: 17,
          LAUNCH: { BEFORE: 18, AFTER: 19, ERROR: 20 },
          EXIT: { BEFORE: 21, AFTER: 22, ERROR: 23 }
        }
      },
      DIRECTOR: { PROCESS: null },
      TRANSPORT: { PROCESS: null },
      FLOW: { PROCESS: null },
      ISOLATED_RUNTIME: { PROCESS: null }
    },
    on(hookId) {
      registrations.push(hookId);
    }
  };

  await runtimeReporter.register.call(runtimeReporter, executor);

  assert.ok(registrations.includes(10));
  assert.equal(registrations.includes(9), false);
});

test(`kernel-main exposes both processForkRuntime and watchdogOrchestrator useCases`, () => {
  const kernelMainPath = path.join(__dirname, `..`, `_core`, `kernel`, `kernel-main.js`);
  const source = fs.readFileSync(kernelMainPath, `utf8`);

  assert.match(source, /useCases\.processForkRuntime = new ProcessForkRuntime/);
  assert.match(source, /useCases\.watchdogOrchestrator = new WatchdogOrchestrator/);
});

test(`process-director enables heartbeat reporting before tenant directory scan to avoid startup timeout regressions`, () => {
  const bootstrapDirectorPath = path.join(__dirname, `..`, `bootstrap`, `process-director.js`);
  const source = fs.readFileSync(bootstrapDirectorPath, `utf8`);

  const heartbeatImportIndex = source.indexOf(`const { setHeartbeatCallback } = require(\`@/_core/orchestrators/watchdog-orchestrator/heartbeat-reporter\`);`);
  const heartbeatIndex = source.indexOf(`setHeartbeatCallback((data) => {`);
  const listenerIndex = source.indexOf(`rpcEndpoint.addListener(nQ.requestUriRoutingRuntime, (i) => requestUriRoutingRuntime.matchRoute(i));`);
  const tenancyScanIndex = source.indexOf(`await tenantDirectoryResolver.scan()`);
  const readyNotifyIndex = source.indexOf(`state: \`ready\``);

  assert.notEqual(heartbeatImportIndex, -1);
  assert.notEqual(heartbeatIndex, -1);
  assert.notEqual(listenerIndex, -1);
  assert.notEqual(tenancyScanIndex, -1);
  assert.notEqual(readyNotifyIndex, -1);
  assert.ok(heartbeatImportIndex < heartbeatIndex);
  assert.ok(heartbeatIndex < tenancyScanIndex);
  assert.ok(listenerIndex < tenancyScanIndex);
  assert.ok(tenancyScanIndex < readyNotifyIndex);
});

test(`process-isolated-runtime preloads heartbeat reporting from the watchdog reporter before privilege drop`, () => {
  const bootstrapIsolatedRuntimePath = path.join(__dirname, `..`, `bootstrap`, `process-isolated-runtime.js`);
  const source = fs.readFileSync(bootstrapIsolatedRuntimePath, `utf8`);
  const heartbeatIndex = source.indexOf(`const { setHeartbeatCallback } = require(\`@/_core/orchestrators/watchdog-orchestrator/heartbeat-reporter\`);`);
  const privilegeDropIndex = source.indexOf(`Switching isolated runtime privileges`);

  assert.notEqual(heartbeatIndex, -1);
  assert.notEqual(privilegeDropIndex, -1);
  assert.ok(heartbeatIndex < privilegeDropIndex);
});

test(`hourly file logger writes runtime and error lines partitioned by date and hour`, () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-hourly-log-`));
  try {
    const logger = createHourlyFileLogger({
      enabled: true,
      baseDir,
      maxFiles: 50,
      cleanupIntervalMs: 100000
    });

    logger.writeRuntime(`runtime line`);
    logger.writeError(`error line`);

    const dateLabel = new Date().toISOString().slice(0, 10);
    const hourLabel = new Date().toISOString().slice(11, 13);
    const runtimeFile = path.join(baseDir, `runtime`, dateLabel, `${hourLabel}.log`);
    const errorFile = path.join(baseDir, `error`, dateLabel, `${hourLabel}.log`);

    assert.equal(fs.existsSync(runtimeFile), true);
    assert.equal(fs.existsSync(errorFile), true);
    assert.match(fs.readFileSync(runtimeFile, `utf8`), /runtime line/);
    assert.match(fs.readFileSync(errorFile, `utf8`), /error line/);
    logger.close();
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test(`hourly file logger enforces maxFiles retention per channel`, async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-hourly-retention-`));
  try {
    const channelRoot = path.join(baseDir, `runtime`);
    fs.mkdirSync(path.join(channelRoot, `2026-03-23`), { recursive: true });
    const files = [
      path.join(channelRoot, `2026-03-23`, `00.log`),
      path.join(channelRoot, `2026-03-23`, `01.log`),
      path.join(channelRoot, `2026-03-23`, `02.log`),
      path.join(channelRoot, `2026-03-23`, `03.log`)
    ];

    for (let i = 0; i < files.length; i++) {
      fs.writeFileSync(files[i], `log-${i}\n`, `utf8`);
      const mtime = new Date(Date.now() - (files.length - i) * 1000);
      fs.utimesSync(files[i], mtime, mtime);
    }

    const logger = createHourlyFileLogger({
      enabled: true,
      baseDir,
      maxFiles: 2,
      cleanupIntervalMs: 100000
    });
    logger.writeRuntime(`trigger-cleanup`);
    await new Promise((resolve) => setImmediate(resolve));

    const remaining = [];
    for (const filePath of files) {
      if (fs.existsSync(filePath)) remaining.push(path.basename(filePath));
    }
    assert.ok(remaining.length <= 2);
    logger.close();
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test(`tenant report writer aggregates per-tenant request metrics and flushes report.json`, async () => {
  const tenantRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-tenant-report-`));
  try {
    const writer = createTenantReportWriter({
      enabled: true,
      flushIntervalMs: 100000
    });

    writer.observeRequest({
      projectRoute: {
        origin: {
          hostname: `www.example.com`,
          tenantId: `aaaaaaaaaaaa`,
          appId: `bbbbbb`,
          domain: `example.com`,
          appName: `www`
        },
        folders: {
          rootFolder: tenantRoot
        }
      },
      responseData: {
        status: 200
      },
      meta: {
        duration: 18,
        latencyProfile: `cacheHit`,
        latencyClass: `fast`
      }
    });

    writer.observeRequest({
      projectRoute: {
        origin: {
          hostname: `www.example.com`,
          tenantId: `aaaaaaaaaaaa`,
          appId: `bbbbbb`,
          domain: `example.com`,
          appName: `www`
        },
        folders: {
          rootFolder: tenantRoot
        }
      },
      responseData: {
        status: 503
      },
      meta: {
        duration: 240,
        latencyProfile: `action`,
        latencyClass: `slow`
      }
    });

    await writer.flushAll();
    await writer.close();

    const reportPath = path.join(tenantRoot, `.ehecoatl`, `log`, `debug`, `report.json`);
    const report = JSON.parse(fs.readFileSync(reportPath, `utf8`));

    assert.equal(report.tenantHost, `www.example.com`);
    assert.equal(report.meta.version, 1);
    assert.equal(typeof report.windowStartedAt, `string`);
    assert.equal(typeof report.lastUpdatedAt, `string`);
    assert.equal(report.totals.requests, 2);
    assert.equal(report.totals.byStatusClass[`2xx`], 1);
    assert.equal(report.totals.byStatusClass[`5xx`], 1);
    assert.equal(report.latency.byProfile.cacheHit, 1);
    assert.equal(report.latency.byProfile.action, 1);
    assert.equal(report.latency.byClass.fast, 1);
    assert.equal(report.latency.byClass.slow, 1);
    assert.equal(report.latency.duration.count, 2);
    assert.equal(report.latency.duration.totalMs, 258);
    assert.equal(report.latency.duration.avgMs, 129);
    assert.equal(report.latency.duration.minMs, 18);
    assert.equal(report.latency.duration.maxMs, 240);
  } finally {
    fs.rmSync(tenantRoot, { recursive: true, force: true });
  }
});

test(`tenant report writer derives report path from app scope contract`, async () => {
  const tenantRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-tenant-report-log-enforced-`));
  try {
    const writer = createTenantReportWriter({
      enabled: true,
      flushIntervalMs: 100000
    });

    writer.observeRequest({
      projectRoute: {
        origin: {
          hostname: `www.example.com`,
          tenantId: `aaaaaaaaaaaa`,
          appId: `bbbbbb`,
          domain: `example.com`,
          appName: `www`
        },
        folders: {
          rootFolder: tenantRoot
        }
      },
      responseData: {
        status: 200
      },
      meta: {
        duration: 12,
        latencyProfile: `cacheHit`,
        latencyClass: `fast`
      }
    });

    await writer.flushAll();
    await writer.close();

    const expectedPath = path.join(tenantRoot, `.ehecoatl`, `log`, `debug`, `report.json`);
    const unexpectedPath = path.join(tenantRoot, `report.json`);

    assert.equal(fs.existsSync(expectedPath), true);
    assert.equal(fs.existsSync(unexpectedPath), false);
  } finally {
    fs.rmSync(tenantRoot, { recursive: true, force: true });
  }
});

test(`runtime-reporter updates tenant report on TRANSPORT.REQUEST.END and flushes on shutdown`, async () => {
  const tenantRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-plugin-tenant-report-`));
  try {
    const listeners = new Map();
    const hookIds = {
      PROCESS: {
        SHUTDOWN: 4,
        DEAD: 5
      },
      REQUEST: {
        END: 30
      }
    };
    const executor = {
      hooks: {
        MAIN: { PROCESS: null },
        DIRECTOR: { PROCESS: null },
        TRANSPORT: {
          PROCESS: {
            SPAWN: 100,
            BOOTSTRAP: 101,
            READY: 102,
            SHUTDOWN: hookIds.PROCESS.SHUTDOWN,
            DEAD: hookIds.PROCESS.DEAD,
            CRASH: 103,
            RESTART: 104,
            ERROR: 105,
            HEARTBEAT: 106
          },
          REQUEST: {
            END: hookIds.REQUEST.END
          }
        },
        FLOW: {
          PROCESS: {
            SPAWN: 200,
            BOOTSTRAP: 201,
            READY: 202,
            SHUTDOWN: 203,
            DEAD: 204,
            CRASH: 205,
            RESTART: 206,
            ERROR: 207,
            HEARTBEAT: 208
          }
        },
        ISOLATED_RUNTIME: { PROCESS: null },
      },
      on(id, fn) {
        listeners.set(id, fn);
      },
      getPluginConfig() {
        return {
          fileLogging: {
            enabled: false
          },
          tenantReport: {
            enabled: true,
            flushIntervalMs: 100000
          }
        };
      }
    };

    await runtimeReporter.register.call(runtimeReporter, executor);
    listeners.get(hookIds.REQUEST.END)({
      projectRoute: {
        origin: {
          hostname: `www.example.com`,
          tenantId: `aaaaaaaaaaaa`,
          appId: `bbbbbb`,
          domain: `example.com`,
          appName: `www`
        },
        folders: {
          rootFolder: tenantRoot
        }
      },
      requestData: {
        method: `GET`,
        url: `/hello`
      },
      responseData: {
        status: 200
      },
      meta: {
        duration: 41,
        latencyProfile: `action`,
        latencyClass: `ok`,
        session: true,
        cached: false,
        action: true
      }
    });

    await listeners.get(hookIds.PROCESS.SHUTDOWN)({});
    await runtimeReporter.teardown.call(runtimeReporter);

    const reportPath = path.join(tenantRoot, `.ehecoatl`, `log`, `debug`, `report.json`);
    const report = JSON.parse(fs.readFileSync(reportPath, `utf8`));
    assert.equal(report.totals.requests, 1);
    assert.equal(report.latency.byProfile.action, 1);
    assert.equal(report.latency.byClass.ok, 1);
  } finally {
    await runtimeReporter.teardown.call(runtimeReporter);
    fs.rmSync(tenantRoot, { recursive: true, force: true });
  }
});

function createMockUwsResponse(overrides = {}) {
  return {
    headers: {},
    status: null,
    body: undefined,
    cork(callback) {
      callback();
      return this;
    },
    writeStatus(value) {
      this.status = value;
      return this;
    },
    writeHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
    end(value) {
      this.body = value;
      return this;
    },
    onWritable() {
      return this;
    },
    onAborted(handler) {
      this.onAbortedHandler = handler;
      return this;
    },
    ...overrides
  };
}

function createSharedCacheKernelContext() {
  return {
    config: {
      _adapters: {
        sharedCacheService: require.resolve(`@adapter/outbound/shared-cache-service/local-memory`)
      },
      sharedCacheService: {
        adapter: `local-memory`
      }
    },
    pluginOrchestrator: {
      hooks: {
        SHARED: {
          SHARED_CACHE: {
            BEFORE: 1,
            AFTER: 2,
            ERROR: 3
          }
        }
      },
      async run() { }
    }
  };
}

function buildOpaqueTenantRoot(basePath, tenantId = `aaaaaaaaaaaa`) {
  return `${basePath}/tenant_${tenantId}`;
}

function buildOpaqueAppRoot(basePath, tenantId = `aaaaaaaaaaaa`, appId = `bbbbbbbbbbbb`) {
  return `${buildOpaqueTenantRoot(basePath, tenantId)}/app_${appId}`;
}

function createOpaqueTenantConfig({
  tenantId = `aaaaaaaaaaaa`,
  tenantDomain = `example.com`,
  alias = [],
  appRoutingMode = `subdomain`,
  defaultAppName = `www`
} = {}) {
  return {
    tenantId,
    tenantDomain,
    alias,
    appRouting: {
      mode: appRoutingMode,
      defaultAppName
    }
  };
}

function createOpaqueAppConfig({
  appId = `bbbbbbbbbbbb`,
  appName = `www`,
  ...rest
} = {}) {
  return {
    appId,
    appName,
    ...rest
  };
}

function createTenancyResolverStorageMock() {
  return {
    async listEntries(targetPath) {
      if (targetPath === `/tmp/tenancy-resolver-test`) {
        return [createDirentMock(`tenant_aaaaaaaaaaaa`, { directory: true })];
      }
      if (targetPath === buildOpaqueTenantRoot(`/tmp/tenancy-resolver-test`)) {
        return [
          createDirentMock(`config.json`, { file: true }),
          createDirentMock(`app_bbbbbbbbbbbb`, { directory: true })
        ];
      }
      return [];
    },
    async readFile(targetPath) {
      if (targetPath === `${buildOpaqueTenantRoot(`/tmp/tenancy-resolver-test`)}/config.json`) {
        return JSON.stringify(createOpaqueTenantConfig());
      }
      if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-test`)}/config.json`) {
        return JSON.stringify(createOpaqueAppConfig({
          routesAvailable: {
            '/hello': {
              pointsTo: `run > hello@index`
            }
          }
        }));
      }
      throw new Error(`Unexpected readFile path: ${targetPath}`);
    }
  };
}

function createTenancyResolverResponseCacheStorageMock({ deletedPaths }) {
  return {
    async listEntries(targetPath) {
      if (targetPath === `/tmp/tenancy-resolver-cleanup`) {
        return [createDirentMock(`tenant_aaaaaaaaaaaa`, { directory: true })];
      }
      if (targetPath === buildOpaqueTenantRoot(`/tmp/tenancy-resolver-cleanup`)) {
        return [
          createDirentMock(`config.json`, { file: true }),
          createDirentMock(`app_bbbbbbbbbbbb`, { directory: true })
        ];
      }
      if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-cleanup`)}/.cache`) {
        return [
          createDirentMock(`[www.example.com]_[hello].txt`, { file: true }),
          createDirentMock(`[www.example.com]_[stale].txt`, { file: true })
        ];
      }
      return [];
    },
    async readFile(targetPath) {
      if (targetPath === `${buildOpaqueTenantRoot(`/tmp/tenancy-resolver-cleanup`)}/config.json`) {
        return JSON.stringify(createOpaqueTenantConfig());
      }
      if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-cleanup`)}/config.json`) {
        return JSON.stringify(createOpaqueAppConfig());
      }
      throw new Error(`Unexpected readFile path: ${targetPath}`);
    },
    async fileExists(targetPath) {
      return targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-cleanup`)}/.cache`;
    },
    async deleteFile(targetPath) {
      deletedPaths.push(targetPath);
      return true;
    }
  };
}

function createTenancyResolverEnableRulesStorageMock() {
  return {
    async listEntries(targetPath) {
      if (targetPath === `/tmp/tenancy-resolver-enable-rules`) {
        return [createDirentMock(`tenant_aaaaaaaaaaaa`, { directory: true })];
      }
      if (targetPath === buildOpaqueTenantRoot(`/tmp/tenancy-resolver-enable-rules`)) {
        return [
          createDirentMock(`config.json`, { file: true }),
          createDirentMock(`app_bbbbbbbbbbbb`, { directory: true }),
          createDirentMock(`app_cccccccccccc`, { directory: true })
        ];
      }
      return [];
    },
    async readFile(targetPath) {
      if (targetPath === `${buildOpaqueTenantRoot(`/tmp/tenancy-resolver-enable-rules`)}/config.json`) {
        return JSON.stringify(createOpaqueTenantConfig({
          alias: [`alias.test`]
        }));
      }
      if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-enable-rules`)}/config.json`) {
        return JSON.stringify(createOpaqueAppConfig({
          routesAvailable: {
            '/hello': {
              pointsTo: `run > hello@index`
            }
          }
        }));
      }
      if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-enable-rules`, `aaaaaaaaaaaa`, `cccccccccccc`)}/config.json`) {
        return JSON.stringify(createOpaqueAppConfig({
          appId: `cccccccccccc`,
          appName: `api`,
          appEnabled: false,
          routesAvailable: {
            '/hello': {
              pointsTo: `run > private@index`
            }
          }
        }));
      }
      throw new Error(`Unexpected readFile path: ${targetPath}`);
    }
  };
}

function createTenancyResolverChangeFingerprintStorageMock() {
  const mtimes = {
    hostConfigMtimeMs: 1000,
    routeFilesMtimeMs: 1000,
    entrypointMtimeMs: 1000
  };

  return {
    setHostConfigMtimeMs(nextMtimeMs) {
      mtimes.hostConfigMtimeMs = nextMtimeMs;
    },
    setEntrypointMtimeMs(nextMtimeMs) {
      mtimes.entrypointMtimeMs = nextMtimeMs;
    },
    setRouteFilesMtimeMs(nextMtimeMs) {
      mtimes.routeFilesMtimeMs = nextMtimeMs;
    },
    async listEntries(targetPath) {
      if (targetPath === `/tmp/tenancy-resolver-change-fingerprint`) {
        return [createDirentMock(`tenant_aaaaaaaaaaaa`, { directory: true })];
      }
      if (targetPath === buildOpaqueTenantRoot(`/tmp/tenancy-resolver-change-fingerprint`)) {
        return [
          createDirentMock(`config.json`, { file: true }),
          createDirentMock(`app_bbbbbbbbbbbb`, { directory: true })
        ];
      }
      if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-change-fingerprint`)}/routes`) {
        return [createDirentMock(`base.json`, { file: true })];
      }
      return [];
    },
    async readFile(targetPath) {
      if (targetPath === `${buildOpaqueTenantRoot(`/tmp/tenancy-resolver-change-fingerprint`)}/config.json`) {
        return JSON.stringify(createOpaqueTenantConfig());
      }
      if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-change-fingerprint`)}/config.json`) {
        return JSON.stringify(createOpaqueAppConfig({
          routesAvailable: {
            '/hello': {
              pointsTo: `run > hello@index`
            }
          }
        }));
      }
      if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-change-fingerprint`)}/routes/base.json`) {
        return JSON.stringify({
          '/from-route-file': {
            pointsTo: `run > route-file@index`
          }
        });
      }
      throw new Error(`Unexpected readFile path: ${targetPath}`);
    },
    async fileStat(targetPath) {
      if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-change-fingerprint`)}/config.json`) {
        return { mtimeMs: mtimes.hostConfigMtimeMs };
      }
      if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-change-fingerprint`)}/index.js`) {
        return { mtimeMs: mtimes.entrypointMtimeMs };
      }
      if (targetPath === `${buildOpaqueAppRoot(`/tmp/tenancy-resolver-change-fingerprint`)}/routes/base.json`) {
        return { mtimeMs: mtimes.routeFilesMtimeMs };
      }
      throw new Error(`Unexpected fileStat path: ${targetPath}`);
    }
  };
}

function createTestTenantRouteMatcherCompiler() {
  return {
    async compileRoutes(routesAvailable) {
      return defaultRouteMatcherCompilerAdapter.compileRoutesAdapter({
        routesAvailable
      });
    }
  };
}

function createDirentMock(name, { directory = false, file = false } = {}) {
  return {
    name,
    isDirectory() {
      return directory;
    },
    isFile() {
      return file;
    }
  };
}

async function flushAsyncOperations() {
  await new Promise((resolve) => setImmediate(resolve));
}

function restoreNodeEnv(value) {
  if (value === undefined) {
    delete process.env.NODE_ENV;
    return;
  }

  process.env.NODE_ENV = value;
}
