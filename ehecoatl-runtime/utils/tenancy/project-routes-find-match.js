// utils/tenancy/project-routes-find-match.js


'use strict';

const normalizeRoutePath = require(`./normalize-route-path`);
const normalizeI18nSourceEntry = require(`@/utils/i18n/normalize-i18n-source-entry`);

const TYPE_STATIC = 0;
const TYPE_DYNAMIC = 1;

function normalizeRouteParamName(key) {
  return String(key ?? ``).replace(/^\{|\}$/g, ``);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, `\\$&`);
}

function replaceTemplate(input, replacements) {
  if (typeof input !== `string`) return input;

  let output = input;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replace(
      new RegExp(escapeRegExp(key), `g`),
      String(value)
    );
  }
  return output;
}

function replaceTemplatesDeep(input, replacements) {
  if (Array.isArray(input)) {
    return input.map((value) => replaceTemplatesDeep(value, replacements));
  }
  if (input && typeof input === `object`) {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, replaceTemplatesDeep(value, replacements)])
    );
  }
  if (typeof input === `string`) {
    return replaceTemplate(input, replacements);
  }
  return input;
}

module.exports = function projectRoutesFindMatch(
  routeURI,
  compiledRoutes
) {
  const normalizedRouteURI = normalizeRoutePath(routeURI);

  for (const route of compiledRoutes) {

    if (route.type === TYPE_STATIC) {
      if (route.pattern === normalizedRouteURI)
        return { ...route.route_data };
      continue;
    }

    const match = normalizedRouteURI.match(route.regexp);
    if (!match) continue;

    const values = match.slice(1);

    const params = Object.fromEntries(
      route.keys.map((key, i) => [normalizeRouteParamName(key), values[i]])
    );
    const rep_data = Object.fromEntries(
      route.keys.map((key, i) => [`{${normalizeRouteParamName(key)}}`, values[i]])
    );

    const route_data = { ...route.route_data };

    rep_data[`{full_uri}`] = normalizedRouteURI;

    for (const i in route_data) {
      route_data[i] = replaceTemplatesDeep(route_data[i], rep_data);
    }
    if (Array.isArray(route_data.i18n)) {
      route_data.i18n = route_data.i18n.map((entry) => normalizeI18nSourceEntry(entry, {
        entryLabel: `Route i18n`
      }));
    }

    return {
      ...route_data,
      params
    };
  }

  return null;
}
