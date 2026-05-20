// _core/kernel/kernel-director.js


'use strict';


const RpcRuntime = require(`@/_core/runtimes/rpc-runtime`);
const QueueManager = require(`@/_core/managers/queue-manager`);
const ProjectDirectoryResolver = require(`@/_core/resolvers/project-directory-resolver`);
const ProjectRegistryResolver = require(`@/_core/resolvers/project-registry-resolver`);
const ProjectRouteMatcherCompiler = require(`@/_core/compilers/project-route-matcher-compiler`);
const RequestUriRoutingRuntime = require(`@/_core/runtimes/request-uri-routing-runtime`);

//SERVICES
const StorageService = require(`@/_core/services/storage-service`);
const CertificateService = require(`@/_core/services/certificate-service`);
const WebServerService = require(`@/_core/services/web-server-service`);
const SharedCacheService = require(`@/_core/services/shared-cache-service`);
const KernelContext = require(`@/_core/kernel/kernel`);
const createPluginUseCases = require(`@/_core/boot/create-plugin-use-cases`);

/**
 * @description
 * Initialize *Director* process boot.
 * Load predefined adapters.
 * Returns dependent useCases instance.
 * 
 * @param {{config, processLabel}} globalCore
 * 
 * @returns {{ 
 * rpcEndpoint: RpcRuntime,
 * queueBroker: QueueManager,
 * projectDirectoryResolver: ProjectDirectoryResolver,
 * projectRegistryResolver: ProjectRegistryResolver,
 * projectRouteMatcherCompiler: ProjectRouteMatcherCompiler,
 * requestUriRoutingRuntime: RequestUriRoutingRuntime,
 * storageService: StorageService,
 * certificateService: CertificateService,
 * webServerService: WebServerService,
 * sharedCacheService: SharedCacheService,
 * }}
 */
module.exports = async function kernel(globalCore) {
  const kernelContext = new KernelContext(globalCore);
  const useCases = {};
  kernelContext.useCases = useCases;
  Object.assign(useCases, await createPluginUseCases({
    config: globalCore.config,
    contextName: `DIRECTOR`,
    processLabel: globalCore.processLabel,
    kernelContext
  }));
  kernelContext.pluginOrchestrator = useCases.pluginOrchestrator;
  kernelContext.pluginRegistryResolver = useCases.pluginRegistryResolver;

  useCases.storageService = new StorageService(kernelContext);
  useCases.certificateService = new CertificateService(kernelContext);
  useCases.webServerService = new WebServerService(kernelContext);
  useCases.sharedCacheService = new SharedCacheService(kernelContext);
  useCases.rpcEndpoint = new RpcRuntime(kernelContext);
  useCases.queueBroker = new QueueManager(kernelContext);
  useCases.projectDirectoryResolver = new ProjectDirectoryResolver(kernelContext);
  useCases.projectRegistryResolver = new ProjectRegistryResolver(kernelContext);
  useCases.projectRouteMatcherCompiler = new ProjectRouteMatcherCompiler(kernelContext);
  useCases.tenantDirectoryResolver = useCases.projectDirectoryResolver;
  useCases.tenantRegistryResolver = useCases.projectRegistryResolver;
  useCases.tenantRouteMatcherCompiler = useCases.projectRouteMatcherCompiler;
  useCases.requestUriRoutingRuntime = new RequestUriRoutingRuntime(kernelContext);
  useCases.projectDirectoryResolver.attachProjectRegistryResolver(useCases.projectRegistryResolver);
  useCases.projectDirectoryResolver.attachRouteMatcherCompiler(useCases.projectRouteMatcherCompiler);
  useCases.projectDirectoryResolver.attachRouteRuntime(useCases.requestUriRoutingRuntime);
  useCases.projectDirectoryResolver.attachWebServerService(useCases.webServerService);

  return useCases;
}

Object.freeze(module.exports);
