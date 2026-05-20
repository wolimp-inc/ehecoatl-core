// _core/resolvers/project-registry-resolver/project-registry-resolver.js


'use strict';

const fs = require(`node:fs/promises`);
const path = require(`node:path`);
const AdaptableUseCase = require(`@/_core/_ports/adaptable-use-case`);
const runtimePackage = require(`@package.json`);
const {
  getInternalScopePath,
  getSupervisionScopePath,
  getRenderedProcessIdentity
} = require(`@/contracts/utils`);
const { reconcileRegistryState } = require(`@/_core/resolvers/tenant-registry-resolver/reconcile-registry-state`);

class ProjectRegistryResolver extends AdaptableUseCase {
  config;
  storageService;
  projectsPath;
  tenantsPath;
  registryPath;
  installRegistryPath;
  registry = null;

  constructor(kernelContext) {
    super(kernelContext.config._adapters.projectRegistryResolver);
    this.config = kernelContext.config.adapters.projectRegistryResolver ?? {};
    this.storageService = kernelContext.useCases.storageService;
    this.projectsPath = getSupervisionScopePath(`RUNTIME`, `projects`);
    this.tenantsPath = getSupervisionScopePath(`RUNTIME`, `tenants`);
    this.registryPath = getSupervisionScopePath(`RUNTIME`, `registry`);
    this.installRegistryPath = this.registryPath ? path.join(this.registryPath, `install.json`) : null;
  }

  async reconcileRegistry(registry, scanSummary = null) {
    const persistedTenantsById = await this.#loadPersistedTenantSnapshots();
    const portStart = Number(this.config.internalProxyPortStart ?? 14_002);
    const portEnd = Number(this.config.internalProxyPortEnd ?? 65_534);
    const reconciledRegistry = reconcileRegistryState({
      registry,
      persistedTenantsById,
      portStart,
      portEnd
    });
    this.registry = reconciledRegistry;

    return {
      registry: reconciledRegistry,
      scanSummary: {
        ...(scanSummary ?? {}),
        registry: reconciledRegistry,
        activeProjects: [...reconciledRegistry.domains.values()].map((tenantRecord) => ({
          projectId: tenantRecord.projectId ?? tenantRecord.tenantId,
          projectDomain: tenantRecord.projectDomain ?? tenantRecord.domain,
          projectRoot: tenantRecord.projectRoot ?? tenantRecord.rootFolder ?? null,
          tenantId: tenantRecord.tenantId,
          tenantDomain: tenantRecord.domain,
          tenantRoot: tenantRecord.rootFolder ?? null,
          aliases: tenantRecord.aliases ?? [],
          internalProxy: tenantRecord.internalProxy ?? null,
          ...buildTransportProcessIdentity(tenantRecord.tenantId)
        })),
        activeTenants: [...reconciledRegistry.domains.values()].map((tenantRecord) => ({
          projectId: tenantRecord.projectId ?? tenantRecord.tenantId,
          projectDomain: tenantRecord.projectDomain ?? tenantRecord.domain,
          projectRoot: tenantRecord.projectRoot ?? tenantRecord.rootFolder ?? null,
          tenantId: tenantRecord.tenantId,
          tenantDomain: tenantRecord.domain,
          tenantRoot: tenantRecord.rootFolder ?? null,
          aliases: tenantRecord.aliases ?? [],
          internalProxy: tenantRecord.internalProxy ?? null,
          ...buildTransportProcessIdentity(tenantRecord.tenantId)
        }))
      }
    };
  }

  async persistRegistry(registry, scanSummary = null) {
    this.registry = registry;

    if (!this.projectsPath || !this.registryPath) {
      throw new Error(`ProjectRegistryResolver requires supervision-scope contract paths RUNTIME.projects and RUNTIME.registry`);
    }

    const persistRegistryAdapter = this.adapter?.persistRegistryAdapter;
    if (typeof persistRegistryAdapter !== `function`) {
      return {
        registryPath: this.registryPath,
        tenantCount: 0,
        appCount: 0
      };
    }

    return await persistRegistryAdapter({
      config: this.config,
      storage: this.storageService,
      registry,
      scanSummary,
      projectsPath: this.projectsPath,
      tenantsPath: this.tenantsPath,
      registryPath: this.registryPath,
      snapshotMetadata: await this.#loadSnapshotMetadata()
    });
  }

  getTenantRecordById(tenantId) {
    const normalizedTenantId = String(tenantId ?? ``).trim();
    if (!normalizedTenantId || !(this.registry?.domains instanceof Map)) {
      return null;
    }

    for (const tenantRecord of this.registry.domains.values()) {
      if (String(tenantRecord?.tenantId ?? ``).trim() === normalizedTenantId) {
        return tenantRecord;
      }
    }

    return null;
  }

  getLetsEncryptTriggerState(tenantId, domain) {
    const normalizedDomain = String(domain ?? ``).trim().toLowerCase();
    const tenantRecord = this.getTenantRecordById(tenantId);
    if (!tenantRecord || !normalizedDomain) return null;
    return tenantRecord?.certificateAutomation?.letsEncryptTriggeredDomains?.[normalizedDomain] ?? null;
  }

  async markLetsEncryptTriggerStarted(tenantId, domain, {
    startedAt = Date.now(),
    expiresAt = startedAt,
    source = `certificate-service`
  } = {}) {
    const normalizedDomain = String(domain ?? ``).trim().toLowerCase();
    const normalizedTenantId = String(tenantId ?? ``).trim();
    if (!normalizedTenantId || !normalizedDomain) {
      throw new Error(`markLetsEncryptTriggerStarted requires projectId and domain`);
    }
    if (!(this.registry?.domains instanceof Map)) {
      throw new Error(`Project registry is not available for certificate trigger persistence`);
    }

    let matchedDomainKey = null;
    let matchedRecord = null;
    for (const [domainKey, tenantRecord] of this.registry.domains.entries()) {
      if (String(tenantRecord?.tenantId ?? ``).trim() !== normalizedTenantId) continue;
      matchedDomainKey = domainKey;
      matchedRecord = tenantRecord;
      break;
    }

    if (!matchedDomainKey || !matchedRecord) {
      throw new Error(`Unable to find project ${normalizedTenantId} in runtime registry`);
    }

    const previousAutomation = matchedRecord.certificateAutomation ?? { letsEncryptTriggeredDomains: {} };
    const previousTriggered = previousAutomation.letsEncryptTriggeredDomains ?? {};
    const nextTriggerEntry = Object.freeze({
      startedAt: Number(startedAt) || Date.now(),
      expiresAt: Number(expiresAt) || Number(startedAt) || Date.now(),
      source: String(source ?? `certificate-service`)
    });
    const nextAutomation = Object.freeze({
      letsEncryptTriggeredDomains: Object.freeze({
        ...previousTriggered,
        [normalizedDomain]: nextTriggerEntry
      })
    });

    const nextDomains = new Map(this.registry.domains);
    nextDomains.set(matchedDomainKey, Object.freeze({
      ...matchedRecord,
      certificateAutomation: nextAutomation
    }));

    this.registry = Object.freeze({
      ...this.registry,
      domains: nextDomains
    });

    await this.persistRegistry(this.registry);
    return nextTriggerEntry;
  }

  async #loadPersistedTenantSnapshots() {
    const tenantsById = new Map();
    const entries = await fs.readdir(this.registryPath, { withFileTypes: true }).catch((error) => {
      if (error?.code === `ENOENT`) return [];
      throw error;
    });

    for (const entry of entries) {
      if (!entry?.isDirectory?.()) continue;
      const entryName = String(entry.name ?? ``);
      if (!/^(?:project|tenant)_[a-z0-9]{12}$/i.test(entryName)) continue;
      const tenantIdFromFolder = entryName.replace(/^(?:project|tenant)_/i, ``);
      const snapshotPath = path.join(this.registryPath, entryName, buildTenantSnapshotFileName(tenantIdFromFolder));
      const rawContent = await fs.readFile(snapshotPath, `utf8`).catch(() => null);
      if (!rawContent) continue;
      try {
        const snapshot = JSON.parse(rawContent);
        const tenantId = String(snapshot?.tenantId ?? ``).trim();
        if (!tenantId) continue;
        tenantsById.set(tenantId, snapshot);
      } catch {
      }
    }

    return tenantsById;
  }

  async #loadSnapshotMetadata() {
    let installId = null;

    if (this.installRegistryPath) {
      const rawInstallRegistry = await fs.readFile(this.installRegistryPath, `utf8`).catch(() => null);
      if (rawInstallRegistry) {
        try {
          installId = String(JSON.parse(rawInstallRegistry)?.installId ?? ``).trim() || null;
        } catch {
        }
      }
    }

    return Object.freeze({
      installId,
      ehecoatlVersion: String(runtimePackage?.version ?? ``).trim() || null
    });
  }
}

function buildTenantSnapshotFileName(tenantId) {
  return `snapshot_${tenantId}.json`;
}

function buildTransportProcessIdentity(tenantId) {
  const identity = getRenderedProcessIdentity(`projectScope`, `transport`, {
    tenant_id: tenantId
  }) ?? {};

  return Object.freeze({
    transportProcessUser: identity.user ?? null,
    transportProcessGroup: identity.group ?? null,
    transportProcessSecondGroup: identity.secondGroup ?? null,
    transportProcessThirdGroup: identity.thirdGroup ?? null
  });
}

module.exports = ProjectRegistryResolver;
Object.freeze(module.exports);
