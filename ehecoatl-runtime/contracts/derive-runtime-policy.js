'use strict';

const path = require(`node:path`);

const contracts = require(`./index.js`);
const context = require(`./context.js`);
const legacyPolicy = require(`../config/runtime-policy.json`);
const { getDirectorRpcSocketDir, getDirectorRpcSocketPath } = require(`../utils/process/director-rpc-socket.js`);

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getLayerByLabel(label) {
  return Object.values(contracts.LAYERS ?? {}).find((layer) => layer?.ABOUT?.label === label) ?? null;
}

function getPrimaryPath(layer, section, key, fallback = null) {
  const candidate = layer?.PATHS?.[section]?.[key];
  return Array.isArray(candidate) && candidate[0] ? candidate[0] : fallback;
}

function getProcessIdentity(layer, processKey) {
  return layer?.ACTORS?.PROCESSES?.[processKey]?.identity ?? null;
}

function deriveRuntimePolicy() {
  const policy = deepClone(legacyPolicy);

  const internalScope = getLayerByLabel(`Internal Scope Layer Contract`);
  const supervisionScope = getLayerByLabel(`Supervision Scope Layer Contract`);
  const projectScope = getLayerByLabel(`Project Scope Layer Contract`);
  const tenantScope = getLayerByLabel(`Tenant Scope Layer Contract`);
  const appScope = getLayerByLabel(`App Scope Layer Contract`);
  const internalRuntime = contracts.SETUP?.IDENTITIES?.internalRuntime ?? null;

  policy.system = {
    ...(policy.system ?? {}),
    sharedUser: internalRuntime?.user ?? policy.system?.sharedUser ?? context.service,
    sharedGroup: internalRuntime?.group ?? policy.system?.sharedGroup ?? context.service
  };

  policy.paths = {
    ...(policy.paths ?? {}),
    // Safe contract-backed values: these resolve directly from the shared setup context.
    projectsBase: context.serviceProjectsRoot,
    tenantsBase: policy.paths?.tenantsBase ?? context.serviceTenantsRoot,
    varBase: path.dirname(context.serviceProjectsRoot),
    directorRpcDir: getDirectorRpcSocketDir(),
    directorRpcSocket: getDirectorRpcSocketPath(),
    // Keep compatibility-backed paths until contracts model these explicitly.
    pluginsBase: policy.paths?.pluginsBase ?? `/srv/opt/${context.service}/plugins`,
    adaptersBase: policy.paths?.adaptersBase ?? `/srv/opt/${context.service}/adapters`,
    projectKitsBase: policy.paths?.projectKitsBase ?? `/srv/opt/${context.service}/project-kits`,
    tenantKitsBase: policy.paths?.tenantKitsBase ?? `/srv/opt/${context.service}/tenant-kits`,
    srvBase: policy.paths?.srvBase ?? `/srv/opt/${context.service}`,
    configBase: policy.paths?.configBase ?? `/etc/opt/${context.service}/config`,
    etcBase: policy.paths?.etcBase ?? `/etc/opt/${context.service}`
  };

  policy.processUsers = {
    ...(policy.processUsers ?? {}),
    main: {
      mode: `fixed`,
      user: getProcessIdentity(supervisionScope, `main`)?.user ?? policy.system.sharedUser,
      group: getProcessIdentity(supervisionScope, `main`)?.group ?? policy.system.sharedGroup
    },
    director: {
      mode: `fixed`,
      user: getProcessIdentity(supervisionScope, `director`)?.user ?? policy.system.sharedUser,
      group: getProcessIdentity(supervisionScope, `director`)?.group ?? policy.system.sharedGroup,
      shareProxyByUser: false
    },
    transport: {
      mode: `fixed`,
      user: getProcessIdentity(projectScope, `transport`)?.user ?? getProcessIdentity(tenantScope, `transport`)?.user ?? policy.system.sharedUser,
      group: getProcessIdentity(projectScope, `transport`)?.group ?? getProcessIdentity(tenantScope, `transport`)?.group ?? context.group.projectScope,
      shareProxyByUser: false
    },
    isolatedRuntime: {
      mode: `fixed`,
      user: getProcessIdentity(appScope, `isolatedRuntime`)?.user ?? policy.system.sharedUser,
      group: getProcessIdentity(appScope, `isolatedRuntime`)?.group ?? context.group.tenantScope,
      shareProxyByUser: false
    }
  };

  policy.tenantLayout = {
    ...(policy.tenantLayout ?? {}),
    domainBaseOwner: context.user.projectUser,
    domainBaseGroup: context.group.projectScope,
    domainBaseMode: `2770`,
    appOwner: context.user.appUser,
    appGroup: context.group.appScope,
    appMode: `2775`,
    appWritableDirMode: `2775`,
    appFileMode: `664`,
    appConfigMode: `664`
  };
  policy.projectLayout = {
    ...(policy.projectLayout ?? policy.tenantLayout ?? {}),
    domainBaseOwner: context.user.projectUser,
    domainBaseGroup: context.group.projectScope,
    domainBaseMode: `2770`,
    appOwner: context.user.appUser,
    appGroup: context.group.appScope,
    appMode: `2775`,
    appWritableDirMode: `2775`,
    appFileMode: `664`,
    appConfigMode: `664`
  };
  policy.tenantAccess = deepClone(policy.tenantAccess ?? {});
  policy.firewall = deepClone(policy.firewall ?? {});

  // Publish a small trace block to make the derivation explicit for future cleanup.
  policy._derivedFromContracts = {
    context: {
      service: context.service,
      serviceInstallRoot: context.serviceInstallRoot,
      serviceProjectsRoot: context.serviceProjectsRoot,
      serviceTenantsRoot: context.serviceTenantsRoot
    },
    mapped: Object.freeze([
      `system.sharedUser`,
      `system.sharedGroup`,
      `paths.projectsBase`,
      `paths.tenantsBase`,
      `paths.varBase`,
      `processUsers.main.user`,
      `processUsers.main.group`,
      `processUsers.director`,
      `processUsers.transport`,
      `processUsers.isolatedRuntime`,
      `projectLayout`,
      `tenantLayout`
    ]),
    compatibilityFallback: Object.freeze([
      `paths.pluginsBase`,
      `paths.adaptersBase`,
      `paths.projectKitsBase`,
      `paths.tenantKitsBase`,
      `paths.srvBase`,
      `paths.configBase`,
      `paths.etcBase`,
      `tenantAccess`,
      `firewall`
    ]),
    internalScopePaths: {
      installation: getPrimaryPath(internalScope, `INTERNAL`, `installation`, null)
    },
    supervisionScopePaths: {
      runtimeRegistry: getPrimaryPath(supervisionScope, `RUNTIME`, `registry`, null),
      overridesConfig: getPrimaryPath(supervisionScope, `OVERRIDES`, `config`, null),
      extensionsPlugins: getPrimaryPath(supervisionScope, `EXTENSIONS`, `customPlugins`, null),
      extensionsProjectKits: getPrimaryPath(supervisionScope, `EXTENSIONS`, `customProjectKits`, null),
      extensionsTenantKits: getPrimaryPath(supervisionScope, `EXTENSIONS`, `customTenantKits`, null)
    }
  };

  return policy;
}

function getNestedValue(target, dottedPath) {
  const segments = String(dottedPath ?? ``).split(`.`);
  let current = target;
  for (const segment of segments) {
    current = current?.[segment];
  }
  return current;
}

function printCliValue(mode, dottedPath) {
  const policy = deriveRuntimePolicy();
  const value = getNestedValue(policy, dottedPath);

  if (mode === `array-lines`) {
    if (!Array.isArray(value)) process.exit(3);
    process.stdout.write(value.join(`\n`));
    return;
  }

  if (value === undefined || value === null) process.exit(2);
  if (typeof value === `object`) {
    process.stdout.write(JSON.stringify(value));
    return;
  }
  process.stdout.write(String(value));
}

if (require.main === module) {
  const [mode, dottedPath] = process.argv.slice(2);

  switch (mode) {
    case undefined:
    case `json`:
      process.stdout.write(JSON.stringify(deriveRuntimePolicy(), null, 2) + `\n`);
      break;
    case `value`:
      printCliValue(`value`, dottedPath);
      break;
    case `array-lines`:
      printCliValue(`array-lines`, dottedPath);
      break;
    default:
      console.error(`Unknown mode: ${mode}`);
      process.exit(1);
  }
}

module.exports = {
  deriveRuntimePolicy
};

Object.freeze(module.exports);
