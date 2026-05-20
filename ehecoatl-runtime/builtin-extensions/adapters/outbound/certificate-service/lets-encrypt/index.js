// builtin-extensions/adapters/inbound/certificate-service/lets-encrypt/index.js


'use strict';

const fs = require(`node:fs`);
const path = require(`node:path`);
const CertificateServicePort = require(`@/_core/_ports/outbound/certificate-service-port`);
const { renderLayerPath } = require(`@/contracts/utils`);
const { findOpaqueTenantRecordByIdSync } = require(`@/utils/tenancy/tenant-layout`);

CertificateServicePort.getCertificatePathAdapter = async function getCertificatePathAdapter({
  domain,
  tenantId = null,
  config = {}
}) {
  const normalizedDomain = String(domain ?? ``).trim().toLowerCase();
  if (!normalizedDomain) {
    return null;
  }

  const normalizedTenantId = String(tenantId ?? ``).trim().toLowerCase();
  if (normalizedTenantId) {
    const tenantRecord = findOpaqueTenantRecordByIdSync({
      projectsBase: String(config.projectsBase ?? `/var/opt/ehecoatl/projects`),
      tenantsBase: String(config.tenantsBase ?? `/var/opt/ehecoatl/tenants`),
      legacyTenantsBase: String(config.legacyTenantsBase ?? config.tenantsBase ?? `/var/opt/ehecoatl/tenants`),
      tenantId: normalizedTenantId
    });
    const tenantSslRoot = renderLayerPath(tenantRecord?.projectRoot ? `projectScope` : `tenantScope`, `RUNTIME`, `ssl`, {
      tenant_id: normalizedTenantId,
      tenant_domain: tenantRecord?.projectDomain ?? tenantRecord?.tenantDomain ?? null
    });
    const tenantDomainDir = tenantSslRoot ? path.join(tenantSslRoot, normalizedDomain) : ``;
    const tenantFullchainPath = tenantDomainDir ? path.join(tenantDomainDir, `fullchain.pem`) : ``;
    const tenantPrivkeyPath = tenantDomainDir ? path.join(tenantDomainDir, `privkey.pem`) : ``;

    if (filePairExists(tenantFullchainPath, tenantPrivkeyPath)) {
      return {
        domain: normalizedDomain,
        fullchainPath: tenantFullchainPath,
        privkeyPath: tenantPrivkeyPath
      };
    }
  }

  const liveBaseDir = String(config.liveBaseDir ?? `/etc/letsencrypt/live`);
  const letsEncryptDomainDir = path.join(liveBaseDir, normalizedDomain);
  const fullchainPath = path.join(letsEncryptDomainDir, `fullchain.pem`);
  const privkeyPath = path.join(letsEncryptDomainDir, `privkey.pem`);

  if (filePairExists(fullchainPath, privkeyPath)) {
    return {
      domain: normalizedDomain,
      fullchainPath,
      privkeyPath
    };
  }

  return null;
};

module.exports = CertificateServicePort;
Object.freeze(module.exports);

function filePairExists(fullchainPath, privkeyPath) {
  if (!fullchainPath || !privkeyPath) return false;
  return fs.existsSync(fullchainPath) && fs.existsSync(privkeyPath);
}
