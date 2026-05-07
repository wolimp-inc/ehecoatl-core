// _core/resolvers/tenant-directory-resolver/tenant-directory-resolver.js


'use strict';

const AdaptableUseCase = require(`@/_core/_ports/adaptable-use-case`);
const { getRenderedProcessIdentity } = require(`@/contracts/utils`);
const {
  buildTenantTransportLabel,
  buildIsolatedRuntimeLabel,
  parseTenantTransportLabel,
  parseIsolatedRuntimeLabel
} = require(`@/utils/process-labels`);

class TenantDirectoryResolver extends AdaptableUseCase {
  storageService;
  sharedCacheService;
  rpcEndpoint;
  tenantRegistryResolver;
  routeMatcherCompiler;
  config;
  plugin;
  registry;
  runtime;
  uriRouterRuntime;
  webServerService;
  processReloadQuestion;
  processShutdownQuestion;
  processEnsureQuestion;
  processListQuestion;
  spawnTenantAppAfterScan;
  scanTTL;
  scanActiveCacheKey;
  scanActiveTTL;
  responseCacheCleanupTTL;
  processRpcTimeoutMs;

  constructor(kernelContext) {
    super(kernelContext.config._adapters.tenantDirectoryResolver);
    this.config = kernelContext.config.adapters.tenantDirectoryResolver;
    this.plugin = kernelContext.pluginOrchestrator;
    this.storageService = kernelContext.useCases.storageService;
    this.sharedCacheService = kernelContext.useCases.sharedCacheService;
    this.rpcEndpoint = kernelContext.useCases?.rpcEndpoint ?? null;
    this.tenantRegistryResolver = kernelContext.useCases?.tenantRegistryResolver ?? null;
    this.routeMatcherCompiler = kernelContext.useCases?.tenantRouteMatcherCompiler ?? null;
    this.processReloadQuestion = kernelContext.config.adapters.watchdogOrchestrator?.question?.reloadProcess ?? `reloadProcess`;
    this.processShutdownQuestion = kernelContext.config.adapters.processForkRuntime?.question?.shutdownProcess ?? `shutdownProcess`;
    this.processEnsureQuestion = kernelContext.config.adapters.processForkRuntime?.question?.ensureProcess ?? `ensureProcess`;
    this.processListQuestion = kernelContext.config.adapters.processForkRuntime?.question?.listProcesses ?? `listProcesses`;
    this.spawnTenantAppAfterScan = this.config.spawnTenantAppAfterScan === true;
    this.processRpcTimeoutMs = Number(this.config.processRpcTimeoutMs ?? 2000);
    this.scanTTL = this.config.scanIntervalMs ?? 5 * 60 * 1000;
    this.scanActiveCacheKey = this.config.scanActiveCacheKey ?? null;
    this.scanActiveTTL = this.config.scanActiveTTL ?? 30_000;
    this.responseCacheCleanupTTL = this.config.responseCacheCleanupIntervalMs ?? this.scanTTL;
    this.registry = Object.freeze({
      hosts: new Map(),
      domains: new Map(),
      domainAliases: new Map(),
      appAliases: new Map(),
      invalidHosts: Object.freeze([])
    });
    this.runtime = {
      scanInterval: null,
      responseCacheCleanupInterval: null,
      firstScanPromise: null,
      activeScanPromise: null,
      queuedForcedScan: null,
      ready: false,
      lastScanAt: null,
      lastScanError: null,
      responseCacheCleanupPromise: null
    };
  }

  attachRouteRuntime(uriRouterRuntime) {
    this.uriRouterRuntime = uriRouterRuntime;
    return uriRouterRuntime;
  }

  attachTenantRegistryResolver(tenantRegistryResolver) {
    this.tenantRegistryResolver = tenantRegistryResolver;
    return tenantRegistryResolver;
  }

  attachRouteMatcherCompiler(routeMatcherCompiler) {
    this.routeMatcherCompiler = routeMatcherCompiler;
    return routeMatcherCompiler;
  }

  attachWebServerService(webServerService) {
    this.webServerService = webServerService;
    return webServerService;
  }

  getRegistry() {
    return this.registry;
  }

  getReadinessSnapshot() {
    return {
      ready: this.runtime.ready,
      lastScanAt: this.runtime.lastScanAt,
      lastScanError: this.runtime.lastScanError
    };
  }

  async scanRegistry() {
    try {
      const scanSummary = await this.adapter.scanTenantsAdapter({
        config: {
          ...this.config,
          registry: this.registry
        },
        storage: this.storageService,
        routeMatcherCompiler: this.routeMatcherCompiler
      }) ?? {};
      this.registry = scanSummary.registry ?? this.registry;
      this.runtime.ready = true;
      this.runtime.lastScanAt = Date.now();
      this.runtime.lastScanError = null;
      return scanSummary;
    } catch (error) {
      this.runtime.ready = false;
      this.runtime.lastScanError = error;
      throw error;
    }
  }

  async runScanCycle() {
    const cycleStartedAt = Date.now();
    await this.#markScanActive();
    try {
      const scanStartedAt = Date.now();
      let scanSummary = await this.scanRegistry();
      await this.#logRescanTenantsLine(`Tenancy scan adapter completed in ${Date.now() - scanStartedAt}ms`);
      const reconcileStartedAt = Date.now();
      const reconcileResult = await this.tenantRegistryResolver?.reconcileRegistry?.(this.registry, scanSummary) ?? {
        registry: this.registry,
        scanSummary
      };
      this.registry = reconcileResult.registry ?? this.registry;
      scanSummary = reconcileResult.scanSummary ?? scanSummary;
      await this.#logRescanTenantsLine(`Tenancy registry reconciliation completed in ${Date.now() - reconcileStartedAt}ms`);
      const registryPersistStartedAt = Date.now();
      await this.tenantRegistryResolver?.persistRegistry?.(this.registry, scanSummary);
      await this.#logRescanTenantsLine(`Tenancy registry persistence completed in ${Date.now() - registryPersistStartedAt}ms`);
      this.uriRouterRuntime?.handleRegistryUpdate?.(scanSummary);
      await this.#syncWebServerSources(scanSummary);
      const invalidationStartedAt = Date.now();
      await this.uriRouterRuntime?.invalidateSharedCaches?.();
      await this.#logRescanTenantsLine(`Tenancy shared-cache invalidation completed in ${Date.now() - invalidationStartedAt}ms`);
      const syncStartedAt = Date.now();
      await this.#syncTenantProcesses(scanSummary);
      await this.#logRescanTenantsLine(`Tenancy process reconciliation completed in ${Date.now() - syncStartedAt}ms`);
      await this.#logRescanTenantsLine(`Tenancy scan cycle completed in ${Date.now() - cycleStartedAt}ms`);
      return scanSummary;
    } finally {
      const clearMarkerStartedAt = Date.now();
      await this.#clearScanMarker();
      await this.#logRescanTenantsLine(`Tenancy scan marker clear completed in ${Date.now() - clearMarkerStartedAt}ms`);
    }
  }

  async #logRescanTenantsLine(message) {
    const directorHooks = this.plugin?.hooks?.DIRECTOR;
    if (directorHooks?.RESCAN_TENANTS === undefined || directorHooks.RESCAN_TENANTS === null) {
      console.log(message);
      return;
    }

    await this.plugin.run(directorHooks.RESCAN_TENANTS, {
      message,
      source: `tenant-directory-resolver`,
      stage: `tenancy-scan`
    }, directorHooks.PROCESS?.ERROR);
  }

  async scan() {
    if (!this.runtime.firstScanPromise) {
      this.runtime.firstScanPromise = this.#startScanCycle();
    }

    if (!this.runtime.scanInterval) {
      this.runtime.scanInterval = setInterval(() => {
        this.#startIntervalScan().catch(() => { });
      }, this.scanTTL);
      this.runtime.scanInterval?.unref();
    }

    if (!this.runtime.responseCacheCleanupInterval && this.responseCacheCleanupTTL > 0) {
      this.runtime.responseCacheCleanupInterval = setInterval(() => {
        this.cleanupInvalidResponseCacheArtifacts().catch(() => { });
      }, this.responseCacheCleanupTTL);
      this.runtime.responseCacheCleanupInterval?.unref();
      Promise.resolve().then(() => this.cleanupInvalidResponseCacheArtifacts()).catch(() => { });
    }

    await this.runtime.firstScanPromise;
  }

  async waitUntilReady() {
    if (!this.runtime.firstScanPromise) {
      throw new Error(`TenantDirectoryResolver first scan has not been started`);
    }

    await this.runtime.firstScanPromise;
    if (!this.runtime.ready) {
      throw new Error(`TenantDirectoryResolver is not ready for route resolution`);
    }
  }

  async cleanupInvalidResponseCacheArtifacts() {
    if (this.runtime.responseCacheCleanupPromise) {
      return this.runtime.responseCacheCleanupPromise;
    }

    this.runtime.responseCacheCleanupPromise = this.uriRouterRuntime?.cleanupInvalidResponseCacheArtifacts?.() ?? Promise.resolve(0);
    try {
      return await this.runtime.responseCacheCleanupPromise;
    } finally {
      this.runtime.responseCacheCleanupPromise = null;
    }
  }

  async destroy() {
    if (this.runtime.scanInterval) {
      clearInterval(this.runtime.scanInterval);
      this.runtime.scanInterval = null;
    }
    if (this.runtime.responseCacheCleanupInterval) {
      clearInterval(this.runtime.responseCacheCleanupInterval);
      this.runtime.responseCacheCleanupInterval = null;
    }
    this.runtime.firstScanPromise = null;
    this.runtime.activeScanPromise = null;
    this.runtime.queuedForcedScan = null;
    this.runtime.responseCacheCleanupPromise = null;
    this.runtime.ready = false;
    this.runtime.lastScanAt = null;
    this.runtime.lastScanError = null;
    await super.destroy();
  }

  async requestForcedScan({ reason = `manual` } = {}) {
    if (this.runtime.activeScanPromise) {
      return this.#queueForcedScan({ reason });
    }

    return this.#runForcedScan({
      reason,
      waitedForActiveScan: false,
      coalesced: false
    });
  }

  async #syncTenantProcesses(scanSummary = {}) {
    if (!this.rpcEndpoint) return;

    if (this.spawnTenantAppAfterScan) {
      await this.#reconcileTenantProcesses(scanSummary);
    }

    if (scanSummary?.initialScan) return;

    const changedHosts = Array.isArray(scanSummary.changedHosts) ? scanSummary.changedHosts : [];
    const removedHosts = Array.isArray(scanSummary.removedHosts) ? scanSummary.removedHosts : [];
    const pendingOperations = [];

    for (const host of changedHosts) {
      const routeData = this.registry.hosts.get(host) ?? null;
      if (!routeData?.tenantId || !routeData?.appId) continue;
      const label = buildIsolatedRuntimeLabel({
        tenantId: routeData.tenantId,
        appId: routeData.appId
      });
      pendingOperations.push(this.#runSupervisorOperation({
        action: `reload`,
        label,
        allowMissing: true,
        payload: {
          target: `main`,
          question: this.processReloadQuestion,
          data: {
            label,
            reason: `tenancy_scan_changed`
          }
        }
      }));
    }

    for (const host of removedHosts) {
      const previousRouteData = scanSummary?.previousRegistry?.hosts?.get?.(host) ?? null;
      if (!previousRouteData?.tenantId || !previousRouteData?.appId) continue;
      const label = buildIsolatedRuntimeLabel({
        tenantId: previousRouteData.tenantId,
        appId: previousRouteData.appId
      });
      pendingOperations.push(this.#runSupervisorOperation({
        action: `shutdown`,
        label,
        allowMissing: true,
        payload: {
          target: `main`,
          question: this.processShutdownQuestion,
          data: {
            label,
            reason: `tenancy_scan_removed`
          }
        }
      }));
    }

    await this.#awaitSupervisorOperations(pendingOperations, `changed-host sync`);
  }

  async #reconcileTenantProcesses(scanSummary = {}) {
    await this.#reconcileTenantTransportProcesses(scanSummary);
    await this.#reconcileIsolatedRuntimeProcesses(scanSummary);
  }

  async #reconcileTenantTransportProcesses(scanSummary = {}) {
    const activeTenants = Array.isArray(scanSummary.activeTenants) ? scanSummary.activeTenants : [];
    const processListing = await this.#listMainProcesses();
    const runningProcesses = Array.isArray(processListing?.processes) ? processListing.processes : [];
    const runningByLabel = new Map(
      runningProcesses
        .filter((processInfo) => typeof processInfo?.label === `string`)
        .map((processInfo) => [processInfo.label, processInfo])
    );
    const activeTransportSet = new Set(
      activeTenants.map((entry) => {
        try {
          return buildTenantTransportLabel({
            tenantId: entry?.tenantId
          });
        } catch {
          return null;
        }
      }).filter((label) => typeof label === `string` && label.length > 0)
    );
    const pendingOperations = [];

    for (const activeTenant of activeTenants) {
      const tenantId = activeTenant?.tenantId;
      if (!tenantId) continue;
      const label = buildTenantTransportLabel({ tenantId });
      const runningProcess = runningByLabel.get(label) ?? null;
      if (transportProcessHasDrift(runningProcess, activeTenant)) {
        pendingOperations.push((async () => {
          await this.#runSupervisorOperation({
            action: `shutdown`,
            label,
            allowMissing: true,
            payload: {
              target: `main`,
              question: this.processShutdownQuestion,
              data: {
                label,
                reason: `tenancy_scan_port_drift`
              }
            }
          });

          return this.#runSupervisorOperation({
            action: `ensure`,
            label,
            payload: {
              target: `main`,
              question: this.processEnsureQuestion,
              data: {
                reason: `tenancy_scan_ensure`,
                layerKey: `tenantScope`,
                processKey: `transport`,
                context: {
                  tenantId,
                  tenantDomain: activeTenant?.tenantDomain ?? null,
                  tenantRoot: activeTenant?.tenantRoot ?? null,
                  httpPort: activeTenant?.internalProxy?.httpPort ?? null,
                  wsPort: activeTenant?.internalProxy?.wsPort ?? null,
                  reason: `tenancy_scan_ensure`
                }
              }
            }
          });
        })());
        continue;
      }
      pendingOperations.push(this.#runSupervisorOperation({
        action: `ensure`,
        label,
        payload: {
          target: `main`,
          question: this.processEnsureQuestion,
          data: {
            reason: `tenancy_scan_ensure`,
            layerKey: `tenantScope`,
            processKey: `transport`,
            context: {
              tenantId,
              tenantDomain: activeTenant?.tenantDomain ?? null,
              tenantRoot: activeTenant?.tenantRoot ?? null,
              httpPort: activeTenant?.internalProxy?.httpPort ?? null,
              wsPort: activeTenant?.internalProxy?.wsPort ?? null,
              reason: `tenancy_scan_ensure`
            }
          }
        }
      }));
    }
    for (const processInfo of runningProcesses) {
      const label = processInfo?.label;
      if (!parseTenantTransportLabel(label)) continue;
      if (activeTransportSet.has(label)) continue;

      pendingOperations.push(this.#runSupervisorOperation({
        action: `shutdown`,
        label,
        allowMissing: true,
        payload: {
          target: `main`,
          question: this.processShutdownQuestion,
          data: {
            label,
            reason: `tenancy_scan_inactive_tenant`
          }
        }
      }));
    }

    await this.#awaitSupervisorOperations(pendingOperations, `transport reconcile`);
  }

  async #reconcileIsolatedRuntimeProcesses(scanSummary = {}) {
    const activeHosts = Array.isArray(scanSummary.activeHosts) ? scanSummary.activeHosts : [];
    const processListing = await this.#listMainProcesses();
    const runningProcesses = Array.isArray(processListing?.processes) ? processListing.processes : [];
    const runningByLabel = new Map(
      runningProcesses
        .filter((processInfo) => typeof processInfo?.label === `string`)
        .map((processInfo) => [processInfo.label, processInfo])
    );
    const activeHostSet = new Set(
      activeHosts.map((entry) => {
        try {
          return buildIsolatedRuntimeLabel({
            tenantId: entry?.tenantId,
            appId: entry?.appId
          });
        } catch {
          return null;
        }
      }).filter((label) => typeof label === `string` && label.length > 0)
    );
    const pendingOperations = [];

    for (const activeHost of activeHosts) {
      const tenantId = activeHost?.tenantId;
      const appId = activeHost?.appId;
      if (!tenantId || !appId) continue;
      const rootFolder = activeHost?.rootFolder ?? null;
      const label = buildIsolatedRuntimeLabel({ tenantId, appId });
      const runningProcess = runningByLabel.get(label) ?? null;
      if (isolatedRuntimeProcessHasDrift(runningProcess, activeHost)) {
        pendingOperations.push(this.#runSupervisorOperation({
          action: `shutdown`,
          label,
          allowMissing: true,
          payload: {
            target: `main`,
            question: this.processShutdownQuestion,
            data: {
              label,
              reason: `tenancy_scan_identity_drift`
            }
          }
        }));
      }
      pendingOperations.push(this.#runSupervisorOperation({
        action: `ensure`,
        label,
        payload: {
          target: `main`,
          question: this.processEnsureQuestion,
          data: {
            reason: `tenancy_scan_ensure`,
            layerKey: `appScope`,
            processKey: `isolatedRuntime`,
            context: {
              tenantId,
              appId,
              tenantDomain: activeHost?.tenantDomain ?? null,
              appDomain: activeHost?.domain ?? null,
              appName: activeHost?.appName ?? null,
              appRoot: rootFolder,
              reason: `tenancy_scan_ensure`
            }
          }
        }
      }));
    }

    for (const processInfo of runningProcesses) {
      const label = processInfo?.label;
      if (!parseIsolatedRuntimeLabel(label)) continue;
      if (activeHostSet.has(label)) continue;

      pendingOperations.push(this.#runSupervisorOperation({
        action: `shutdown`,
        label,
        allowMissing: true,
        payload: {
          target: `main`,
          question: this.processShutdownQuestion,
          data: {
            label,
            reason: `tenancy_scan_inactive_host`
          }
        }
      }));
    }

    await this.#awaitSupervisorOperations(pendingOperations, `isolated-runtime reconcile`);
  }

  async #syncWebServerSources(scanSummary = {}) {
    if (!this.webServerService) return;

    const previousSources = buildTenantSourceMap(scanSummary.previousRegistry);
    const nextSources = buildTenantSourceMap(this.registry);
    console.log(`[WEB SERVER SYNC] previous=${previousSources.size} next=${nextSources.size}`);
    const changedSourceKeys = collectChangedTenantSourceKeys({
      previousSources,
      nextSources,
      initialScan: scanSummary.initialScan === true
    });
    console.log(`[WEB SERVER SYNC] changed=${changedSourceKeys.join(`,`)}`);

    for (const sourceKey of changedSourceKeys) {
      const source = nextSources.get(sourceKey) ?? null;
      if (!source) continue;
      console.log(`[WEB SERVER SYNC] update start key=${sourceKey}`);
      await this.webServerService.updateSource({
        ...source,
        forceReload: scanSummary.initialScan === true
      }, source.routeType ?? null);
      console.log(`[WEB SERVER SYNC] update complete key=${sourceKey}`);
    }

    for (const sourceKey of previousSources.keys()) {
      if (nextSources.has(sourceKey)) continue;
      console.log(`[WEB SERVER SYNC] remove key=${sourceKey}`);
      await this.webServerService.removeSource(sourceKey);
    }

    console.log(`[WEB SERVER SYNC] flush start`);
    await this.webServerService.flushChanges();
    console.log(`[WEB SERVER SYNC] flush complete`);
  }

  async #markScanActive() {
    if (!this.scanActiveCacheKey) return;
    await this.sharedCacheService.set(this.scanActiveCacheKey, `1`, this.scanActiveTTL).catch(() => { });
  }

  async #clearScanMarker() {
    if (!this.scanActiveCacheKey) return;
    await this.sharedCacheService.delete(this.scanActiveCacheKey).catch(() => { });
  }

  async #startIntervalScan() {
    if (this.runtime.activeScanPromise) {
      return this.runtime.activeScanPromise;
    }

    return this.#startScanCycle();
  }

  #startScanCycle() {
    if (this.runtime.activeScanPromise) {
      return this.runtime.activeScanPromise;
    }

    const activePromise = this.runScanCycle();
    this.runtime.activeScanPromise = activePromise;
    if (!this.runtime.firstScanPromise) {
      this.runtime.firstScanPromise = activePromise;
    }

    activePromise.finally(() => {
      if (this.runtime.activeScanPromise === activePromise) {
        this.runtime.activeScanPromise = null;
      }

      const queuedForcedScan = this.runtime.queuedForcedScan;
      if (!queuedForcedScan) return;

      this.runtime.queuedForcedScan = null;
      this.#runForcedScan({
        reason: queuedForcedScan.reason,
        waitedForActiveScan: true,
        coalesced: queuedForcedScan.requestCount > 1
      }).then(queuedForcedScan.resolve, queuedForcedScan.reject);
    }).catch(() => { });

    return activePromise;
  }

  #queueForcedScan({ reason }) {
    if (this.runtime.queuedForcedScan) {
      this.runtime.queuedForcedScan.requestCount += 1;
      return this.runtime.queuedForcedScan.promise;
    }

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    this.runtime.queuedForcedScan = {
      reason,
      requestCount: 1,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise
    };

    return promise;
  }

  async #runForcedScan({ reason, waitedForActiveScan, coalesced }) {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    try {
      const scanSummary = await this.#startScanCycle();
      const finishedAtMs = Date.now();
      return {
        success: true,
        reason,
        waitedForActiveScan,
        coalesced,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        scanSummary
      };
    } catch (error) {
      const finishedAtMs = Date.now();
      return {
        success: false,
        reason,
        waitedForActiveScan,
        coalesced,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        error: error?.message ?? String(error)
      };
    }
  }

  async #askMainProcessRpc(payload = {}, {
    timeoutMs = this.processRpcTimeoutMs
  } = {}) {
    if (!this.rpcEndpoint) {
      throw new Error(`TenantDirectoryResolver RPC endpoint is not ready`);
    }

    const normalizedTimeoutMs = Number(timeoutMs);
    if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
      return this.rpcEndpoint.ask(payload);
    }

    let timer = null;
    try {
      return await Promise.race([
        this.rpcEndpoint.ask(payload),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(
              `TenantDirectoryResolver RPC timeout after ${normalizedTimeoutMs}ms for question "${payload?.question ?? `unknown`}" `
            ));
          }, normalizedTimeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #listMainProcesses() {
    const result = await this.#runSupervisorOperation({
      action: `list`,
      label: `main`,
      payload: {
        target: `main`,
        question: this.processListQuestion,
        data: {}
      }
    });
    return result;
  }

  async #runSupervisorOperation({
    action,
    label,
    payload,
    allowMissing = false
  }) {
    try {
      const result = await this.#askMainProcessRpc(payload);
      if (this.#isSupervisorOperationSuccessful({ action, result, allowMissing })) {
        return result;
      }

      const reason = result?.reason ?? result?.error ?? `unexpected_supervisor_response`;
      throw new Error(
        `Supervisor ${action} failed for ${label}: ${reason}`
      );
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      console.warn(
        `Tenancy supervisor ${action} failed for ${label}: ${normalizedError.message}`
      );
      throw normalizedError;
    }
  }

  #isSupervisorOperationSuccessful({ action, result, allowMissing = false }) {
    if (action === `list`) {
      return result?.success === true && Array.isArray(result?.processes);
    }

    if (allowMissing && result?.missing === true) {
      return true;
    }

    if (action === `ensure`) {
      return result?.success === true;
    }

    if (action === `shutdown` || action === `reload`) {
      return result?.success === true;
    }

    return result?.success === true;
  }

  async #awaitSupervisorOperations(pendingOperations, phaseLabel) {
    const results = await Promise.allSettled(pendingOperations);
    const failures = results.filter((result) => result.status === `rejected`);
    if (!failures.length) return results;

    const message = failures
      .map((result) => result.reason?.message ?? String(result.reason))
      .join(`; `);
    throw new Error(`Tenancy ${phaseLabel} failed: ${message}`);
  }
}

function buildTenantSourceMap(registry) {
  const sourceMap = new Map();
  if (!(registry?.domains instanceof Map)) return sourceMap;
  for (const tenantRecord of registry.domains.values()) {
    const tenantId = String(tenantRecord?.tenantId ?? ``).trim();
    if (!tenantId) continue;
    const tenantDomain = String(tenantRecord?.domain ?? ``).trim().toLowerCase();
    if (!tenantDomain) continue;
    const baseSource = {
      tenantId,
      tenantDomain,
      tenantRoot: tenantRecord.rootFolder ?? null,
      internalProxy: tenantRecord.internalProxy ?? null
    };
    const tenantDomains = [tenantDomain, ...(Array.isArray(tenantRecord.aliases) ? tenantRecord.aliases : [])]
      .map((domain) => String(domain ?? ``).trim().toLowerCase())
      .filter(Boolean);
    const appRoutingMode = String(tenantRecord?.appRouting?.mode ?? `subdomain`).trim().toLowerCase() === `path`
      ? `path`
      : `subdomain`;
    const defaultAppName = String(tenantRecord?.appRouting?.defaultAppName ?? `www`).trim().toLowerCase() || `www`;
    const tenantApps = collectTenantApps(registry, tenantId);

    if (appRoutingMode === `path`) {
      const pathModeApps = tenantApps.map((appRecord) => ({
        appId: appRecord.appId,
        appName: appRecord.appName
      }));
      for (const domain of tenantDomains) {
        const tenantKind = domain === tenantDomain ? `tenant-primary` : `tenant-alias`;
        registerSource(sourceMap, {
          ...baseSource,
          key: domain,
          kind: tenantKind,
          routeType: `tenant`,
          domain,
          appRoutingMode,
          apps: pathModeApps
        });
        registerSource(sourceMap, {
          ...baseSource,
          key: `www.${domain}`,
          kind: tenantKind,
          routeType: `tenant`,
          domain: `www.${domain}`,
          appRoutingMode,
          apps: pathModeApps
        });
      }
    }

    if (appRoutingMode === `subdomain`) {
      const defaultAppRecord = tenantApps.find((appRecord) => appRecord.appName === defaultAppName) ?? null;
      for (const domain of tenantDomains) {
        if (defaultAppRecord) {
          registerSource(sourceMap, {
            ...baseSource,
            key: domain,
            kind: `app-default-root`,
            routeType: `app`,
            domain,
            forcedAppId: defaultAppRecord.appId
          });
          registerSource(sourceMap, {
            ...baseSource,
            key: `${defaultAppName}.${domain}`,
            kind: `app-default-domain`,
            routeType: `app`,
            domain: `${defaultAppName}.${domain}`,
            forcedAppId: defaultAppRecord.appId
          });
        }

        for (const appRecord of tenantApps) {
          registerSource(sourceMap, {
            ...baseSource,
            key: `${appRecord.appName}.${domain}`,
            kind: `app-domain`,
            routeType: `app`,
            domain: `${appRecord.appName}.${domain}`,
            forcedAppId: appRecord.appId
          });
        }
      }
    }
  }

  if (!(registry?.appAliases instanceof Map)) return sourceMap;
  for (const appAliasRecord of registry.appAliases.values()) {
    const domain = String(appAliasRecord?.domain ?? ``).trim().toLowerCase();
    if (!domain) continue;
    const tenantRecord = registry.domains.get(String(appAliasRecord?.tenantDomain ?? ``).trim().toLowerCase()) ?? null;
    if (!tenantRecord?.tenantId) continue;
    registerSource(sourceMap, {
      key: domain,
      kind: `app-alias`,
      routeType: `app`,
      domain,
      tenantId: tenantRecord.tenantId,
      tenantDomain: tenantRecord.domain,
      tenantRoot: tenantRecord.rootFolder ?? null,
      internalProxy: tenantRecord.internalProxy ?? null,
      forcedAppId: appAliasRecord.appId ?? null
    });
  }
  return sourceMap;
}

function collectTenantApps(registry, tenantId) {
  const hosts = registry?.hosts instanceof Map ? registry.hosts : new Map();
  const appsById = new Map();
  for (const routeDataObject of hosts.values()) {
    if (String(routeDataObject?.tenantId ?? ``).trim() !== String(tenantId ?? ``).trim()) continue;
    const appId = String(routeDataObject?.appId ?? ``).trim();
    const appName = String(routeDataObject?.appName ?? ``).trim().toLowerCase();
    if (!appId || !appName) continue;
    if (!appsById.has(appId)) {
      appsById.set(appId, Object.freeze({ appId, appName }));
    }
  }
  return [...appsById.values()].sort((left, right) => left.appName.localeCompare(right.appName));
}

function registerSource(sourceMap, source) {
  const sourceKey = String(source?.key ?? source?.domain ?? ``).trim().toLowerCase();
  if (!sourceKey) return;
  const nextSource = Object.freeze({
    ...source,
    key: sourceKey,
    domain: String(source?.domain ?? sourceKey).trim().toLowerCase()
  });
  const previousSource = sourceMap.get(sourceKey) ?? null;
  if (previousSource) {
    if (sourcesTargetSameDestination(previousSource, nextSource)) {
      return;
    }
    throw new Error(`Web server source host "${sourceKey}" conflicts between "${describeSource(previousSource)}" and "${describeSource(nextSource)}"`);
  }
  sourceMap.set(sourceKey, nextSource);
}

function describeSource(source) {
  return `${source?.routeType ?? `unknown`}:${source?.kind ?? `unknown`}:${source?.tenantDomain ?? `unknown`}:${source?.forcedAppId ?? `none`}`;
}

function sourcesTargetSameDestination(left, right) {
  return JSON.stringify({
    routeType: left?.routeType ?? null,
    domain: left?.domain ?? null,
    tenantId: left?.tenantId ?? null,
    tenantDomain: left?.tenantDomain ?? null,
    tenantRoot: left?.tenantRoot ?? null,
    internalProxy: left?.internalProxy ?? null,
    forcedAppId: left?.forcedAppId ?? null,
    appRoutingMode: left?.appRoutingMode ?? null,
    apps: left?.apps ?? null
  }) === JSON.stringify({
    routeType: right?.routeType ?? null,
    domain: right?.domain ?? null,
    tenantId: right?.tenantId ?? null,
    tenantDomain: right?.tenantDomain ?? null,
    tenantRoot: right?.tenantRoot ?? null,
    internalProxy: right?.internalProxy ?? null,
    forcedAppId: right?.forcedAppId ?? null,
    appRoutingMode: right?.appRoutingMode ?? null,
    apps: right?.apps ?? null
  });
}

function collectChangedTenantSourceKeys({
  previousSources,
  nextSources,
  initialScan
}) {
  if (initialScan) {
    return [...nextSources.keys()];
  }

  const keys = [];
  for (const [sourceKey, nextSource] of nextSources.entries()) {
    const previousSource = previousSources.get(sourceKey) ?? null;
    if (stableSerializeTenantSource(previousSource) !== stableSerializeTenantSource(nextSource)) {
      keys.push(sourceKey);
    }
  }
  return keys;
}

function stableSerializeTenantSource(source) {
  if (!source) return null;
  return JSON.stringify({
    kind: source.kind ?? null,
    routeType: source.routeType ?? null,
    domain: source.domain ?? null,
    tenantId: source.tenantId,
    tenantDomain: source.tenantDomain,
    tenantRoot: source.tenantRoot,
    internalProxy: source.internalProxy ?? null,
    forcedAppId: source.forcedAppId ?? null
  });
}

function transportProcessHasDrift(processInfo, activeTenant) {
  if (!processInfo) return false;
  const variables = Array.isArray(processInfo.variables) ? processInfo.variables : [];
  const expectedHttpPort = String(activeTenant?.internalProxy?.httpPort ?? ``);
  const expectedWsPort = String(activeTenant?.internalProxy?.wsPort ?? ``);
  const expectedUser = String(activeTenant?.transportProcessUser ?? ``);
  const expectedGroup = String(activeTenant?.transportProcessGroup ?? ``);
  const expectedSecondGroup = String(activeTenant?.transportProcessSecondGroup ?? ``);
  const expectedThirdGroup = String(activeTenant?.transportProcessThirdGroup ?? ``);
  return String(variables[3] ?? ``) !== expectedHttpPort
    || String(variables[4] ?? ``) !== expectedWsPort
    || String(processInfo?.processUser ?? ``) !== expectedUser
    || String(processInfo?.processGroup ?? ``) !== expectedGroup
    || String(processInfo?.processSecondGroup ?? ``) !== expectedSecondGroup
    || String(processInfo?.processThirdGroup ?? ``) !== expectedThirdGroup;
}

function isolatedRuntimeProcessHasDrift(processInfo, activeHost) {
  if (!processInfo) return false;
  const expectedIdentity = getRenderedProcessIdentity(`appScope`, `isolatedRuntime`, {
    tenant_id: activeHost?.tenantId ?? null,
    app_id: activeHost?.appId ?? null
  }) ?? {};

  return String(processInfo?.processUser ?? ``) !== String(expectedIdentity.user ?? ``)
    || String(processInfo?.processGroup ?? ``) !== String(expectedIdentity.group ?? ``)
    || String(processInfo?.processSecondGroup ?? ``) !== String(expectedIdentity.secondGroup ?? ``)
    || String(processInfo?.processThirdGroup ?? ``) !== String(expectedIdentity.thirdGroup ?? ``);
}

module.exports = TenantDirectoryResolver;
module.exports.buildTenantSourceMapForTests = buildTenantSourceMap;
Object.freeze(module.exports);
