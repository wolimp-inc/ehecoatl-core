// adapters/inbound/project-directory-resolver/default-tenancy.js


'use strict';


const ProjectDirectoryResolverPort = require(`@/_core/_ports/inbound/project-directory-resolver-port`);
const path = require(`path`);
const runtimePackage = require(`@package.json`);
const { renderLayerPath } = require(`@/contracts/utils`);

const {
  parseTenantDirName,
  parseAppDirName,
  resolveDefaultTenantConfig,
  normalizeTenantConfig,
  normalizeAppConfig
} = require(`@/utils/tenancy/tenant-layout`);
const deepMerge = require(`@/utils/deep-merge`);

const projectRoutesAvailableProperty = `routesAvailable`;
const projectRawRoutesAvailableProperty = `rawRoutesAvailable`;
const projectCompiledRoutesProperty = `compiledRoutes`;
const projectWsRoutesAvailableProperty = `wsRoutesAvailable`;
const projectRawWsRoutesAvailableProperty = `rawWsRoutesAvailable`;
const projectCompiledWsRoutesProperty = `compiledWsRoutes`;
const configRelativePath = `config.json`;
const appConfigDirName = `config`;
const tenantSharedConfigRelativePath = path.join(`shared`, appConfigDirName);
const legacyAppConfigRelativePath = `config.json`;
const configErrorRelativePath = `config.validation.error.json`;
const appEntrypointRelativePath = `index.js`;
const tenantActionsFolderName = `actions`;
const tenantAssetsFolderName = `assets`;
const projectRoutesFolderName = `routes`;
const tenantHttpRoutesFolderName = `http`;
const projectWsRoutesFolderName = `ws`;
const appHttpActionsRelativePath = path.join(`app`, `http`, `actions`);
const appWsActionsRelativePath = path.join(`app`, `ws`, `actions`);
const appHttpMiddlewaresRelativePath = path.join(`app`, `http`, `middlewares`);
const appWsMiddlewaresRelativePath = path.join(`app`, `ws`, `middlewares`);

/**
 * @param {{
 * config: typeof import('@/config/default.config').adapters.projectDirectoryResolver,
 * storage: import('@/_core/services/storage-service')
 * routeMatcherCompiler?: import('@/_core/compilers/project-route-matcher-compiler')
 * }} param0
 */
ProjectDirectoryResolverPort.scanProjectsAdapter = async function ({
  config,
  storage,
  routeMatcherCompiler
}) {
  const scanRoots = resolveProjectScanRoots(config);
  const expectedEhecoatlVersion = resolveExpectedEhecoatlVersion(config);
  const nextDomainAliases = new Map();
  const nextAppAliases = new Map();
  const nextDomains = new Map();
  const nextHosts = new Map();
  const invalidHosts = [];
  const previousRegistry = config.registry ?? null;
  const previousHostSignatures = buildSignatureMap(previousRegistry?.hosts);
  const pendingTenants = [];
  const scopeErrors = new Map();

  for (const scanRoot of scanRoots) {
    const rootEntries = await safeListEntries(storage, scanRoot.path);
    for (const rootEntry of rootEntries) {
      const entryPath = path.join(scanRoot.path, rootEntry.name);
      if (!rootEntry.isDirectory?.()) continue;

      const tenantFolder = parseTenantDirName(rootEntry.name);
      if (!tenantFolder) {
        const reason = buildConfigValidationError({
          host: rootEntry.name,
          rootFolder: entryPath,
          appConfigPath: path.join(entryPath, configRelativePath),
          scope: scanRoot.legacy ? `tenant` : `project`,
          error: new Error(`Project folder "${rootEntry.name}" must match project_<domain>; legacy tenant_<domain> remains accepted in the legacy tenants root`)
        });
        invalidHosts.push(reason);
        rememberScopeError(scopeErrors, `tenant:${entryPath}`, reason);
        continue;
      }

      const tenantConfigPath = path.join(entryPath, configRelativePath);
      try {
        const tenantConfigContent = await storage.readFile(tenantConfigPath, `utf-8`);
        const tenantConfig = normalizeTenantConfig(JSON.parse(tenantConfigContent), {
          defaultAppName: config.defaultAppName ?? `www`,
          expectedTenantDomain: tenantFolder.tenantDomain,
          expectedEhecoatlVersion
        });
        await clearConfigValidationError(storage, entryPath);
        pendingTenants.push({
          projectId: tenantConfig.projectId,
          projectDomain: tenantConfig.projectDomain,
          projectRoot: entryPath,
          tenantId: tenantConfig.tenantId,
          tenantDomain: tenantConfig.tenantDomain,
          tenantAliases: tenantConfig.alias ?? [],
          tenantRoot: entryPath,
          tenantConfigPath,
          tenantConfig,
          legacyTenantLayout: scanRoot.legacy || tenantFolder.legacyTenantLayout,
          apps: []
        });
      } catch (error) {
        const reason = buildConfigValidationError({
          host: rootEntry.name,
          rootFolder: entryPath,
          appConfigPath: tenantConfigPath,
          scope: scanRoot.legacy ? `tenant` : `project`,
          error
        });
        invalidHosts.push(reason);
        await writeConfigValidationError(storage, entryPath, reason);
      }
    }
  }

  for (const tenantRecord of pendingTenants) {
    const appEntries = await storage.listEntries(tenantRecord.tenantRoot) ?? [];
    const pendingApps = [];
    for (const appEntry of appEntries) {
      if (!appEntry.isDirectory?.()) continue;

      const appPath = path.join(tenantRecord.tenantRoot, appEntry.name);
      const appFolder = parseAppDirName(appEntry.name);
      if (!appFolder) {
        continue;
      }

      const appConfigPath = path.join(appPath, appConfigDirName);
      try {
        const mergedAppConfig = await resolveMergedAppConfig({
          storage,
          tenantRoot: tenantRecord.tenantRoot,
          appRoot: appPath
        });
        const normalizedAppIdentity = normalizeAppConfig(mergedAppConfig.config, {
          expectedAppName: appFolder.appName,
          expectedEhecoatlVersion
        });
        if (!isAppEnabled(mergedAppConfig.config)) {
          await clearConfigValidationError(storage, appPath);
          continue;
        }

        const httpRoutes = await loadMergedRoutesAvailable({
          storage,
          appPath,
          inlineRoutesAvailable: mergedAppConfig.config[projectRoutesAvailableProperty]
        });
        const wsRoutes = await loadMergedWsRoutesAvailable({
          storage,
          appPath
        });
        const resolvedRoutes = await routeMatcherCompiler?.compileRoutes?.(httpRoutes.routesAvailable) ?? {
          routesAvailable: httpRoutes.routesAvailable,
          compiledRoutes: []
        };
        const resolvedWsRoutes = await routeMatcherCompiler?.compileRoutes?.(wsRoutes.routesAvailable) ?? {
          routesAvailable: wsRoutes.routesAvailable,
          compiledRoutes: []
        };

        pendingApps.push({
          tenantId: tenantRecord.tenantId,
          tenantDomain: tenantRecord.tenantDomain,
          tenantAliases: tenantRecord.tenantAliases,
          tenantRoot: tenantRecord.tenantRoot,
          tenantConfig: tenantRecord.tenantConfig,
          appId: normalizedAppIdentity.appId,
          appName: normalizedAppIdentity.appName,
          ehecoatlVersion: normalizedAppIdentity.ehecoatlVersion ?? null,
          appAliases: normalizedAppIdentity.alias ?? [],
          appPath,
          appConfigPath,
          appConfig: mergedAppConfig.config,
          resolvedRoutes,
          resolvedWsRoutes,
          appConfigMtimeMs: mergedAppConfig.mtimeMs,
          routeFilesMtimeMs: httpRoutes.mtimeMs,
          wsRouteFilesMtimeMs: wsRoutes.mtimeMs,
          tenantEntrypointMtimeMs: await resolveFileMtimeMs(
            storage,
            path.join(appPath, appEntrypointRelativePath)
          )
        });
      } catch (error) {
        const reason = buildConfigValidationError({
          host: `${appEntry.name}.${tenantRecord.tenantDomain}`,
          rootFolder: appPath,
          appConfigPath,
          scope: `app`,
          error
        });
        invalidHosts.push(reason);
        await writeConfigValidationError(storage, appPath, reason);
      }
    }

    const duplicateAppNames = findDuplicates(pendingApps, `appName`);
    for (const appRecord of pendingApps) {
      if (duplicateAppNames.has(appRecord.appName)) {
        const reason = buildConfigValidationError({
          host: `${appRecord.appName}.${tenantRecord.tenantDomain}`,
          rootFolder: appRecord.appPath,
          appConfigPath: appRecord.appConfigPath,
          scope: `app`,
          error: new Error(`Duplicate appName "${appRecord.appName}" is not allowed within tenant "${tenantRecord.tenantDomain}"`)
        });
        invalidHosts.push(reason);
        rememberScopeError(scopeErrors, `app:${appRecord.appPath}`, reason);
        await writeConfigValidationError(storage, appRecord.appPath, reason);
        continue;
      }
      tenantRecord.apps.push(appRecord);
    }
  }

  const conflictingScopes = collectConflictingScopes(pendingTenants);
  for (const conflict of conflictingScopes) {
    invalidHosts.push(conflict.reason);
    rememberScopeError(scopeErrors, conflict.scopeKey, conflict.reason);
  }

  for (const tenantRecord of pendingTenants) {
    const tenantScopeKey = `tenant:${tenantRecord.tenantRoot}`;
    if (scopeErrors.has(tenantScopeKey)) {
      await writeConfigValidationError(storage, tenantRecord.tenantRoot, scopeErrors.get(tenantScopeKey));
      continue;
    }

    const activeApps = tenantRecord.apps.filter((appRecord) => !scopeErrors.has(`app:${appRecord.appPath}`));
    const activeAppNames = [];
    for (const appRecord of activeApps) {
      const host = `${appRecord.appName}.${tenantRecord.tenantDomain}`.toLowerCase();
        const routeDataObject = {
          host,
          projectId: appRecord.tenantId,
          projectDomain: tenantRecord.tenantDomain,
          projectRoot: tenantRecord.tenantRoot,
          tenantId: appRecord.tenantId,
          tenantDomain: tenantRecord.tenantDomain,
          appId: appRecord.appId,
        domain: tenantRecord.tenantDomain,
        appName: appRecord.appName,
        alias: Object.freeze([...(appRecord.appAliases ?? [])]),
        tenantRootFolder: tenantRecord.tenantRoot,
        domainRoutingMode: tenantRecord.tenantConfig.appRouting.mode,
        domainDefaultAppName: tenantRecord.tenantConfig.appRouting.defaultAppName,
        rootFolder: appRecord.appPath,
        ...resolveTenantSourceFolders(appRecord.appPath, {
          tenantId: appRecord.tenantId,
          tenantDomain: tenantRecord.tenantDomain,
          tenantRoot: tenantRecord.tenantRoot
        }),
        appConfigMtimeMs: appRecord.appConfigMtimeMs,
        routeFilesMtimeMs: appRecord.routeFilesMtimeMs,
        wsRouteFilesMtimeMs: appRecord.wsRouteFilesMtimeMs,
        tenantEntrypointMtimeMs: appRecord.tenantEntrypointMtimeMs,
        ...appRecord.appConfig,
        [projectRawRoutesAvailableProperty]: appRecord.resolvedRoutes.routesAvailable ?? null,
        [projectRoutesAvailableProperty]: appRecord.resolvedRoutes.routesAvailable ?? null,
        [projectCompiledRoutesProperty]: appRecord.resolvedRoutes.compiledRoutes ?? [],
        [projectRawWsRoutesAvailableProperty]: appRecord.resolvedWsRoutes.routesAvailable ?? null,
        [projectWsRoutesAvailableProperty]: appRecord.resolvedWsRoutes.routesAvailable ?? null,
        [projectCompiledWsRoutesProperty]: appRecord.resolvedWsRoutes.compiledRoutes ?? []
      };

      nextHosts.set(host, routeDataObject);
      for (const appAlias of appRecord.appAliases ?? []) {
        nextAppAliases.set(appAlias, Object.freeze({
          domain: appAlias,
          tenantId: appRecord.tenantId,
          tenantDomain: tenantRecord.tenantDomain,
          appId: appRecord.appId,
          appName: appRecord.appName
        }));
      }
      activeAppNames.push(appRecord.appName);
      await clearConfigValidationError(storage, appRecord.appPath);
    }

    for (const tenantAlias of tenantRecord.tenantAliases ?? []) {
      nextDomainAliases.set(tenantAlias, Object.freeze({
        enabled: true,
        point: tenantRecord.tenantDomain
      }));
    }

    nextDomains.set(tenantRecord.tenantDomain, Object.freeze({
      projectId: tenantRecord.tenantId,
      projectDomain: tenantRecord.tenantDomain,
      projectRoot: tenantRecord.tenantRoot,
      tenantId: tenantRecord.tenantId,
      domain: tenantRecord.tenantDomain,
      ehecoatlVersion: tenantRecord.tenantConfig.ehecoatlVersion ?? null,
      rootFolder: tenantRecord.tenantRoot,
      certbotEmail: tenantRecord.tenantConfig.certbotEmail ?? null,
      appRouting: Object.freeze({
        mode: tenantRecord.tenantConfig.appRouting.mode,
        defaultAppName: tenantRecord.tenantConfig.appRouting.defaultAppName
      }),
      appNames: Object.freeze(activeAppNames.sort()),
      aliases: Object.freeze([...(tenantRecord.tenantAliases ?? [])])
    }));
    await clearConfigValidationError(storage, tenantRecord.tenantRoot);
  }

  const nextHostSignatures = buildSignatureMap(nextHosts);
  const initialScan = previousHostSignatures.size === 0;
  const registry = createRegistry({
    hosts: nextHosts,
    domains: nextDomains,
    domainAliases: nextDomainAliases,
    appAliases: nextAppAliases,
    invalidHosts
  });

  return {
    registry,
    previousRegistry,
    initialScan,
    activeProjects: [...registry.domains.values()].map((tenantRecord) => ({
      projectId: tenantRecord.projectId ?? tenantRecord.tenantId,
      projectDomain: tenantRecord.projectDomain ?? tenantRecord.domain,
      projectRoot: tenantRecord.projectRoot ?? tenantRecord.rootFolder,
      tenantId: tenantRecord.tenantId,
      tenantDomain: tenantRecord.domain,
      tenantRoot: tenantRecord.rootFolder
    })),
    activeTenants: [...registry.domains.values()].map((tenantRecord) => ({
      projectId: tenantRecord.projectId ?? tenantRecord.tenantId,
      projectDomain: tenantRecord.projectDomain ?? tenantRecord.domain,
      projectRoot: tenantRecord.projectRoot ?? tenantRecord.rootFolder,
      tenantId: tenantRecord.tenantId,
      tenantDomain: tenantRecord.domain,
      tenantRoot: tenantRecord.rootFolder
    })),
    activeHosts: [...registry.hosts.values()].map((routeDataObject) => ({
      host: routeDataObject.host,
      projectId: routeDataObject.projectId ?? routeDataObject.tenantId,
      projectDomain: routeDataObject.projectDomain ?? routeDataObject.tenantDomain,
      projectRoot: routeDataObject.projectRoot ?? routeDataObject.tenantRootFolder ?? null,
      tenantId: routeDataObject.tenantId,
      tenantDomain: routeDataObject.tenantDomain,
      appId: routeDataObject.appId,
      domain: routeDataObject.domain,
      appName: routeDataObject.appName,
      rootFolder: routeDataObject.rootFolder
    })),
    changedHosts: initialScan
      ? []
      : [...nextHostSignatures.entries()]
        .filter(([host, signature]) => previousHostSignatures.get(host) !== signature)
        .map(([host]) => host),
    removedHosts: initialScan
      ? []
      : [...previousHostSignatures.keys()]
        .filter((host) => !nextHostSignatures.has(host)),
    invalidHosts
  };
};

function resolveExpectedEhecoatlVersion(config = {}) {
  const configuredVersion = String(config?.ehecoatlVersion ?? config?.expectedEhecoatlVersion ?? ``).trim();
  if (configuredVersion) return configuredVersion;

  const packageVersion = String(runtimePackage?.version ?? ``).trim();
  if (!packageVersion || packageVersion === `{{version}}`) return null;
  return packageVersion;
}

function resolveProjectScanRoots(config = {}) {
  const roots = [];
  const seen = new Set();
  const addRoot = (candidate, legacy = false) => {
    const normalized = String(candidate ?? ``).trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    roots.push(Object.freeze({ path: normalized, legacy }));
  };

  addRoot(config.projectsPath ?? config.projectPath ?? `/var/opt/ehecoatl/projects`, false);
  addRoot(config.legacyTenantsPath ?? config.tenantsPath, true);
  return roots;
}

async function safeListEntries(storage, targetPath) {
  try {
    return await storage.listEntries(targetPath) ?? [];
  } catch (error) {
    if (error?.code === `ENOENT`) return [];
    throw error;
  }
}

function findDuplicates(entries, propertyName) {
  const counts = new Map();
  for (const entry of entries) {
    const key = String(entry?.[propertyName] ?? ``).trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([key]) => key)
  );
}

function buildConfigValidationError({
  host,
  rootFolder,
  appConfigPath,
  error,
  scope
}) {
  return {
    host,
    rootFolder,
    scope,
    status: `invalid_config`,
    generatedAt: new Date().toISOString(),
    appConfigPath,
    error: {
      name: error?.name ?? `Error`,
      code: error?.code ?? null,
      message: error?.message ?? String(error)
    }
  };
}

async function resolveMergedAppConfig({
  storage,
  tenantRoot,
  appRoot
}) {
  const sharedConfigDir = path.join(tenantRoot, tenantSharedConfigRelativePath);
  const appConfigDir = path.join(appRoot, appConfigDirName);
  const legacyAppConfigPath = path.join(appRoot, legacyAppConfigRelativePath);

  const sharedLayer = await readMergedJsonFolder({
    storage,
    folderPath: sharedConfigDir
  });
  const appLayer = await readMergedJsonFolder({
    storage,
    folderPath: appConfigDir
  });
  const legacyAppConfig = await safeReadJsonFile(storage, legacyAppConfigPath);

  let mergedConfig = deepMerge({}, sharedLayer.config);
  if (isPlainObject(legacyAppConfig)) {
    mergedConfig = deepMerge(mergedConfig, legacyAppConfig);
  }
  mergedConfig = deepMerge(mergedConfig, appLayer.config);

  return Object.freeze({
    config: Object.freeze(mergedConfig),
    sharedConfigDir,
    appConfigDir,
    legacyAppConfigPath,
    hasConfigFiles: sharedLayer.hasFiles || appLayer.hasFiles || Boolean(legacyAppConfig),
    mtimeMs: maxFiniteNumber([
      sharedLayer.mtimeMs,
      appLayer.mtimeMs,
      await resolveFileMtimeMs(storage, legacyAppConfigPath)
    ])
  });
}

async function readMergedJsonFolder({
  storage,
  folderPath
}) {
  if (typeof storage?.listEntries !== `function`) {
    return Object.freeze({
      config: Object.freeze({}),
      hasFiles: false,
      mtimeMs: null
    });
  }

  let entries = [];
  try {
    entries = await storage.listEntries(folderPath) ?? [];
  } catch (error) {
    if (error?.code === `ENOENT`) {
      return Object.freeze({
        config: Object.freeze({}),
        hasFiles: false,
        mtimeMs: null
      });
    }
    throw error;
  }

  const merged = {};
  let hasFiles = false;
  const mtimes = [];
  const sortedEntries = [...entries].sort((a, b) => String(a?.name ?? ``).localeCompare(String(b?.name ?? ``)));
  for (const entry of sortedEntries) {
    if (!entry?.isFile?.()) continue;
    if (!String(entry.name ?? ``).toLowerCase().endsWith(`.json`)) continue;
    hasFiles = true;
    const filePath = path.join(folderPath, entry.name);
    const parsed = JSON.parse(await storage.readFile(filePath, `utf-8`));
    if (!isPlainObject(parsed)) {
      throw new Error(`Config file ${filePath} must contain a JSON object`);
    }
    Object.assign(merged, deepMerge(merged, parsed));
    mtimes.push(await resolveFileMtimeMs(storage, filePath));
  }

  return Object.freeze({
    config: Object.freeze(merged),
    hasFiles,
    mtimeMs: maxFiniteNumber(mtimes)
  });
}

async function safeReadJsonFile(storage, filePath) {
  if (typeof storage?.readFile !== `function`) return null;
  try {
    return JSON.parse(await storage.readFile(filePath, `utf-8`));
  } catch (error) {
    if (error?.code === `ENOENT`) return null;
    throw error;
  }
}

async function writeConfigValidationError(storage, rootFolder, details) {
  if (!storage || typeof storage.writeFile !== `function`) return;
  const errorFilePath = path.join(rootFolder, configErrorRelativePath);
  const parentFolder = path.dirname(errorFilePath);
  if (typeof storage.createFolder === `function`) {
    await storage.createFolder(parentFolder).catch(() => { });
  }
  await storage.writeFile(
    errorFilePath,
    JSON.stringify(details, null, 2),
    `utf8`
  ).catch(() => { });
}

async function clearConfigValidationError(storage, rootFolder) {
  if (!storage || typeof storage.deleteFile !== `function`) return;
  const errorFilePath = path.join(rootFolder, configErrorRelativePath);
  await storage.deleteFile(errorFilePath).catch(() => { });
}

function rememberScopeError(scopeErrors, scopeKey, reason) {
  if (!scopeKey || !reason || scopeErrors.has(scopeKey)) return;
  scopeErrors.set(scopeKey, reason);
}

function collectConflictingScopes(pendingTenants = []) {
  const domainClaims = new Map();

  for (const tenantRecord of pendingTenants) {
    registerDomainClaim(domainClaims, {
      domain: tenantRecord.tenantDomain,
      scopeKey: `tenant:${tenantRecord.tenantRoot}`,
      scope: `tenant`,
      host: tenantRecord.tenantDomain,
      rootFolder: tenantRecord.tenantRoot,
      appConfigPath: tenantRecord.tenantConfigPath,
      conflictLabel: `tenant primary domain`
    });

    for (const tenantAlias of tenantRecord.tenantAliases ?? []) {
      registerDomainClaim(domainClaims, {
        domain: tenantAlias,
        scopeKey: `tenant:${tenantRecord.tenantRoot}`,
        scope: `tenant`,
        host: tenantAlias,
        rootFolder: tenantRecord.tenantRoot,
        appConfigPath: tenantRecord.tenantConfigPath,
        conflictLabel: `tenant alias domain`
      });
    }

    for (const appRecord of tenantRecord.apps ?? []) {
      registerDomainClaim(domainClaims, {
        domain: `${appRecord.appName}.${tenantRecord.tenantDomain}`,
        scopeKey: `app:${appRecord.appPath}`,
        scope: `app`,
        host: `${appRecord.appName}.${tenantRecord.tenantDomain}`,
        rootFolder: appRecord.appPath,
        appConfigPath: appRecord.appConfigPath,
        conflictLabel: `generated app hostname`
      });

      for (const tenantAlias of tenantRecord.tenantAliases ?? []) {
        registerDomainClaim(domainClaims, {
          domain: `${appRecord.appName}.${tenantAlias}`,
          scopeKey: `app:${appRecord.appPath}`,
          scope: `app`,
          host: `${appRecord.appName}.${tenantAlias}`,
          rootFolder: appRecord.appPath,
          appConfigPath: appRecord.appConfigPath,
          conflictLabel: `generated app hostname`
        });
      }

      for (const appAlias of appRecord.appAliases ?? []) {
        registerDomainClaim(domainClaims, {
          domain: appAlias,
          scopeKey: `app:${appRecord.appPath}`,
          scope: `app`,
          host: appAlias,
          rootFolder: appRecord.appPath,
          appConfigPath: appRecord.appConfigPath,
          conflictLabel: `app alias domain`
        });
      }
    }
  }

  const conflicts = [];
  for (const [domain, claims] of domainClaims.entries()) {
    if (claims.length < 2) continue;
    const labels = [...new Set(claims.map((claim) => claim.conflictLabel))].join(`, `);
    for (const claim of claims) {
      conflicts.push({
        scopeKey: claim.scopeKey,
        reason: buildConfigValidationError({
          host: claim.host,
          rootFolder: claim.rootFolder,
          appConfigPath: claim.appConfigPath,
          scope: claim.scope,
          error: new Error(`Domain "${domain}" conflicts with another active ${labels}`)
        })
      });
    }
  }

  return conflicts;
}

function registerDomainClaim(domainClaims, claim) {
  const domain = String(claim?.domain ?? ``).trim().toLowerCase();
  if (!domain) return;
  const claims = domainClaims.get(domain) ?? [];
  claims.push(Object.freeze({
    ...claim,
    domain
  }));
  domainClaims.set(domain, claims);
}

function buildSignatureMap(hostMap) {
  if (!(hostMap instanceof Map)) return new Map();
  return new Map(
    [...hostMap.entries()].map(([host, routeDataObject]) => [
      host,
      stableSerialize(toComparableRouteData(routeDataObject))
    ])
  );
}

function toComparableRouteData(routeDataObject) {
  if (!routeDataObject || typeof routeDataObject !== `object`) return routeDataObject;

  const comparable = {};
  for (const [key, value] of Object.entries(routeDataObject)) {
    if (key === projectCompiledRoutesProperty || key === `appEnabled`) continue;
    comparable[key] = value;
  }
  return comparable;
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(`,`)}]`;
  }
  if (!value || typeof value !== `object`) {
    return JSON.stringify(value);
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(`,`)}}`;
}

async function resolveFileMtimeMs(storage, filePath) {
  if (typeof storage?.fileStat !== `function`) return null;

  try {
    const stats = await storage.fileStat(filePath);
    if (!stats || typeof stats.mtimeMs !== `number`) return null;
    return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}

function maxFiniteNumber(values = []) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) return null;
  return Math.max(...finiteValues);
}

function resolveTenantSourceFolders(rootFolder, {
  tenantId = null,
  tenantDomain = null,
  tenantRoot = null
} = {}) {
  const httpActionsRootFolder = path.join(rootFolder, appHttpActionsRelativePath);
  const routesRootFolder = path.join(rootFolder, projectRoutesFolderName);
  return {
    actionsRootFolder: httpActionsRootFolder,
    httpActionsRootFolder,
    wsActionsRootFolder: path.join(rootFolder, appWsActionsRelativePath),
    assetsRootFolder: path.join(rootFolder, tenantAssetsFolderName),
    httpSharedActionsRootFolder: renderLayerPath(`projectScope`, `SHARED`, `httpActions`, {
      tenant_id: tenantId,
      tenant_domain: tenantDomain
    }) ?? (tenantRoot ? path.join(tenantRoot, `shared`, `app`, `http`, `actions`) : null),
    wsSharedActionsRootFolder: renderLayerPath(`projectScope`, `SHARED`, `wsActions`, {
      tenant_id: tenantId,
      tenant_domain: tenantDomain
    }) ?? (tenantRoot ? path.join(tenantRoot, `shared`, `app`, `ws`, `actions`) : null),
    assetsSharedRootFolder: renderLayerPath(`projectScope`, `SHARED`, `assets`, {
      tenant_id: tenantId,
      tenant_domain: tenantDomain
    }) ?? (tenantRoot ? path.join(tenantRoot, `shared`, `assets`) : null),
    httpMiddlewaresRootFolder: path.join(rootFolder, appHttpMiddlewaresRelativePath),
    wsMiddlewaresRootFolder: path.join(rootFolder, appWsMiddlewaresRelativePath),
    routesRootFolder,
    httpRoutesRootFolder: path.join(routesRootFolder, tenantHttpRoutesFolderName),
    wsRoutesRootFolder: path.join(routesRootFolder, projectWsRoutesFolderName)
  };
}

async function loadMergedRoutesAvailable({
  storage,
  appPath,
  inlineRoutesAvailable
}) {
  const mergedRoutes = isPlainObject(inlineRoutesAvailable)
    ? { ...inlineRoutesAvailable }
    : {};
  const mtimes = [];
  const routesFolderPath = path.join(appPath, projectRoutesFolderName);
  const httpRoutesFolderPath = path.join(routesFolderPath, tenantHttpRoutesFolderName);
  if (await folderExists(storage, httpRoutesFolderPath)) {
    await mergeRoutesFolderInto({
      storage,
      folderPath: httpRoutesFolderPath,
      mergedRoutes,
      mtimes
    });
  } else {
    await mergeRoutesFolderInto({
      storage,
      folderPath: routesFolderPath,
      mergedRoutes,
      mtimes,
      skipDirectoryNames: [projectWsRoutesFolderName]
    });
  }
  return Object.freeze({
    routesAvailable: Object.keys(mergedRoutes).length > 0 ? mergedRoutes : null,
    mtimeMs: maxFiniteNumber(mtimes)
  });
}

async function loadMergedWsRoutesAvailable({
  storage,
  appPath
}) {
  const routesFolderPath = path.join(appPath, projectRoutesFolderName);
  const wsRoutesFolderPath = path.join(routesFolderPath, projectWsRoutesFolderName);
  if (!await folderExists(storage, wsRoutesFolderPath)) {
    return Object.freeze({
      routesAvailable: null,
      mtimeMs: null
    });
  }

  const mergedRoutes = {};
  const mtimes = [];
  await mergeWsRoutesFolderInto({
    storage,
    folderPath: wsRoutesFolderPath,
    mergedRoutes,
    mtimes
  });
  return Object.freeze({
    routesAvailable: Object.keys(mergedRoutes).length > 0 ? mergedRoutes : null,
    mtimeMs: maxFiniteNumber(mtimes)
  });
}

async function mergeRoutesFolderInto({
  storage,
  folderPath,
  mergedRoutes,
  mtimes,
  skipDirectoryNames = []
}) {
  if (typeof storage?.listEntries !== `function`) return;

  let entries = [];
  try {
    entries = await storage.listEntries(folderPath) ?? [];
  } catch (error) {
    if (error?.code === `ENOENT`) return;
    throw error;
  }

  const sortedEntries = [...entries].sort((a, b) => String(a?.name ?? ``).localeCompare(String(b?.name ?? ``)));
  for (const entry of sortedEntries) {
    if (!entry?.name) continue;
    const entryPath = path.join(folderPath, entry.name);
    if (entry.isDirectory?.()) {
      if (skipDirectoryNames.includes(String(entry.name ?? ``).trim().toLowerCase())) {
        continue;
      }
      await mergeRoutesFolderInto({
        storage,
        folderPath: entryPath,
        mergedRoutes,
        mtimes,
        skipDirectoryNames
      });
      continue;
    }
    if (!entry.isFile?.() || !entry.name.endsWith(`.json`)) continue;

    const fileContent = await storage.readFile(entryPath, `utf-8`);
    const parsed = JSON.parse(fileContent);
    const routesFragment = normalizeRoutesFragment(parsed, entryPath);
    Object.assign(mergedRoutes, routesFragment);
    mtimes?.push(await resolveFileMtimeMs(storage, entryPath));
  }
}

async function mergeWsRoutesFolderInto({
  storage,
  folderPath,
  mergedRoutes,
  mtimes
}) {
  if (typeof storage?.listEntries !== `function`) return;

  let entries = [];
  try {
    entries = await storage.listEntries(folderPath) ?? [];
  } catch (error) {
    if (error?.code === `ENOENT`) return;
    throw error;
  }

  const sortedEntries = [...entries].sort((a, b) => String(a?.name ?? ``).localeCompare(String(b?.name ?? ``)));
  for (const entry of sortedEntries) {
    if (!entry?.name) continue;
    const entryPath = path.join(folderPath, entry.name);
    if (entry.isDirectory?.()) {
      await mergeWsRoutesFolderInto({
        storage,
        folderPath: entryPath,
        mergedRoutes,
        mtimes
      });
      continue;
    }
    if (!entry.isFile?.() || !entry.name.endsWith(`.json`)) continue;

    const fileContent = await storage.readFile(entryPath, `utf-8`);
    const parsed = JSON.parse(fileContent);
    const routesFragment = normalizeWsRoutesFragment(parsed, entryPath);
    Object.assign(mergedRoutes, routesFragment);
    mtimes?.push(await resolveFileMtimeMs(storage, entryPath));
  }
}

function normalizeRoutesFragment(parsed, sourcePath) {
  if (!isPlainObject(parsed)) {
    throw new Error(`Route file ${sourcePath} must contain a JSON object`);
  }

  const fragment = isPlainObject(parsed.routesAvailable)
    ? parsed.routesAvailable
    : parsed;

  if (!isPlainObject(fragment)) {
    throw new Error(`Route file ${sourcePath} must resolve to a routes object`);
  }

  return fragment;
}

function normalizeWsRoutesFragment(parsed, sourcePath) {
  const fragment = normalizeRoutesFragment(parsed, sourcePath);
  const normalized = {};
  flattenWsRoutes(fragment, ``, normalized, sourcePath);
  return normalized;
}

function flattenWsRoutes(routeMap, prefixPath, flattenedRoutes, sourcePath) {
  if (!isPlainObject(routeMap)) return;

  for (const [routePath, routeValue] of Object.entries(routeMap)) {
    if (!String(routePath ?? ``).startsWith(`/`)) continue;
    const fullPath = normalizeRoutePath(prefixPath, routePath);

    if (isPrefixGroup(routeValue)) {
      flattenWsRoutes(routeValue, fullPath, flattenedRoutes, sourcePath);
      continue;
    }

    flattenedRoutes[fullPath] = normalizeWsRouteDefinition(routeValue, fullPath, sourcePath);
  }
}

function normalizeWsRouteDefinition(routeValue, routePath, sourcePath) {
  if (!isPlainObject(routeValue)) {
    throw new Error(`WS route "${routePath}" in ${sourcePath} must resolve to a JSON object`);
  }

  return {
    ...routeValue,
    middleware: routeValue.middleware ?? routeValue.middlewares ?? null,
    upgrade: {
      enabled: true,
      transport: [`websocket`],
      authScope: routeValue.authScope ?? null,
      wsActionsAvailable: routeValue.wsActionsAvailable ?? routeValue.actionsAvailable ?? null,
      room: routeValue.room ?? null,
      description: routeValue.description ?? null
    }
  };
}

function normalizeRoutePath(prefixPath, routePath) {
  const prefix = String(prefixPath ?? ``).trim();
  const route = String(routePath ?? ``).trim();
  const combined = `${prefix}${route}`.replace(/\/+/g, `/`);
  if (!combined) return `/`;
  return combined.startsWith(`/`) ? combined : `/${combined}`;
}

function isPrefixGroup(routeValue) {
  if (!isPlainObject(routeValue)) return false;
  return Object.keys(routeValue).some((childKey) => String(childKey ?? ``).startsWith(`/`));
}

function isPlainObject(value) {
  return value != null && typeof value === `object` && !Array.isArray(value);
}

async function folderExists(storage, folderPath) {
  if (typeof storage?.listEntries !== `function`) return false;
  try {
    await storage.listEntries(folderPath);
    return true;
  } catch (error) {
    if (error?.code === `ENOENT`) return false;
    throw error;
  }
}

function isAppEnabled(appConfig) {
  if (!appConfig || typeof appConfig !== `object`) return true;
  return appConfig.appEnabled !== false;
}

function createRegistry({
  hosts,
  domains,
  domainAliases,
  appAliases,
  invalidHosts
}) {
  return Object.freeze({
    hosts: new Map(hosts ?? []),
    domains: new Map(domains ?? []),
    domainAliases: new Map(domainAliases ?? []),
    appAliases: new Map(appAliases ?? []),
    invalidHosts: Object.freeze([...(invalidHosts ?? [])])
  });
}

module.exports = ProjectDirectoryResolverPort;
Object.freeze(ProjectDirectoryResolverPort);
