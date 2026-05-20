// _core/services/certificate-service/certificate-service.js


'use strict';

const AdaptableUseCase = require(`@/_core/_ports/adaptable-use-case`);

/** Bootstrap-owned certificate lookup service backed by an adapter. */
class CertificateService extends AdaptableUseCase {
  /** @type {typeof import('@/config/default.config').adapters.certificateService} */
  config;
  kernelContext;

  constructor(kernelContext) {
    super(kernelContext.config._adapters.certificateService);
    this.kernelContext = kernelContext;
    this.config = kernelContext.config.adapters.certificateService ?? {};
    Object.freeze(this);
  }

  async getCertificatePath(domain, tenantId = null) {
    const normalizedDomain = String(domain ?? ``).trim().toLowerCase();
    const normalizedTenantId = tenantId == null ? null : String(tenantId ?? ``).trim();
    if (!normalizedDomain) {
      return null;
    }

    const getCertificatePathAdapter = this.adapter?.getCertificatePathAdapter;
    if (typeof getCertificatePathAdapter !== `function`) {
      return null;
    }

    const resolvedCertificate = await getCertificatePathAdapter({
      config: this.config,
      domain: normalizedDomain,
      tenantId: normalizedTenantId
    });
    if (resolvedCertificate) {
      return resolvedCertificate;
    }

    if (!normalizedTenantId) {
      return null;
    }

    const projectRegistryResolver = this.kernelContext?.useCases?.projectRegistryResolver
      ?? this.kernelContext?.useCases?.tenantRegistryResolver
      ?? null;
    if (!projectRegistryResolver) {
      return null;
    }
    const tenantRecord = projectRegistryResolver.getTenantRecordById?.(normalizedTenantId) ?? null;
    const certbotEmail = this.#resolveCertbotEmail(tenantRecord);

    const cooldownMs = Number(this.config.triggerCooldownMs ?? 0);
    const triggerState = projectRegistryResolver.getLetsEncryptTriggerState?.(normalizedTenantId, normalizedDomain) ?? null;
    const now = Date.now();
    if (triggerState && Number(triggerState.expiresAt ?? 0) > now) {
      return null;
    }

    try {
      const triggerResult = await this.#requestPrivilegedHostOperation(`certificate.issueLetsEncrypt`, {
        domain: normalizedDomain,
        issueCommandTemplate: this.#buildIssueCommandTemplate({
          domain: normalizedDomain,
          certbotEmail
        })
      });

      if (triggerResult?.started) {
        await projectRegistryResolver.markLetsEncryptTriggerStarted?.(normalizedTenantId, normalizedDomain, {
          startedAt: now,
          expiresAt: now + Math.max(0, cooldownMs),
          source: `certificate-service:auto-trigger`
        });
      }
    } catch (error) {
      console.error(`[CERTIFICATE SERVICE] Auto-issue trigger failed for ${normalizedDomain}`);
      console.error(error);
    }

    return null;
  }

  async #requestPrivilegedHostOperation(operation, payload = {}) {
    const rpcEndpoint = this.kernelContext?.useCases?.rpcEndpoint ?? null;
    if (!rpcEndpoint?.ask) {
      throw new Error(`certificate-service privileged host operation requires rpcEndpoint`);
    }
    const response = await rpcEndpoint.ask({
      target: `main`,
      question: `privilegedHostOperation`,
      data: { operation, payload }
    });
    if (response?.success === false) {
      const error = new Error(response?.error ?? `Privileged host operation failed`);
      error.details = response?.details ?? null;
      throw error;
    }
    return response?.result ?? null;
  }

  #resolveCertbotEmail(tenantRecord = null) {
    const tenantEmail = typeof tenantRecord?.certbotEmail === `string`
      ? tenantRecord.certbotEmail.trim()
      : ``;
    if (tenantEmail) {
      return tenantEmail;
    }

    const defaultEmail = typeof this.config.defaultCertbotEmail === `string`
      ? this.config.defaultCertbotEmail.trim()
      : ``;
    return defaultEmail || null;
  }

  #buildIssueCommandTemplate({
    domain,
    certbotEmail = null
  }) {
    const baseTemplate = Array.isArray(this.config.certbotIssueCommandTemplate)
      ? this.config.certbotIssueCommandTemplate.map((entry) => String(entry))
      : [];
    if (baseTemplate.length === 0) {
      throw new Error(`certificate-service requires certbotIssueCommandTemplate to trigger auto issuance`);
    }

    const hasEmailFlag = baseTemplate.includes(`--email`);
    const hasUnsafeNoEmailFlag = baseTemplate.includes(`--register-unsafely-without-email`);
    const nextTemplate = [...baseTemplate];

    if (!hasEmailFlag && !hasUnsafeNoEmailFlag) {
      if (certbotEmail) {
        nextTemplate.push(`--email`, certbotEmail);
      } else {
        nextTemplate.push(`--register-unsafely-without-email`);
      }
    }

    return nextTemplate.map((entry) => String(entry ?? ``).replaceAll(`{domain}`, String(domain ?? ``)));
  }
}

module.exports = CertificateService;
Object.freeze(module.exports);
