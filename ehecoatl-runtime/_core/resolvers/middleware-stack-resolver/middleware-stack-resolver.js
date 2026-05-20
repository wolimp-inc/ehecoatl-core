// _core/resolvers/middleware-stack-resolver/middleware-stack-resolver.js


'use strict';


const fs = require(`node:fs/promises`);
const path = require(`node:path`);

const { renderLayerPath } = require(`@/contracts/utils`);
const weakRequire = require(`@/utils/module/weak-require`);
const {
  findOpaqueAppRecordByTenantIdAndAppIdSync,
  findOpaqueTenantRecordByIdSync
} = require(`@/utils/tenancy/tenant-layout`);

class MiddlewareStackResolver {
  config;
  tenantId;
  tenantsBase;
  coreMiddlewarePaths;
  tenantMiddlewarePaths;
  appMiddlewarePathsResolver;
  coreMiddlewares;
  coreMiddlewareOrder;
  coreMiddlewareSourcePaths;
  tenantMiddlewares;
  tenantMiddlewareSourcePaths;
  appMiddlewares;
  appMiddlewareSourcePaths;

  constructor({
    config,
    tenantId = null,
    tenantsBase = null,
    coreMiddlewarePaths = null,
    coreMiddlewaresPath = null,
    tenantMiddlewarePaths = null,
    appMiddlewarePathsResolver = null
  } = {}) {
    this.config = config ?? {};
    this.tenantId = typeof tenantId === `string` && tenantId.trim()
      ? tenantId.trim().toLowerCase()
      : null;
    this.tenantsBase = tenantsBase
      ?? this.config?.adapters?.tenantDirectoryResolver?.projectsPath
      ?? this.config?.adapters?.tenantDirectoryResolver?.tenantsPath
      ?? null;
    this.coreMiddlewarePaths = normalizeProtocolPaths(coreMiddlewarePaths ?? coreMiddlewaresPath ?? null);
    this.tenantMiddlewarePaths = tenantMiddlewarePaths ?? null;
    this.appMiddlewarePathsResolver = appMiddlewarePathsResolver ?? null;
    this.coreMiddlewares = freezeProtocolRegistry({
      http: {},
      ws: {}
    });
    this.coreMiddlewareOrder = freezeProtocolOrder({
      http: [],
      ws: []
    });
    this.coreMiddlewareSourcePaths = createProtocolSourcePathRegistry();
    this.tenantMiddlewares = freezeProtocolRegistry({
      http: {},
      ws: {}
    });
    this.tenantMiddlewareSourcePaths = createProtocolSourcePathRegistry();
    this.appMiddlewares = Object.create(null);
    this.appMiddlewareSourcePaths = Object.create(null);
  }

  async initialize() {
    this.coreMiddlewarePaths = await this.#resolveCoreMiddlewarePaths();
    await this.loadCoreMiddlewares(`http`);
    await this.loadCoreMiddlewares(`ws`);
    return this;
  }

  getCoreMiddlewares(protocol = `http`) {
    return this.coreMiddlewares[normalizeProtocol(protocol)] ?? Object.freeze({});
  }

  getCoreMiddlewareOrder(protocol = `http`) {
    return this.coreMiddlewareOrder[normalizeProtocol(protocol)] ?? Object.freeze([]);
  }

  async loadCoreMiddlewares(protocol = `http`) {
    const normalizedProtocol = normalizeProtocol(protocol);
    const coreMiddlewarePaths = await this.#resolveCoreMiddlewarePaths();
    const loaded = await loadWatchedMiddlewareRegistry(coreMiddlewarePaths[normalizedProtocol], {
      previousSourcePaths: this.coreMiddlewareSourcePaths[normalizedProtocol] ?? [],
      include(middlewareName) {
        return middlewareName !== `core`;
      }
    });

    this.coreMiddlewares = freezeProtocolRegistry({
      ...this.coreMiddlewares,
      [normalizedProtocol]: loaded.registry
    });
    this.coreMiddlewareSourcePaths = Object.freeze({
      ...this.coreMiddlewareSourcePaths,
      [normalizedProtocol]: Object.freeze([...loaded.sourcePaths])
    });

    validateCoreMiddlewareManifest(
      await this.loadCoreMiddlewareOrder(normalizedProtocol),
      this.coreMiddlewares[normalizedProtocol]
    );
    return this.coreMiddlewares[normalizedProtocol];
  }

  async loadCoreMiddlewareOrder(protocol = `http`) {
    const normalizedProtocol = normalizeProtocol(protocol);
    const coreMiddlewarePaths = await this.#resolveCoreMiddlewarePaths();
    const nextOrder = await loadCoreMiddlewareOrder(coreMiddlewarePaths[normalizedProtocol]);
    this.coreMiddlewareOrder = freezeProtocolOrder({
      ...this.coreMiddlewareOrder,
      [normalizedProtocol]: nextOrder
    });
    return this.coreMiddlewareOrder[normalizedProtocol];
  }

  getTenantMiddlewares() {
    return this.tenantMiddlewares;
  }

  async loadTenantMiddlewares() {
    if (!this.tenantId) {
      throw new Error(`middleware-stack-resolver requires tenantId to initialize tenant middlewares`);
    }

    const loaded = await loadWatchedProtocolRegistry(this.#resolveTenantMiddlewarePaths(), {
      previousSourcePaths: this.tenantMiddlewareSourcePaths
    });
    this.tenantMiddlewares = loaded.registry;
    this.tenantMiddlewareSourcePaths = loaded.sourcePaths;
    return this.tenantMiddlewares;
  }

  getAppMiddlewares(appId) {
    const normalizedAppId = normalizeKey(appId);
    return normalizedAppId ? this.appMiddlewares[normalizedAppId] ?? null : null;
  }

  async loadAppMiddlewares(appId, {
    pathsByProtocol = null
  } = {}) {
    const normalizedAppId = normalizeKey(appId);
    if (!normalizedAppId) {
      throw new Error(`middleware-stack-resolver requires a valid appId`);
    }

    if (pathsByProtocol) {
      return this.#refreshAppMiddlewares(normalizedAppId, normalizeProtocolPaths(pathsByProtocol));
    }

    if (!this.tenantId) {
      throw new Error(`middleware-stack-resolver requires tenantId to load app middlewares`);
    }

    const appRecord = findOpaqueAppRecordByTenantIdAndAppIdSync({
      tenantsBase: this.tenantsBase,
      tenantId: this.tenantId,
      appId: normalizedAppId
    });
    if (!appRecord) {
      throw new Error(
        `App "${normalizedAppId}" is not present inside transport tenant "${this.tenantId}"`
      );
    }

    return this.#refreshAppMiddlewares(
      normalizedAppId,
      this.#resolveAppMiddlewarePaths(normalizedAppId, appRecord)
    );
  }

  async #resolveCoreMiddlewarePaths() {
    if (this.coreMiddlewarePaths) return this.coreMiddlewarePaths;
    return normalizeProtocolPaths({
      http: path.dirname(require.resolve(`@middleware/http/core.js`)),
      ws: path.dirname(require.resolve(`@middleware/ws/core.js`))
    });
  }

  #resolveTenantMiddlewarePaths() {
    if (this.tenantMiddlewarePaths) return this.tenantMiddlewarePaths;
    const tenantRecord = this.tenantsBase && this.tenantId
      ? findOpaqueTenantRecordByIdSync({
        tenantsBase: this.tenantsBase,
        tenantId: this.tenantId
      })
      : null;

    return {
      http: renderLayerPath(`tenantScope`, `SHARED`, `httpMiddlewares`, {
        tenant_id: this.tenantId,
        tenant_domain: tenantRecord?.tenantDomain ?? null
      }),
      ws: renderLayerPath(`tenantScope`, `SHARED`, `wsMiddlewares`, {
        tenant_id: this.tenantId,
        tenant_domain: tenantRecord?.tenantDomain ?? null
      })
    };
  }

  #resolveAppMiddlewarePaths(appId, appRecord = null) {
    if (typeof this.appMiddlewarePathsResolver === `function`) {
      return this.appMiddlewarePathsResolver({
        tenantId: this.tenantId,
        appId,
        appRecord
      });
    }

    return {
      http: renderLayerPath(`appScope`, `RESOURCES`, `httpMiddlewares`, {
        tenant_id: this.tenantId,
        app_id: appId,
        tenant_domain: appRecord?.tenantDomain ?? null,
        app_name: appRecord?.appName ?? null
      }),
      ws: renderLayerPath(`appScope`, `RESOURCES`, `wsMiddlewares`, {
        tenant_id: this.tenantId,
        app_id: appId,
        tenant_domain: appRecord?.tenantDomain ?? null,
        app_name: appRecord?.appName ?? null
      })
    };
  }

  async #refreshAppMiddlewares(appId, pathsByProtocol) {
    const loaded = await loadWatchedProtocolRegistry(pathsByProtocol, {
      previousSourcePaths: this.appMiddlewareSourcePaths[appId] ?? createProtocolSourcePathRegistry()
    });
    this.appMiddlewares[appId] = loaded.registry;
    this.appMiddlewareSourcePaths[appId] = loaded.sourcePaths;
    return loaded.registry;
  }
}

async function loadProtocolRegistry(pathsByProtocol = {}) {
  return freezeProtocolRegistry({
    http: await loadMiddlewareRegistry(pathsByProtocol?.http ?? null),
    ws: await loadMiddlewareRegistry(pathsByProtocol?.ws ?? null)
  });
}

async function loadWatchedProtocolRegistry(pathsByProtocol = {}, {
  previousSourcePaths = createProtocolSourcePathRegistry()
} = {}) {
  const httpLoad = await loadWatchedMiddlewareRegistry(pathsByProtocol?.http ?? null, {
    previousSourcePaths: previousSourcePaths.http ?? []
  });
  const wsLoad = await loadWatchedMiddlewareRegistry(pathsByProtocol?.ws ?? null, {
    previousSourcePaths: previousSourcePaths.ws ?? []
  });

  return Object.freeze({
    registry: freezeProtocolRegistry({
      http: httpLoad.registry,
      ws: wsLoad.registry
    }),
    sourcePaths: Object.freeze({
      http: Object.freeze([...httpLoad.sourcePaths]),
      ws: Object.freeze([...wsLoad.sourcePaths])
    })
  });
}

async function loadMiddlewareRegistry(directoryPath, {
  include = null
} = {}) {
  if (typeof directoryPath !== `string` || !directoryPath.trim()) return {};

  let entries = [];
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === `ENOENT`) return {};
    throw error;
  }

  const registry = {};
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sortedEntries) {
    if (!entry?.isFile?.() || !entry.name.endsWith(`.js`)) continue;

    const middlewareName = path.basename(entry.name, path.extname(entry.name));
    if (!middlewareName || middlewareName.startsWith(`_`)) continue;
    if (typeof include === `function` && !include(middlewareName, entry.name)) continue;

    const sourcePath = path.join(directoryPath, entry.name);
    try {
      registry[middlewareName] = require(sourcePath);
    } catch (error) {
      throw new Error(`Couldn't load middleware ${sourcePath}: ${error?.message ?? error}`);
    }
  }

  return registry;
}

async function loadWatchedMiddlewareRegistry(directoryPath, {
  previousSourcePaths = [],
  include = null
} = {}) {
  if (typeof directoryPath !== `string` || !directoryPath.trim()) {
    clearWeakRequireSourcePaths(previousSourcePaths);
    return {
      registry: {},
      sourcePaths: []
    };
  }

  let entries = [];
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === `ENOENT`) {
      clearWeakRequireSourcePaths(previousSourcePaths);
      return {
        registry: {},
        sourcePaths: []
      };
    }
    throw error;
  }

  const registry = {};
  const sourcePaths = [];
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sortedEntries) {
    if (!entry?.isFile?.() || !entry.name.endsWith(`.js`)) continue;

    const middlewareName = path.basename(entry.name, path.extname(entry.name));
    if (!middlewareName || middlewareName.startsWith(`_`)) continue;
    if (typeof include === `function` && !include(middlewareName, entry.name)) continue;

    const sourcePath = path.join(directoryPath, entry.name);
    try {
      registry[middlewareName] = weakRequire(sourcePath);
      sourcePaths.push(sourcePath);
    } catch (error) {
      throw new Error(`Couldn't load middleware ${sourcePath}: ${error?.message ?? error}`);
    }
  }

  clearWeakRequireSourcePaths(previousSourcePaths, sourcePaths);
  return {
    registry,
    sourcePaths
  };
}

async function loadCoreMiddlewareOrder(directoryPath) {
  if (typeof directoryPath !== `string` || !directoryPath.trim()) {
    throw new Error(`middleware-stack-resolver requires a core middlewares directory`);
  }

  const manifestPath = path.join(directoryPath, `core.js`);
  let manifest = null;
  try {
    manifest = weakRequire(manifestPath);
  } catch (error) {
    throw new Error(`Couldn't load core middleware manifest ${manifestPath}: ${error?.message ?? error}`);
  }

  if (!Array.isArray(manifest)) {
    throw new Error(`Core middleware manifest ${manifestPath} must export an array`);
  }

  const normalizedManifest = manifest
    .map((middlewareName) => String(middlewareName ?? ``).trim())
    .filter(Boolean);

  if (normalizedManifest.some((middlewareName) => !middlewareName.startsWith(`core-`))) {
    throw new Error(`Core middleware manifest ${manifestPath} may reference only core-* middleware labels`);
  }

  return Object.freeze(normalizedManifest);
}

function validateCoreMiddlewareManifest(coreMiddlewareOrder, coreMiddlewares) {
  for (const middlewareName of coreMiddlewareOrder) {
    if (!(middlewareName in coreMiddlewares)) {
      throw new Error(`Core middleware manifest references missing middleware "${middlewareName}"`);
    }
  }
}

function normalizeKey(value) {
  const normalized = String(value ?? ``).trim().toLowerCase();
  return normalized || null;
}

function createProtocolSourcePathRegistry() {
  return Object.freeze({
    http: Object.freeze([]),
    ws: Object.freeze([])
  });
}

function clearWeakRequireSourcePaths(previousSourcePaths = [], activeSourcePaths = []) {
  const active = new Set(activeSourcePaths);
  for (const sourcePath of previousSourcePaths) {
    if (!active.has(sourcePath)) {
      weakRequire.clear(sourcePath);
    }
  }
}

function freezeRegistry(registry = {}) {
  return Object.freeze({ ...registry });
}

function freezeProtocolRegistry(registry = {}) {
  return Object.freeze({
    http: freezeRegistry(registry.http ?? {}),
    ws: freezeRegistry(registry.ws ?? {})
  });
}

function freezeProtocolOrder(order = {}) {
  return Object.freeze({
    http: Object.freeze([...(order.http ?? [])]),
    ws: Object.freeze([...(order.ws ?? [])])
  });
}

function normalizeProtocol(protocol) {
  return String(protocol ?? `http`).trim().toLowerCase() === `ws`
    ? `ws`
    : `http`;
}

function normalizeProtocolPaths(paths = null) {
  if (!paths) return null;
  if (typeof paths === `string`) {
    const baseDir = path.resolve(paths);
    const parentDir = path.dirname(baseDir);
    return Object.freeze({
      http: baseDir,
      ws: path.join(parentDir, `ws`)
    });
  }

  return Object.freeze({
    http: path.resolve(String(paths.http ?? ``)),
    ws: path.resolve(String(paths.ws ?? ``))
  });
}

module.exports = MiddlewareStackResolver;
Object.freeze(module.exports);
