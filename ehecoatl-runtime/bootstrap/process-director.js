// bootstrap/process-director.js


'use strict';


require(`module-alias/register`);
const { setHeartbeatCallback } = require(`@/_core/orchestrators/watchdog-orchestrator/heartbeat-reporter`);
const { ensureBootstrapCapabilitiesSanitized } = require(`@/utils/process/bootstrap-capabilities`);
const { attachManagedCgroupOrExit } = require(`@/utils/process/attach-managed-cgroup`);
const { applyProcessIdentityFromEnv } = require(`@/utils/process/apply-process-identity`);
const { applyConfiguredNoSpawnFilter } = require(`@/utils/process/seccomp`);
const configLoad = require(`@/config/default.user.config`);
const kernelDirector = require(`@/_core/kernel/kernel-director`);
const BootResolver = require(`@/_core/boot/boot-resolver`);
const clearRequireCache = require(`@/utils/module/clear-require-cache`);
const { startDirectorCliSocketServer } = require(`./director-cli-socket`);

boot();

/**
 * Boots the director child process and wires project routing
 * and queue RPC services.
 */
async function boot() {
  attachManagedCgroupOrExit();
  applyProcessIdentityFromEnv();
  await ensureBootstrapCapabilitiesSanitized({
    dropIfAnyCapabilities: true
  });
  applyConfiguredNoSpawnFilter({
    processLabel: process.env.PROCESS_LABEL ?? `director`
  });

  // CONFIG LOAD
  const config = await configLoad();

  const processLabel = process.env.PROCESS_LABEL ?? `director`;
  const useCasesDirector = await kernelDirector({ config, processLabel });
  const plugin = useCasesDirector.pluginOrchestrator;
  const { hooks } = plugin;

  BootResolver.setupExitHandlers(plugin, hooks.DIRECTOR.PROCESS);

  /* HOOK >> */ await plugin.run(hooks.DIRECTOR.PROCESS.SPAWN, null, hooks.DIRECTOR.PROCESS.ERROR);

  /* HOOK >> */ await plugin.run(hooks.DIRECTOR.PROCESS.BOOTSTRAP, {
    message: `BOOTSTRAP: DIRECTOR`,
    source: `process-director`,
    stage: `kernel-ready`,
    data: {
      node: process.version,
      pid: process.pid
    }
  }, hooks.DIRECTOR.PROCESS.ERROR);

  //SETUP ENDPOINT
  const { rpcEndpoint } = useCasesDirector;
  BootResolver.registerStateReporter(async (state, data = {}) => {
    await rpcEndpoint.ask({
      target: `main`,
      question: `state`,
      data: { state, ...data }
    });
  });

  console.log(`Enabling director heartbeat reporting`);
  setHeartbeatCallback((data) => {
    rpcEndpoint.ask({
      target: `main`,
      question: config.adapters.watchdogOrchestrator?.question?.heartbeat ?? `heartbeat`,
      data
    }).catch(() => { });
  }, { processLabel: process.env.PROCESS_LABEL ?? `director` });

  {
    const { webServerService } = useCasesDirector;
    console.log(`Waiting for web server service readiness`);
    webServerService.setupServer().then(() => {

    }).catch((e) => {

    });
  }

  {
    // PROJECT ROUTING
    const { projectDirectoryResolver, requestUriRoutingRuntime } = useCasesDirector;
    const nQ = config.adapters.ingressRuntime.question;
    const projectResolverConfig = config.adapters.projectDirectoryResolver
      ?? config.adapters.tenantDirectoryResolver;
    const legacyResolverConfig = config.adapters.tenantDirectoryResolver ?? {};
    const tQ = projectResolverConfig.question ?? {};
    const legacyQ = legacyResolverConfig.question ?? {};
    const pQ = config.adapters.processForkRuntime.question;
    console.log(`Registering project routing RPC handlers`);
    rpcEndpoint.addListener(nQ.requestUriRoutingRuntime, (i) => requestUriRoutingRuntime.matchRoute(i));
    const registerOnce = (() => {
      const questions = new Set();
      return (question, listener) => {
        const normalizedQuestion = String(question ?? ``).trim();
        if (!normalizedQuestion || questions.has(normalizedQuestion)) return;
        questions.add(normalizedQuestion);
        rpcEndpoint.addListener(normalizedQuestion, listener);
      };
    })();
    const forceRescanListener = (i) => projectDirectoryResolver.requestForcedScan({
      reason: i?.reason ?? `rpc_force_rescan`
    });
    registerOnce(tQ.forceRescanNow, forceRescanListener);
    registerOnce(legacyQ.forceRescanNow, forceRescanListener);
    const shutdownProcessListener = async (i) => {
      const label = i?.label ?? null;
      if (!label) {
        return {
          success: false,
          skipped: true,
          reason: `missing_label`
        };
      }

      return rpcEndpoint.ask({
        target: `main`,
        question: pQ.shutdownProcess ?? `shutdownProcess`,
        data: {
          label,
          reason: i?.reason ?? `director_requested_shutdown`,
          timeoutMs: i?.timeoutMs ?? null
        }
      });
    };
    registerOnce(tQ.shutdownProcessNow, shutdownProcessListener);
    registerOnce(legacyQ.shutdownProcessNow, shutdownProcessListener);

    console.log(`Starting director CLI RPC socket`);
    const directorCliSocketServer = await startDirectorCliSocketServer({
      rpcEndpoint,
      config
    });
    process.on(`exit`, () => {
      directorCliSocketServer.close().catch(() => { });
    });

    console.log(`Loading project route definitions`);
    await projectDirectoryResolver.scan();

    const projectReadiness = projectDirectoryResolver.getReadinessSnapshot();
    if (!projectReadiness.ready) {
      throw new Error(`Director project directory resolver is not ready after initial scan`);
    }

    // rpcEndpoint.addListener(nQ.getSharedObject, .getSharedObject);
    // rpcEndpoint.addListener(nQ.setSharedObject, .setSharedObject);
  }

  {
    // SHARED QUEUE BROKER
    const { queueBroker } = useCasesDirector;

    // REGISTER MIDDLEWARE STACK ANSWERS
    const mQ = config.adapters.middlewareStackRuntime.question;
    console.log(`Registering shared queue RPC handlers`);
    rpcEndpoint.addListener(mQ.enqueue, (i, delayedResolve) => queueBroker.appendToQueue(i, delayedResolve));
    rpcEndpoint.addListener(mQ.dequeue, (i) => queueBroker.removeFromQueue(i));
    rpcEndpoint.addListener(mQ.cleanupByOrigin, (i) => queueBroker.removeTasksByOrigin(i));
  }

  console.log(`Notifying main process that director is ready`);
  rpcEndpoint.ask({
    target: `main`,
    question: `state`,
    data: {
      state: `ready`
    }
  }).catch(() => { });

  /* HOOK >> */ await plugin.run(hooks.DIRECTOR.PROCESS.READY, null, hooks.DIRECTOR.PROCESS.ERROR);
  clearRequireCache();
}
