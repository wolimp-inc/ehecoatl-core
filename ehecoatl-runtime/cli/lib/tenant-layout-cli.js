'use strict';

const path = require(`node:path`);

const tenantLayout = require(path.join(__dirname, `..`, `..`, `utils`, `tenancy`, `tenant-layout.js`));
const legacyTenantsBase = String(process.env.EHECOATL_LEGACY_TENANTS_BASE ?? ``).trim() || null;

function scanArgs(baseArg) {
  return {
    projectsBase: baseArg,
    tenantsBase: legacyTenantsBase,
    legacyTenantsBase
  };
}

const [
  command,
  ...args
] = process.argv.slice(2);

async function main() {
  switch (command) {
    case `generate-unique-id`:
      return output(
        tenantLayout.generateUniqueOpaqueId({
          prefix: args[0],
          exists: (folderName) => require(`node:fs`).existsSync(path.join(args[1], folderName))
        })
      );
    case `build-process-user`:
      return output(
        tenantLayout.buildIsolatedRuntimeProcessIdentity({
          domain: args[0],
          appName: args[1]
        }).processUser
      );
    case `patch-tenant-config`:
      return outputJson(patchTenantConfig(args));
    case `patch-app-config`:
      return outputJson(patchAppConfig(args));
    case `find-app-json-by-process-user`:
      return outputJson(
        tenantLayout.findOpaqueAppRecordByProcessUserSync({
          ...scanArgs(args[0]),
          processUser: args[1]
        })
      );
    case `find-tenant-json-by-domain`:
      return outputJson(
        tenantLayout.findOpaqueTenantRecordByDomainSync({
          ...scanArgs(args[0]),
          tenantDomain: args[1]
        })
      );
    case `find-tenant-json-by-id`:
      return outputJson(
        tenantLayout.findOpaqueTenantRecordByIdSync({
          ...scanArgs(args[0]),
          tenantId: args[1]
        })
      );
    case `find-app-json-by-domain-and-app-name`:
      return outputJson(
        tenantLayout.findOpaqueAppRecordByDomainAndAppNameSync({
          ...scanArgs(args[0]),
          tenantDomain: args[1],
          appName: args[2]
        })
      );
    case `find-app-json-by-id`:
      return outputJson(
        tenantLayout.findOpaqueAppRecordByIdSync({
          ...scanArgs(args[0]),
          appId: args[1]
        })
      );
    case `find-app-json-by-tenant-id-and-app-id`:
      return outputJson(
        tenantLayout.findOpaqueAppRecordByTenantIdAndAppIdSync({
          ...scanArgs(args[0]),
          tenantId: args[1],
          appId: args[2]
        })
      );
    case `find-app-json-by-tenant-id-and-app-name`:
      return outputJson(
        tenantLayout.findOpaqueAppRecordByTenantIdAndAppNameSync({
          ...scanArgs(args[0]),
          tenantId: args[1],
          appName: args[2]
        })
      );
    case `list-tenants`:
      return outputJson(
        tenantLayout.scanOpaqueTenantRecordsSync({
          ...scanArgs(args[0])
        }).map((record) => ({
          projectId: record.projectId,
          projectDomain: record.projectDomain,
          projectRoot: record.projectRoot,
          projectConfigPath: record.projectConfigPath,
          tenantId: record.tenantId,
          tenantDomain: record.tenantDomain,
          tenantRoot: record.tenantRoot,
          tenantConfigPath: record.tenantConfigPath,
          appCount: record.apps.length
        }))
      );
    case `list-apps-by-tenant-id`:
      return outputJson(
        tenantLayout.findOpaqueTenantRecordByIdSync({
          ...scanArgs(args[0]),
          tenantId: args[1]
        })?.apps ?? []
      );
    case `resolve-scope-by-path`:
      return outputJson(
        tenantLayout.resolveOpaqueScopeRecordByPathSync({
          ...scanArgs(args[0]),
          targetPath: args[1]
        })
      );
    case `migrate-layout`:
      return outputJson(
        tenantLayout.migrateLegacyTenantsSync({
          tenantsBase: args[0]
        })
      );
    default:
      throw new Error(`Unknown tenant-layout-cli command: ${command ?? `(missing)`}`);
  }
}

function patchTenantConfig([configPath, tenantId, tenantDomain]) {
  const current = tenantLayout.readJsonFileSync(configPath);
  const legacyRepoField = `repo` + `URL`;
  const { [legacyRepoField]: _legacyRepoField, ...source } = current?.source && typeof current.source === `object` ? current.source : {};
  const next = {
    ...current,
    projectId: tenantLayout.normalizeOpaqueId(tenantId),
    projectDomain: tenantLayout.normalizeTenantDomain(tenantDomain),
    tenantId: tenantLayout.normalizeOpaqueId(tenantId),
    tenantDomain: tenantLayout.normalizeTenantDomain(tenantDomain),
    alias: tenantLayout.normalizeDomainAliasList(current?.alias),
    source
  };
  tenantLayout.writeJsonFileSync(configPath, next);
  return next;
}

function patchAppConfig([configPath, appId, appName]) {
  const current = tenantLayout.readJsonFileSync(configPath);
  const legacyRepoField = `repo` + `URL`;
  const { [legacyRepoField]: _legacyRepoField, ...source } = current?.source && typeof current.source === `object` ? current.source : {};
  const next = {
    ...current,
    appId: tenantLayout.normalizeOpaqueId(appId),
    appName: tenantLayout.normalizeAppName(appName),
    alias: tenantLayout.normalizeDomainAliasList(current?.alias),
    source
  };
  tenantLayout.writeJsonFileSync(configPath, next);
  return next;
}

function output(value) {
  process.stdout.write(String(value ?? ``));
}

function outputJson(value) {
  process.stdout.write(JSON.stringify(value ?? null));
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exit(1);
});
