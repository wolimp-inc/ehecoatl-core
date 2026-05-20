// _core/runtimes/ingress-runtime/execution/project-route.js


'use strict';


const fs = require(`node:fs`);
const ProjectRouteMeta = require(`@/_core/runtimes/ingress-runtime/execution/project-route-meta`);
const { resolveScopeFallbackPathSync } = require(`@/utils/fs/resolve-scope-fallback-path`);
const { normalizeRouteCachePolicy } = require(`@/utils/http/route-cache-policy`);
const {
  buildEffectiveMethods,
  renderAllowHeader
} = require(`@/utils/http/http-method-policy`);

/** Immutable route descriptor that represents the resolved project action target. */
class ProjectRoute {

  /** Stores resolved project route metadata and freezes it for request-safe reuse. */
  constructor(params) {
    this.meta = new ProjectRouteMeta(params);
    this.pointsTo = this.meta.pointsTo;
    this.target = this.meta.target;
    this.i18n = this.meta.i18n;
    this.cache = this.meta.cache;
    this.session = this.meta.session;
    this.middleware = this.meta.middleware;
    this.authScope = this.meta.authScope;
    this.wsActionsAvailable = this.meta.wsActionsAvailable;
    this.cors = this.meta.cors;
    this.methodsAvailable = this.meta.methodsAvailable;
    this.methods = this.meta.methods;
    this.effectiveHostMethods = buildEffectiveMethods(this.methodsAvailable);
    this.effectiveMethods = buildEffectiveMethods(this.methods);
    this.contentTypes = this.meta.contentTypes;
    this.upload = this.meta.upload;
    this.maxInputBytes = this.meta.maxInputBytes;
    this.upgrade = this.meta.upgrade;
    this.params = this.meta.params;
    this.view = this.meta.view;
    this.origin = this.meta.origin;
    this.projectId = this.origin.projectId;
    this.projectDomain = this.origin.projectDomain;
    this.projectRoot = this.origin.projectRoot ?? this.meta.folders.projectRootFolder;
    this.domainRoutingMode = this.meta.domainRoutingMode;
    this.folders = this.meta.folders;

    Object.freeze(this);
  }

  /** Reports whether the route points to a static asset response. */
  isStaticAsset() { return Boolean(this.target.asset?.path); }
  /** Reports whether the route is a websocket-upgrade route. */
  isWsUpgradeRoute() { return Boolean(this.upgrade?.enabled); }
  /** Builds the absolute file path for the resolved static asset. */
  assetPath() {
    return resolveScopeFallbackPathSync({
      primaryRootFolder: this.folders.assetsRootFolder ?? null,
      fallbackRootFolder: this.folders.assetsSharedRootFolder ?? null,
      filename: this.target.asset?.path ?? ``,
      existsSync: fs.existsSync
    }).path;
  }
  /** Reports whether the route should emit a redirect response. */
  isRedirect() { return this.target.redirect; }
  /** Reports whether the provided HTTP method is allowed for the host. */
  allowsHostMethod(method) {
    return this.effectiveHostMethods.includes(String(method ?? ``).trim().toUpperCase());
  }
  /** Reports whether the provided HTTP method is allowed for this route. */
  allowsMethod(method) {
    return this.effectiveMethods.includes(String(method ?? ``).trim().toUpperCase());
  }
  /** Renders the Allow header for the host-level methods policy. */
  hostAllowHeader() {
    return renderAllowHeader(this.methodsAvailable);
  }
  /** Renders the Allow header for the route-level methods policy. */
  allowHeader() {
    return renderAllowHeader(this.methods);
  }
  /** Reports whether the provided request Content-Type is allowed for this route. */
  allowsContentType(contentType) {
    if (this.contentTypes == null) return true;
    return this.contentTypes.includes(normalizeContentType(contentType));
  }
  /** Resolves an arbitrary project-local file path from the app root folder. */
  getFilePath(file) { return `${this.folders.rootFolder}/${file}`; }

  /** Builds the cache file path for a URL when route caching is enabled. */
  getCacheFilePath(url) {
    const cachePolicy = normalizeRouteCachePolicy(this.cache);
    if (cachePolicy.internalTtlMs == null) { return null; }
    const root = this.folders.rootFolder;
    const cacheFolder = `.ehecoatl/.cache`;
    const filename = url.replace(/\//g, `]_[`);
    return `${root}/${cacheFolder}/[${filename}]`;
  }
}

module.exports = ProjectRoute;
Object.freeze(module.exports);

function normalizeContentType(contentType) {
  return String(contentType ?? ``)
    .split(`;`, 1)[0]
    .trim()
    .toLowerCase();
}
