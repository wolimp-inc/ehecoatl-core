// _core/_ports/inbound/project-directory-resolver-port.js


'use strict';


/** Contract singleton for project directory scanning and registry-building port methods. */
class ProjectDirectoryResolverPort {
  /**
   * @type {(params: {
   * config: typeof import('@/config/default.config').adapters.projectDirectoryResolver,
   * storage: import('@/_core/services/storage-service')
   * routeMatcherCompiler?: import('@/_core/compilers/project-route-matcher-compiler')
   * }) => Promise<void | {
   * registry?: any,
   * initialScan?: boolean,
   * changedHosts?: string[],
   * removedHosts?: string[],
   * activeProjects?: Array<{ projectId?: string, projectDomain?: string, projectRoot?: string }>,
   * activeApps?: Array<{ hostname: string, domain?: string, appName?: string, rootFolder?: string }>,
   * invalidApps?: Array<{
   * hostname: string,
   * rootFolder?: string,
   * scope?: string,
   * status?: string,
   * generatedAt?: string,
   * appConfigPath?: string,
   * error?: { name?: string, code?: string | null, message?: string }
   * }>
   * }>}
   */
  scanProjectsAdapter;
  /** @type {() => Promise<void>} */
  destroyAdapter = async () => { };
}

module.exports = new ProjectDirectoryResolverPort();
Object.preventExtensions(module.exports);
