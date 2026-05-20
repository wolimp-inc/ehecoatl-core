// _core/compilers/project-route-matcher-compiler/project-route-matcher-compiler.js


'use strict';

const AdaptableUseCase = require(`@/_core/_ports/adaptable-use-case`);

class ProjectRouteMatcherCompiler extends AdaptableUseCase {
  config;

  constructor(kernelContext) {
    super(kernelContext.config._adapters.projectRouteMatcherCompiler);
    this.config = kernelContext.config.adapters.projectRouteMatcherCompiler ?? {};
  }

  async compileRoutes(routesAvailable = null) {
    const compileRoutesAdapter = this.adapter?.compileRoutesAdapter;
    if (typeof compileRoutesAdapter !== `function`) {
      return {
        routesAvailable: routesAvailable ?? null,
        compiledRoutes: []
      };
    }
    return await compileRoutesAdapter({
      config: this.config,
      routesAvailable
    });
  }
}

module.exports = ProjectRouteMatcherCompiler;
Object.freeze(module.exports);
