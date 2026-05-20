// adapters/inbound/project-registry-resolver/default-runtime-registry-v1.js


'use strict';

const fs = require(`node:fs/promises`);
const path = require(`node:path`);
const ProjectRegistryResolverPort = require(`@/_core/_ports/inbound/project-registry-resolver-port`);

ProjectRegistryResolverPort.persistRegistryAdapter = async function persistRegistryAdapter({
  storage,
  registry,
  projectsPath,
  tenantsPath,
  registryPath,
  snapshotMetadata = null
}) {
  const registryRootParent = path.dirname(registryPath);
  const tempRegistryPath = `${registryPath}.__tmp__-${process.pid}-${Date.now()}`;
  const previousRegistryPath = `${registryPath}.__prev__-${process.pid}-${Date.now()}`;
  const persistedSnapshotState = await loadPersistedSnapshotState(registryPath);
  const createdAtFallback = new Date().toISOString();

  await fs.access(registryRootParent);
  await fs.rm(tempRegistryPath, { recursive: true, force: true });
  await fs.rm(previousRegistryPath, { recursive: true, force: true });
  await fs.mkdir(tempRegistryPath);
  await preserveNonTenantEntries({
    sourceRoot: registryPath,
    targetRoot: tempRegistryPath
  });

  const domains = [...(registry?.domains?.values?.() ?? [])];
  const hosts = [...(registry?.hosts?.values?.() ?? [])];
  const appsByTenantId = groupAppsByTenantId(hosts);

  for (const tenantRecord of domains) {
    const tenantFolderName = `project_${tenantRecord.projectId ?? tenantRecord.tenantId}`;
    const tenantFolder = path.join(tempRegistryPath, tenantFolderName);
    const tenantApps = appsByTenantId.get(tenantRecord.tenantId) ?? [];

    await storage.createFolder(tenantFolder);
    await storage.writeFile(
      buildTenantSnapshotPath(tenantFolder, tenantRecord.tenantId),
      JSON.stringify(buildTenantSnapshot({
        tenantRecord,
        projectsPath,
        tenantsPath,
        tenantApps,
        snapshotMetadata,
        persistedTenantSnapshot: persistedSnapshotState.tenantsById.get(tenantRecord.tenantId) ?? null,
        createdAtFallback
      }), null, 2),
      `utf8`
    );

    for (const appRecord of tenantApps) {
      const appFolderName = `app_${appRecord.appId}`;
      const appFolder = path.join(tenantFolder, appFolderName);
      await storage.createFolder(appFolder);
      await storage.writeFile(
        buildAppSnapshotPath(appFolder, tenantRecord.tenantId, appRecord.appId),
        JSON.stringify(buildAppSnapshot({
          tenantRecord,
          appRecord,
          projectsPath,
          tenantsPath,
          snapshotMetadata,
          persistedAppSnapshot: persistedSnapshotState.appsByTenantAndAppId.get(buildAppSnapshotKey({
            tenantId: tenantRecord.tenantId,
            appId: appRecord.appId
          })) ?? null,
          createdAtFallback
        }), null, 2),
        `utf8`
      );
    }
  }

  let previousRegistryExists = false;
  try {
    await fs.rename(registryPath, previousRegistryPath);
    previousRegistryExists = true;
  } catch (error) {
    if (error?.code !== `ENOENT`) throw error;
  }

  try {
    await fs.rename(tempRegistryPath, registryPath);
  } catch (error) {
    if (previousRegistryExists) {
      await fs.rename(previousRegistryPath, registryPath).catch(() => { });
    }
    throw error;
  }

  if (previousRegistryExists) {
    await fs.rm(previousRegistryPath, { recursive: true, force: true });
  }

  return {
    registryPath,
    tenantCount: domains.length,
    appCount: hosts.length
  };
};

module.exports = ProjectRegistryResolverPort;
Object.freeze(module.exports);

function buildTenantSnapshotPath(tenantFolder, tenantId) {
  return path.join(tenantFolder, `snapshot_${tenantId}.json`);
}

function buildAppSnapshotPath(appFolder, tenantId, appId) {
  return path.join(appFolder, `snapshot_${tenantId}_${appId}.json`);
}

function groupAppsByTenantId(appRecords) {
  const groups = new Map();
  for (const appRecord of appRecords) {
    const tenantId = String(appRecord?.tenantId ?? ``).trim();
    if (!tenantId) continue;
    const records = groups.get(tenantId) ?? [];
    records.push(appRecord);
    groups.set(tenantId, records);
  }
  return groups;
}

function buildTenantSnapshot({
  tenantRecord,
  projectsPath,
  tenantsPath,
  tenantApps,
  snapshotMetadata,
  persistedTenantSnapshot = null,
  createdAtFallback
}) {
  const createdMetadata = resolveCreatedMetadata({
    persistedSnapshot: persistedTenantSnapshot,
    snapshotMetadata,
    createdAtFallback
  });

  return {
    ...createdMetadata,
    ehecoatlVersion: tenantRecord.ehecoatlVersion ?? createdMetadata.ehecoatlVersion,
    projectId: tenantRecord.projectId ?? tenantRecord.tenantId,
    projectDomain: tenantRecord.projectDomain ?? tenantRecord.domain,
    projectRoot: tenantRecord.projectRoot ?? tenantRecord.rootFolder ?? null,
    tenantId: tenantRecord.tenantId,
    tenantDomain: tenantRecord.domain,
    certbotEmail: tenantRecord.certbotEmail ?? null,
    appRouting: tenantRecord.appRouting ?? null,
    appNames: tenantRecord.appNames ?? tenantApps.map((appRecord) => appRecord.appName),
    aliases: tenantRecord.aliases ?? [],
    internalProxy: tenantRecord.internalProxy ?? null,
    certificateAutomation: tenantRecord.certificateAutomation ?? {
      letsEncryptTriggeredDomains: {}
    },
    source: {
      projectsRoot: projectsPath ?? tenantsPath,
      tenantsRoot: tenantsPath,
      projectFolder: tenantRecord.projectRoot ?? tenantRecord.rootFolder ?? null,
      tenantFolder: tenantRecord.rootFolder ?? null
    }
  };
}

function buildAppSnapshot({
  tenantRecord,
  appRecord,
  projectsPath,
  tenantsPath,
  snapshotMetadata,
  persistedAppSnapshot = null,
  createdAtFallback
}) {
  const {
    rootFolder,
    actionsRootFolder,
    httpActionsRootFolder,
    wsActionsRootFolder,
    assetsRootFolder,
    httpMiddlewaresRootFolder,
    wsMiddlewaresRootFolder,
    routesRootFolder,
    httpRoutesRootFolder,
    wsRoutesRootFolder,
    appConfigMtimeMs,
    routeFilesMtimeMs,
    wsRouteFilesMtimeMs,
    tenantEntrypointMtimeMs,
    ...persistedConfig
  } = appRecord ?? {};

  const createdMetadata = resolveCreatedMetadata({
    persistedSnapshot: persistedAppSnapshot,
    snapshotMetadata,
    createdAtFallback
  });

  return {
    ...createdMetadata,
    ...persistedConfig,
    projectId: tenantRecord.projectId ?? tenantRecord.tenantId,
    projectDomain: tenantRecord.projectDomain ?? tenantRecord.domain,
    tenantDomain: tenantRecord.domain,
    source: {
      projectsRoot: projectsPath ?? tenantsPath,
      tenantsRoot: tenantsPath,
      appFolder: rootFolder ?? null,
      actionsRootFolder: actionsRootFolder ?? null,
      httpActionsRootFolder: httpActionsRootFolder ?? null,
      wsActionsRootFolder: wsActionsRootFolder ?? null,
      assetsRootFolder: assetsRootFolder ?? null,
      httpMiddlewaresRootFolder: httpMiddlewaresRootFolder ?? null,
      wsMiddlewaresRootFolder: wsMiddlewaresRootFolder ?? null,
      routesRootFolder: routesRootFolder ?? null,
      httpRoutesRootFolder: httpRoutesRootFolder ?? null,
      wsRoutesRootFolder: wsRoutesRootFolder ?? null,
      appConfigMtimeMs: appConfigMtimeMs ?? null,
      routeFilesMtimeMs: routeFilesMtimeMs ?? null,
      wsRouteFilesMtimeMs: wsRouteFilesMtimeMs ?? null,
      tenantEntrypointMtimeMs: tenantEntrypointMtimeMs ?? null
    }
  };
}

function resolveCreatedMetadata({
  persistedSnapshot = null,
  snapshotMetadata = null,
  createdAtFallback
}) {
  const persistedInstallId = String(persistedSnapshot?.installId ?? ``).trim() || null;
  const persistedVersion = String(persistedSnapshot?.ehecoatlVersion ?? ``).trim() || null;
  const persistedCreatedAt = String(persistedSnapshot?.createdAt ?? ``).trim() || null;
  const currentInstallId = String(snapshotMetadata?.installId ?? ``).trim() || null;
  const currentVersion = String(snapshotMetadata?.ehecoatlVersion ?? ``).trim() || null;

  return Object.freeze({
    installId: persistedInstallId ?? currentInstallId,
    ehecoatlVersion: persistedVersion ?? currentVersion,
    createdAt: persistedCreatedAt ?? createdAtFallback
  });
}

async function loadPersistedSnapshotState(registryPath) {
  const tenantsById = new Map();
  const appsByTenantAndAppId = new Map();
  let tenantEntries = [];

  try {
    tenantEntries = await fs.readdir(registryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === `ENOENT`) {
      return Object.freeze({
        tenantsById,
        appsByTenantAndAppId
      });
    }
    throw error;
  }

  for (const tenantEntry of tenantEntries) {
    if (!tenantEntry?.isDirectory?.()) continue;
    const tenantFolderName = String(tenantEntry.name ?? ``).trim();
    if (!/^(?:project|tenant)_[a-z0-9]{12}$/i.test(tenantFolderName)) continue;

    const tenantFolder = path.join(registryPath, tenantFolderName);
    const tenantIdFromFolder = tenantFolderName.replace(/^(?:project|tenant)_/i, ``);
    const tenantSnapshot = await readJsonOrNull(buildTenantSnapshotPath(tenantFolder, tenantIdFromFolder));
    const tenantId = String(tenantSnapshot?.tenantId ?? ``).trim();
    if (tenantSnapshot && tenantId) {
      tenantsById.set(tenantId, tenantSnapshot);
    }

    const appEntries = await fs.readdir(tenantFolder, { withFileTypes: true }).catch((error) => {
      if (error?.code === `ENOENT`) return [];
      throw error;
    });

    for (const appEntry of appEntries) {
      if (!appEntry?.isDirectory?.()) continue;
      const appFolderName = String(appEntry.name ?? ``).trim();
      if (!/^app_[a-z0-9]{6,12}$/i.test(appFolderName)) continue;
      const appIdFromFolder = appFolderName.replace(/^app_/i, ``);
      const appSnapshot = await readJsonOrNull(buildAppSnapshotPath(
        path.join(tenantFolder, appFolderName),
        tenantId,
        appIdFromFolder
      ));
      const appId = String(appSnapshot?.appId ?? ``).trim();
      if (!tenantId || !appId || !appSnapshot) continue;
      appsByTenantAndAppId.set(buildAppSnapshotKey({ tenantId, appId }), appSnapshot);
    }
  }

  return Object.freeze({
    tenantsById,
    appsByTenantAndAppId
  });
}

async function readJsonOrNull(filePath) {
  const rawContent = await fs.readFile(filePath, `utf8`).catch(() => null);
  if (!rawContent) return null;
  try {
    return JSON.parse(rawContent);
  } catch {
    return null;
  }
}

function buildAppSnapshotKey({
  tenantId,
  appId
}) {
  return `${String(tenantId ?? ``).trim()}:${String(appId ?? ``).trim()}`;
}

async function preserveNonTenantEntries({
  sourceRoot,
  targetRoot
}) {
  let entries = [];
  try {
    entries = await fs.readdir(sourceRoot, {
      withFileTypes: true
    });
  } catch (error) {
    if (error?.code === `ENOENT`) return;
    throw error;
  }

  for (const entry of entries) {
    if (isTenantRegistryEntry(entry.name)) continue;
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    await fs.cp(sourcePath, targetPath, {
      force: true,
      recursive: true,
      errorOnExist: false
    });
  }
}

function isTenantRegistryEntry(entryName) {
  return /^(?:project|tenant)_[a-z0-9]+$/i.test(String(entryName ?? ``).trim());
}
