'use strict';

const test = require(`node:test`);
const assert = require(`node:assert/strict`);
const path = require(`node:path`);
const Module = require(`node:module`);

installLocalAliasResolver();

const AppFluentFsRuntime = require(`../_core/runtimes/app-fluent-fs-runtime/app-fluent-fs-runtime`);

test(`AppFluentFsRuntime resolves app-local files first and supports fluent path chaining`, () => {
  const storageService = createStorageServiceMock({
    existingPaths: [
      `/runtime/app/app/http/hello.js`,
      `/runtime/app/app/ws/notify.js`
    ]
  });
  const runtime = createRuntime(storageService);

  assert.equal(
    runtime.app.http.path(`hello.js`),
    `/runtime/app/app/http/hello.js`
  );
  assert.equal(
    runtime.app.path(`index.js`),
    `/runtime/app/app/index.js`
  );
  assert.equal(
    runtime.app.scripts.path(`hello.js`),
    `/runtime/app/app/scripts/hello.js`
  );
  assert.equal(
    runtime.storage.path(`file.txt`),
    `/runtime/app/storage/file.txt`
  );
  assert.equal(
    runtime.assets.static.htm.path(`index.htm`),
    `/runtime/app/assets/static/htm/index.htm`
  );
  assert.equal(
    runtime.app.ws.path(`notify.js`),
    `/runtime/app/app/ws/notify.js`
  );
});

test(`AppFluentFsRuntime falls back to tenant shared roots when app-local file is missing`, () => {
  const storageService = createStorageServiceMock({
    existingPaths: [
      `/runtime/tenant-shared/app/http/hello.js`,
      `/runtime/tenant-shared/app/ws/actions/notify.js`,
      `/runtime/tenant-shared/assets/static/htm/index.htm`
    ]
  });
  const runtime = createRuntime(storageService);

  assert.equal(
    runtime.app.http.path(`hello.js`),
    `/runtime/tenant-shared/app/http/hello.js`
  );
  assert.equal(
    runtime.assets.static.htm.path(`index.htm`),
    `/runtime/tenant-shared/assets/static/htm/index.htm`
  );
  assert.equal(
    runtime.app.ws.actions.path(`notify.js`),
    `/runtime/tenant-shared/app/ws/actions/notify.js`
  );
  assert.equal(
    runtime.storage.path(`file.txt`),
    `/runtime/app/storage/file.txt`
  );
});

test(`AppFluentFsRuntime returns the app-local path when neither app nor tenant shared file exists`, () => {
  const storageService = createStorageServiceMock();
  const runtime = createRuntime(storageService);

  assert.equal(
    runtime.app.http.actions.path(`missing.js`),
    `/runtime/app/app/http/actions/missing.js`
  );
});

test(`AppFluentFsRuntime caches path resolution for the configured TTL`, () => {
  const storageService = createStorageServiceMock({
    existingPaths: [`/runtime/tenant-shared/app/http/hello.js`]
  });
  const runtime = createRuntime(storageService, {
    resolutionCacheTtlMs: 30_000
  });

  assert.equal(
    runtime.app.http.path(`hello.js`),
    `/runtime/tenant-shared/app/http/hello.js`
  );
  assert.equal(storageService.fileExistsSyncCalls.length, 2);

  assert.equal(
    runtime.app.http.path(`hello.js`),
    `/runtime/tenant-shared/app/http/hello.js`
  );
  assert.equal(
    storageService.fileExistsSyncCalls.length,
    2,
    `cached resolution should avoid repeated existence checks inside the TTL window`
  );
});

test(`AppFluentFsRuntime writes to the resolved scope and refreshes the cache`, async () => {
  const storageService = createStorageServiceMock({
    existingPaths: [`/runtime/tenant-shared/app/http/hello.js`]
  });
  const runtime = createRuntime(storageService);

  runtime.app.http.writeSync(`hello.js`, `module.exports = 1;`);
  assert.deepEqual(storageService.writeFileSyncCalls[0], {
    path: `/runtime/tenant-shared/app/http/hello.js`,
    content: `module.exports = 1;`,
    encoding: `utf8`
  });

  await runtime.assets.static.writeAsync(`site.css`, `body{}`);
  assert.deepEqual(storageService.writeFileCalls[0], {
    path: `/runtime/app/assets/static/site.css`,
    content: `body{}`,
    encoding: `utf8`
  });

  assert.equal(
    runtime.assets.static.path(`site.css`),
    `/runtime/app/assets/static/site.css`
  );
});

test(`AppFluentFsRuntime unlinks files through the resolved fluent path`, async () => {
  const storageService = createStorageServiceMock({
    existingPaths: [`/runtime/app/storage/cache/mailing/user@example.com.json`]
  });
  const runtime = createRuntime(storageService);

  assert.equal(
    await runtime.storage.cache.mailing.unlinkAsync(`user@example.com.json`),
    true
  );
  assert.deepEqual(storageService.deleteFileCalls[0], {
    path: `/runtime/app/storage/cache/mailing/user@example.com.json`
  });
  assert.equal(
    await runtime.storage.cache.mailing.existsAsync(`user@example.com.json`),
    false
  );
});

function createRuntime(storageService, options = {}) {
  return new AppFluentFsRuntime({
    useCases: {
      storageService
    }
  }, {
    appRootFolder: `/runtime/app`,
    tenantSharedRootFolder: `/runtime/tenant-shared`,
    ...options
  });
}

function createStorageServiceMock({
  existingPaths = []
} = {}) {
  const existing = new Set(existingPaths);
  const fileExistsSyncCalls = [];
  const fileExistsCalls = [];
  const writeFileSyncCalls = [];
  const writeFileCalls = [];
  const createFolderCalls = [];
  const deleteFileCalls = [];

  return {
    fileExistsSyncCalls,
    fileExistsCalls,
    writeFileSyncCalls,
    writeFileCalls,
    createFolderCalls,
    deleteFileCalls,
    readFileSync(targetPath) {
      return `sync:${targetPath}`;
    },
    async readFile(targetPath) {
      return `async:${targetPath}`;
    },
    writeFileSync(targetPath, content, encoding = `utf8`) {
      existing.add(targetPath);
      writeFileSyncCalls.push({
        path: targetPath,
        content,
        encoding
      });
      return undefined;
    },
    async writeFile(targetPath, content, encoding = `utf8`) {
      existing.add(targetPath);
      writeFileCalls.push({
        path: targetPath,
        content,
        encoding
      });
      return undefined;
    },
    async createFolder(targetPath) {
      createFolderCalls.push({
        path: targetPath
      });
      return undefined;
    },
    async deleteFile(targetPath) {
      deleteFileCalls.push({
        path: targetPath
      });
      const existed = existing.has(targetPath);
      existing.delete(targetPath);
      return existed;
    },
    fileExistsSync(targetPath) {
      fileExistsSyncCalls.push(targetPath);
      return existing.has(targetPath);
    },
    async fileExists(targetPath) {
      fileExistsCalls.push(targetPath);
      return existing.has(targetPath);
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
