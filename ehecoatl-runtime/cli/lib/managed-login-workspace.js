'use strict';

const path = require(`node:path`);

const context = require(path.join(__dirname, `..`, `..`, `contracts`, `context.js`));
const tenantLayout = require(path.join(__dirname, `..`, `..`, `utils`, `tenancy`, `tenant-layout.js`));

const superWorkspaceLinks = Object.freeze([
  Object.freeze({
    relativePath: `config`,
    targetPath: path.join(context.serviceOverrideRoot, `config`),
    scope: `super`
  }),
  Object.freeze({
    relativePath: `srv`,
    targetPath: context.serviceSrvRoot,
    scope: `super`
  }),
  Object.freeze({
    relativePath: `projects`,
    targetPath: context.serviceProjectsRoot,
    scope: `super`
  }),
  Object.freeze({
    relativePath: `tenants`,
    targetPath: context.serviceTenantsRoot,
    scope: `super`
  }),
  Object.freeze({
    relativePath: `logs`,
    targetPath: context.serviceLogRoot,
    scope: `super`
  }),
  Object.freeze({
    relativePath: `var`,
    targetPath: context.serviceVarRoot,
    scope: `super`
  }),
  Object.freeze({
    relativePath: `runtime`,
    targetPath: context.serviceLibRoot,
    scope: `super`
  })
]);

function buildManagedLoginWorkspacePlan({
  scopeSelectors = [],
  projectsBase = context.serviceProjectsRoot,
  tenantsBase = context.serviceTenantsRoot,
  legacyTenantsBase = tenantsBase,
  workspaceHome
} = {}) {
  const normalizedWorkspaceHome = String(workspaceHome ?? ``).trim();
  if (!normalizedWorkspaceHome) {
    throw new Error(`workspaceHome is required`);
  }

  const resolvedGroups = [];
  const resolvedScopes = [];

  for (const rawSelector of scopeSelectors) {
    const selector = String(rawSelector ?? ``).trim();
    if (!selector) continue;

    const resolvedScope = resolveScopeSelector({
      selector,
      projectsBase,
      tenantsBase,
      legacyTenantsBase
    });
    appendUnique(resolvedGroups, resolvedScope.group);
    resolvedScopes.push(resolvedScope);
  }

  if (resolvedGroups.length === 0) {
    throw new Error(`At least one valid scope selector is required.`);
  }

  const workspaceLinks = [];
  const seenRelativePaths = new Set();
  const hasSuperScope = resolvedScopes.some((entry) => entry.kind === `super`);

  if (hasSuperScope) {
    for (const link of superWorkspaceLinks) {
      pushWorkspaceLink({
        workspaceLinks,
        seenRelativePaths,
        workspaceHome: normalizedWorkspaceHome,
        ...link
      });
    }
  }

  for (const entry of resolvedScopes) {
    if (entry.kind === `project` && !hasSuperScope) {
      pushWorkspaceLink({
        workspaceLinks,
        seenRelativePaths,
        workspaceHome: normalizedWorkspaceHome,
        relativePath: `@${entry.projectDomain ?? entry.tenantDomain}`,
        targetPath: entry.projectRoot ?? entry.tenantRoot,
        scope: `project`,
        selector: entry.selector,
        tenantId: entry.tenantId
      });
    }

    if (entry.kind === `app` && !hasSuperScope) {
      pushWorkspaceLink({
        workspaceLinks,
        seenRelativePaths,
        workspaceHome: normalizedWorkspaceHome,
        relativePath: `${entry.appName}@${entry.tenantDomain}`,
        targetPath: entry.appRoot,
        scope: `app`,
        selector: entry.selector,
        tenantId: entry.tenantId,
        appId: entry.appId
      });
    }
  }

  return Object.freeze({
    workspaceHome: normalizedWorkspaceHome,
    resolvedGroups: Object.freeze([...resolvedGroups]),
    workspaceLinks: Object.freeze(workspaceLinks.map((entry) => Object.freeze({ ...entry })))
  });
}

function resolveScopeSelector({
  selector,
  projectsBase,
  tenantsBase,
  legacyTenantsBase
}) {
  if (selector === `super`) {
    return Object.freeze({
      kind: `super`,
      selector,
      group: `g_superScope`
    });
  }

  const appSelector = parseAppScopeSelector(selector);
  if (appSelector) {
    const appRecord = resolveAppScopeSelector({
      projectsBase,
      tenantsBase,
      legacyTenantsBase,
      selector,
      appName: appSelector.appName,
      tenantSelector: appSelector.tenantSelector
    });

    if (!appRecord) {
      throw new Error(`App selector '${selector}' not found.`);
    }

    return Object.freeze({
      kind: `app`,
      selector,
      group: `g_${appRecord.tenantId}_${appRecord.appId}`,
      tenantId: appRecord.tenantId,
      appId: appRecord.appId,
      tenantDomain: appRecord.tenantDomain,
      appName: appRecord.appName,
      tenantRoot: appRecord.tenantRoot,
      appRoot: appRecord.appRoot
    });
  }

  if (/^@[a-z0-9]{12}$/.test(selector)) {
    const tenantId = selector.slice(1);
    const tenantRecord = tenantLayout.findOpaqueTenantRecordByIdSync({
      projectsBase,
      tenantsBase,
      legacyTenantsBase,
      tenantId
    });

    if (!tenantRecord) {
      throw new Error(`Project selector '${selector}' not found.`);
    }

    return Object.freeze({
      kind: `project`,
      selector,
      group: `g_${tenantRecord.tenantId}`,
      projectId: tenantRecord.projectId ?? tenantRecord.tenantId,
      projectDomain: tenantRecord.projectDomain ?? tenantRecord.tenantDomain,
      projectRoot: tenantRecord.projectRoot ?? tenantRecord.tenantRoot,
      tenantId: tenantRecord.tenantId,
      tenantDomain: tenantRecord.tenantDomain,
      tenantRoot: tenantRecord.tenantRoot
    });
  }

  if (selector.startsWith(`@`)) {
    const tenantRecord = tenantLayout.findOpaqueTenantRecordByDomainSync({
      projectsBase,
      tenantsBase,
      legacyTenantsBase,
      tenantDomain: selector.slice(1)
    });

    if (!tenantRecord) {
      throw new Error(`Project selector '${selector}' not found.`);
    }

    return Object.freeze({
      kind: `project`,
      selector,
      group: `g_${tenantRecord.tenantId}`,
      projectId: tenantRecord.projectId ?? tenantRecord.tenantId,
      projectDomain: tenantRecord.projectDomain ?? tenantRecord.tenantDomain,
      projectRoot: tenantRecord.projectRoot ?? tenantRecord.tenantRoot,
      tenantId: tenantRecord.tenantId,
      tenantDomain: tenantRecord.tenantDomain,
      tenantRoot: tenantRecord.tenantRoot
    });
  }

  throw new Error(`Unsupported scope selector '${selector}'. Use 'super', '@<domain>', '@<project_id>', '<appname>@<domain>', or '<appname>@<project_id>'. Legacy tenant ids remain accepted.`);
}

function parseAppScopeSelector(selector) {
  const match = /^([^@\s]+)@(.+)$/.exec(selector);
  if (!match) return null;

  const appName = tenantLayout.normalizeAppName(match[1]);
  const tenantSelector = String(match[2] ?? ``).trim().toLowerCase();
  if (!appName || !tenantSelector) return null;

  return Object.freeze({
    appName,
    tenantSelector
  });
}

function resolveAppScopeSelector({
  projectsBase,
  tenantsBase,
  legacyTenantsBase,
  appName,
  tenantSelector
}) {
  if (/^[a-z0-9]{12}$/.test(tenantSelector)) {
    return tenantLayout.findOpaqueAppRecordByTenantIdAndAppNameSync({
      projectsBase,
      tenantsBase,
      legacyTenantsBase,
      tenantId: tenantSelector,
      appName
    });
  }

  return tenantLayout.findOpaqueAppRecordByDomainAndAppNameSync({
    projectsBase,
    tenantsBase,
    legacyTenantsBase,
    tenantDomain: tenantSelector,
    appName
  });
}

function appendUnique(target, value) {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function pushWorkspaceLink({
  workspaceLinks,
  seenRelativePaths,
  workspaceHome,
  relativePath,
  targetPath,
  scope,
  selector = null,
  tenantId = null,
  appId = null
}) {
  const normalizedRelativePath = String(relativePath ?? ``).trim();
  if (!normalizedRelativePath || seenRelativePaths.has(normalizedRelativePath)) {
    return;
  }

  seenRelativePaths.add(normalizedRelativePath);
  workspaceLinks.push({
    relativePath: normalizedRelativePath,
    linkPath: path.join(workspaceHome, normalizedRelativePath),
    targetPath,
    scope,
    selector,
    tenantId,
    appId
  });
}

module.exports = {
  buildManagedLoginWorkspacePlan
};

Object.freeze(module.exports);
