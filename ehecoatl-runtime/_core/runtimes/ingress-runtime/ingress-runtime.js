// _core/runtimes/ingress-runtime/ingress-runtime.js


'use strict';

const DirectorRuntimeResolver = require(`./director-runtime-resolver`);
const ExecutionContext = require(`@/_core/runtimes/ingress-runtime/execution/execution-context`);
const AdaptableUseCase = require(`@/_core/_ports/adaptable-use-case`);
const StorageService = require(`@/_core/services/storage-service`);
const SharedCacheService = require(`@/_core/services/shared-cache-service`);
const RpcRuntime = require(`@/_core/runtimes/rpc-runtime`);

/** Transport runtime use case that binds network adapter I/O to execution contexts and director services. */
class IngressRuntime extends AdaptableUseCase {
  /** @type {typeof import('@/config/default.config').adapters.ingressRuntime} */
  config;
  startupPromise;
  routeCacheTTL;

  /** @type {DirectorRuntimeResolver} */
  directorRuntimeResolver;
  middlewareStackRuntimeConfig;
  middlewareStackRuntime;
  /** @type {import('@/_core/orchestrators/plugin-orchestrator')} */
  plugin;

  /** 
   * @type {{
   * storage: StorageService,
   * cache: SharedCacheService,
   * rpc: RpcRuntime,
   * eRendererRuntime: any,
   * wsHubManager: any
   * }}
   * */
  services;

  /** Captures engine config, shared services, and boots the active network adapter. 
   * @param {import('@/_core/kernel/kernel')} kernelContext
  */
  constructor(kernelContext) {
    super(kernelContext.config._adapters.ingressRuntime);
    this.config = kernelContext.config.adapters.ingressRuntime;
    this.projectDirectoryResolverConfig = kernelContext.config.adapters.projectDirectoryResolver
      ?? kernelContext.config.adapters.tenantDirectoryResolver
      ?? {};
    this.tenantDirectoryResolverConfig = this.projectDirectoryResolverConfig;
    this.requestUriRoutingRuntimeConfig = kernelContext.config.adapters.requestUriRoutingRuntime ?? {};
    this.routeCacheTTL = kernelContext.config.adapters.requestUriRoutingRuntime?.routeMatchTTL ?? null;
    this.plugin = kernelContext.pluginOrchestrator;
    this.rpcEndpoint = kernelContext.useCases.rpcEndpoint;

    this.middlewareStackRuntimeConfig = kernelContext.config.adapters.middlewareStackRuntime;
    this.middlewareStackRuntime = kernelContext.useCases.middlewareStackRuntime;

    this.httpCoreIngressPort = kernelContext.config.adapters.ingressRuntime.httpCoreIngressPort;
    this.wsCoreIngressPort = kernelContext.config.adapters.ingressRuntime.wsCoreIngressPort;

    this.storageService = kernelContext.useCases.storageService;
    this.sharedCacheService = kernelContext.useCases.sharedCacheService;
    this.eRendererRuntime = kernelContext.useCases.eRendererRuntime;
    this.wsHubManager = kernelContext.useCases.wsHubManager;

    this.services = Object.freeze({
      rpc: this.rpcEndpoint,
      cache: this.sharedCacheService,
      storage: this.storageService,
      eRendererRuntime: this.eRendererRuntime,
      wsHubManager: this.wsHubManager,
    });
    this.directorRuntimeResolver = new DirectorRuntimeResolver(this);

    this.startupPromise = Promise.resolve(this.adapter.setupAdapter({
      services: this.services,
      httpCoreIngressPort: this.httpCoreIngressPort,
      wsCoreIngressPort: this.wsCoreIngressPort,
      ingressRuntimeConfig: this.config,
      createExecutionContext: this.createExecutionContext.bind(this)
    }));

    Object.freeze(this);
  }

  //TODO: pool recycling objects in future
  /** Creates one execution context instance for an inbound network request. */
  createExecutionContext(params) {
    return new ExecutionContext(this, params);
  }

  /**
   * Builds the request-scoped helper facade consumed by transport middlewares.
   * @param {ExecutionContext} ec
   */
  createDirectorHelper(ec) {
    const m = this.directorRuntimeResolver;
    return Object.freeze({
      askDirector: async (question, data) => await m.ask(question, data, ec),
      resolveRoute: async (params = null) => ec.projectRoute = await m.resolveRoute(ec, params ?? undefined),
      getObject: async (key, defaultValue) => await m.getObject(key, defaultValue),
      setObject: async (key, value) => await m.setObject(key, value)
    });
  }
}

module.exports = IngressRuntime;
Object.freeze(module.exports);
