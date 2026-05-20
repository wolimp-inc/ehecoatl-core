// bootstrap/process-isolated-runtime.js


'use strict';


require(`module-alias/register`);
const fs = require(`fs`);
const path = require(`path`);
const ProjectRoute = require(`@/_core/runtimes/ingress-runtime/execution/project-route`);
const { setHeartbeatCallback } = require(`@/_core/orchestrators/watchdog-orchestrator/heartbeat-reporter`);
const { ensureBootstrapCapabilitiesSanitized } = require(`@/utils/process/bootstrap-capabilities`);
const { attachManagedCgroupOrExit } = require(`@/utils/process/attach-managed-cgroup`);
const { applyProcessIdentityFromEnv } = require(`@/utils/process/apply-process-identity`);
const { applyConfiguredNoSpawnFilter } = require(`@/utils/process/seccomp`);
const clearRequireCache = require(`@/utils/module/clear-require-cache`);
const weakRequire = require(`@/utils/module/weak-require`);
const { finalizeRuntimeIsolation } = require(`@/utils/process/finalize-runtime-isolation`);
const { renderLayerPathEntry } = require(`@/contracts/utils`);
const configLoad = require(`@/config/default.user.config`);
const kernelIsolatedRuntime = require(`@/_core/kernel/kernel-isolated-runtime`);
const BootResolver = require(`@/_core/boot/boot-resolver`);
const bootLogger = require(`@plugin/boot-logger`);

/**
 * Boots one isolated runtime child process and serves action
 * execution for a single isolated app identity.
 */
async function boot() {
  attachManagedCgroupOrExit();
  applyProcessIdentityFromEnv();
  await ensureBootstrapCapabilitiesSanitized({
    dropIfAnyCapabilities: true
  });
  applyConfiguredNoSpawnFilter({
    processLabel: process.env.PROCESS_LABEL ?? `isolated`
  });

  // CONFIG LOAD
  const config = await configLoad();

  const tenantId = process.argv[2] ?? null;
  const appId = process.argv[3] ?? null;
  const appRoot = process.argv[4] ?? process.cwd();
  const isolatedLabel = process.argv[5] ?? null;
  const processLabel = isolatedLabel ?? process.env.PROCESS_LABEL ?? `isolated`;
  const appDomain = process.argv[6] ?? null;
  const appName = process.argv[7] ?? null;
  const tenantSharedRootFolder = renderLayerPathEntry(`tenantScope`, `SHARED`, `root`, {
    tenant_id: tenantId,
    tenant_domain: appDomain
  })?.path ?? null;
  const useCasesIsolatedRuntime = await kernelIsolatedRuntime({
    config,
    processLabel,
    tenantId,
    appId,
    tenantDomain: appDomain,
    appName,
    appRootFolder: appRoot,
    tenantSharedRootFolder
  });
  const plugin = useCasesIsolatedRuntime.pluginOrchestrator;
  const { hooks } = plugin;

  BootResolver.setupExitHandlers(plugin, hooks.ISOLATED_RUNTIME.PROCESS);

  /* HOOK >> */ await plugin.run(
    hooks.ISOLATED_RUNTIME.PROCESS.SPAWN,
    null,
    hooks.ISOLATED_RUNTIME.PROCESS.ERROR
  );

  const {
    rpcEndpoint,
    storageService,
    appFluentFsRuntime,
    appRpcRuntime,
    sharedCacheService,
    wsAppRuntime
  } = useCasesIsolatedRuntime;
  /* HOOK >> */ await plugin.run(
    hooks.ISOLATED_RUNTIME.PROCESS.BOOTSTRAP,
    {
      message: `BOOTSTRAP: ISOLATED RUNTIME`,
      source: `process-isolated-runtime`,
      stage: `kernel-ready`,
      data: {
        node: process.version,
        pid: process.pid,
        tenantId,
        appId,
        appRoot
      },
      forwardBootLogLines: createBootLogForwarder(rpcEndpoint)
    },
    hooks.ISOLATED_RUNTIME.PROCESS.ERROR
  );

  const services = Object.freeze({
    storage: storageService,
    fluentFs: appFluentFsRuntime ?? null,
    cache: sharedCacheService,
    rpc: appRpcRuntime?.createService?.() ?? rpcEndpoint,
    ws: wsAppRuntime.createService()
  });
  BootResolver.registerStateReporter(async (state, data = {}) => {
    await rpcEndpoint.ask({
      target: `main`,
      question: `state`,
      data: { state, ...data }
    });
  });
  clearRequireCache();
  finalizeRuntimeIsolation();
  console.log(`Loading isolated runtime entrypoint from ${appRoot}/index.js`);
  const { isolatedApp, appTopology } = await bootIsolatedAppEntrypoint({
    appRoot,
    appDomain,
    appName,
    tenantId,
    appId,
    isolatedLabel,
    services
  });

  const tenantActionQuestion = config.adapters.middlewareStackRuntime?.question?.tenantAction ?? `tenantAction`;
  const tenantWsActionQuestion = config.adapters.middlewareStackRuntime?.question?.tenantWsAction ?? `tenantWsAction`;
  const isolatedRuntimeState = {
    draining: false,
    activeActionRequests: 0
  };

  BootResolver.registerDrainHandler(async ({ timeoutMs = 1000 }) => {
    isolatedRuntimeState.draining = true;
    const startedAt = Date.now();
    while (isolatedRuntimeState.activeActionRequests > 0) {
      if (Date.now() - startedAt >= timeoutMs) break;
      await new Promise((resolve) => {
        const wait = setTimeout(resolve, 10);
        wait.unref?.();
      });
    }
  });

  console.log(`Registering isolated runtime action request handler`);
  rpcEndpoint.addListener(tenantActionQuestion, async ({ projectRoute, requestData, sessionData }, resolve) => {
    if (isolatedRuntimeState.draining) {
      resolve(createActionFailureResponse(503, `Isolated runtime is draining`, {
        run: projectRoute?.target?.run ?? null,
        resource: projectRoute?.target?.run?.resource ?? null,
        action: projectRoute?.target?.run?.action ?? null,
        reason: `draining`
      }));
      return false;
    }

    isolatedRuntimeState.activeActionRequests += 1;
    const actionStartedAt = Date.now();
    try {
      const response = await handleIsolatedActionRequest({
        projectRoute,
        requestData,
        sessionData,
        appRoot,
        isolatedLabel,
        isolatedApp,
        appTopology,
        services
      });
      resolve(response, {
        actionMeta: {
          actionMs: Date.now() - actionStartedAt
        }
      });
    } finally {
      if (isolatedRuntimeState.activeActionRequests > 0) {
        isolatedRuntimeState.activeActionRequests -= 1;
      } else {
        isolatedRuntimeState.activeActionRequests = 0;
      }
    }
    return false;
  });

  rpcEndpoint.addListener(tenantWsActionQuestion, async ({ projectRoute, sessionData, wsMessageData }, resolve) => {
    if (isolatedRuntimeState.draining) {
      resolve({
        success: false,
        reason: `draining`
      });
      return false;
    }

    isolatedRuntimeState.activeActionRequests += 1;
    try {
      resolve(await handleIsolatedWsActionRequest({
        projectRoute,
        sessionData,
        wsMessageData,
        appRoot,
        isolatedLabel,
        isolatedApp,
        appTopology,
        services
      }));
    } finally {
      if (isolatedRuntimeState.activeActionRequests > 0) {
        isolatedRuntimeState.activeActionRequests -= 1;
      } else {
        isolatedRuntimeState.activeActionRequests = 0;
      }
    }
    return false;
  });

  console.log(`Enabling isolated runtime heartbeat reporting`);
  setHeartbeatCallback((data) => {
    rpcEndpoint.ask({
      target: `main`,
      question: config.adapters.watchdogOrchestrator?.question?.heartbeat ?? `heartbeat`,
      data
    }).catch(() => { });
  }, { processLabel });

  console.log(`Notifying main process that isolated runtime is ready`);
  rpcEndpoint.ask({
    target: `main`,
    question: `state`,
    data: {
      state: `ready`
    }
  }).catch(() => { });


  /* HOOK >> */ await plugin.run(
    hooks.ISOLATED_RUNTIME.PROCESS.READY,
    null,
    hooks.ISOLATED_RUNTIME.PROCESS.ERROR
  );
}

function createBootLogForwarder(rpcEndpoint) {
  return async (lines) => {
    await rpcEndpoint.ask({
      target: `main`,
      question: bootLogger.BOOT_LOG_WRITE_QUESTION,
      data: { lines }
    });
  };
}

async function bootIsolatedAppEntrypoint({
  appRoot,
  appDomain,
  appName,
  isolatedLabel,
  services
}) {
  const entryPath = path.join(appRoot, `index.js`);
  if (!fs.existsSync(entryPath)) {
    return {
      isolatedApp: null,
      appTopology: null
    };
  }

  const isolatedEntrypoint = weakRequire(entryPath);
  const baseBootContext = Object.freeze({
    appRoot,
    appDomain,
    appName,
    isolatedLabel,
    services
  });
  const appTopology = await resolveIsolatedAppTopology(isolatedEntrypoint, baseBootContext);
  const bootContext = Object.freeze({
    ...baseBootContext,
    appTopology
  });
  const bootHandler = resolveIsolatedAppBootHandler(isolatedEntrypoint);
  if (typeof bootHandler !== `function`) {
    return {
      isolatedApp: isolatedEntrypoint,
      appTopology
    };
  }

  return {
    isolatedApp: await bootHandler(bootContext),
    appTopology
  };
}

function resolveIsolatedAppBootHandler(isolatedEntrypoint) {
  if (typeof isolatedEntrypoint === `function`) return isolatedEntrypoint;
  if (isolatedEntrypoint && typeof isolatedEntrypoint.boot === `function`) return isolatedEntrypoint.boot;
  if (isolatedEntrypoint?.default && typeof isolatedEntrypoint.default === `function`) return isolatedEntrypoint.default;
  if (isolatedEntrypoint?.default && typeof isolatedEntrypoint.default.boot === `function`) return isolatedEntrypoint.default.boot;
  return null;
}

async function resolveIsolatedAppTopology(isolatedEntrypoint, context) {
  const declaration = resolveIsolatedAppTopologyDeclaration(isolatedEntrypoint);
  if (declaration == null) return null;

  const topology = typeof declaration === `function`
    ? await declaration(context)
    : declaration;

  if (!isPlainObject(topology)) {
    throw new Error(`Isolated app topology must resolve to a plain object`);
  }

  return topology;
}

function resolveIsolatedAppTopologyDeclaration(isolatedEntrypoint) {
  if (!isolatedEntrypoint || (typeof isolatedEntrypoint !== `object` && typeof isolatedEntrypoint !== `function`)) {
    return null;
  }
  if (isolatedEntrypoint.topology != null) return isolatedEntrypoint.topology;
  if (isolatedEntrypoint.default?.topology != null) return isolatedEntrypoint.default.topology;
  return null;
}

function isPlainObject(value) {
  return value != null
    && typeof value === `object`
    && !Array.isArray(value);
}

function resolveActionHandler(actionModule, actionName) {
  if (actionName && actionModule && typeof actionModule[actionName] === `function`) {
    return actionModule[actionName];
  }
  if (actionModule && typeof actionModule.default === `function`) {
    return actionModule.default;
  }
  if (typeof actionModule === `function`) {
    return actionModule;
  }
  return null;
}

function resolveActionPath(resource, appRoot, actionsRootFolder = null, appTopology = null, services = null) {
  if (path.isAbsolute(resource)) return resource;
  const normalizedResource = String(resource ?? ``).trim().replaceAll(`\\`, `/`).replace(/^\/+/, ``);
  const filename = normalizedResource.endsWith(`.js`) ? normalizedResource : `${normalizedResource}.js`;
  const fluentPath = services?.fluentFs?.app?.http?.actions?.path?.(filename) ?? null;
  if (typeof fluentPath === `string` && fluentPath.trim()) {
    return fluentPath;
  }
  const candidateFolders = [
    actionsRootFolder,
    resolveTopologyPath(appTopology, [`app`, `http`, `actions`]),
    path.join(appRoot, `app`, `http`, `actions`),
    path.join(appRoot, `actions`)
  ].filter((value, index, array) => typeof value === `string`
    && value.trim()
    && array.indexOf(value) === index);

  for (const folder of candidateFolders) {
    const candidatePath = path.join(folder, filename);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return path.join(candidateFolders[0] ?? path.join(appRoot, `app`, `http`, `actions`), filename);
}

function resolveTopologyPath(topology, segments = []) {
  let current = topology;
  for (const segment of segments) {
    if (!isPlainObject(current)) return null;
    current = current[segment];
  }
  return typeof current === `string` && current.trim() ? current : null;
}

function isActionLoadError(error) {
  return error?.code === `MODULE_NOT_FOUND` || error?.code === `ENOENT`;
}

function createActionFailureResponse(status, body, details = null) {
  return {
    success: false,
    status,
    body,
    error: details
  };
}

async function handleIsolatedActionRequest({
  projectRoute,
  requestData,
  sessionData,
  appRoot,
  isolatedLabel,
  isolatedApp,
  appTopology,
  services
}) {
  const runTarget = formatRunTarget(projectRoute?.target?.run ?? null);
  const resource = projectRoute?.target?.run?.resource ?? null;
  const actionName = projectRoute?.target?.run?.action ?? null;
  if (!resource || !actionName) return { status: 404, body: `Action not found` };

  try {
    const actionModule = weakRequire(resolveActionPath(
      resource,
      appRoot,
      projectRoute?.folders?.httpActionsRootFolder
        ?? projectRoute?.folders?.actionsRootFolder,
      appTopology,
      services
    ));
    const handler = resolveActionHandler(actionModule, actionName);

    if (typeof handler !== `function`) {
      return createActionFailureResponse(500, `Invalid action handler`, {
        run: runTarget,
        resource,
        action: actionName
      });
    }

    const context = Object.freeze({
      projectRoute,
      requestData,
      sessionData,
      appRoot,
      isolatedLabel,
      isolatedApp,
      appTopology,
      services
    });

    return await handler(context);
  } catch (error) {
    if (isActionLoadError(error)) {
      return createActionFailureResponse(404, `Action not found`, {
        run: runTarget,
        resource,
        action: actionName,
        error: error?.message ?? String(error)
      });
    }

    return createActionFailureResponse(500, `Action load failure`, {
      run: runTarget,
      resource,
      action: actionName,
      error: error?.message ?? String(error)
    });
  }
}

async function handleIsolatedWsActionRequest({
  projectRoute,
  sessionData,
  wsMessageData,
  appRoot,
  isolatedLabel,
  isolatedApp,
  appTopology,
  services
}) {
  const runtimeProjectRoute = projectRoute instanceof ProjectRoute
    ? projectRoute
    : new ProjectRoute(projectRoute ?? {});
  const actionTarget = String(wsMessageData?.actionTarget ?? ``).trim();
  const parsedAction = parseWsActionTarget(actionTarget);
  if (!parsedAction) {
    return {
      success: false,
      reason: `invalid_ws_action_target`,
      sessionData: snapshotSessionData(sessionData)
    };
  }

  try {
    const actionModule = weakRequire(resolveWsActionPath(
      parsedAction.resource,
      appRoot,
      runtimeProjectRoute?.folders?.wsActionsRootFolder ?? null,
      appTopology,
      services
    ));
    const handler = resolveActionHandler(actionModule, parsedAction.action);
    if (typeof handler !== `function`) {
      return {
        success: false,
        reason: `invalid_ws_action_handler`,
        actionTarget,
        sessionData: snapshotSessionData(sessionData)
      };
    }

    const context = Object.freeze({
      projectRoute: runtimeProjectRoute,
      sessionData,
      wsMessageData,
      appRoot,
      isolatedLabel,
      isolatedApp,
      appTopology,
      services
    });

    return {
      success: true,
      result: await handler(context),
      sessionData: snapshotSessionData(sessionData)
    };
  } catch (error) {
    if (isActionLoadError(error)) {
      return {
        success: false,
        reason: `ws_action_not_found`,
        actionTarget,
        error: error?.message ?? String(error),
        sessionData: snapshotSessionData(sessionData)
      };
    }

    return {
      success: false,
      reason: `ws_action_load_failure`,
      actionTarget,
      error: error?.message ?? String(error),
      sessionData: snapshotSessionData(sessionData)
    };
  }
}

function formatRunTarget(runTarget) {
  if (!runTarget || typeof runTarget !== `object`) return null;
  const resource = String(runTarget.resource ?? ``).trim();
  const action = String(runTarget.action ?? ``).trim();
  if (!resource) return null;
  return `${resource}@${action || `index`}`;
}

function parseWsActionTarget(actionTarget) {
  if (typeof actionTarget !== `string`) return null;
  const normalized = actionTarget.trim();
  if (!normalized) return null;
  const separatorIndex = normalized.lastIndexOf(`@`);
  if (separatorIndex < 1) return null;

  const resource = normalizeResourceIdentifier(normalized.slice(0, separatorIndex));
  const action = normalizeActionIdentifier(normalized.slice(separatorIndex + 1)) ?? `index`;
  if (!resource || !action) return null;
  return Object.freeze({
    resource,
    action
  });
}

function resolveWsActionPath(resource, appRoot, wsActionsRootFolder = null, appTopology = null, services = null) {
  const normalizedResource = String(resource ?? ``).trim().replaceAll(`\\`, `/`).replace(/^\/+/, ``);
  const filename = normalizedResource.endsWith(`.js`) ? normalizedResource : `${normalizedResource}.js`;
  const fluentPath = services?.fluentFs?.app?.ws?.actions?.path?.(filename) ?? null;
  if (typeof fluentPath === `string` && fluentPath.trim()) {
    return fluentPath;
  }
  const candidateFolders = [
    wsActionsRootFolder,
    resolveTopologyPath(appTopology, [`app`, `ws`, `actions`]),
    path.join(appRoot, `app`, `ws`, `actions`)
  ].filter((value, index, array) => typeof value === `string`
    && value.trim()
    && array.indexOf(value) === index);

  for (const folder of candidateFolders) {
    const candidatePath = path.join(folder, filename);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return path.join(candidateFolders[0] ?? path.join(appRoot, `app`, `ws`, `actions`), filename);
}

function normalizeResourceIdentifier(resource) {
  const normalized = String(resource ?? ``).trim().replaceAll(`\\`, `/`);
  if (!normalized) return null;
  return normalized
    .replace(/^actions\//, ``)
    .replace(/\.js$/i, ``)
    .replace(/^\/+/, ``)
    .replace(/\/+/g, `/`)
    .trim() || null;
}

function normalizeActionIdentifier(action) {
  const normalized = String(action ?? ``).trim();
  return normalized || null;
}

function snapshotSessionData(sessionData) {
  try {
    return JSON.parse(JSON.stringify(sessionData ?? {}));
  } catch {
    return {};
  }
}

if (require.main === module) {
  boot();
}

module.exports = Object.freeze({
  boot,
  bootIsolatedAppEntrypoint,
  handleIsolatedActionRequest,
  handleIsolatedWsActionRequest,
  _internal: Object.freeze({
    resolveActionPath,
    resolveWsActionPath,
    parseWsActionTarget,
    resolveIsolatedAppBootHandler,
    resolveIsolatedAppTopology,
    resolveIsolatedAppTopologyDeclaration,
    resolveTopologyPath
  })
});
