'use strict';

require(`module-alias/register`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);
const fs = require(`node:fs`);
const os = require(`node:os`);
const path = require(`node:path`);
const { PassThrough } = require(`node:stream`);

const responseCacheResolverMiddleware = require(`@middleware/http/core-response-cache-resolver`);

test(`response cache resolver materializes safe public action output after next`, async () => {
  const writes = [];
  const cacheSets = [];
  const middlewareContext = createMaterializationContext({
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
  });

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

test(`response cache resolver materialization caps route ttl by maxResponseCacheTTL`, async () => {
  const cacheSets = [];
  const middlewareContext = createMaterializationContext({
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
    middlewareStackRuntimeConfig: {
      maxResponseCacheTTL: 5
    },
    services: {
      storage: {
        async createFolder() {},
        async writeFile() {}
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
  });

  await responseCacheResolverMiddleware(middlewareContext, async () => true);
  await flushAsyncOperations();

  assert.equal(cacheSets.length, 1);
  assert.equal(cacheSets[0].ttl, 5000);
});

test(`response cache resolver materialization skips non-cacheable session routes`, async () => {
  let wrote = false;
  const middlewareContext = createMaterializationContext({
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
  });

  const continueMiddlewareStack = await responseCacheResolverMiddleware(middlewareContext, async () => true);

  assert.equal(continueMiddlewareStack, true);
  assert.equal(wrote, false);
});

test(`response cache resolver materialization infers ttl from cache-control directives`, async () => {
  const cacheSets = [];
  const middlewareContext = createMaterializationContext({
    projectRoute: {
      target: {
        run: {
          action: `hello@index`
        }
      },
      cache: `public, max-age=60, s-maxage=120, stale-while-revalidate=30`,
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
        async createFolder() {},
        async writeFile() {}
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
  });

  await responseCacheResolverMiddleware(middlewareContext, async () => true);
  await flushAsyncOperations();

  assert.equal(cacheSets.length, 1);
  assert.equal(cacheSets[0].ttl, 120000);
});

test(`response cache resolver materialization skips custom cache-control without cacheable age directives`, async () => {
  let wrote = false;
  const middlewareContext = createMaterializationContext({
    projectRoute: {
      target: {
        run: {
          action: `hello@index`
        }
      },
      cache: `public, immutable`,
      session: false,
      isStaticAsset() {
        return false;
      },
      getCacheFilePath() {
        wrote = true;
        return `/tmp/should-not-write`;
      }
    },
    requestData: {
      method: `GET`,
      url: `tenant.test/hello`
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
  });

  const continueMiddlewareStack = await responseCacheResolverMiddleware(middlewareContext, async () => true);

  assert.equal(continueMiddlewareStack, true);
  assert.equal(wrote, false);
});

test(`response cache resolver materializes streamed bodies before releasing queue`, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-stream-cache-`));
  const cacheSets = [];
  const queueCalls = [];
  const finishCallbacks = [];
  const cacheArtifactPath = path.join(tempRoot, `.ehecoatl`, `.cache`, `tenant.test_stream.txt`);
  const body = new PassThrough();

  const middlewareContext = createMaterializationContext({
    requestData: {
      method: `GET`,
      url: `tenant.test/stream`
    },
    projectRoute: {
      origin: {
        hostname: `tenant.test`
      },
      folders: {
        rootFolder: tempRoot
      },
      target: {
        run: {
          action: `stream@index`
        }
      },
      cache: 60,
      session: false,
      isStaticAsset() {
        return false;
      },
      getCacheFilePath() {
        return path.join(tempRoot, `.ehecoatl`, `.cache`, `tenant.test_stream`);
      }
    },
    services: {
      storage: {
        async createFolder(folderPath) {
          await fs.promises.mkdir(folderPath, { recursive: true });
        },
        async writeStream(filePath) {
          return fs.createWriteStream(filePath, { encoding: `utf8` });
        },
        async fileExists(filePath) {
          try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            return true;
          } catch {
            return false;
          }
        },
        async deleteFile(filePath) {
          try {
            await fs.promises.unlink(filePath);
            return true;
          } catch (error) {
            if (error?.code === `ENOENT`) return false;
            throw error;
          }
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
      queueCalls.push({ question, payload });
      if (question === `queue`) {
        return {
          taskId: 1,
          first: true,
          queueLabel: payload.queueLabel
        };
      }
      return { success: true };
    },
    addFinishCallback(callback) {
      finishCallbacks.push(callback);
    },
    getStatus() {
      return 200;
    },
    getBody() {
      return body;
    },
    setBody(nextBody) {
      this.body = nextBody;
    },
    getHeaders() {
      return {
        'Content-Type': `text/plain; charset=utf-8`
      };
    },
    getCookies() {
      return null;
    }
  });

  const pendingMiddleware = responseCacheResolverMiddleware(middlewareContext, async () => true);
  body.end(`streamed body`);
  const continueMiddlewareStack = await pendingMiddleware;

  try {
    assert.equal(continueMiddlewareStack, true);
    assert.deepEqual(cacheSets, [
      {
        key: `validResponseCache:tenant.test/stream`,
        value: cacheArtifactPath,
        ttl: 60000
      }
    ]);
    assert.equal(fs.readFileSync(cacheArtifactPath, `utf8`), `streamed body`);
    assert.deepEqual(finishCallbacks, []);
    assert.deepEqual(queueCalls.map((call) => call.question), [`queue`, `dequeue`]);
    assert.deepEqual(middlewareContext.body, {
      __ehecoatlBodyKind: `nginx-internal-redirect`,
      uri: `/_ehecoatl_internal/cache/tenant.test_stream.txt`
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(`response cache resolver materialization skips write when tenant-specific disk limit is exceeded`, async () => {
  const tenantRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-disk-limit-block-`));
  const cacheSets = [];
  const writes = [];
  const middlewareContext = createMaterializationContext({
    projectRoute: {
      host: `tenant.test`,
      origin: {
        hostname: `tenant.test`
      },
      rootFolder: tenantRoot,
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
        return path.join(tenantRoot, `.ehecoatl`, `.cache`, `${url.replace(/\//g, `_`)}`);
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
        trackedPaths: [`.ehecoatl/.cache`],
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
    getStatus() {
      return 200;
    },
    getBody() {
      return `0123456789`;
    },
    getHeaders() {
      return {};
    },
    getCookies() {
      return null;
    }
  });

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

test(`response cache resolver materialization can cleanup tracked files and proceed within disk limit`, async () => {
  const tenantRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-disk-limit-cleanup-`));
  const cacheSets = [];
  const writes = [];
  const deleted = [];
  const staleCacheFile = path.join(tenantRoot, `.ehecoatl`, `.cache`, `stale.txt`);
  fs.mkdirSync(path.dirname(staleCacheFile), { recursive: true });
  fs.writeFileSync(staleCacheFile, `stale-file-contents-1234567890`, `utf8`);
  const staleDate = new Date(Date.now() - 60_000);
  fs.utimesSync(staleCacheFile, staleDate, staleDate);

  const middlewareContext = createMaterializationContext({
    projectRoute: {
      host: `tenant.test`,
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
        trackedPaths: [`.ehecoatl/.cache`],
        cleanupFirst: true,
        cleanupTargetRatio: 1
      },
      isStaticAsset() {
        return false;
      },
      getCacheFilePath(url) {
        return path.join(tenantRoot, `.ehecoatl`, `.cache`, `${url.replace(/\//g, `_`)}`);
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
        trackedPaths: [`.ehecoatl/.cache`],
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
    getStatus() {
      return 200;
    },
    getBody() {
      return `0123456789`;
    },
    getHeaders() {
      return {};
    },
    getCookies() {
      return null;
    }
  });

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

function createMaterializationContext(overrides = {}) {
  return {
    middlewareStackRuntimeConfig: {},
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
    addFinishCallback() {},
    ...overrides
  };
}

async function flushAsyncOperations() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
