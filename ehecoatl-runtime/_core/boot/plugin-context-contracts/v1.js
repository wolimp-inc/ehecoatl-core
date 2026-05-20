'use strict';

class BasePluginContextV1 {
  constructor({
    contractId,
    contextName,
    processLabel,
    kernelContext
  } = {}) {
    this.contractId = contractId;
    this.apiVersion = 1;
    this.contextName = contextName ?? null;
    this.processLabel = processLabel ?? null;
    this.meta = Object.freeze({
      contextName: this.contextName,
      processLabel: this.processLabel
    });
    Object.defineProperty(this, `kernelContext`, {
      value: kernelContext,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }

  static validate(context) {
    return !!context
      && context.apiVersion === 1
      && typeof context.contractId === `string`
      && typeof context.contextName === `string`;
  }

  get useCases() {
    return this.kernelContext?.useCases ?? {};
  }
}

class MainPluginContextV1 extends BasePluginContextV1 {
  static contractId = `main.v1`;

  constructor(options = {}) {
    super({
      ...options,
      contractId: MainPluginContextV1.contractId,
      contextName: `MAIN`
    });

    this.rpc = Object.freeze({
      addListener: (question, handler) => {
        const endpoint = this.useCases?.rpcRouter?.endpoint ?? null;
        if (!endpoint || typeof endpoint.addListener !== `function`) {
          throw new Error(`main.v1 rpc endpoint is not ready`);
        }
        return endpoint.addListener(question, handler);
      },
      removeListener: (question) => {
        const endpoint = this.useCases?.rpcRouter?.endpoint ?? null;
        if (!endpoint || typeof endpoint.removeListener !== `function`) return undefined;
        return endpoint.removeListener(question);
      }
    });

    this.supervision = Object.freeze({
      listProcesses: () => this.useCases?.processForkRuntime?.listProcesses?.() ?? [],
      getProcessCounts: () => this.useCases?.processForkRuntime?.getProcessCountsSnapshot?.() ?? {
        total: 0,
        director: 0,
        transport: 0,
        isolatedRuntime: 0,
        other: 0
      },
      getLifecycleHistory: (label = null) => this.useCases?.processForkRuntime?.getLifecycleHistory?.(label) ?? [],
      getHeartbeatHealth: (label = null) => {
        const watchdog = this.useCases?.watchdogOrchestrator ?? null;
        if (label) return watchdog?.getProcessHealth?.(label) ?? null;
        const healthByLabel = watchdog?.heartbeatHealthByLabel;
        if (!(healthByLabel instanceof Map)) return [];
        return [...healthByLabel.entries()].map(([processLabel, health]) => ({
          label: processLabel,
          health
        }));
      },
      reloadProcess: (label, reason = `observability_reload`) => {
        return this.useCases?.watchdogOrchestrator?.reloadProcess?.(label, reason) ?? false;
      },
      shutdownProcess: (label, reason = `observability_shutdown`, timeoutMs = null) => {
        return this.useCases?.processForkRuntime?.shutdownProcess?.(
          label,
          reason,
          timeoutMs ?? undefined
        ) ?? false;
      }
    });

    Object.freeze(this);
  }

  static validate(context) {
    return BasePluginContextV1.validate(context)
      && context.contractId === MainPluginContextV1.contractId
      && context.contextName === `MAIN`
      && typeof context.rpc?.addListener === `function`
      && typeof context.rpc?.removeListener === `function`
      && typeof context.supervision?.listProcesses === `function`;
  }
}

class DirectorPluginContextV1 extends BasePluginContextV1 {
  static contractId = `director.v1`;

  constructor(options = {}) {
    super({
      ...options,
      contractId: DirectorPluginContextV1.contractId,
      contextName: `DIRECTOR`
    });

    this.rpc = Object.freeze({
      addListener: (question, handler) => {
        const endpoint = this.useCases?.rpcEndpoint ?? null;
        if (!endpoint || typeof endpoint.addListener !== `function`) {
          throw new Error(`director.v1 rpc endpoint is not ready`);
        }
        return endpoint.addListener(question, handler);
      },
      removeListener: (question) => this.useCases?.rpcEndpoint?.removeListener?.(question)
    });
    this.project = Object.freeze({
      getReadinessSnapshot: () => this.useCases?.projectDirectoryResolver?.getReadinessSnapshot?.() ?? null,
      forceRescan: (reason = `plugin_context_rescan`) => {
        return this.useCases?.projectDirectoryResolver?.requestForcedScan?.({ reason }) ?? null;
      }
    });
    this.tenancy = this.project;
    this.queue = Object.freeze({});

    Object.freeze(this);
  }
}

class TransportPluginContextV1 extends BasePluginContextV1 {
  static contractId = `transport.v1`;

  constructor(options = {}) {
    super({
      ...options,
      contractId: TransportPluginContextV1.contractId,
      contextName: `TRANSPORT`
    });

    this.runtime = Object.freeze({
      getServices: () => Object.freeze({ ...(this.useCases?.ingressRuntime?.services ?? {}) })
    });

    Object.freeze(this);
  }
}

class IsolatedRuntimePluginContextV1 extends BasePluginContextV1 {
  static contractId = `isolated-runtime.v1`;

  constructor(options = {}) {
    super({
      ...options,
      contractId: IsolatedRuntimePluginContextV1.contractId,
      contextName: `ISOLATED_RUNTIME`
    });

    const runtime = options?.kernelContext?.runtime ?? {};
    this.identity = Object.freeze({
      tenantId: runtime.tenantId ?? null,
      appId: runtime.appId ?? null,
      appName: runtime.appName ?? null,
      tenantDomain: runtime.tenantDomain ?? null
    });

    Object.freeze(this);
  }
}

module.exports = Object.freeze({
  BasePluginContextV1,
  MainPluginContextV1,
  DirectorPluginContextV1,
  TransportPluginContextV1,
  IsolatedRuntimePluginContextV1
});
