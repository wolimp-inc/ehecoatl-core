// bootstrap/process-main.js


'use strict';

require(`module-alias/register`);
const { ensureBootstrapCapabilitiesSanitized } = require(`@/utils/process/bootstrap-capabilities`);
const { applyProcessIdentityFromEnv } = require(`@/utils/process/apply-process-identity`);
const configLoad = require(`@/config/default.user.config`);
const kernelMain = require(`@/_core/kernel/kernel-main`);
const BootResolver = require(`@/_core/boot/boot-resolver`);
const clearRequireCache = require(`@/utils/module/clear-require-cache`);
const {
  PRIVILEGED_HOST_OPERATION_QUESTION,
  requestPrivilegedHostOperation
} = require(`@/scripts/privileged-host-bridge`);
const {
  APP_RPC_CLI_QUESTION
} = require(`@/_core/services/app-rpc-cli-service/app-rpc-cli-service`);
const bootLogger = require(`@plugin/boot-logger`);

/**
 * Boots the root main process, loads core use cases,
 * and starts the supervised child process tree.
 */
module.exports = async function boot() {
  applyProcessIdentityFromEnv({ requireIdentity: false });

  await ensureBootstrapCapabilitiesSanitized({
    keepCapabilities: [`setuid`, `setgid`]
  });

  // CONFIG LOAD
  const config = await configLoad();

  const processLabel = process.env.PROCESS_LABEL ?? `main`;
  const useCasesMain = await kernelMain({ config, processLabel });
  const plugin = useCasesMain.pluginOrchestrator;
  const { hooks } = plugin;

  BootResolver.setupExitHandlers(plugin, hooks.MAIN.PROCESS);

  /* HOOK >> */ await plugin.run(hooks.MAIN.PROCESS.SPAWN, null, hooks.MAIN.PROCESS.ERROR);

  BootResolver.registerShutdownTask(async ({ source }) => {
    const shutdownReason = normalizeShutdownReason(source);
    await useCasesMain.processForkRuntime?.shutdownAllChildren?.(shutdownReason);
  }, -100);

  /* HOOK >> */ await plugin.run(hooks.MAIN.PROCESS.BOOTSTRAP, {
    message: `BOOTSTRAP: MAIN`,
    source: `process-main`,
    stage: `kernel-ready`,
    data: {
      node: process.version,
      pid: process.pid
    }
  }, hooks.MAIN.PROCESS.ERROR);

  const { multiProcessOrchestrator, rpcRouter, appRpcCliService } = useCasesMain;

  rpcRouter.endpoint.addListener(bootLogger.BOOT_LOG_WRITE_QUESTION, async ({ lines = [] } = {}) => {
    bootLogger.writeForwardedLines(lines, { consoleEnabled: false });
    return {
      success: true
    };
  });

  rpcRouter.endpoint.addListener(PRIVILEGED_HOST_OPERATION_QUESTION, async ({ operation, payload = {} }) => {
    console.log(`[PRIVILEGED HOST] main received operation=${operation}`);
    const result = await requestPrivilegedHostOperation({ operation, payload });
    console.log(`[PRIVILEGED HOST] main completed operation=${operation}`);
    return {
      success: true,
      result
    };
  });

  rpcRouter.endpoint.addListener(APP_RPC_CLI_QUESTION, async ({
    commandLine,
    timeoutMs,
    internalMeta
  }) => {
    return appRpcCliService.runCommandRequest({
      commandLine,
      timeoutMs,
      internalMeta
    });
  });

  console.log(`Starting director process through MultiProcessOrchestrator`);
  await multiProcessOrchestrator.forkProcess(`supervisionScope`, `director`, {});

  // ISOLATED RUNTIME AUTO-SPAWN ON ROUTE
  console.log(`Registering isolated runtime auto-spawn routing`);
  rpcRouter.bindTemporarySpawner(`e_app_`, async (
    _endpointTarget,
    payload
  ) => {
    const projectRoute = payload?.data?.projectRoute ?? null;
    const appRoot = projectRoute?.folders?.rootFolder ?? projectRoute?.rootFolder ?? null;
    const tenantId = projectRoute?.origin?.projectId ?? projectRoute?.projectId ?? projectRoute?.origin?.tenantId ?? projectRoute?.tenantId;
    const appId = projectRoute?.origin?.appId ?? projectRoute?.appId;
    await multiProcessOrchestrator.forkProcess(`appScope`, `isolatedRuntime`, {
      tenantId,
      appId,
      appRoot,
      appDomain: projectRoute?.origin?.domain ?? projectRoute?.origin?.projectDomain ?? projectRoute?.projectDomain ?? projectRoute?.domain ?? null,
      appName: projectRoute?.origin?.appName ?? projectRoute?.appName ?? null,
      reason: `temporary_rpc_spawn`
    });
    return true;
  });

  console.log(`Registering main direct-message RPC handlers`);

  /* HOOK >> */ await plugin.run(hooks.MAIN.PROCESS.READY, null, hooks.MAIN.PROCESS.ERROR);
  clearRequireCache();
};

function normalizeShutdownReason(source) {
  if (!source || source === `signal`) {
    return `shutdown`;
  }

  return source;
}

Object.freeze(module.exports);

if (require.main === module) {
  module.exports().catch(async (error) => {
    console.error(`[FATAL MAIN BOOTSTRAP ERROR]`);
    console.error(error);
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.exit(1);
  });
}
