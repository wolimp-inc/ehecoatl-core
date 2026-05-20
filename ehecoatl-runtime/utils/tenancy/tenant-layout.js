'use strict';

const crypto = require(`node:crypto`);
const fs = require(`node:fs`);
const path = require(`node:path`);
const deepMerge = require(`../deep-merge`);

const { buildIsolatedRuntimeLabel } = require(`../process-labels`);
const { getRenderedProcessIdentity } = require(`../../contracts/utils`);

const TENANT_OPAQUE_ID_LENGTH = 12;
const APP_OPAQUE_ID_LENGTH = 6;
const OPAQUE_ID_LENGTH = TENANT_OPAQUE_ID_LENGTH;
const OPAQUE_ID_ALPHABET = `abcdefghijklmnopqrstuvwxyz0123456789`;
const projectDirPrefix = `project_`;
const legacyTenantDirPrefix = `tenant_`;
const tenantDirPrefix = projectDirPrefix;
const appDirPrefix = `app_`;
const tenantOpaqueIdPattern = new RegExp(`^[a-z0-9]{${TENANT_OPAQUE_ID_LENGTH}}$`);
const appOpaqueIdPattern = new RegExp(`^[a-z0-9]{${APP_OPAQUE_ID_LENGTH}}$`);
const opaqueIdPattern = tenantOpaqueIdPattern;
const tenantDirSuffixPattern = /^[a-z0-9.-]+$/;
const appDirSuffixPattern = /^[a-z0-9._-]+$/;
const tenantDirPattern = new RegExp(`^(?:${projectDirPrefix}|${legacyTenantDirPrefix})(.+)$`);
const appDirPattern = new RegExp(`^${appDirPrefix}(.+)$`);
const legacyOpaqueTenantDirPattern = new RegExp(`^${legacyTenantDirPrefix}([a-z0-9]{${TENANT_OPAQUE_ID_LENGTH}})$`);
const legacyOpaqueAppDirPattern = new RegExp(`^${appDirPrefix}([a-z0-9]{${APP_OPAQUE_ID_LENGTH}})$`);
const appConfigDirName = `config`;
const tenantSharedConfigRelativePath = path.join(`shared`, appConfigDirName);
const legacyAppConfigRelativePath = `config.json`;

function normalizeTenantDomain(domain) {
  return String(domain ?? ``).trim().toLowerCase();
}

function normalizeAppName(appName) {
  return String(appName ?? ``).trim().toLowerCase();
}

function normalizeOpaqueId(id) {
  return String(id ?? ``).trim().toLowerCase();
}

function normalizeEhecoatlVersion(version) {
  return String(version ?? ``).trim();
}

function getEhecoatlVersionCompatibilityKey(version) {
  const normalizedVersion = normalizeEhecoatlVersion(version);
  if (!normalizedVersion) return null;

  const parts = normalizedVersion.split(`.`);
  if (parts.length < 2 || !parts[0] || !parts[1]) return normalizedVersion;
  return `${parts[0]}.${parts[1]}`;
}

function validateEhecoatlVersion(rawConfig, {
  expectedEhecoatlVersion = null,
  configLabel = `Config`
} = {}) {
  const expectedVersion = normalizeEhecoatlVersion(expectedEhecoatlVersion);
  if (!expectedVersion) return null;

  const configVersion = normalizeEhecoatlVersion(rawConfig?.ehecoatlVersion);
  if (!configVersion) {
    const error = new Error(`${configLabel} is missing ehecoatlVersion for runtime version ${expectedVersion}`);
    error.code = `EHECOATL_VERSION_MISSING`;
    throw error;
  }

  const expectedCompatibilityKey = getEhecoatlVersionCompatibilityKey(expectedVersion);
  const configCompatibilityKey = getEhecoatlVersionCompatibilityKey(configVersion);
  if (configCompatibilityKey !== expectedCompatibilityKey) {
    const error = new Error(`${configLabel} ehecoatlVersion mismatch: expected compatible version ${expectedCompatibilityKey}.x from ${expectedVersion}, found ${configVersion}`);
    error.code = `EHECOATL_VERSION_MISMATCH`;
    throw error;
  }
  return configVersion;
}

function validateTenantDirSuffix(tenantDomain) {
  const normalizedTenantDomain = normalizeTenantDomain(tenantDomain);
  if (!normalizedTenantDomain || !tenantDirSuffixPattern.test(normalizedTenantDomain)) {
    throw new Error(`tenantDomain must match ${tenantDirSuffixPattern}`);
  }
  return normalizedTenantDomain;
}

function normalizeProjectDomain(domain) {
  return normalizeTenantDomain(domain);
}

function validateAppDirSuffix(appName) {
  const normalizedAppName = normalizeAppName(appName);
  if (!normalizedAppName || !appDirSuffixPattern.test(normalizedAppName)) {
    throw new Error(`appName must match ${appDirSuffixPattern}`);
  }
  return normalizedAppName;
}

function normalizeDomainAliasList(aliasList, { allowEmpty = true } = {}) {
  if (aliasList == null) return Object.freeze([]);
  if (!Array.isArray(aliasList)) {
    throw new Error(`Alias config must contain an array of domains`);
  }

  const normalized = [];
  for (const alias of aliasList) {
    if (typeof alias !== `string`) {
      throw new Error(`Alias entries must be domain strings`);
    }
    const normalizedAlias = normalizeTenantDomain(alias);
    if (!normalizedAlias) {
      throw new Error(`Alias entries must not be empty`);
    }
    normalized.push(normalizedAlias);
  }

  if (!allowEmpty && normalized.length === 0) {
    throw new Error(`Alias config must contain at least one domain`);
  }

  return Object.freeze([...new Set(normalized)].sort());
}

function isOpaqueId(id) {
  return opaqueIdPattern.test(normalizeOpaqueId(id));
}

function isTenantOpaqueId(id) {
  return tenantOpaqueIdPattern.test(normalizeOpaqueId(id));
}

function isAppOpaqueId(id) {
  return appOpaqueIdPattern.test(normalizeOpaqueId(id));
}

function buildTenantDirName(tenantDomain) {
  return `${tenantDirPrefix}${validateTenantDirSuffix(tenantDomain)}`;
}

function buildProjectDirName(projectDomain) {
  return buildTenantDirName(projectDomain);
}

function buildAppDirName(appName) {
  return `${appDirPrefix}${validateAppDirSuffix(appName)}`;
}

function parseTenantDirName(name) {
  const match = tenantDirPattern.exec(String(name ?? ``).trim());
  if (!match) return null;
  const tenantDomain = normalizeTenantDomain(match[1]);
  if (!tenantDomain || !tenantDirSuffixPattern.test(tenantDomain)) return null;
  return Object.freeze({
    projectDomain: tenantDomain,
    tenantDomain
  });
}

function parseAppDirName(name) {
  const match = appDirPattern.exec(String(name ?? ``).trim());
  if (!match) return null;
  const appName = normalizeAppName(match[1]);
  if (!appName || !appDirSuffixPattern.test(appName)) return null;
  return Object.freeze({
    appName
  });
}

function parseLegacyOpaqueTenantDirName(name) {
  const match = legacyOpaqueTenantDirPattern.exec(String(name ?? ``).trim());
  if (!match) return null;
  return Object.freeze({
    tenantId: match[1]
  });
}

function parseLegacyOpaqueAppDirName(name) {
  const match = legacyOpaqueAppDirPattern.exec(String(name ?? ``).trim());
  if (!match) return null;
  return Object.freeze({
    appId: match[1]
  });
}

function isTenantDirName(name) {
  return parseTenantDirName(name) !== null;
}

function isAppDirName(name) {
  return parseAppDirName(name) !== null;
}

function generateOpaqueId({
  length = TENANT_OPAQUE_ID_LENGTH,
  randomBytes = crypto.randomBytes
} = {}) {
  let nextId = ``;
  while (nextId.length < length) {
    const randomChunk = randomBytes(length);
    for (const value of randomChunk) {
      nextId += OPAQUE_ID_ALPHABET[value % OPAQUE_ID_ALPHABET.length];
      if (nextId.length === length) {
        break;
      }
    }
  }
  return nextId;
}

function generateUniqueOpaqueId({
  prefix,
  exists,
  maxAttempts = 1024,
  randomBytes
}) {
  const normalizedPrefix = String(prefix ?? ``).trim();
  if (![projectDirPrefix, legacyTenantDirPrefix, appDirPrefix].includes(normalizedPrefix)) {
    throw new Error(`generateUniqueOpaqueId requires prefix "${projectDirPrefix}", "${legacyTenantDirPrefix}" or "${appDirPrefix}"`);
  }
  if (typeof exists !== `function`) {
    throw new Error(`generateUniqueOpaqueId requires an exists callback`);
  }

  const idLength = normalizedPrefix === appDirPrefix
    ? APP_OPAQUE_ID_LENGTH
    : TENANT_OPAQUE_ID_LENGTH;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const id = generateOpaqueId({ length: idLength, randomBytes });
    const folderName = `${normalizedPrefix}${id}`;
    if (!exists(folderName, id)) {
      return id;
    }
  }

  throw new Error(`Unable to generate a unique opaque id after ${maxAttempts} attempts`);
}

function resolveDefaultTenantConfig(defaultAppName = `www`) {
  const normalizedDefaultAppName = normalizeAppName(defaultAppName) || `www`;
  return Object.freeze({
    certbotEmail: null,
    appRouting: Object.freeze({
      mode: `subdomain`,
      defaultAppName: normalizedDefaultAppName
    })
  });
}

function normalizeTenantConfig(rawConfig = {}, {
  defaultAppName = `www`,
  expectedTenantId = null,
  expectedTenantDomain = null,
  fallbackTenantDomain = null,
  expectedEhecoatlVersion = null
} = {}) {
  if (!rawConfig || typeof rawConfig !== `object` || Array.isArray(rawConfig)) {
    throw new Error(`Project config must contain a JSON object`);
  }

  const fallback = resolveDefaultTenantConfig(defaultAppName);
  const tenantId = normalizeOpaqueId(rawConfig.projectId ?? rawConfig.tenantId);
  if (!isTenantOpaqueId(tenantId)) {
    throw new Error(`Project config is missing a valid projectId`);
  }
  if (expectedTenantId && tenantId !== normalizeOpaqueId(expectedTenantId)) {
    throw new Error(`Project config projectId does not match folder name`);
  }

  const tenantDomain = normalizeTenantDomain(rawConfig.projectDomain || rawConfig.tenantDomain || fallbackTenantDomain);
  if (!tenantDomain) {
    throw new Error(`Project config is missing projectDomain`);
  }
  validateTenantDirSuffix(tenantDomain);
  if (expectedTenantDomain && tenantDomain !== normalizeTenantDomain(expectedTenantDomain)) {
    throw new Error(`Project config projectDomain does not match folder name`);
  }
  const ehecoatlVersion = validateEhecoatlVersion(rawConfig, {
    expectedEhecoatlVersion,
    configLabel: `Project config`
  });

  const configuredMode = typeof rawConfig?.appRoutingMode === `string`
    ? rawConfig.appRoutingMode
    : rawConfig?.appRouting?.mode;
  const configuredDefaultAppName = typeof rawConfig?.defaultAppName === `string`
    && normalizeAppName(rawConfig.defaultAppName)
    ? rawConfig.defaultAppName
    : rawConfig?.appRouting?.defaultAppName;

  return Object.freeze({
    projectId: tenantId,
    projectDomain: tenantDomain,
    tenantId,
    tenantDomain,
    ...(ehecoatlVersion ? { ehecoatlVersion } : {}),
    alias: normalizeDomainAliasList(rawConfig.alias),
    certbotEmail: typeof rawConfig?.certbotEmail === `string` && rawConfig.certbotEmail.trim()
      ? rawConfig.certbotEmail.trim()
      : fallback.certbotEmail,
    appRouting: Object.freeze({
      mode: configuredMode === `path` ? `path` : `subdomain`,
      defaultAppName: normalizeAppName(configuredDefaultAppName) || fallback.appRouting.defaultAppName
    })
  });
}

function normalizeAppConfig(rawConfig = {}, {
  expectedAppId = null,
  expectedAppName = null,
  fallbackAppName = null,
  expectedEhecoatlVersion = null
} = {}) {
  if (!rawConfig || typeof rawConfig !== `object` || Array.isArray(rawConfig)) {
    throw new Error(`App config must contain a JSON object`);
  }

  const appId = normalizeOpaqueId(rawConfig.appId);
  if (!isAppOpaqueId(appId)) {
    throw new Error(`App config is missing a valid appId`);
  }
  if (expectedAppId && appId !== normalizeOpaqueId(expectedAppId)) {
    throw new Error(`App config appId does not match folder name`);
  }

  const appName = normalizeAppName(rawConfig.appName || fallbackAppName);
  if (!appName) {
    throw new Error(`App config is missing appName`);
  }
  validateAppDirSuffix(appName);
  if (expectedAppName && appName !== normalizeAppName(expectedAppName)) {
    throw new Error(`App config appName does not match folder name`);
  }
  const ehecoatlVersion = validateEhecoatlVersion(rawConfig, {
    expectedEhecoatlVersion,
    configLabel: `App config`
  });

  return Object.freeze({
    appId,
    appName,
    ...(ehecoatlVersion ? { ehecoatlVersion } : {}),
    alias: normalizeDomainAliasList(rawConfig.alias)
  });
}

function buildIsolatedRuntimeProcessIdentity({
  tenantId,
  appId,
  domain = null,
  appName = null
}) {
  const normalizedTenantId = normalizeOpaqueId(tenantId);
  const normalizedAppId = normalizeOpaqueId(appId);
  if (!isTenantOpaqueId(normalizedTenantId) || !isAppOpaqueId(normalizedAppId)) {
    throw new Error(`buildIsolatedRuntimeProcessIdentity requires both tenantId and appId`);
  }

  const label = buildIsolatedRuntimeLabel({
    tenantId: normalizedTenantId,
    appId: normalizedAppId
  });

  return Object.freeze({
    label,
    processUser: getRenderedProcessIdentity(`appScope`, `isolatedRuntime`, {
      tenant_id: normalizedTenantId,
      app_id: normalizedAppId
    })?.user ?? null,
    tenantId: normalizedTenantId,
    appId: normalizedAppId,
    domain: normalizeTenantDomain(domain) || null,
    appName: normalizeAppName(appName) || null,
    hostname: domain && appName ? `${normalizeAppName(appName)}.${normalizeTenantDomain(domain)}` : null
  });
}

function readJsonFileSync(targetPath) {
  return JSON.parse(fs.readFileSync(targetPath, `utf8`));
}

function writeJsonFileSync(targetPath, data) {
  fs.writeFileSync(targetPath, JSON.stringify(data, null, 2) + `\n`, `utf8`);
}

function safeReadDirentsSync(targetPath) {
  try {
    return fs.readdirSync(targetPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === `ENOENT`) return [];
    throw error;
  }
}

function safeReadJsonFileSync(targetPath) {
  try {
    return readJsonFileSync(targetPath);
  } catch (error) {
    if (error?.code === `ENOENT`) return null;
    throw error;
  }
}

function readMergedJsonFolderSync(targetPath) {
  const merged = {};
  let hasFiles = false;
  for (const entry of safeReadDirentsSync(targetPath)) {
    if (!entry?.isFile?.()) continue;
    if (!String(entry.name ?? ``).toLowerCase().endsWith(`.json`)) continue;
    hasFiles = true;
    const filePath = path.join(targetPath, entry.name);
    const parsed = readJsonFileSync(filePath);
    if (!parsed || typeof parsed !== `object` || Array.isArray(parsed)) {
      throw new Error(`Config file ${filePath} must contain a JSON object`);
    }
    Object.assign(merged, deepMerge(merged, parsed));
  }
  return Object.freeze({
    config: Object.freeze(merged),
    hasFiles
  });
}

function resolveMergedAppConfigSync({
  tenantRoot,
  appRoot
}) {
  const sharedConfigDir = path.join(tenantRoot, tenantSharedConfigRelativePath);
  const appConfigDir = path.join(appRoot, appConfigDirName);
  const legacyAppConfigPath = path.join(appRoot, legacyAppConfigRelativePath);

  const sharedLayer = readMergedJsonFolderSync(sharedConfigDir);
  const appLayer = readMergedJsonFolderSync(appConfigDir);
  const legacyAppConfig = safeReadJsonFileSync(legacyAppConfigPath);

  let mergedConfig = deepMerge({}, sharedLayer.config);
  if (legacyAppConfig && typeof legacyAppConfig === `object` && !Array.isArray(legacyAppConfig)) {
    mergedConfig = deepMerge(mergedConfig, legacyAppConfig);
  }
  mergedConfig = deepMerge(mergedConfig, appLayer.config);

  return Object.freeze({
    config: Object.freeze(mergedConfig),
    sharedConfigDir,
    appConfigDir,
    legacyAppConfigPath,
    hasConfigFiles: sharedLayer.hasFiles || appLayer.hasFiles || Boolean(legacyAppConfig)
  });
}

function resolveProjectScanBases({
  projectsBase = null,
  tenantsBase = null,
  legacyTenantsBase = null
} = {}) {
  const bases = [];
  const addBase = (base, legacy = false) => {
    const normalizedBase = String(base ?? ``).trim();
    if (!normalizedBase) return;
    if (bases.some((entry) => entry.base === normalizedBase)) return;
    bases.push(Object.freeze({ base: normalizedBase, legacy }));
  };

  addBase(projectsBase ?? tenantsBase, false);
  addBase(legacyTenantsBase, true);
  if (projectsBase && tenantsBase && projectsBase !== tenantsBase) {
    addBase(tenantsBase, true);
  }
  return Object.freeze(bases);
}

function scanOpaqueTenantRecordsSync({ tenantsBase = null, projectsBase = null, legacyTenantsBase = null } = {}) {
  const tenantRecords = [];
  const seenProjectIds = new Set();
  for (const scanBase of resolveProjectScanBases({ tenantsBase, projectsBase, legacyTenantsBase })) {
    for (const entry of safeReadDirentsSync(scanBase.base)) {
      if (!entry?.isDirectory?.()) continue;
      const tenantMatch = parseTenantDirName(entry.name);
      if (!tenantMatch) continue;

      const tenantRoot = path.join(scanBase.base, entry.name);
      const tenantConfigPath = path.join(tenantRoot, `config.json`);
      const tenantConfig = normalizeTenantConfig(
        safeReadJsonFileSync(tenantConfigPath) ?? {},
        { expectedTenantDomain: tenantMatch.tenantDomain }
      );
      if (seenProjectIds.has(tenantConfig.projectId)) continue;
      seenProjectIds.add(tenantConfig.projectId);

      const apps = [];
      for (const appEntry of safeReadDirentsSync(tenantRoot)) {
        if (!appEntry?.isDirectory?.()) continue;
        const appMatch = parseAppDirName(appEntry.name);
        if (!appMatch) continue;

        const appRoot = path.join(tenantRoot, appEntry.name);
        const mergedAppConfig = resolveMergedAppConfigSync({
          tenantRoot,
          appRoot
        });
        const appConfig = normalizeAppConfig(
          mergedAppConfig.config,
          { expectedAppName: appMatch.appName }
        );
        const processIdentity = buildIsolatedRuntimeProcessIdentity({
          tenantId: tenantConfig.tenantId,
          appId: appConfig.appId,
          domain: tenantConfig.tenantDomain,
          appName: appConfig.appName
        });

        apps.push(Object.freeze({
          projectId: tenantConfig.projectId,
          projectDomain: tenantConfig.projectDomain,
          projectAliases: tenantConfig.alias,
          projectRoot: tenantRoot,
          projectConfigPath: tenantConfigPath,
          legacyTenantLayout: scanBase.legacy || entry.name.startsWith(legacyTenantDirPrefix),
          tenantId: tenantConfig.tenantId,
          tenantDomain: tenantConfig.tenantDomain,
          tenantAliases: tenantConfig.alias,
          tenantRoot,
          tenantConfigPath,
          appId: appConfig.appId,
          appName: appConfig.appName,
          alias: appConfig.alias,
          appRoot,
          appConfigPath: mergedAppConfig.appConfigDir,
          processUser: processIdentity.processUser,
          processLabel: processIdentity.label,
          hostname: processIdentity.hostname
        }));
      }

      tenantRecords.push(Object.freeze({
        projectId: tenantConfig.projectId,
        projectDomain: tenantConfig.projectDomain,
        projectRoot: tenantRoot,
        projectConfigPath: tenantConfigPath,
        legacyTenantLayout: scanBase.legacy || entry.name.startsWith(legacyTenantDirPrefix),
        tenantId: tenantConfig.tenantId,
        tenantDomain: tenantConfig.tenantDomain,
        alias: tenantConfig.alias,
        tenantRoot,
        tenantConfigPath,
        apps: Object.freeze(apps)
      }));
    }
  }

  return Object.freeze(tenantRecords);
}

function findOpaqueAppRecordByProcessUserSync({
  tenantsBase,
  projectsBase = null,
  legacyTenantsBase = null,
  processUser
}) {
  const normalizedProcessUser = String(processUser ?? ``).trim();
  if (!normalizedProcessUser) return null;

  for (const tenantRecord of scanOpaqueTenantRecordsSync({ tenantsBase, projectsBase, legacyTenantsBase })) {
    const matchedApp = tenantRecord.apps.find((entry) => entry.processUser === normalizedProcessUser);
    if (matchedApp) return matchedApp;
  }

  return null;
}

function findOpaqueTenantRecordByDomainSync({
  tenantsBase,
  projectsBase = null,
  legacyTenantsBase = null,
  tenantDomain
}) {
  const normalizedTenantDomain = normalizeTenantDomain(tenantDomain);
  if (!normalizedTenantDomain) return null;

  return scanOpaqueTenantRecordsSync({ tenantsBase, projectsBase, legacyTenantsBase })
    .find((record) => record.projectDomain === normalizedTenantDomain || record.tenantDomain === normalizedTenantDomain)
    ?? null;
}

function findOpaqueTenantRecordByIdSync({
  tenantsBase,
  projectsBase = null,
  legacyTenantsBase = null,
  tenantId
}) {
  const normalizedTenantId = normalizeOpaqueId(tenantId);
  if (!isTenantOpaqueId(normalizedTenantId)) return null;

  return scanOpaqueTenantRecordsSync({ tenantsBase, projectsBase, legacyTenantsBase })
    .find((record) => record.projectId === normalizedTenantId || record.tenantId === normalizedTenantId)
    ?? null;
}

function findOpaqueAppRecordByDomainAndAppNameSync({
  tenantsBase,
  projectsBase = null,
  legacyTenantsBase = null,
  tenantDomain,
  appName
}) {
  const tenantRecord = findOpaqueTenantRecordByDomainSync({
    tenantsBase,
    projectsBase,
    legacyTenantsBase,
    tenantDomain
  });
  if (!tenantRecord) return null;

  const normalizedAppName = normalizeAppName(appName);
  return tenantRecord.apps.find((record) => record.appName === normalizedAppName) ?? null;
}

function findOpaqueAppRecordByTenantIdAndAppNameSync({
  tenantsBase,
  projectsBase = null,
  legacyTenantsBase = null,
  tenantId,
  appName
}) {
  const tenantRecord = findOpaqueTenantRecordByIdSync({
    tenantsBase,
    projectsBase,
    legacyTenantsBase,
    tenantId
  });
  if (!tenantRecord) return null;

  const normalizedAppName = normalizeAppName(appName);
  return tenantRecord.apps.find((record) => record.appName === normalizedAppName) ?? null;
}

function findOpaqueAppRecordByTenantIdAndAppIdSync({
  tenantsBase,
  projectsBase = null,
  legacyTenantsBase = null,
  tenantId,
  appId
}) {
  const tenantRecord = findOpaqueTenantRecordByIdSync({
    tenantsBase,
    projectsBase,
    legacyTenantsBase,
    tenantId
  });
  if (!tenantRecord) return null;

  const normalizedAppId = normalizeOpaqueId(appId);
  if (!isAppOpaqueId(normalizedAppId)) return null;

  return tenantRecord.apps.find((record) => record.appId === normalizedAppId) ?? null;
}

function findOpaqueAppRecordByIdSync({
  tenantsBase,
  projectsBase = null,
  legacyTenantsBase = null,
  appId
}) {
  const normalizedAppId = normalizeOpaqueId(appId);
  if (!isAppOpaqueId(normalizedAppId)) return null;

  for (const tenantRecord of scanOpaqueTenantRecordsSync({ tenantsBase, projectsBase, legacyTenantsBase })) {
    const matchedApp = tenantRecord.apps.find((record) => record.appId === normalizedAppId);
    if (matchedApp) return matchedApp;
  }

  return null;
}

function resolveOpaqueScopeRecordByPathSync({
  tenantsBase,
  projectsBase = null,
  legacyTenantsBase = null,
  targetPath
}) {
  const normalizedTargetPath = typeof targetPath === `string` && targetPath.length
    ? path.resolve(targetPath)
    : null;
  if (!normalizedTargetPath) return null;

  for (const tenantRecord of scanOpaqueTenantRecordsSync({ tenantsBase, projectsBase, legacyTenantsBase })) {
    for (const appRecord of tenantRecord.apps) {
      if (
        normalizedTargetPath === appRecord.appRoot ||
        normalizedTargetPath.startsWith(`${appRecord.appRoot}${path.sep}`)
      ) {
        return Object.freeze({
          kind: `app`,
          ...appRecord
        });
      }
    }

    if (
      normalizedTargetPath === tenantRecord.tenantRoot ||
      normalizedTargetPath.startsWith(`${tenantRecord.tenantRoot}${path.sep}`)
    ) {
      return Object.freeze({
        kind: tenantRecord.legacyTenantLayout ? `tenant` : `project`,
        ...tenantRecord
      });
    }
  }

  return null;
}

function migrateLegacyTenantsSync({
  tenantsBase
}) {
  const rootEntries = safeReadDirentsSync(tenantsBase);
  const aliasEntries = rootEntries.filter((entry) => entry?.isFile?.());
  const tenantEntries = rootEntries.filter((entry) => entry?.isDirectory?.());
  const canonicalEntries = tenantEntries.filter((entry) => (
    isTenantDirName(entry.name) && parseLegacyOpaqueTenantDirName(entry.name) === null
  ));
  const legacyEntries = tenantEntries.filter((entry) => parseLegacyOpaqueTenantDirName(entry.name) !== null);
  const invalidEntries = tenantEntries.filter((entry) => (
    parseLegacyOpaqueTenantDirName(entry.name) === null && !isTenantDirName(entry.name)
  ));

  if (canonicalEntries.length > 0) {
    throw new Error(`Migration requires an opaque-id-only tenants root; found existing canonical tenant folders`);
  }
  if (invalidEntries.length > 0) {
    throw new Error(`Migration found unsupported tenant folders: ${invalidEntries.map((entry) => entry.name).join(`, `)}`);
  }

  const migrated = [];
  const generatedTenantDirs = new Set();
  for (const tenantEntry of legacyEntries) {
    const legacyTenantFolder = parseLegacyOpaqueTenantDirName(tenantEntry.name);
    if (!legacyTenantFolder) {
      throw new Error(`Legacy tenant folder "${tenantEntry.name}" is invalid`);
    }
    const legacyTenantRoot = path.join(tenantsBase, tenantEntry.name);
    const tenantConfigPath = path.join(legacyTenantRoot, `config.json`);
    const normalizedTenantConfig = normalizeTenantConfig(
      safeReadJsonFileSync(tenantConfigPath) ?? {},
      { expectedTenantId: legacyTenantFolder.tenantId }
    );
    const tenantDirName = buildTenantDirName(normalizedTenantConfig.tenantDomain);
    if (generatedTenantDirs.has(tenantDirName) || fs.existsSync(path.join(tenantsBase, tenantDirName))) {
      throw new Error(`Duplicate tenant domain "${normalizedTenantConfig.tenantDomain}" found during migration`);
    }
    generatedTenantDirs.add(tenantDirName);
    const canonicalTenantRoot = path.join(tenantsBase, tenantDirName);

    fs.renameSync(legacyTenantRoot, canonicalTenantRoot);

    const appEntries = safeReadDirentsSync(canonicalTenantRoot).filter((entry) => entry?.isDirectory?.());
    const seenAppNames = new Set();
    const generatedAppDirs = new Set();
    const apps = [];

    for (const appEntry of appEntries) {
      const legacyAppFolder = parseLegacyOpaqueAppDirName(appEntry.name);
      if (!legacyAppFolder) continue;

      const legacyAppRoot = path.join(canonicalTenantRoot, appEntry.name);
      const mergedAppConfig = resolveMergedAppConfigSync({
        tenantRoot: canonicalTenantRoot,
        appRoot: legacyAppRoot
      });
      if (!mergedAppConfig.hasConfigFiles) {
        throw new Error(`App config missing or invalid for "${appEntry.name}" inside tenant "${normalizedTenantConfig.tenantDomain}"`);
      }
      const normalizedAppConfig = normalizeAppConfig(
        mergedAppConfig.config,
        { expectedAppId: legacyAppFolder.appId }
      );
      if (seenAppNames.has(normalizedAppConfig.appName)) {
        throw new Error(`Duplicate app name "${normalizedAppConfig.appName}" found for tenant "${normalizedTenantConfig.tenantDomain}" during migration`);
      }
      seenAppNames.add(normalizedAppConfig.appName);

      const appDirName = buildAppDirName(normalizedAppConfig.appName);
      if (generatedAppDirs.has(appDirName) || fs.existsSync(path.join(canonicalTenantRoot, appDirName))) {
        throw new Error(`Duplicate app folder "${appDirName}" found for tenant "${normalizedTenantConfig.tenantDomain}" during migration`);
      }
      generatedAppDirs.add(appDirName);
      const canonicalAppRoot = path.join(canonicalTenantRoot, appDirName);
      fs.renameSync(legacyAppRoot, canonicalAppRoot);

      apps.push(Object.freeze({
        appId: normalizedAppConfig.appId,
        appName: normalizedAppConfig.appName,
        appRoot: canonicalAppRoot
      }));
    }

    migrated.push(Object.freeze({
      tenantId: normalizedTenantConfig.tenantId,
      tenantDomain: normalizedTenantConfig.tenantDomain,
      tenantRoot: canonicalTenantRoot,
      apps: Object.freeze(apps)
    }));
  }

  for (const aliasEntry of aliasEntries) {
    fs.rmSync(path.join(tenantsBase, aliasEntry.name), { force: true });
  }

  return Object.freeze({
    tenantsBase,
    aliasesMigrated: aliasEntries.map((entry) => entry.name).sort(),
    migrated: Object.freeze(migrated)
  });
}

module.exports = Object.freeze({
  OPAQUE_ID_LENGTH,
  TENANT_OPAQUE_ID_LENGTH,
  APP_OPAQUE_ID_LENGTH,
  projectDirPrefix,
  tenantDirPrefix,
  appDirPrefix,
  opaqueIdPattern,
  tenantOpaqueIdPattern,
  appOpaqueIdPattern,
  tenantDirPattern,
  appDirPattern,
  normalizeTenantDomain,
  normalizeProjectDomain,
  normalizeDomainAliasList,
  normalizeAppName,
  normalizeOpaqueId,
  normalizeEhecoatlVersion,
  isOpaqueId,
  isTenantOpaqueId,
  isAppOpaqueId,
  buildTenantDirName,
  buildProjectDirName,
  buildAppDirName,
  parseTenantDirName,
  parseAppDirName,
  parseLegacyOpaqueTenantDirName,
  parseLegacyOpaqueAppDirName,
  isTenantDirName,
  isAppDirName,
  generateOpaqueId,
  generateUniqueOpaqueId,
  resolveDefaultTenantConfig,
  normalizeTenantConfig,
  normalizeAppConfig,
  buildIsolatedRuntimeProcessIdentity,
  scanOpaqueTenantRecordsSync,
  findOpaqueTenantRecordByIdSync,
  findOpaqueTenantRecordByDomainSync,
  findOpaqueAppRecordByTenantIdAndAppNameSync,
  findOpaqueAppRecordByTenantIdAndAppIdSync,
  findOpaqueAppRecordByIdSync,
  findOpaqueAppRecordByDomainAndAppNameSync,
  findOpaqueAppRecordByProcessUserSync,
  resolveOpaqueScopeRecordByPathSync,
  migrateLegacyTenantsSync,
  resolveMergedAppConfigSync,
  readJsonFileSync,
  writeJsonFileSync
});
