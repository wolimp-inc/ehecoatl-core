'use strict';

require(`module-alias/register`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);
const fs = require(`node:fs`);
const os = require(`node:os`);
const path = require(`node:path`);
const { EventEmitter } = require(`node:events`);

const ProcessForkRuntime = require(`@/_core/runtimes/process-fork-runtime`);

test(`defaultWanBlock false clears WAN rules and skips automatic WAN block`, async (t) => {
  const operations = installPrivilegedBridgeStub(t);
  const supervisor = new ProcessForkRuntime(createKernelContext({
    runtime: {
      network: {
        defaultWanBlock: false,
        wanOpenApps: [],
        openLocalPorts: [15010]
      }
    }
  }));

  await supervisor.rpcRouterReadyPromise;
  await supervisor.launchProcess({
    label: `e_app_tenant_app`,
    path: `/tmp/app.js`,
    cwd: `/tmp`,
    processUser: `u_app`,
    firewall: {
      processKind: `app`,
      appSelector: `www@example.com`,
      localProxyPorts: []
    }
  });

  assert.deepEqual(
    operations.map((entry) => entry.operation),
    [`firewall.wanBlock.offAll`]
  );
});

test(`wanOpenApps skips WAN block for listed apps only`, async (t) => {
  const operations = installPrivilegedBridgeStub(t);
  const supervisor = new ProcessForkRuntime(createKernelContext({
    runtime: {
      network: {
        defaultWanBlock: true,
        wanOpenApps: [`www@example.com`],
        openLocalPorts: []
      }
    }
  }));

  await supervisor.rpcRouterReadyPromise;
  await supervisor.launchProcess({
    label: `e_app_tenant_www`,
    path: `/tmp/www.js`,
    cwd: `/tmp`,
    processUser: `u_www`,
    firewall: {
      processKind: `app`,
      appSelector: `www@example.com`,
      localProxyPorts: []
    }
  });
  await supervisor.launchProcess({
    label: `e_app_tenant_admin`,
    path: `/tmp/admin.js`,
    cwd: `/tmp`,
    processUser: `u_admin`,
    firewall: {
      processKind: `app`,
      appSelector: `admin@example.com`,
      localProxyPorts: []
    }
  });

  assert.deepEqual(
    operations.map((entry) => entry.operation),
    [`firewall.wanBlock.on`]
  );
  assert.equal(operations[0].payload.processUser, `u_admin`);
});

test(`transport firewall uses runtime.network.openLocalPorts for local proxy allowlist`, async (t) => {
  const operations = installPrivilegedBridgeStub(t);
  const supervisor = new ProcessForkRuntime(createKernelContext({
    runtime: {
      network: {
        defaultWanBlock: true,
        wanOpenApps: [],
        openLocalPorts: [15010, 6379]
      }
    }
  }));

  await supervisor.rpcRouterReadyPromise;
  await supervisor.launchProcess({
    label: `e_transport_tenant`,
    path: `/tmp/transport.js`,
    cwd: `/tmp`,
    processUser: `u_transport`,
    firewall: {
      localProxyPorts: [14002, 14003]
    }
  });

  assert.deepEqual(
    operations.map((entry) => entry.operation),
    [`firewall.localProxy.on`, `firewall.wanBlock.on`]
  );
  assert.equal(operations[0].payload.openLocalPortsCsv, `6379,15010`);
  assert.equal(operations[0].payload.proxyPortsCsv, `14002,14003`);
});

function createKernelContext(config = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ehecoatl-firewall-runtime-`));
  const adapterPath = path.join(tempDir, `adapter.js`);
  fs.writeFileSync(adapterPath, [
    `'use strict';`,
    `const { EventEmitter } = require('node:events');`,
    `module.exports = {`,
    `  currentProcessAdapter() { return process; },`,
    `  spawnAdapter() {`,
    `    const child = new EventEmitter();`,
    `    child.pid = Math.floor(Math.random() * 100000) + 1000;`,
    `    child.kill = () => {};`,
    `    child.send = () => {};`,
    `    return child;`,
    `  },`,
    `  initAdapter() {},`,
    `};`
  ].join(`\n`));

  return {
    config: {
      _adapters: {
        processForkRuntime: adapterPath
      },
      ...config
    },
    pluginOrchestrator: {
      processLabel: `main`,
      hooks: {
        MAIN: {
          SUPERVISOR: {
            BOOTSTRAP: 1,
            ERROR: 2,
            READY: 3,
            SHUTDOWN: 4,
            CRASH: 5,
            RESTART: 6,
            DEAD: 7,
            HEARTBEAT: 8,
            LAUNCH: { BEFORE: 9, AFTER: 10, ERROR: 11 },
            EXIT: { BEFORE: 12, AFTER: 13, ERROR: 14 }
          }
        }
      },
      async runWithContext(hookId, context) {
        return context;
      },
      async run() {}
    },
    useCases: {
      rpcRouter: {
        endpoint: {
          addListener() {},
          onReceive() {}
        },
        registerTarget() {},
        unregisterTarget() {},
        routeTo() {}
      }
    }
  };
}

function installPrivilegedBridgeStub(t) {
  const operations = [];
  const originalSend = process.send;

  process.send = (message) => {
    operations.push({
      operation: message.operation,
      payload: message.payload ?? {}
    });
    process.nextTick(() => {
      process.emit(`message`, {
        type: `privileged_host_bridge_response`,
        requestId: message.requestId,
        success: true,
        result: { ok: true }
      });
    });
    return true;
  };

  t.after(() => {
    if (originalSend) {
      process.send = originalSend;
    } else {
      delete process.send;
    }
  });

  return operations;
}
