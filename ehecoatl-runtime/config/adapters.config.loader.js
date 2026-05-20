// config/defult.adapters.resolver.js


'use strict';


module.exports = (config) => {
  const varAdaptersDir = config.runtime.customAdaptersPath;
  function resolveAdapterPath(directionFolder, adaptableFolder, adapterId, {
    legacyAdapterId = null,
    legacyAdaptableFolder = adaptableFolder
  } = {}) {
    if (!(adapterId in config.adapters) && legacyAdapterId && legacyAdapterId in config.adapters) {
      config.adapters[adapterId] = config.adapters[legacyAdapterId];
    }
    if (!(adapterId in config.adapters) || !(`adapter` in config.adapters[adapterId])) {
      throw new Error(`Failed loading ${directionFolder}/${adaptableFolder} adapter ${adapterId}`);
    }
    const a = `${directionFolder}/${adaptableFolder}/${config.adapters[adapterId].adapter}`;
    config._adapters[adapterId] = {
      bundled: `@adapter/${a}`,
      custom: `${varAdaptersDir}/${a}`,
      portPath: `@/_core/_ports/${directionFolder}/${adaptableFolder}-port`
    };
    if (legacyAdapterId) {
      config.adapters[legacyAdapterId] = config.adapters[legacyAdapterId] ?? config.adapters[adapterId];
      const legacyPath = `${directionFolder}/${legacyAdaptableFolder}/${config.adapters[legacyAdapterId].adapter}`;
      config._adapters[legacyAdapterId] = {
        bundled: `@adapter/${legacyPath}`,
        custom: `${varAdaptersDir}/${legacyPath}`,
        portPath: `@/_core/_ports/${directionFolder}/${legacyAdaptableFolder}-port`
      };
    }
  }

  resolveAdapterPath(`inbound`, `rpc-runtime`, `rpcRuntime`);
  resolveAdapterPath(`inbound`, `ingress-runtime`, `ingressRuntime`);
  resolveAdapterPath(`outbound`, `certificate-service`, `certificateService`);

  resolveAdapterPath(`outbound`, `process-fork-runtime`, `processForkRuntime`);

  resolveAdapterPath(`inbound`, `queue-manager`, `queueBroker`);
  resolveAdapterPath(`inbound`, `ws-hub-manager`, `wsHubManager`);

  resolveAdapterPath(`inbound`, `project-directory-resolver`, `projectDirectoryResolver`, {
    legacyAdapterId: `tenantDirectoryResolver`,
    legacyAdaptableFolder: `tenant-directory-resolver`
  });
  resolveAdapterPath(`inbound`, `project-registry-resolver`, `projectRegistryResolver`, {
    legacyAdapterId: `tenantRegistryResolver`,
    legacyAdaptableFolder: `tenant-registry-resolver`
  });
  resolveAdapterPath(`inbound`, `project-route-matcher-compiler`, `projectRouteMatcherCompiler`, {
    legacyAdapterId: `tenantRouteMatcherCompiler`,
    legacyAdaptableFolder: `tenant-route-matcher-compiler`
  });
  resolveAdapterPath(`inbound`, `i18n-compiler`, `i18nCompiler`);
  resolveAdapterPath(`inbound`, `e-renderer-runtime`, `eRendererRuntime`);
  resolveAdapterPath(`inbound`, `request-uri-routing-runtime`, `requestUriRoutingRuntime`);

  resolveAdapterPath(`outbound`, `storage-service`, `storageService`);
  resolveAdapterPath(`outbound`, `web-server-service`, `webServerService`);
  resolveAdapterPath(`outbound`, `shared-cache-service`, `sharedCacheService`);
};
