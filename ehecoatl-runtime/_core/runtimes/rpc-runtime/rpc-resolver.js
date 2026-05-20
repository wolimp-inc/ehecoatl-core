// _core/runtimes/rpc-runtime/rpc-resolver.js


'use strict';

const RpcRuntime = require("./rpc-runtime");
const RpcChannel = require("./rpc-channel");
const AdaptableUseCase = require(`@/_core/_ports/adaptable-use-case`);

/** Shared RPC resolver that resolves labeled process targets and forwards IPC messages. */
class RpcResolver extends AdaptableUseCase {
  /** @type {typeof import('@/config/default.config').adapters.rpcRuntime} */
  config;

  /** @type {RpcChannel}  */
  channel;
  /** @type {RpcRuntime} */
  endpoint;
  /** @type {import('@/_core/orchestrators/plugin-orchestrator')} */
  plugin;

  /** @type {Map<string,(...any)=>any>} */
  temporaryPreffixSpawner;

  constructor(kernelContext) {
    super(kernelContext.config._adapters.rpcRuntime);
    this.config = kernelContext.config.adapters.rpcRuntime;
    this.plugin = kernelContext.pluginOrchestrator;
    this.channel = new RpcChannel(this.adapter);
    this.endpoint = new RpcRuntime(kernelContext, {
      channel: this.channel,
      routeAnswer: (target, payload) => this.routeTo(target, payload)
    });
    this.children = new Map();
    //this.parents = new Map();
    this.temporaryPreffixSpawner = new Map();
  }

  registerTarget(label, processHandleOrLabel) {
    this.children.set(label, processHandleOrLabel);
  }

  unregisterTarget(label) {
    this.children.delete(label);
  }

  resolveRoute(endpointLabelOrProcess) {
    if (!endpointLabelOrProcess) return null;
    if (typeof endpointLabelOrProcess !== "string") return endpointLabelOrProcess;
    return this.children.get(endpointLabelOrProcess) ?? null;// ?? this.parents.get(endpointLabelOrProcess)
  }

  async routeTo(endpointTarget, payload) {
    const { ERROR, RECEIVED, ROUTED } = this.plugin.hooks.MAIN.RPC_ROUTER;
    const targetProcess = this.resolveRoute(endpointTarget);

    await this.plugin.run(RECEIVED, {}, ERROR);

    if (!targetProcess) {
      if (typeof endpointTarget !== `string`) {
        await this.plugin.run(ERROR, {});
        return undefined;
      }
      for (const [preffix, spawnCallback] of this.temporaryPreffixSpawner) {
        if (endpointTarget.startsWith(preffix)) {
          const spawnStartedAt = Date.now();
          if (await spawnCallback(endpointTarget, payload)) {
            attachColdWaitMeta(payload, Date.now() - spawnStartedAt);
            const success = await this.channel.sendMessage(this.resolveRoute(endpointTarget), payload);
            await this.plugin.run(success ? ROUTED : ERROR, {}, ERROR);
            return true;
          }
        }
      }
      await this.plugin.run(ERROR, {});
      return undefined; // TARGET NOT FOUND
    }

    const success = await this.channel.sendMessage(targetProcess, payload);
    await this.plugin.run(success ? ROUTED : ERROR, {}, ERROR);
  }

  bindTemporarySpawner(preffix, spawnCallback) {
    this.temporaryPreffixSpawner.set(preffix, spawnCallback);
  }
}

function attachColdWaitMeta(payload, coldWaitMs) {
  if (!payload || !payload.data?.projectRoute?.target?.run?.action) return;

  payload.internalMeta = {
    ...(payload.internalMeta ?? {}),
    actionMeta: {
      ...(payload.internalMeta?.actionMeta ?? {}),
      coldWaitMs
    }
  };
}

module.exports = RpcResolver;
Object.freeze(module.exports);
