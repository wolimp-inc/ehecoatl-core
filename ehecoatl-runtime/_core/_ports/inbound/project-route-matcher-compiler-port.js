// _core/_ports/inbound/project-route-matcher-compiler-port.js


'use strict';


/** Contract singleton for project route normalization and first-match comparer compilation. */
class ProjectRouteMatcherCompilerPort {
  /**
   * @type {(params: {
   * config?: typeof import('@/config/default.config').adapters.projectRouteMatcherCompiler,
   * routesAvailable?: Record<string, any> | null
   * }) => Promise<{
   * routesAvailable: Record<string, any> | null,
   * compiledRoutes: any[]
   * }>}
   */
  compileRoutesAdapter;
  /** @type {() => Promise<void>} */
  destroyAdapter = async () => { };
}

module.exports = new ProjectRouteMatcherCompilerPort();
Object.preventExtensions(module.exports);
