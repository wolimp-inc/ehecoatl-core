// _core/runtimes/process-fork-runtime/process-fork-runtime.js


'use strict';

const ManagedProcess = require("./managed-process");
const MessageSchema = require(`@/_core/runtimes/rpc-runtime/schemas/message-schema`);
const AdaptableUseCase = require(`@/_core/_ports/adaptable-use-case`);
const { requestPrivilegedHostOperation } = require(`@/scripts/privileged-host-bridge`);
const {
  isWanOpenApp,
  normalizeRuntimeNetworkConfig
} = require(`@/utils/config/runtime-network-config`);

/** Main-process runtime responsible for spawning, routing, and supervising child processes. */
class ProcessForkRuntime extends AdaptableUseCase {
  /** @type {Map<string, ManagedProcess>} */
  children;
  /** @type {Map<number, string>} */
  labelsByPid;
  lifecycleHistory;
  lifecycleHistoryMax;

  /** @type {import('@/_core/useCases/index').RpcResolver}  */
  rpcRouter;
  routerLabel;

  /** @type {typeof import('@/config/default.config').adapters.processForkRuntime} */
  config;
  /** @type {import('@/_core/orchestrators/plugin-orchestrator')} */
  plugin;
  rpcRouterReadyPromise;
  queueCleanupQuestion;
  shutdownProcessQuestion;
  ensureProcessQuestion;
  listProcessesQuestion;
  processCountsQuestion;
  runtimeNetworkConfig;

  /** Initializes process supervision state, health tracking, and RPC router bindings. */
  constructor(kernelContext) {
    super(kernelContext.config._adapters.processForkRuntime);
    this.kernelContext = kernelContext;
    const adaptersConfig = kernelContext.config.adapters ?? {};
    this.config = adaptersConfig.processForkRuntime ?? kernelContext.config.processForkRuntime ?? {};
    this.plugin = kernelContext.pluginOrchestrator;
    this.children = new Map(); // label -> ManagedProcess
    this.labelsByPid = new Map(); // pid -> label
    this.lifecycleHistory = [];
    this.lifecycleHistoryMax = this.config.lifecycleHistoryMax ?? 200;
    this.rpcRouterReadyPromise = Promise.resolve();
    this.queueCleanupQuestion = adaptersConfig.middlewareStackRuntime?.question?.cleanupByOrigin
      ?? kernelContext.config.middlewareStackRuntime?.question?.cleanupByOrigin
      ?? `queueCleanupByOrigin`;
    this.shutdownProcessQuestion = this.config.question?.shutdownProcess ?? `shutdownProcess`;
    this.ensureProcessQuestion = this.config.question?.ensureProcess ?? `ensureProcess`;
    this.listProcessesQuestion = this.config.question?.listProcesses ?? `listProcesses`;
    this.processCountsQuestion = this.config.question?.processCounts ?? `processCounts`;
    this.runtimeNetworkConfig = normalizeRuntimeNetworkConfig(kernelContext.config);

    const rpcRouter = kernelContext.useCases?.rpcRouter ?? null;
    const routerLabel = this.plugin.processLabel ?? null;
    if (rpcRouter && routerLabel) {
      this.rpcRouterReadyPromise = this.#setRpcResolver({ routerLabel, rpcRouter });
    }
  }

  /** Connects the supervisor to the shared RPC router and installs supervisor listeners. */
  async #setRpcResolver({ routerLabel, rpcRouter }) {
    const plugin = this.plugin;
    const { hooks } = plugin;
    const { BOOTSTRAP, ERROR } = hooks.MAIN.SUPERVISOR;
    this.rpcRouter = rpcRouter;
    this.routerLabel = routerLabel;
    this.rpcRouter.registerTarget(routerLabel, this.currentProcess);
    await plugin.run(BOOTSTRAP, {
      routerLabel,
      process: this.currentProcess
    }, ERROR).catch(() => { });
    await this.#reconcileWanBlockDefault();

    // LISTEN TO STATE CHANGES
    this.rpcRouter.endpoint.addListener(`state`, async ({ origin, state, ...details }) => {
      const managedProcess = this.children.get(origin);
      if (!managedProcess) return { success: false };
      managedProcess.state = state;
      this.recordLifecycleEvent({
        type: `state`,
        label: origin,
        pid: managedProcess.pid,
        state,
        ...details
      });

      const stateHookMap = {
        ready: hooks.MAIN.SUPERVISOR.READY,
        shutdown: hooks.MAIN.SUPERVISOR.SHUTDOWN,
        crash: hooks.MAIN.SUPERVISOR.CRASH,
      };
      const hookId = stateHookMap[state] ?? null;
      if (Number.isInteger(hookId)) {
        plugin.run(hookId, {
          label: origin,
          pid: managedProcess.pid,
          state,
          ...details
        }, hooks.MAIN.SUPERVISOR.ERROR).catch(() => { });
      }

      return { success: true };
    });

    this.rpcRouter.endpoint.addListener(this.shutdownProcessQuestion, async ({ label, reason, timeoutMs }) => {
      if (!label) return { success: false, skipped: true, reason: `missing_label` };
      const managedProcess = this.getProcessByLabel(label);
      if (!managedProcess) {
        return {
          success: false,
          skipped: true,
          label,
          action: `shutdown`,
          reason: reason ?? `shutdown`,
          missing: true
        };
      }

      const success = await this.shutdownProcess(
        label,
        reason ?? `shutdown`,
        timeoutMs ?? this.config.defaultTimeout ?? 30_000
      );
      return {
        success,
        skipped: false,
        label,
        action: `shutdown`,
        reason: reason ?? `shutdown`
      };
    });

    this.rpcRouter.endpoint.addListener(this.ensureProcessQuestion, async ({
      label,
      reason,
      layerKey = null,
      processKey = null,
      context = {},
      processType = null,
      appDomain,
      appName,
      appRoot
    }) => {
      const multiProcessOrchestrator = this.kernelContext?.useCases?.multiProcessOrchestrator ?? null;
      const fallbackLayerKey = inferLayerKey({ layerKey, processType });
      const fallbackProcessKey = inferProcessKey({ processKey, processType });

      if (!multiProcessOrchestrator?.ensureProcess || !fallbackLayerKey || !fallbackProcessKey) {
        return {
          success: false,
          skipped: true,
          reason: `unsupported_process_request`,
          label,
          processType,
          layerKey: fallbackLayerKey,
          processKey: fallbackProcessKey
        };
      }

      return multiProcessOrchestrator.ensureProcess(
        fallbackLayerKey,
        fallbackProcessKey,
        {
          ...context,
          label,
          reason,
          processType,
          appDomain,
          appName,
          appRoot,
          ...(context ?? {})
        }
      );
    });

    this.rpcRouter.endpoint.addListener(this.listProcessesQuestion, async () => {
      return {
        success: true,
        processes: this.listProcesses()
      };
    });

    this.rpcRouter.endpoint.addListener(this.processCountsQuestion, async () => {
      return {
        success: true,
        counts: this.getProcessCountsSnapshot()
      };
    });
  }

  /** Returns the current process handle through the active supervision adapter. */
  get currentProcess() {
    return this.adapter.currentProcessAdapter();
  }

  get watchdogOrchestrator() {
    return this.kernelContext?.useCases?.watchdogOrchestrator ?? null;
  }

  /** Spawns a managed child process, runs launch hooks, and registers its routing lifecycle.
   * @param {{label, path, cwd, processUser, variables, serialization, env, resources}} processOptions
  */
  async launchProcess(processOptions) {
    await this.#waitUntilSupervisorReady();
    const launchContext = await this.#runLaunchBeforeHook(processOptions);
    let managedProcess;

    try {
      managedProcess = new ManagedProcess(
        this.adapter.spawnAdapter,
        launchContext.processOptions
      );
    } catch (error) {
      await this.#runLaunchErrorHook(launchContext, error);
      await this.#runCleanupTasks(launchContext.cleanupTasks);
      throw error;
    }
    const { pid, label } = managedProcess;
    await this.#registerManagedCgroupPid(managedProcess).catch((error) => {
      this.recordLifecycleEvent({
        type: `cgroup_register_failed`,
        label,
        pid,
        error: error?.message ?? String(error)
      });
    });

    const onExitCallback = async (code = null, signal = null) => {
      const exitContext = {
        code,
        signal,
        label,
        pid,
        processCountsBeforeExit: this.getProcessCountsSnapshot(),
        managedProcess,
        process: managedProcess.process,
          processOptions: {
          label: managedProcess.label,
          path: managedProcess.path,
          cwd: managedProcess.cwd,
          processUser: managedProcess.processUser,
          processGroup: managedProcess.processGroup,
          processSecondGroup: managedProcess.processSecondGroup,
          processThirdGroup: managedProcess.processThirdGroup,
          variables: managedProcess.variables,
          serialization: managedProcess.serialization,
          env: managedProcess.env,
          resources: managedProcess.resources,
          cleanupTasks: managedProcess.cleanupTasks,
        },
        resources: managedProcess.resources,
        cleanupTasks: managedProcess.cleanupTasks,
        reason: managedProcess.exitReason ?? null,
        restartOnExit: managedProcess.restartOnExit === true,
      };

      let exitError = null;

      try {
        await this.#runExitHook(`BEFORE`, exitContext);
      } catch (error) {
        exitError = error;
      }

      this.children.delete(label);
      this.labelsByPid.delete(pid);
      this.rpcRouter.unregisterTarget(label);
      exitContext.processCountsAfterExit = this.getProcessCountsSnapshot();

      try {
        await this.#runCleanupTasks(managedProcess.cleanupTasks);
        await this.#runExitHook(`AFTER`, exitContext);
      } catch (error) {
        exitError ??= error;
      }

      await this.cleanupDirectorQueueTasksForProcess(label).catch(() => { });

      try {
        if (exitError) {
          await this.#runExitErrorHook(exitContext, exitError);
        }

        await this.watchdogOrchestrator?.onProcessExit(label, {
          terminal: managedProcess.restartOnExit !== true,
          pid,
          reason: managedProcess.exitReason ?? null,
          code,
          signal,
          processOptions: exitContext.processOptions,
          listeners: managedProcess.listeners(`stateChange`)
        });
      } finally {
        managedProcess.resolveExitTeardown?.();
      }
    };

    const onMessageToRootCallback = async (payload) => {
      // ensure origin is set so replies can be routed
      if (!payload.origin) payload.origin = label;

      const targetEndpointLabel = payload.target ?? null;

      // Requests for the root process stay local, handled by the supervisor;
      // others are forwarded by label
      if (targetEndpointLabel === this.routerLabel)
        this.rpcRouter.endpoint.onReceive(payload);
      else
        this.rpcRouter.routeTo(targetEndpointLabel, payload);
    };

    try {
      this.adapter.initAdapter({ managedProcess, onMessageToRootCallback, onExitCallback });
      this.children.set(label, managedProcess);
      this.labelsByPid.set(pid, label);
      this.rpcRouter.registerTarget(label, managedProcess.process);
      this.watchdogOrchestrator?.onProcessLaunch(label);
      this.recordLifecycleEvent({
        type: `launch`,
        label,
        pid,
        path: managedProcess.path
      });
      await this.#runLaunchAfterHook(managedProcess, launchContext);
    } catch (error) {
      await this.#rollbackFailedLaunch({
        managedProcess,
        launchContext,
        error,
        onMessageToRootCallback,
        onExitCallback
      });
      throw error;
    }
    return managedProcess;
  }

  /** Resolves a managed child instance from its pid. */
  getProcessByPid(pid) {
    const label = this.labelsByPid.get(pid);
    if (!label) return undefined;
    return this.children.get(label);
  }

  /** Resolves a managed child instance from its logical process label. */
  getProcessByLabel(label) {
    return this.children.get(label);
  }

  /** Stores a bounded lifecycle event history for runtime inspection and auditing. */
  recordLifecycleEvent(event) {
    const entry = Object.freeze({
      at: new Date().toISOString(),
      ...event
    });
    this.lifecycleHistory.push(entry);
    if (this.lifecycleHistory.length > this.lifecycleHistoryMax) {
      this.lifecycleHistory.splice(0, this.lifecycleHistory.length - this.lifecycleHistoryMax);
    }
    return entry;
  }

  /** Returns recent lifecycle events, optionally filtered to one process label. */
  getLifecycleHistory(label = null) {
    if (!label) return [...this.lifecycleHistory];
    return this.lifecycleHistory.filter((entry) => entry.label === label);
  }

  /** Lists managed children with current pid/state for runtime reconciliation. */
  listProcesses() {
    return [...this.children.values()].map((managedProcess) => ({
      label: managedProcess.label,
      pid: managedProcess.pid,
      state: managedProcess.state ?? null,
      processUser: managedProcess.processUser ?? null,
      processGroup: managedProcess.processGroup ?? null,
      processSecondGroup: managedProcess.processSecondGroup ?? null,
      processThirdGroup: managedProcess.processThirdGroup ?? null,
      variables: Array.isArray(managedProcess.variables) ? [...managedProcess.variables] : []
    }));
  }

  /** Returns child-process counts grouped by process label family for operational visibility. */
  getProcessCountsSnapshot() {
    const counts = {
      total: this.children.size,
      director: 0,
      transport: 0,
      isolatedRuntime: 0,
      other: 0
    };

    for (const label of this.children.keys()) {
      if (label === `director`) counts.director += 1;
      else if (label.startsWith(`e_transport_`) || label.startsWith(`transport_`)) counts.transport += 1;
      else if (label.startsWith(`e_app_`) || label.startsWith(`isolated_`)) counts.isolatedRuntime += 1;
      else counts.other += 1;
    }

    return counts;
  }

  /** Requests one supervised child to exit and waits briefly for its process handle to terminate. */
  async shutdownProcess(label, reason = `shutdown`, timeoutMs = this.config.defaultTimeout ?? 30_000) {
    const managedProcess = this.children.get(label);
    if (!managedProcess?.process) return false;
    managedProcess.restartOnExit = false;
    managedProcess.exitReason = reason;

    return await new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        managedProcess.process.off(`exit`, onExit);
        resolve(value);
      };

      const onExit = () => {
        managedProcess.exitTeardownPromise
          .then(() => finish(true))
          .catch(() => finish(false));
      };
      managedProcess.process.once(`exit`, onExit);

      timer = setTimeout(() => {
        forceKillManagedProcess(managedProcess, { label, reason: `shutdown_timeout` })
          .catch(() => { })
          .finally(() => finish(false));
      }, timeoutMs);
      timer.unref?.();

      try {
        if (typeof managedProcess.process.send === `function`) {
          managedProcess.process.send({
            __supervisorCommand: `drain`,
            code: 0,
            reason,
            timeoutMs
          });
        } else {
          forceKillManagedProcess(managedProcess, { label, reason: `missing_ipc_send` })
            .catch(() => { })
            .finally(() => finish(false));
        }
      } catch {
        forceKillManagedProcess(managedProcess, { label, reason: `send_exit_command_failed` })
          .catch(() => { })
          .finally(() => finish(false));
      }
    });
  }

  /** Requests an orderly shutdown for every supervised child process and waits for completion. */
  async shutdownAllChildren(reason = `shutdown`) {
    const labels = [...this.children.keys()];
    const results = await Promise.allSettled(
      labels.map((label) => this.shutdownProcess(label, reason))
    );

    return {
      success: results.every((result) => result.status === `fulfilled` && result.value === true),
      total: labels.length,
      results
    };
  }

  /** Shuts down all children before delegating to adapter teardown. */
  async destroy() {
    await this.shutdownAllChildren(`destroy`);
    await super.destroy();
  }

  /** Asks the director process to release orphaned queue tasks owned by one exited transport worker. */
  async cleanupDirectorQueueTasksForProcess(label) {
    if (!this.rpcRouter?.endpoint || !ownsDirectorQueueTasks(label)) {
      return { success: false, skipped: true, label };
    }

    try {
      const payload = MessageSchema.createQuestion({
        id: -1,
        target: `director`,
        question: this.queueCleanupQuestion,
        data: { origin: label },
        origin: this.rpcRouter.routerLabel ?? this.plugin?.processLabel ?? `main`
      });
      Promise.resolve()
        .then(() => this.rpcRouter.routeTo(`director`, payload))
        .catch(() => { });
      return { success: true, skipped: false, label, fireAndForget: true };
    } catch {
      return { success: false, skipped: false, label };
    }
  }

  async #runLaunchBeforeHook(processOptions) {
    const plugin = this.plugin;
    const { hooks } = plugin;
    const launchHooks = hooks.MAIN.SUPERVISOR.LAUNCH;
    const defaultResources = getDefaultProcessResources(this.config);
    const resources = {
      ...defaultResources,
      ...(processOptions.resources ?? {}),
      ...(defaultResources.cgroups || processOptions.resources?.cgroups
        ? { cgroups: { ...(defaultResources.cgroups ?? {}), ...(processOptions.resources?.cgroups ?? {}) } }
        : {})
    };
    const launchContext = {
      label: processOptions.label ?? null,
      processCountsBeforeLaunch: this.getProcessCountsSnapshot(),
      processOptions: {
        ...processOptions,
        env: { ...(processOptions.env ?? {}) },
        resources,
        cleanupTasks: Array.isArray(processOptions.cleanupTasks) ? [...processOptions.cleanupTasks] : [],
      },
      resources,
      cleanupTasks: Array.isArray(processOptions.cleanupTasks) ? [...processOptions.cleanupTasks] : [],
    };

    const nextContext = await plugin.runWithContext(launchHooks.BEFORE, launchContext, {
      errHook: launchHooks.ERROR,
      rethrow: true
    });
    nextContext.processOptions.resources = nextContext.resources ?? {};
    nextContext.processOptions.cleanupTasks = Array.isArray(nextContext.cleanupTasks)
      ? nextContext.cleanupTasks
      : [];
    await this.#prepareManagedFirewall(nextContext);
    await this.#prepareManagedCgroup(nextContext);
    return nextContext;
  }

  async #reconcileWanBlockDefault() {
    if (this.runtimeNetworkConfig.defaultWanBlock !== false) return;

    await requestPrivilegedHostOperation({
      operation: `firewall.wanBlock.offAll`,
      payload: {
        reason: `runtime_network_default_wan_block_disabled`
      },
      timeoutMs: 5000
    });
  }

  async #prepareManagedFirewall(launchContext) {
    const firewall = launchContext.processOptions?.firewall ?? null;
    const processUser = launchContext.processOptions?.processUser ?? null;
    const label = launchContext.label ?? launchContext.processOptions?.label ?? `unknown`;
    if (!firewall || !processUser) return;

    const cleanupTasks = Array.isArray(launchContext.cleanupTasks) ? [...launchContext.cleanupTasks] : [];
    const localProxyPorts = normalizeFirewallPorts(firewall.localProxyPorts ?? []);
    if (localProxyPorts.length > 0) {
      await requestPrivilegedHostOperation({
        operation: `firewall.localProxy.on`,
        payload: {
          processUser,
          openLocalPortsCsv: this.runtimeNetworkConfig.openLocalPorts.join(`,`),
          proxyPortsCsv: localProxyPorts.join(`,`)
        },
        timeoutMs: 5000
      });
      cleanupTasks.push(async () => {
        await requestPrivilegedHostOperation({
          operation: `firewall.localProxy.off`,
          payload: { processUser },
          timeoutMs: 5000
        }).catch(() => {});
      });
    }

    if (this.#shouldApplyWanBlock(firewall)) {
      await requestPrivilegedHostOperation({
        operation: `firewall.wanBlock.on`,
        payload: {
          processUser,
          label
        },
        timeoutMs: 5000
      });
      cleanupTasks.push(async () => {
        await requestPrivilegedHostOperation({
          operation: `firewall.wanBlock.off`,
          payload: {
            processUser,
            label
          },
          timeoutMs: 5000
        }).catch(() => {});
      });
    }

    launchContext.cleanupTasks = cleanupTasks;
    launchContext.processOptions.cleanupTasks = cleanupTasks;
  }

  #shouldApplyWanBlock(firewall) {
    if (this.runtimeNetworkConfig.defaultWanBlock !== true) return false;
    if (firewall?.processKind === `app` && isWanOpenApp(this.runtimeNetworkConfig, firewall.appSelector)) {
      return false;
    }
    return true;
  }

  async #prepareManagedCgroup(launchContext) {
    const cgroups = launchContext.resources?.cgroups ?? null;
    if (!cgroups || cgroups.enabled !== true) return;

    const label = launchContext.label ?? launchContext.processOptions?.label ?? `unknown`;
    const result = await requestPrivilegedHostOperation({
      operation: `cgroup.ensure`,
      payload: {
        label,
        cgroups,
        registryFile: cgroups.registryFile,
        managedRootName: cgroups.managedRootName,
        delegateSubgroup: cgroups.delegateSubgroup,
        cleanupIntervalMs: cgroups.cleanupIntervalMs
      },
      timeoutMs: Number(cgroups.operationTimeoutMs ?? 5000)
    });

    launchContext.resources = {
      ...launchContext.resources,
      cgroups: {
        ...cgroups,
        id: result.id,
        cgroupPath: result.cgroupPath,
        memoryMaxBytes: result.memoryMaxBytes,
        cpuMax: result.cpuMax
      }
    };
    launchContext.processOptions.resources = launchContext.resources;
    launchContext.processOptions.env = {
      ...(launchContext.processOptions.env ?? {}),
      EHECOATL_CGROUP_ID: result.id,
      EHECOATL_CGROUP_PATH: result.cgroupPath,
      EHECOATL_CGROUP_REQUIRED: `1`
    };
    launchContext.cleanupTasks = [
      ...(Array.isArray(launchContext.cleanupTasks) ? launchContext.cleanupTasks : []),
      async () => {
        await requestPrivilegedHostOperation({
          operation: `cgroup.release`,
          payload: {
            id: result.id,
            label,
            registryFile: cgroups.registryFile,
            managedRootName: cgroups.managedRootName,
            delegateSubgroup: cgroups.delegateSubgroup
          },
          timeoutMs: Number(cgroups.operationTimeoutMs ?? 5000)
        }).catch(() => {});
      }
    ];
    launchContext.processOptions.cleanupTasks = launchContext.cleanupTasks;
  }

  async #registerManagedCgroupPid(managedProcess) {
    const cgroups = managedProcess.resources?.cgroups ?? null;
    if (!cgroups?.id || !cgroups?.enabled) return null;
    return await requestPrivilegedHostOperation({
      operation: `cgroup.registerPid`,
      payload: {
        id: cgroups.id,
        pid: managedProcess.pid,
        label: managedProcess.label,
        registryFile: cgroups.registryFile,
        managedRootName: cgroups.managedRootName,
        delegateSubgroup: cgroups.delegateSubgroup
      },
      timeoutMs: Number(cgroups.operationTimeoutMs ?? 5000)
    });
  }

  async #waitUntilSupervisorReady() {
    await this.rpcRouterReadyPromise;
    if (!this.rpcRouter || !this.routerLabel) {
      throw new Error(`ProcessForkRuntime RPC router is not ready`);
    }
  }

  async #runLaunchAfterHook(managedProcess, launchContext) {
    const plugin = this.plugin;
    const { hooks } = plugin;
    const launchHooks = hooks.MAIN.SUPERVISOR.LAUNCH;

    return await plugin.run(launchHooks.AFTER, {
      label: managedProcess.label,
      pid: managedProcess.pid,
      processCounts: this.getProcessCountsSnapshot(),
      processCountsBeforeLaunch: launchContext.processCountsBeforeLaunch,
      managedProcess,
      process: managedProcess.process,
      processOptions: launchContext.processOptions,
      resources: managedProcess.resources,
      cleanupTasks: managedProcess.cleanupTasks,
    }, launchHooks.ERROR);
  }

  async #runLaunchErrorHook(launchContext, error) {
    const plugin = this.plugin;
    const { hooks } = plugin;
    const launchHooks = hooks.MAIN.SUPERVISOR.LAUNCH;

    return await plugin.run(launchHooks.ERROR, {
      ...launchContext,
      processCounts: this.getProcessCountsSnapshot(),
      error
    }, hooks.MAIN.SUPERVISOR.ERROR);
  }

  async #runExitHook(phase, exitContext) {
    const plugin = this.plugin;
    const { hooks } = plugin;
    const exitHooks = hooks.MAIN.SUPERVISOR.EXIT;
    const hookId = exitHooks?.[phase] ?? null;
    if (!Number.isInteger(hookId)) return;
    await plugin.run(hookId, exitContext, exitHooks.ERROR);
  }

  async #runExitErrorHook(exitContext, error) {
    const plugin = this.plugin;
    const { hooks } = plugin;
    const exitHooks = hooks.MAIN.SUPERVISOR.EXIT;
    await plugin.run(exitHooks.ERROR, {
      ...exitContext,
      error
    }, hooks.MAIN.SUPERVISOR.ERROR);
  }

  async #runCleanupTasks(cleanupTasks = []) {
    const cleanupTaskTimeoutMs = Number(this.config.cleanupTaskTimeoutMs ?? 3000);
    const pendingTasks = cleanupTasks
      .filter((task) => typeof task === `function`)
      .map((task) => this.#runCleanupTaskWithTimeout(task, cleanupTaskTimeoutMs));

    await Promise.allSettled(pendingTasks);
  }

  async #runCleanupTaskWithTimeout(task, timeoutMs) {
    const normalizedTimeoutMs = Number(timeoutMs);
    if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
      return task();
    }

    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(() => task()),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`cleanup task timed out after ${normalizedTimeoutMs}ms`));
          }, normalizedTimeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #rollbackFailedLaunch({
    managedProcess,
    launchContext,
    error,
    onMessageToRootCallback,
    onExitCallback
  }) {
    const { label, pid } = managedProcess;

    try {
      managedProcess.process?.off?.(`message`, onMessageToRootCallback);
      managedProcess.process?.off?.(`exit`, onExitCallback);
    } catch { }

    this.children.delete(label);
    this.labelsByPid.delete(pid);
    this.rpcRouter?.unregisterTarget?.(label);
    this.watchdogOrchestrator?.discardProcessState(label);

    try {
      managedProcess.restartOnExit = false;
      managedProcess.exitReason = `launch_failed`;
      managedProcess.process?.kill?.();
    } catch { }

    await this.#runLaunchErrorHook({
      ...launchContext,
      label,
      pid,
      managedProcess,
      process: managedProcess.process
    }, error);
    await this.#runCleanupTasks(managedProcess.cleanupTasks);
  }

}

function ownsDirectorQueueTasks(label) {
  return Boolean(
    typeof label === `string`
    && (
      label.startsWith(`e_transport_`)
      || 
      label.startsWith(`transport_`)
    )
  );
}

function inferLayerKey({ layerKey = null, processType = null }) {
  if (layerKey) return layerKey;
  if (processType === `transport`) return `tenantScope`;
  if (processType === `isolatedRuntime`) return `appScope`;
  return null;
}

function inferProcessKey({ processKey = null, processType = null }) {
  if (processKey) return processKey;
  if (processType === `transport`) return `transport`;
  if (processType === `isolatedRuntime`) return `isolatedRuntime`;
  return null;
}

function normalizeFirewallPorts(values = []) {
  if (!Array.isArray(values)) return [];
  const ports = values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65535);
  return [...new Set(ports)].sort((left, right) => left - right);
}

function getDefaultProcessResources(config) {
  const resources = {};
  const nodeMaxOldSpaceSizeMb = Number(config?.nodeMaxOldSpaceSizeMb);
  if (Number.isInteger(nodeMaxOldSpaceSizeMb) && nodeMaxOldSpaceSizeMb > 0) {
    resources.nodeMaxOldSpaceSizeMb = nodeMaxOldSpaceSizeMb;
  }
  if (config?.cgroups?.enabled === true) {
    resources.cgroups = normalizeDefaultCgroupResources(config.cgroups);
  }
  return resources;
}

function normalizeDefaultCgroupResources(cgroups = {}) {
  const memoryMaxMb = Number(cgroups.memoryMaxMb ?? 192);
  const cpuMaxPercent = Number(cgroups.cpuMaxPercent ?? 50);
  const cleanupIntervalMs = Number(cgroups.cleanupIntervalMs ?? 30_000);
  return {
    enabled: true,
    memoryMaxMb: Number.isInteger(memoryMaxMb) && memoryMaxMb > 0 ? memoryMaxMb : 192,
    cpuMaxPercent: Number.isFinite(cpuMaxPercent) && cpuMaxPercent > 0 ? cpuMaxPercent : 50,
    cleanupIntervalMs: Number.isInteger(cleanupIntervalMs) && cleanupIntervalMs >= 1000 ? cleanupIntervalMs : 30_000,
    ...(cgroups.registryFile ? { registryFile: cgroups.registryFile } : {}),
    ...(cgroups.managedRootName ? { managedRootName: cgroups.managedRootName } : {}),
    ...(cgroups.delegateSubgroup ? { delegateSubgroup: cgroups.delegateSubgroup } : {}),
    ...(cgroups.operationTimeoutMs ? { operationTimeoutMs: cgroups.operationTimeoutMs } : {})
  };
}

async function forceKillManagedProcess(managedProcess, {
  label = null,
  reason = `force_kill`
} = {}) {
  const pid = managedProcess?.pid ?? null;
  if (!pid || !managedProcess?.process) {
    const error = new Error(`Cannot force-kill managed process without a pid`);
    error.code = `MISSING_MANAGED_PROCESS_PID`;
    throw error;
  }

  try {
    managedProcess.process.kill(`SIGKILL`);
    return {
      pid,
      method: `direct`,
      signal: `SIGKILL`
    };
  } catch (error) {
    if (error?.code === `ESRCH`) {
      return {
        pid,
        method: `already_exited`,
        signal: `SIGKILL`
      };
    }
    if (![ `EPERM`, `EACCES` ].includes(error?.code)) throw error;
  }

  const result = await requestPrivilegedHostOperation({
    operation: `process.kill`,
    payload: {
      pid,
      signal: `SIGKILL`,
      expectedLabel: label,
      reason
    }
  });
  return {
    pid,
    method: `privileged`,
    signal: `SIGKILL`,
    result
  };
}

module.exports = ProcessForkRuntime;
Object.freeze(module.exports);
