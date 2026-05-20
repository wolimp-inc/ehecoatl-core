'use strict';

const {
  buildEffectiveMethods,
  normalizeMethod
} = require(`./http-method-policy`);

const DEFAULT_ALLOWED_HEADERS = `content-type, x-csrf-token`;

function getOriginHeader(source) {
  const requestData = getRequestData(source);
  const origin = requestData?.headers?.origin;
  return typeof origin === `string` && origin.trim() ? origin.trim() : null;
}

function getRequestOrigin(source) {
  const requestData = getRequestData(source);
  const protocol = String(requestData?.protocol ?? ``).trim().toLowerCase();
  const hostname = String(requestData?.hostname ?? ``).trim().toLowerCase();
  const port = requestData?.port;
  if (!protocol || !hostname) return null;

  const defaultPort = protocol === `https` ? 443 : 80;
  const suffix = Number(port) && Number(port) !== defaultPort ? `:${Number(port)}` : ``;
  return `${protocol}://${hostname}${suffix}`;
}

function isCrossOriginRequest(source) {
  const requestOrigin = getRequestOrigin(source);
  const originHeader = getOriginHeader(source);
  if (!originHeader) return false;
  if (!requestOrigin) return true;
  return originHeader.toLowerCase() !== requestOrigin.toLowerCase();
}

function getAllowedCorsOrigins(source) {
  const projectRoute = getProjectRoute(source);
  return Array.isArray(projectRoute?.cors)
    ? projectRoute.cors
    : [];
}

function isOriginAllowed(source, origin) {
  const allowedOrigins = getAllowedCorsOrigins(source);
  if (allowedOrigins.length === 0) return false;
  if (allowedOrigins.includes(`*`)) return true;
  return allowedOrigins.includes(String(origin ?? ``).trim());
}

function resolveAllowedMethods(source) {
  const projectRoute = getProjectRoute(source);
  const effectiveMethods = Array.isArray(projectRoute?.effectiveMethods)
    ? projectRoute.effectiveMethods
    : buildEffectiveMethods(projectRoute?.methods);
  return effectiveMethods.join(`, `);
}

function resolveAllowedHeaders(source) {
  const requestData = getRequestData(source);
  const requested = requestData?.headers?.[`access-control-request-headers`];
  if (typeof requested === `string` && requested.trim()) {
    return requested
      .split(`,`)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .join(`, `);
  }
  return DEFAULT_ALLOWED_HEADERS;
}

function buildCorsHeaders(source, origin = getOriginHeader(source)) {
  const allowedOrigins = getAllowedCorsOrigins(source);
  const allowAnyOrigin = allowedOrigins.includes(`*`);
  return Object.freeze({
    Vary: `Origin`,
    'Access-Control-Allow-Origin': allowAnyOrigin ? `*` : origin,
    'Access-Control-Allow-Methods': resolveAllowedMethods(source),
    'Access-Control-Allow-Headers': resolveAllowedHeaders(source),
    ...(allowAnyOrigin ? {} : { 'Access-Control-Allow-Credentials': `true` })
  });
}

function buildCorsBlockedResponse(source, origin = getOriginHeader(source)) {
  return Object.freeze({
    status: 403,
    headers: Object.freeze({
      'Content-Type': `application/json`
    }),
    body: Object.freeze({
      success: false,
      error: `cors_blocked`,
      origin
    })
  });
}

function resolveRequestedPreflightMethod(source) {
  const requestData = getRequestData(source);
  const rawMethod = requestData?.headers?.[`access-control-request-method`];
  return normalizeMethod(rawMethod);
}

function getRequestData(source) {
  if (source?.requestData) return source.requestData;
  return source ?? null;
}

function getProjectRoute(source) {
  if (source?.projectRoute) return source.projectRoute;
  return source ?? null;
}

module.exports = {
  getOriginHeader,
  getRequestOrigin,
  isCrossOriginRequest,
  getAllowedCorsOrigins,
  isOriginAllowed,
  resolveAllowedMethods,
  resolveAllowedHeaders,
  buildCorsHeaders,
  buildCorsBlockedResponse,
  resolveRequestedPreflightMethod
};

Object.freeze(module.exports);
