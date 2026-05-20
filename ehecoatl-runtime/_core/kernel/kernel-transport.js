// _core/kernel/kernel-transport.js


'use strict';


const RpcRuntime = require(`@/_core/runtimes/rpc-runtime`);
const IngressRuntime = require(`@/_core/runtimes/ingress-runtime`);
const MiddlewareStackRuntime = require(`@/_core/runtimes/middleware-stack-runtime`);
const MiddlewareStackResolver = require(`@/_core/resolvers/middleware-stack-resolver`);
const KernelContext = require(`@/_core/kernel/kernel`);
const createPluginUseCases = require(`@/_core/boot/create-plugin-use-cases`);
const { renderLayerPath } = require(`@/contracts/utils`);

//SERVICES
const StorageService = require(`@/_core/services/storage-service`);
const SharedCacheService = require(`@/_core/services/shared-cache-service`);
const I18nCompiler = require(`@/_core/compilers/i18n-compiler`);
const ERendererRuntime = require(`@/_core/runtimes/e-renderer-runtime`);
const WsHubManager = require(`@/_core/managers/ws-hub-manager`);

module.exports = async function kernel(globalCore) {
  const kernelContext = new KernelContext(globalCore);
  const useCases = {};
  kernelContext.useCases = useCases;
  const projectId = globalCore.projectId ?? globalCore.tenantId ?? null;
  const projectDomain = globalCore.projectDomain ?? globalCore.tenantDomain ?? null;
  const customPluginsPaths = [
    globalCore.config?.runtime?.customPluginsPath ?? null,
    renderLayerPath(`tenantScope`, `OVERRIDES`, `plugins`, {
      tenant_id: projectId,
      tenant_domain: projectDomain
    })
  ];
  Object.assign(useCases, await createPluginUseCases({
    config: globalCore.config,
    contextName: `TRANSPORT`,
    processLabel: globalCore.processLabel,
    customPluginsPaths,
    kernelContext
  }));
  kernelContext.pluginOrchestrator = useCases.pluginOrchestrator;
  kernelContext.pluginRegistryResolver = useCases.pluginRegistryResolver;

  useCases.storageService = new StorageService(kernelContext);
  useCases.sharedCacheService = new SharedCacheService(kernelContext);
  useCases.i18nCompiler = new I18nCompiler(kernelContext);
  useCases.eRendererRuntime = new ERendererRuntime(kernelContext);
  useCases.wsHubManager = new WsHubManager(kernelContext);
  useCases.rpcEndpoint = new RpcRuntime(kernelContext);
  useCases.middlewareStackResolver = new MiddlewareStackResolver({
    config: globalCore.config,
    tenantId: projectId,
    tenantMiddlewarePaths: {
      http: renderLayerPath(`tenantScope`, `SHARED`, `httpMiddlewares`, {
        tenant_id: projectId,
        tenant_domain: projectDomain
      }),
      ws: renderLayerPath(`tenantScope`, `SHARED`, `wsMiddlewares`, {
        tenant_id: projectId,
        tenant_domain: projectDomain
      })
    }
  });
  await useCases.middlewareStackResolver.initialize();
  useCases.middlewareStackRuntime = new MiddlewareStackRuntime(kernelContext);
  useCases.ingressRuntime = new IngressRuntime(kernelContext);

  return useCases;
}

Object.freeze(module.exports);
