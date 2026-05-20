// utils/tenancy/project-routes-compiler.js


'use strict';


const ___esc = s => s.replaceAll(/[\.]/g, "\\$&").replaceAll("*", ".*");
const ___vars_regex = /\{[a-z0-9-_]+\}/gi;
const ___rep_regex = "([^/]+)";

const TYPE_STATIC = 0;
const TYPE_DYNAMIC = 1;

module.exports = function projectRoutesCompiler(routesAvailable) {
  const compiled = [];

  for (const [pattern, route_data] of Object.entries(routesAvailable)) {

    const keys = pattern.match(___vars_regex);
    if (!keys) {
      const type = TYPE_STATIC;

      compiled.push({
        type,
        pattern,
        route_data
      });
      continue;
    }

    const type = TYPE_DYNAMIC;
    const source = `^${___esc(pattern).replace(___vars_regex, ___rep_regex)}$`;
    const regexp = new RegExp(source, `i`);

    compiled.push({
      type,
      regexp,
      keys,
      route_data
    });

  }

  return compiled;

}
