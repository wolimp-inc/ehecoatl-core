'use strict';

/*
 * Nginx web-server adapter
 *
 * This adapter materializes one managed nginx config per exposed domain via
 * `updateSource(source, routeType, webServerConfig)`.
 *
 * Supported domain route types:
 * - `project` / `tenant`:
 *   Generates a normal project-facing vhost. The proxied request follows the
 *   standard project routing flow in the transport process. `tenant` remains
 *   accepted as the legacy route type.
 * - `app`:
 *   Generates a direct app-alias vhost. In this case the nginx config injects
 *   the internal routing header `X-Ehecoatl-Target-App-Id`, allowing ingress
 *   to bypass app-selection mode and tunnel the request directly to the target
 *   app inside the current project.
 *
 * TLS lookup behavior:
 * - Primary source:
 *   `certificateService.getCertificatePath(domain, projectId)`
 *   which currently resolves project-scope SSL first and Let's Encrypt second
 * - Fallback source:
 *   Ehecoatl generic placeholder certificate under internal-scope runtime SSL.
 *
 * So, yes:
 * - the service can materialize separate nginx configs for normal tenant domains
 *   and direct app domains;
 * - direct app domains are distinguished by the special internal header above;
 * - TLS lookup prefers the certificate-service result before the internal
 *   fallback certificate.
 */

const fs = require(`node:fs/promises`);
const path = require(`node:path`);
const { execFile } = require(`node:child_process`);
const { promisify } = require(`node:util`);

const WebServerServicePort = require(`@/_core/_ports/outbound/web-server-service-port`);
const { renderLayerPath, renderLayerPathEntry } = require(`@/contracts/utils`);
const { buildTenantSourceRenderModel, renderTenantTemplate } = require(`./source-renderer`);

const execFileAsync = promisify(execFile);
const adapterState = {
  config: null,
  dirty: false
};

WebServerServicePort.setupServerAdapter = async function setupServerAdapter(webServerConfig = {}) {
  const config = normalizeWebServerConfig(webServerConfig);
  adapterState.config = config;
  await ensureManagedConfigDir(config.managedConfigDir, webServerConfig);
  return {
    managedConfigDir: config.managedConfigDir
  };
};

WebServerServicePort.updateSourceAdapter = async function updateSourceAdapter(source, routeType = null, webServerConfig = {}) {
  const config = normalizeWebServerConfig(webServerConfig);
  adapterState.config = config;
  await ensureManagedConfigDir(config.managedConfigDir, webServerConfig);

  const sourceKey = String(source?.key ?? source?.domain ?? source?.projectId ?? source?.tenantId ?? ``).trim();
  if (!sourceKey) {
    throw new Error(`web-server-service nginx adapter requires source.key, source.domain or source.projectId`);
  }

  const normalizedRouteType = normalizeRouteType(routeType ?? source?.routeType ?? null);
  const forceReload = source?.forceReload === true;
  const tenantTemplatePath = await ensureTenantTemplatePath(source, config);
  const templateContent = await fs.readFile(tenantTemplatePath, `utf8`);
  const effectiveSource = await withEffectiveTls({
    ...source,
    routeType: normalizedRouteType
  }, config);
  const renderModel = buildTenantSourceRenderModel(effectiveSource);
  await ensureTenantLogFiles(effectiveSource, renderModel, webServerConfig);
  const renderedConfig = renderTenantTemplate(templateContent, effectiveSource);
  const targetPath = buildManagedSourcePath(sourceKey, config);
  const previousContent = await fs.readFile(targetPath, `utf8`).catch(() => null);

  if (previousContent === renderedConfig) {
    if (forceReload) {
      adapterState.dirty = true;
    }
    return {
      changed: false,
      reloadRequired: forceReload,
      sourceKey,
      targetPath,
      templatePath: tenantTemplatePath
    };
  }

  await writeManagedSource(targetPath, renderedConfig, webServerConfig);
  adapterState.dirty = true;

  return {
    changed: true,
    sourceKey,
    targetPath,
    templatePath: tenantTemplatePath
  };
};

WebServerServicePort.removeSourceAdapter = async function removeSourceAdapter(sourceKey, webServerConfig = {}) {
  const config = normalizeWebServerConfig(webServerConfig);
  adapterState.config = config;

  const normalizedSourceKey = String(sourceKey ?? ``).trim();
  if (!normalizedSourceKey) {
    throw new Error(`web-server-service nginx adapter requires a sourceKey`);
  }

  const targetPath = buildManagedSourcePath(normalizedSourceKey, config);
  const existed = await fs.access(targetPath).then(() => true).catch(() => false);
  if (!existed) {
    return {
      changed: false,
      sourceKey: normalizedSourceKey,
      targetPath
    };
  }

  try {
    await removeManagedSource(targetPath, webServerConfig);
    adapterState.dirty = true;
    return {
      changed: true,
      sourceKey: normalizedSourceKey,
      targetPath
    };
  } catch (error) {
    if (error?.code === `ENOENT`) {
      return {
        changed: false,
        sourceKey: normalizedSourceKey,
        targetPath
      };
    }
    throw error;
  }
};

WebServerServicePort.flushChangesAdapter = async function flushChangesAdapter(webServerConfig = {}) {
  const config = normalizeWebServerConfig(webServerConfig);
  adapterState.config = config;

  if (!adapterState.dirty) {
    return {
      changed: false,
      tested: false,
      reloaded: false
    };
  }

  try {
    if (typeof webServerConfig?.privilegedHostOperation === `function`) {
      await webServerConfig.privilegedHostOperation(`nginx.reload`, {
        testCommand: config.nginxTestCommand,
        reloadCommand: config.nginxReloadCommand
      });
    } else {
      await runCommand(config.nginxTestCommand);
      await runCommand(config.nginxReloadCommand);
    }
  } catch (error) {
    if (!isMissingNginxDependencyError(error)) {
      throw error;
    }

    console.warn(`[web-server-service.nginx] Nginx is unavailable; skipping config validation/reload until it is installed.`);
    return {
      changed: true,
      tested: false,
      reloaded: false
    };
  }
  adapterState.dirty = false;

  return {
    changed: true,
    tested: true,
    reloaded: true
  };
};

module.exports = WebServerServicePort;
Object.freeze(WebServerServicePort);

function normalizeWebServerConfig(webServerConfig = {}) {
  return Object.freeze({
    managedConfigDir: webServerConfig.managedConfigDir ?? `/etc/nginx/conf.d/ehecoatl`,
    managedIncludeFile: webServerConfig.managedIncludeFile ?? `/etc/nginx/conf.d/ehecoatl.conf`,
    managedConfigPrefix: webServerConfig.managedConfigPrefix ?? `project_`,
    managedConfigOwner: webServerConfig.managedConfigOwner ?? `ehecoatl`,
    managedConfigGroup: webServerConfig.managedConfigGroup ?? `g_directorScope`,
    managedConfigMode: String(webServerConfig.managedConfigMode ?? `2770`),
    genericTlsCertPath: webServerConfig.genericTlsCertPath ?? null,
    genericTlsKeyPath: webServerConfig.genericTlsKeyPath ?? null,
    nginxTestCommand: normalizeCommand(webServerConfig.nginxTestCommand ?? [`nginx`, `-t`], `nginxTestCommand`),
    nginxReloadCommand: normalizeCommand(webServerConfig.nginxReloadCommand ?? [`nginx`, `-s`, `reload`], `nginxReloadCommand`),
    defaultProjectKitName: webServerConfig.defaultProjectKitName ?? webServerConfig.defaultTenantKitName ?? `empty`,
    defaultProjectKitBaseDir: webServerConfig.defaultProjectKitBaseDir ?? `/srv/opt/ehecoatl/project-kits`,
    defaultTenantKitName: webServerConfig.defaultTenantKitName ?? `empty`,
    defaultTenantKitBaseDir: webServerConfig.defaultTenantKitBaseDir ?? `/srv/opt/ehecoatl/tenant-kits`,
    getCertificatePath: typeof webServerConfig.getCertificatePath === `function`
      ? webServerConfig.getCertificatePath
      : null
  });
}

function normalizeCommand(command, key) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error(`web-server-service nginx adapter requires ${key} to be a non-empty command array`);
  }
  return command.map((entry) => String(entry));
}

function isMissingNginxDependencyError(error) {
  const code = String(error?.code ?? ``).trim();
  const message = String(error?.message ?? ``);
  const stderr = String(error?.details?.stderr ?? ``);
  const combined = `${message}\n${stderr}`.toLowerCase();

  return code === `ENOENT`
    || combined.includes(`spawn nginx enoent`)
    || combined.includes(`unit nginx.service not found`)
    || combined.includes(`command not found`)
    || combined.includes(`no such file or directory`);
}

async function runCommand(command) {
  const [binary, ...args] = command;
  await execFileAsync(binary, args);
}

async function ensureManagedConfigDir(targetDir, webServerConfig = {}) {
  if (typeof webServerConfig?.privilegedHostOperation === `function`) {
    await webServerConfig.privilegedHostOperation(`nginx.ensureManagedIncludeFile`, {
      targetPath: adapterState.config?.managedIncludeFile ?? `/etc/nginx/conf.d/ehecoatl.conf`,
      managedConfigDir: targetDir,
      mode: `644`
    });
    await webServerConfig.privilegedHostOperation(`nginx.ensureManagedConfigDir`, {
      targetDir,
      owner: adapterState.config?.managedConfigOwner ?? `ehecoatl`,
      group: adapterState.config?.managedConfigGroup ?? `g_directorScope`,
      mode: adapterState.config?.managedConfigMode ?? `2770`
    });
    return;
  }
  await fs.mkdir(targetDir, { recursive: true });
  const managedIncludeFile = adapterState.config?.managedIncludeFile ?? `/etc/nginx/conf.d/ehecoatl.conf`;
  const includeContent = `# Ehecoatl managed nginx include root\ninclude ${targetDir}/*.conf;\n`;
  await fs.writeFile(managedIncludeFile, includeContent, `utf8`);
}

async function writeManagedSource(targetPath, content, webServerConfig = {}) {
  if (typeof webServerConfig?.privilegedHostOperation === `function`) {
    await webServerConfig.privilegedHostOperation(`nginx.writeManagedSource`, {
      targetPath,
      content
    });
    return;
  }
  await fs.writeFile(targetPath, content, `utf8`);
}

async function removeManagedSource(targetPath, webServerConfig = {}) {
  if (typeof webServerConfig?.privilegedHostOperation === `function`) {
    await webServerConfig.privilegedHostOperation(`nginx.removeManagedSource`, {
      targetPath
    });
    return;
  }
  await fs.rm(targetPath, { force: true });
}

async function ensureTenantLogFiles(source, renderModel, webServerConfig = {}) {
  const accessLogPath = String(renderModel?.accessLogPath ?? ``).trim();
  const errorLogPath = String(renderModel?.errorLogPath ?? ``).trim();
  if (!accessLogPath && !errorLogPath) return;

  const logRootEntry = renderLayerPathEntry(`projectScope`, `LOGS`, `root`, {
    tenant_id: source?.projectId ?? source?.tenantId ?? null,
    tenant_domain: source?.projectDomain ?? source?.tenantDomain ?? null
  });
  const fileMode = dirModeToFileMode(logRootEntry?.mode ?? `2775`);
  const payload = {
    accessLogPath,
    errorLogPath,
    owner: logRootEntry?.owner ?? null,
    group: logRootEntry?.group ?? null,
    directoryMode: logRootEntry?.mode ?? `2775`,
    fileMode,
    truncateAccessLogLines: 200
  };

  if (typeof webServerConfig?.privilegedHostOperation === `function`) {
    await webServerConfig.privilegedHostOperation(`nginx.ensureTenantLogFiles`, payload);
    return;
  }

  await materializeLogFile(accessLogPath, fileMode);
  await materializeLogFile(errorLogPath, fileMode);
  await truncateFileToLastLines(accessLogPath, payload.truncateAccessLogLines);
}

async function materializeLogFile(filePath, fileMode) {
  if (!filePath) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, `a`);
  await handle.close();
  await fs.chmod(filePath, Number.parseInt(fileMode, 8)).catch(() => { });
}

async function truncateFileToLastLines(filePath, maxLines) {
  const lineLimit = Number(maxLines);
  if (!filePath || !Number.isInteger(lineLimit) || lineLimit < 1) return;
  const content = await fs.readFile(filePath, `utf8`).catch((error) => {
    if (error?.code === `ENOENT`) return null;
    throw error;
  });
  if (content == null) return;

  const hadTrailingNewline = content.endsWith(`\n`);
  const lines = content.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();
  if (lines.length <= lineLimit) return;

  const truncated = lines.slice(-lineLimit).join(`\n`) + (hadTrailingNewline ? `\n` : ``);
  await fs.writeFile(filePath, truncated, `utf8`);
}

function dirModeToFileMode(mode = `2775`) {
  const modeDigits = String(mode).slice(-3);
  const owner = (Number.parseInt(modeDigits[0] ?? `7`, 8) & 6).toString(8);
  const group = (Number.parseInt(modeDigits[1] ?? `7`, 8) & 6).toString(8);
  const other = (Number.parseInt(modeDigits[2] ?? `5`, 8) & 6).toString(8);
  return `0${owner}${group}${other}`;
}

function buildManagedSourcePath(sourceKey, config) {
  return path.join(config.managedConfigDir, `${config.managedConfigPrefix}${sourceKey}.conf`);
}

async function ensureTenantTemplatePath(source, config) {
  const tenantRoot = String(source?.projectRoot ?? source?.tenantRoot ?? ``).trim();
  if (!tenantRoot) {
    throw new Error(`web-server-service nginx adapter requires source.projectRoot; legacy source.tenantRoot is still accepted`);
  }

  const tenantTemplatePath = path.join(tenantRoot, `.ehecoatl`, `lib`, `nginx.e.conf`);
  try {
    await fs.access(tenantTemplatePath);
    return tenantTemplatePath;
  } catch (error) {
    if (error?.code !== `ENOENT`) throw error;
  }

  const fallbackTemplatePath = await resolveDefaultTenantTemplatePath(config);
  const fallbackTemplateContent = await fs.readFile(fallbackTemplatePath, `utf8`);
  await fs.mkdir(path.dirname(tenantTemplatePath), { recursive: true });
  await fs.writeFile(tenantTemplatePath, fallbackTemplateContent, `utf8`);
  return tenantTemplatePath;
}

async function resolveDefaultTenantTemplatePath(config) {
  const customProjectKitTemplate = path.join(
    config.defaultProjectKitBaseDir,
    config.defaultProjectKitName,
    `.ehecoatl`,
    `lib`,
    `nginx.e.conf`
  );

  try {
    await fs.access(customProjectKitTemplate);
    return customProjectKitTemplate;
  } catch (error) {
    if (error?.code !== `ENOENT`) throw error;
  }

  const customTenantKitTemplate = path.join(
    config.defaultTenantKitBaseDir,
    config.defaultTenantKitName,
    `.ehecoatl`,
    `lib`,
    `nginx.e.conf`
  );

  try {
    await fs.access(customTenantKitTemplate);
    return customTenantKitTemplate;
  } catch (error) {
    if (error?.code !== `ENOENT`) throw error;
  }

  const packagedProjectTemplatePath = path.resolve(
    __dirname,
    `../../../../project-kits`,
    config.defaultProjectKitName,
    `.ehecoatl`,
    `lib`,
    `nginx.e.conf`
  );

  try {
    await fs.access(packagedProjectTemplatePath);
    return packagedProjectTemplatePath;
  } catch (error) {
    if (error?.code !== `ENOENT`) throw error;
  }

  const packagedTenantTemplatePath = path.resolve(
    __dirname,
    `../../../../tenant-kits`,
    config.defaultTenantKitName,
    `.ehecoatl`,
    `lib`,
    `nginx.e.conf`
  );
  await fs.access(packagedTenantTemplatePath);
  return packagedTenantTemplatePath;
}

async function withEffectiveTls(source, config = {}) {
  const domain = String(source?.domain ?? source?.projectDomain ?? source?.tenantDomain ?? ``).trim().toLowerCase();
  const configuredGenericCertPath = String(config?.genericTlsCertPath ?? ``).trim();
  const configuredGenericKeyPath = String(config?.genericTlsKeyPath ?? ``).trim();
  const genericSslRoot = configuredGenericCertPath && configuredGenericKeyPath
    ? ``
    : renderLayerPath(`supervisionScope`, `RUNTIME`, `ssl`, {});
  const genericCertPath = configuredGenericCertPath || (genericSslRoot ? path.join(genericSslRoot, `generic.fullchain.pem`) : ``);
  const genericKeyPath = configuredGenericKeyPath || (genericSslRoot ? path.join(genericSslRoot, `generic.privkey.pem`) : ``);

  const resolvedTls = typeof config?.getCertificatePath === `function`
    ? await config.getCertificatePath(domain, source?.projectId ?? source?.tenantId ?? null)
    : null;

  if (resolvedTls?.fullchainPath && resolvedTls?.privkeyPath) {
    return {
      ...source,
      effectiveTls: {
        mode: `tenant`,
        certPath: resolvedTls.fullchainPath,
        keyPath: resolvedTls.privkeyPath,
        httpsEnabled: true,
        httpRedirectToHttps: true
      }
    };
  }

  const genericHasTls = await filePairExists(genericCertPath, genericKeyPath);
  if (genericHasTls) {
    return {
      ...source,
      effectiveTls: {
        mode: `generic`,
        certPath: genericCertPath,
        keyPath: genericKeyPath,
        httpsEnabled: true,
        httpRedirectToHttps: false
      }
    };
  }

  return {
    ...source,
    effectiveTls: {
      mode: `none`,
      certPath: ``,
      keyPath: ``,
      httpsEnabled: false,
      httpRedirectToHttps: false
    }
  };
}

function normalizeRouteType(routeType) {
  const normalized = String(routeType ?? ``).trim().toLowerCase();
  if (normalized === `project` || normalized === `tenant` || normalized === `app`) {
    return normalized;
  }
  return `project`;
}

async function filePairExists(firstPath, secondPath) {
  if (!firstPath || !secondPath) return false;
  try {
    await fs.access(firstPath);
    await fs.access(secondPath);
    return true;
  } catch {
    return false;
  }
}
