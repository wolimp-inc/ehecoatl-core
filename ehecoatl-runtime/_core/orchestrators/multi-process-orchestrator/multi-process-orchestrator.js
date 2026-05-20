// _core/orchestrators/multi-process-orchestrator/multi-process-orchestrator.js


'use strict';

const {
  getProcessLabel,
  getProcessBootstrapEntry,
  getRenderedProcessIdentity,
  getInternalScopePath
} = require(`@/contracts/utils`);

class MultiProcessOrchestrator {
  constructor(kernelContext) {
    this.kernelContext = kernelContext;
    this.processForkRuntime = kernelContext.useCases?.processForkRuntime ?? null;
  }

  async forkProcess(layerKey, processKey, context = {}) {
    if (!this.processForkRuntime?.launchProcess) {
      throw new Error(`MultiProcessOrchestrator requires processForkRuntime.launchProcess`);
    }

    const normalizedContext = normalizeForkContext(context);
    const launchOptions = this.#buildLaunchOptions(layerKey, processKey, normalizedContext);
    await this.processForkRuntime.launchProcess(launchOptions);

    return {
      success: true,
      skipped: false,
      existing: false,
      label: launchOptions.label,
      layerKey,
      processKey,
      reason: normalizedContext.reason ?? `fork`
    };
  }

  async ensureProcess(layerKey, processKey, context = {}) {
    const normalizedContext = normalizeForkContext(context);
    const label = getProcessLabel(layerKey, processKey, normalizedContext);
    if (!label) {
      return {
        success: false,
        skipped: true,
        reason: `missing_label`,
        layerKey,
        processKey
      };
    }

    const existing = this.processForkRuntime?.getProcessByLabel?.(label);
    if (existing) {
      return {
        success: true,
        skipped: true,
        existing: true,
        label,
        layerKey,
        processKey,
        reason: normalizedContext.reason ?? `ensure`
      };
    }

    return this.forkProcess(layerKey, processKey, normalizedContext);
  }

  async shutdownProcess(label, reason = `shutdown`, timeoutMs) {
    return this.processForkRuntime?.shutdownProcess?.(label, reason, timeoutMs) ?? false;
  }

  #buildLaunchOptions(layerKey, processKey, context) {
    const label = getProcessLabel(layerKey, processKey, context);
    if (!label) {
      throw new Error(`Unable to render process label for ${layerKey}.${processKey}`);
    }

    const bootstrapEntry = getProcessBootstrapEntry(layerKey, processKey);
    if (!bootstrapEntry) {
      throw new Error(`Missing bootstrap entry for ${layerKey}.${processKey}`);
    }

    const identity = getRenderedProcessIdentity(layerKey, processKey, context);
    const variables = buildProcessVariables(layerKey, processKey, {
      ...context,
      label
    });

    return {
      label,
      path: mapContractBootstrapEntryToRuntimeModule(bootstrapEntry),
      processUser: identity?.user ?? null,
      processGroup: identity?.group ?? null,
      processSecondGroup: identity?.secondGroup ?? null,
      processThirdGroup: identity?.thirdGroup ?? null,
      firewall: buildFirewallLaunchOptions(layerKey, processKey, context),
      variables,
      cwd: process.cwd(),
      serialization: `advanced`,
      env: { ...process.env }
    };
  }
}

function normalizeForkContext(context = {}) {
  const tenantId = context.project_id ?? context.projectId ?? context.tenant_id ?? context.tenantId ?? null;
  const appId = context.app_id ?? context.appId ?? null;
  const appName = context.appName ?? null;
  const appDomain = context.appDomain ?? null;
  const tenantDomain = context.projectDomain ?? context.tenantDomain ?? deriveTenantDomainFromAppDomain(appName, appDomain);

  return Object.freeze({
    ...context,
    projectId: tenantId,
    tenantId,
    appId,
    project_id: tenantId,
    tenant_id: tenantId,
    app_id: appId,
    projectDomain: tenantDomain,
    tenantDomain,
    projectRoot: context.projectRoot ?? context.tenantRoot ?? null,
    tenantRoot: context.projectRoot ?? context.tenantRoot ?? null,
    appRoot: context.appRoot ?? null,
    appDomain,
    appName,
    reason: context.reason ?? null
  });
}

function mapContractBootstrapEntryToRuntimeModule(bootstrapEntry) {
  const installationRoot = getInternalScopePath(`INTERNAL`, `installation`);
  if (typeof bootstrapEntry !== `string` || !bootstrapEntry.length) {
    return bootstrapEntry;
  }
  if (installationRoot && bootstrapEntry.startsWith(installationRoot)) {
    return `@${bootstrapEntry.slice(installationRoot.length)}`;
  }
  return bootstrapEntry;
}

function buildProcessVariables(layerKey, processKey, context) {
  if (layerKey === `supervisionScope` && processKey === `director`) {
    return [];
  }

  if ((layerKey === `projectScope` || layerKey === `tenantScope`) && processKey === `transport`) {
    return [
      context.tenantId,
      context.tenantDomain,
      context.tenantRoot,
      context.httpPort ?? null,
      context.wsPort ?? null,
      context.label
    ];
  }

  if (layerKey === `appScope` && processKey === `isolatedRuntime`) {
    return [
      context.tenantId,
      context.appId,
      context.appRoot,
      context.label,
      context.appDomain,
      context.appName
    ];
  }

  return [];
}

function buildFirewallLaunchOptions(layerKey, processKey, context) {
  if ((layerKey === `projectScope` || layerKey === `tenantScope`) && processKey === `transport`) {
    const localProxyPorts = [context.httpPort, context.wsPort]
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65535);

    return Object.freeze({
      localProxyPorts: [...new Set(localProxyPorts)]
    });
  }

  if (layerKey === `appScope` && processKey === `isolatedRuntime`) {
    const appSelector = buildAppSelector(context.appName, context.tenantDomain);
    return Object.freeze({
      appDomain: context.appDomain ?? null,
      appName: context.appName ?? null,
      appSelector,
      localProxyPorts: [],
      processKind: `app`
    });
  }

  return Object.freeze({
    localProxyPorts: []
  });
}

function buildAppSelector(appName, tenantDomain) {
  const normalizedAppName = typeof appName === `string` ? appName.trim() : ``;
  const normalizedTenantDomain = typeof tenantDomain === `string` ? tenantDomain.trim().toLowerCase() : ``;
  if (!normalizedAppName || !normalizedTenantDomain) return null;
  return `${normalizedAppName}@${normalizedTenantDomain}`;
}

function deriveTenantDomainFromAppDomain(appName, appDomain) {
  if (typeof appName !== `string` || typeof appDomain !== `string`) return null;
  const normalizedAppName = appName.trim().toLowerCase();
  const normalizedAppDomain = appDomain.trim().toLowerCase();
  const prefix = `${normalizedAppName}.`;
  if (!normalizedAppName || !normalizedAppDomain.startsWith(prefix)) return null;
  const tenantDomain = normalizedAppDomain.slice(prefix.length);
  return tenantDomain || null;
}

module.exports = MultiProcessOrchestrator;
Object.freeze(module.exports);
