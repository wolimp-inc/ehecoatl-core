'use strict';

require(`module-alias/register`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);
const fs = require(`node:fs`);
const os = require(`node:os`);
const path = require(`node:path`);

const weakRequire = require(`@/utils/module/weak-require`);
const {
  handleIsolatedActionRequest,
  handleIsolatedWsActionRequest
} = require(`@/bootstrap/process-isolated-runtime`);

test.afterEach(() => {
  weakRequire.clearAll();
});

test(`weakRequire returns the tracked module while the source file is unchanged`, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-weak-require-`));
  const modulePath = path.join(tempRoot, `tracked.js`);
  fs.writeFileSync(modulePath, `module.exports = { value: 'stable' };\n`);

  try {
    const firstLoad = weakRequire(modulePath);
    const secondLoad = weakRequire(modulePath);

    assert.equal(firstLoad, secondLoad);
    assert.equal(secondLoad.value, `stable`);
  } finally {
    weakRequire.clear(modulePath);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(`weakRequire reloads when the tracked file changes and clears stale cache on failures`, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-weak-require-reload-`));
  const modulePath = path.join(tempRoot, `tracked.js`);
  fs.writeFileSync(modulePath, `module.exports = { value: 'first' };\n`);

  try {
    const firstLoad = weakRequire(modulePath);
    writeModuleAndAdvanceMtime(modulePath, `module.exports = { value: 'second' };\n`);
    const secondLoad = weakRequire(modulePath);

    assert.notEqual(firstLoad, secondLoad);
    assert.equal(secondLoad.value, `second`);

    writeModuleAndAdvanceMtime(modulePath, `module.exports = ;\n`);
    assert.throws(() => weakRequire(modulePath));

    writeModuleAndAdvanceMtime(modulePath, `module.exports = { value: 'third' };\n`);
    const thirdLoad = weakRequire(modulePath);

    assert.equal(thirdLoad.value, `third`);
    assert.notEqual(secondLoad, thirdLoad);
  } finally {
    weakRequire.clear(modulePath);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(`weakRequire clears cache state when a tracked file is deleted and can load it again after recreation`, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-weak-require-delete-`));
  const modulePath = path.join(tempRoot, `tracked.js`);
  fs.writeFileSync(modulePath, `module.exports = { value: 'present' };\n`);

  try {
    const firstLoad = weakRequire(modulePath);
    fs.rmSync(modulePath, { force: true });

    assert.throws(() => weakRequire(modulePath), /(Cannot find module|ENOENT)/);

    writeModuleAndAdvanceMtime(modulePath, `module.exports = { value: 'restored' };\n`);
    const restoredLoad = weakRequire(modulePath);

    assert.equal(firstLoad.value, `present`);
    assert.equal(restoredLoad.value, `restored`);
    assert.notEqual(firstLoad, restoredLoad);
  } finally {
    weakRequire.clear(modulePath);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(`isolated HTTP actions reload changed source without process restart`, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-http-action-reload-`));
  const actionPath = path.join(tempRoot, `app`, `http`, `actions`, `hello.js`);
  fs.mkdirSync(path.dirname(actionPath), { recursive: true });
  fs.writeFileSync(actionPath, `module.exports = async () => ({ status: 200, body: 'first' });\n`);

  try {
    const firstResponse = await handleIsolatedActionRequest({
      projectRoute: {
        target: {
          run: {
            resource: `hello`,
            action: `index`
          }
        },
        folders: {
          httpActionsRootFolder: path.join(tempRoot, `app`, `http`, `actions`)
        }
      },
      requestData: { url: `www.example.com/hello` },
      sessionData: {},
      appRoot: tempRoot,
      isolatedLabel: `isolated-test`,
      isolatedApp: null,
      appTopology: null,
      services: {}
    });

    writeModuleAndAdvanceMtime(actionPath, `module.exports = async () => ({ status: 200, body: 'second' });\n`);

    const secondResponse = await handleIsolatedActionRequest({
      projectRoute: {
        target: {
          run: {
            resource: `hello`,
            action: `index`
          }
        },
        folders: {
          httpActionsRootFolder: path.join(tempRoot, `app`, `http`, `actions`)
        }
      },
      requestData: { url: `www.example.com/hello` },
      sessionData: {},
      appRoot: tempRoot,
      isolatedLabel: `isolated-test`,
      isolatedApp: null,
      appTopology: null,
      services: {}
    });

    assert.equal(firstResponse.body, `first`);
    assert.equal(secondResponse.body, `second`);
  } finally {
    weakRequire.clear(actionPath);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(`isolated WS actions reload changed source without process restart`, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-ws-action-reload-`));
  const actionPath = path.join(tempRoot, `app`, `ws`, `actions`, `hello.js`);
  fs.mkdirSync(path.dirname(actionPath), { recursive: true });
  fs.writeFileSync(actionPath, `module.exports = async () => ({ version: 'first' });\n`);

  try {
    const firstResponse = await handleIsolatedWsActionRequest({
      projectRoute: {
        folders: {
          wsActionsRootFolder: path.join(tempRoot, `app`, `ws`, `actions`)
        }
      },
      sessionData: {},
      wsMessageData: {
        actionTarget: `hello@index`
      },
      appRoot: tempRoot,
      isolatedLabel: `isolated-test`,
      isolatedApp: null,
      appTopology: null,
      services: {}
    });

    writeModuleAndAdvanceMtime(actionPath, `module.exports = async () => ({ version: 'second' });\n`);

    const secondResponse = await handleIsolatedWsActionRequest({
      projectRoute: {
        folders: {
          wsActionsRootFolder: path.join(tempRoot, `app`, `ws`, `actions`)
        }
      },
      sessionData: {},
      wsMessageData: {
        actionTarget: `hello@index`
      },
      appRoot: tempRoot,
      isolatedLabel: `isolated-test`,
      isolatedApp: null,
      appTopology: null,
      services: {}
    });

    assert.deepEqual(firstResponse, {
      success: true,
      result: {
        version: `first`
      }
    });
    assert.deepEqual(secondResponse, {
      success: true,
      result: {
        version: `second`
      }
    });
  } finally {
    weakRequire.clear(actionPath);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function writeModuleAndAdvanceMtime(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
  const currentStat = fs.statSync(filePath);
  const nextMtimeMs = Math.max(Date.now(), Math.ceil(currentStat.mtimeMs) + 1000);
  const nextMtime = new Date(nextMtimeMs);
  fs.utimesSync(filePath, nextMtime, nextMtime);
}
