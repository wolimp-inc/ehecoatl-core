// _core/_ports/inbound/project-registry-resolver-port.js


'use strict';


/** Contract singleton for persisting runtime project/app registry snapshots to disk. */
class ProjectRegistryResolverPort {
  /**
   * @type {(params: {
   * config?: typeof import('@/config/default.config').adapters.projectRegistryResolver,
   * storage: import('@/_core/services/storage-service'),
   * registry?: any,
   * scanSummary?: any,
   * projectsPath: string,
   * tenantsPath?: string,
   * registryPath: string
   * }) => Promise<{ registryPath: string, tenantCount: number, appCount: number }>}
   */
  persistRegistryAdapter;
  /** @type {() => Promise<void>} */
  destroyAdapter = async () => { };
}

module.exports = new ProjectRegistryResolverPort();
Object.preventExtensions(module.exports);
