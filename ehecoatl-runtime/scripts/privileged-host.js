'use strict';

const path = require(`node:path`);
const { spawn } = require(`node:child_process`);
const fs = require(`node:fs`);
const {
  cleanupManagedCgroups,
  ensureManagedCgroup,
  registerManagedCgroupPid,
  releaseManagedCgroup
} = require(`./managed-cgroups`);

const {
  PRIVILEGED_HOST_BRIDGE_REQUEST,
  PRIVILEGED_HOST_BRIDGE_RESPONSE
} = require(`./privileged-host-bridge`);

const FIREWALL_COMMANDS_DIR = path.join(__dirname, `..`, `cli`, `commands`, `firewall`);
const FIREWALL_COMMAND_TIMEOUT_MS = 3000;
const HOST_COMMAND_TIMEOUT_MS = 5000;
const HOST_COMMAND_PATH_FALLBACKS = Object.freeze([
  `/usr/local/sbin`,
  `/usr/local/bin`,
  `/usr/sbin`,
  `/usr/bin`,
  `/sbin`,
  `/bin`
]);
const MANAGED_PROCESS_ENTRYPOINTS = Object.freeze([
  `process-director.js`,
  `process-transport.js`,
  `process-isolated-runtime.js`
]);
const MANAGED_PROCESS_SIGNALS = Object.freeze([
  `SIGKILL`,
  `SIGTERM`
]);
let managedCgroupCleanupTimer = null;
let managedCgroupCleanupPayload = null;

function runFirewallCommand(commandFile, args = [], {
  timeoutMs = FIREWALL_COMMAND_TIMEOUT_MS
} = {}) {
  const commandPath = path.join(FIREWALL_COMMANDS_DIR, commandFile);

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(commandPath, args, {
      cwd: path.join(__dirname, `..`),
      env: { ...process.env },
      stdio: [`ignore`, `inherit`, `inherit`],
      shell: false
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(`SIGKILL`); } catch { }
      reject(new Error(`Firewall command ${commandFile} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.once(`error`, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once(`exit`, (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(
        `Firewall command ${commandFile} failed (code=${code ?? `null`} signal=${signal ?? `null`})`
      ));
    });
  });
}

async function clearStaleFirewallStateBeforeBoot() {
  const cleanupCommands = [
    [`newtork_local_proxy.sh`, [`off`, `all`]],
    [`newtork_wan_block.sh`, [`off`, `all`]]
  ];

  await Promise.allSettled(cleanupCommands.map(([commandFile, args]) => (
    runFirewallCommand(commandFile, args).catch((error) => {
      console.error(`[BOOTSTRAP FIREWALL CLEANUP ERROR]`);
      console.error(error);
    })
  )));
}

function runHostCommand(command, args = [], {
  timeoutMs = HOST_COMMAND_TIMEOUT_MS
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = ``;
    let stderr = ``;
    const resolvedCommand = resolveHostBinary(command);
    const child = spawn(resolvedCommand, args, {
      cwd: path.join(__dirname, `..`),
      env: { ...process.env },
      stdio: [`ignore`, `pipe`, `pipe`],
      shell: false
    });

    child.stdout?.on(`data`, (chunk) => {
      if (stdout.length < 8192) stdout += String(chunk);
    });
    child.stderr?.on(`data`, (chunk) => {
      if (stderr.length < 8192) stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(`SIGKILL`); } catch { }
      const error = new Error(`Host command ${resolvedCommand} timed out after ${timeoutMs}ms`);
      error.code = `HOST_COMMAND_TIMEOUT`;
      reject(error);
    }, timeoutMs);
    timer.unref?.();

    child.once(`error`, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once(`exit`, (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({
          code,
          signal,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
        return;
      }

      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();
      const detailSuffix = [
        trimmedStderr ? `stderr=${trimmedStderr}` : ``,
        trimmedStdout ? `stdout=${trimmedStdout}` : ``
      ].filter(Boolean).join(`; `);
      const error = new Error(
        `Host command ${resolvedCommand} failed (code=${code ?? `null`} signal=${signal ?? `null`})`
        + (detailSuffix ? `: ${detailSuffix}` : ``)
      );
      error.code = `HOST_COMMAND_FAILED`;
      error.details = {
        stdout: trimmedStdout,
        stderr: trimmedStderr
      };
      reject(error);
    });
  });
}

function runDetachedHostCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const resolvedCommand = resolveHostBinary(command);
    const child = spawn(resolvedCommand, args, {
      cwd: path.join(__dirname, `..`),
      env: { ...process.env },
      stdio: [`ignore`, `ignore`, `ignore`],
      shell: false,
      detached: true
    });

    child.once(`error`, reject);
    child.once(`spawn`, () => {
      child.unref();
      resolve({
        pid: child.pid ?? null
      });
    });
  });
}

function resolveHostBinary(command) {
  const normalizedCommand = String(command ?? ``).trim();
  if (!normalizedCommand) {
    throw new Error(`Host command is required`);
  }
  if (path.isAbsolute(normalizedCommand) || normalizedCommand.includes(path.sep)) {
    return normalizedCommand;
  }

  const envPathEntries = String(process.env.PATH ?? ``)
    .split(path.delimiter)
    .map((entry) => String(entry ?? ``).trim())
    .filter(Boolean);
  const candidateDirs = [...new Set([
    ...envPathEntries,
    ...HOST_COMMAND_PATH_FALLBACKS
  ])];

  for (const directory of candidateDirs) {
    const candidatePath = path.join(directory, normalizedCommand);
    try {
      fs.accessSync(candidatePath, fs.constants.X_OK);
      return candidatePath;
    } catch { }
  }

  return normalizedCommand;
}

function normalizeCommandEntries(commandEntries, {
  placeholderDomain = ``
} = {}) {
  if (!Array.isArray(commandEntries) || commandEntries.length === 0) {
    throw new Error(`Privileged host operation requires a non-empty command array`);
  }

  return commandEntries.map((entry) => String(entry ?? ``).replaceAll(`{domain}`, placeholderDomain));
}

function assertManagedNginxPath(targetPath) {
  const normalizedPath = path.resolve(targetPath);
  const managedRoot = path.resolve(`/etc/nginx/conf.d/ehecoatl`);
  if (
    normalizedPath !== managedRoot &&
    !normalizedPath.startsWith(`${managedRoot}${path.sep}`)
  ) {
    const error = new Error(`Managed nginx path is outside the allowed root: ${targetPath}`);
    error.code = `INVALID_MANAGED_NGINX_PATH`;
    throw error;
  }
  return normalizedPath;
}

function assertManagedNginxIncludePath(targetPath) {
  const normalizedPath = path.resolve(targetPath);
  const expectedPath = path.resolve(`/etc/nginx/conf.d/ehecoatl.conf`);
  if (normalizedPath !== expectedPath) {
    const error = new Error(`Managed nginx include path is outside the allowed target: ${targetPath}`);
    error.code = `INVALID_MANAGED_NGINX_INCLUDE_PATH`;
    throw error;
  }
  return normalizedPath;
}

function assertTenantNginxLogPath(targetPath) {
  const normalizedPath = path.resolve(targetPath);
  const allowedRoots = [
    { root: path.resolve(`/var/opt/ehecoatl/projects`), prefix: `project_` },
    { root: path.resolve(`/var/opt/ehecoatl/tenants`), prefix: `tenant_` }
  ];
  const match = allowedRoots
    .map(({ root, prefix }) => ({
      prefix,
      relativePath: path.relative(root, normalizedPath)
    }))
    .find(({ relativePath }) => !relativePath.startsWith(`..`) && !path.isAbsolute(relativePath));
  const relativePath = match?.relativePath ?? `..`;
  const segments = relativePath.split(path.sep);
  const fileName = segments.at(-1);
  if (
    !match ||
    segments.length !== 4 ||
    !segments[0].startsWith(match.prefix) ||
    segments[1] !== `.ehecoatl` ||
    segments[2] !== `log` ||
    ![`nginx.access.log`, `nginx.error.log`].includes(fileName)
  ) {
    const error = new Error(`Tenant nginx log path is outside the allowed target: ${targetPath}`);
    error.code = `INVALID_TENANT_NGINX_LOG_PATH`;
    throw error;
  }
  return normalizedPath;
}

async function materializeTenantLogFile(filePath, {
  owner = null,
  group = null,
  directoryMode = `2775`,
  fileMode = `0664`
} = {}) {
  if (!filePath) return null;
  const normalizedPath = assertTenantNginxLogPath(filePath);
  await fs.promises.mkdir(path.dirname(normalizedPath), { recursive: true });
  const handle = await fs.promises.open(normalizedPath, `a`);
  await handle.close();

  const desiredUid = owner ? await resolveUid(owner) : null;
  const desiredGid = group ? await resolveGid(group) : null;
  if (desiredUid != null && desiredGid != null) {
    await attemptMetadataUpdate(() => fs.promises.chown(path.dirname(normalizedPath), desiredUid, desiredGid));
    await attemptMetadataUpdate(() => fs.promises.chown(normalizedPath, desiredUid, desiredGid));
  }
  await attemptMetadataUpdate(() => fs.promises.chmod(path.dirname(normalizedPath), Number.parseInt(String(directoryMode), 8)));
  await attemptMetadataUpdate(() => fs.promises.chmod(normalizedPath, Number.parseInt(String(fileMode), 8)));
  return normalizedPath;
}

async function truncateFileToLastLines(filePath, maxLines) {
  const normalizedPath = assertTenantNginxLogPath(filePath);
  const lineLimit = Number(maxLines);
  if (!Number.isInteger(lineLimit) || lineLimit < 1) return { truncated: false, lineCount: null };

  const content = await fs.promises.readFile(normalizedPath, `utf8`).catch((error) => {
    if (error?.code === `ENOENT`) return null;
    throw error;
  });
  if (content == null) return { truncated: false, lineCount: null };

  const hadTrailingNewline = content.endsWith(`\n`);
  const lines = content.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();
  if (lines.length <= lineLimit) {
    return { truncated: false, lineCount: lines.length };
  }

  await fs.promises.writeFile(
    normalizedPath,
    lines.slice(-lineLimit).join(`\n`) + (hadTrailingNewline ? `\n` : ``),
    `utf8`
  );
  return { truncated: true, lineCount: lineLimit };
}

async function resolveUid(userName) {
  const resolved = await runHostCommand(`id`, [`-u`, String(userName)]);
  const uid = Number.parseInt(String(resolved.stdout ?? ``).trim(), 10);
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error(`Could not resolve uid for user "${userName}"`);
  }
  return uid;
}

async function resolveGid(groupName) {
  const resolved = await runHostCommand(`getent`, [`group`, String(groupName)]);
  const parts = String(resolved.stdout ?? ``).trim().split(`:`);
  const gid = Number.parseInt(parts[2] ?? ``, 10);
  if (!Number.isInteger(gid) || gid < 0) {
    throw new Error(`Could not resolve gid for group "${groupName}"`);
  }
  return gid;
}

async function attemptMetadataUpdate(updateFn) {
  try {
    await updateFn();
    return true;
  } catch (error) {
    if ([`EPERM`, `EACCES`].includes(error?.code)) {
      return false;
    }
    throw error;
  }
}

function normalizePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    const error = new Error(`${label} must be a positive integer`);
    error.code = `INVALID_PRIVILEGED_PROCESS_TARGET`;
    throw error;
  }
  return parsed;
}

function normalizeManagedProcessSignal(signal) {
  const normalized = String(signal ?? `SIGKILL`).trim().toUpperCase();
  if (!MANAGED_PROCESS_SIGNALS.includes(normalized)) {
    const error = new Error(`Unsupported managed process signal "${signal}"`);
    error.code = `INVALID_PRIVILEGED_PROCESS_SIGNAL`;
    throw error;
  }
  return normalized;
}

async function readProcessCmdline(pid) {
  const content = await fs.promises.readFile(`/proc/${pid}/cmdline`).catch((error) => {
    if (error?.code === `ENOENT`) {
      const notFoundError = new Error(`Managed process ${pid} no longer exists`);
      notFoundError.code = `MANAGED_PROCESS_NOT_FOUND`;
      throw notFoundError;
    }
    throw error;
  });
  return String(content)
    .split(`\0`)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function assertManagedProcessCmdline(pid, args, expectedLabel = null) {
  const entrypoint = args.find((entry) => (
    MANAGED_PROCESS_ENTRYPOINTS.some((allowed) => entry === allowed || entry.endsWith(`/${allowed}`))
  ));
  if (!entrypoint) {
    const error = new Error(`Refusing to signal non-managed process ${pid}`);
    error.code = `UNMANAGED_PROCESS_TARGET`;
    error.details = { pid, args };
    throw error;
  }

  const label = String(expectedLabel ?? ``).trim();
  if (
    label &&
    label !== `director` &&
    !args.includes(label)
  ) {
    const error = new Error(`Managed process ${pid} does not match expected label "${label}"`);
    error.code = `MANAGED_PROCESS_LABEL_MISMATCH`;
    error.details = { pid, label, args };
    throw error;
  }

  return entrypoint;
}

async function signalManagedProcess(payload = {}) {
  const pid = normalizePositiveInteger(payload.pid, `pid`);
  const signal = normalizeManagedProcessSignal(payload.signal);
  const expectedLabel = String(payload.expectedLabel ?? ``).trim() || null;
  const args = await readProcessCmdline(pid);
  const entrypoint = assertManagedProcessCmdline(pid, args, expectedLabel);
  process.kill(pid, signal);
  return {
    pid,
    signal,
    entrypoint,
    expectedLabel,
    signaled: true
  };
}

function scheduleManagedCgroupCleanup(payload = {}) {
  managedCgroupCleanupPayload = {
    registryFile: payload.registryFile,
    cgroupFsRoot: payload.cgroupFsRoot,
    managedRootName: payload.managedRootName,
    delegateSubgroup: payload.delegateSubgroup,
    serviceCgroup: payload.serviceCgroup
  };

  if (managedCgroupCleanupTimer) return;

  const cleanupIntervalMs = normalizeCleanupIntervalMs(payload.cleanupIntervalMs);
  const runCleanup = () => {
    cleanupManagedCgroups(managedCgroupCleanupPayload ?? {})
      .catch((error) => {
        console.error(`[PRIVILEGED HOST] managed cgroup cleanup failed`);
        console.error(error);
      });
  };
  managedCgroupCleanupTimer = setInterval(runCleanup, cleanupIntervalMs);
  managedCgroupCleanupTimer.unref?.();
  runCleanup();
}

function normalizeCleanupIntervalMs(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000) return 30_000;
  return parsed;
}

async function handlePrivilegedBridgeOperation(operation, payload = {}) {
  switch (operation) {
    case `process.kill`:
      return await signalManagedProcess(payload);
    case `cgroup.ensure`: {
      const result = await ensureManagedCgroup(payload);
      scheduleManagedCgroupCleanup(payload);
      return result;
    }
    case `cgroup.registerPid`:
      return await registerManagedCgroupPid(payload);
    case `cgroup.release`:
      return await releaseManagedCgroup(payload);
    case `cgroup.cleanup`:
      return await cleanupManagedCgroups(payload);
    case `nginx.ensureManagedConfigDir`: {
      const targetDir = assertManagedNginxPath(String(payload.targetDir ?? ``));
      const owner = String(payload.owner ?? `ehecoatl`).trim() || `ehecoatl`;
      const group = String(payload.group ?? `g_directorScope`).trim() || `g_directorScope`;
      const mode = String(payload.mode ?? `2770`).trim() || `2770`;
      const desiredUid = await resolveUid(owner);
      const desiredGid = await resolveGid(group);
      const desiredMode = Number.parseInt(mode, 8);
      await fs.promises.mkdir(targetDir, { recursive: true });
      let currentStats = await fs.promises.stat(targetDir);
      let ownerAdjusted = false;
      let modeAdjusted = false;
      let ownershipUpdateSkipped = false;
      let modeUpdateSkipped = false;

      if (currentStats.uid !== desiredUid || currentStats.gid !== desiredGid) {
        ownerAdjusted = await attemptMetadataUpdate(() => fs.promises.chown(targetDir, desiredUid, desiredGid));
        ownershipUpdateSkipped = !ownerAdjusted;
        currentStats = await fs.promises.stat(targetDir);
      }
      if ((currentStats.mode & 0o7777) !== desiredMode) {
        modeAdjusted = await attemptMetadataUpdate(() => fs.promises.chmod(targetDir, desiredMode));
        modeUpdateSkipped = !modeAdjusted;
        currentStats = await fs.promises.stat(targetDir);
      }
      return {
        targetDir,
        ownerAdjusted,
        modeAdjusted,
        ownershipUpdateSkipped,
        modeUpdateSkipped,
        effectiveUid: currentStats.uid,
        effectiveGid: currentStats.gid,
        effectiveMode: (currentStats.mode & 0o7777).toString(8)
      };
    }
    case `nginx.ensureManagedIncludeFile`: {
      const targetPath = assertManagedNginxIncludePath(String(payload.targetPath ?? ``));
      const managedConfigDir = assertManagedNginxPath(String(payload.managedConfigDir ?? ``));
      const expectedContent = `# Ehecoatl managed nginx include root\ninclude ${managedConfigDir}/*.conf;\n`;
      const existingContent = await fs.promises.readFile(targetPath, `utf8`).catch((error) => {
        if (error?.code === `ENOENT`) {
          return null;
        }
        throw error;
      });

      if (existingContent !== expectedContent) {
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.promises.writeFile(targetPath, expectedContent, `utf8`);
      }

      let currentStats = await fs.promises.stat(targetPath);
      let ownerAdjusted = false;
      let modeAdjusted = false;
      let ownershipUpdateSkipped = false;
      let modeUpdateSkipped = false;
      const desiredMode = Number.parseInt(String(payload.mode ?? `644`).trim() || `644`, 8);

      if (currentStats.uid !== 0 || currentStats.gid !== 0) {
        ownerAdjusted = await attemptMetadataUpdate(() => fs.promises.chown(targetPath, 0, 0));
        ownershipUpdateSkipped = !ownerAdjusted;
        currentStats = await fs.promises.stat(targetPath);
      }
      if ((currentStats.mode & 0o7777) !== desiredMode) {
        modeAdjusted = await attemptMetadataUpdate(() => fs.promises.chmod(targetPath, desiredMode));
        modeUpdateSkipped = !modeAdjusted;
        currentStats = await fs.promises.stat(targetPath);
      }

      return {
        targetPath,
        managedConfigDir,
        ownerAdjusted,
        modeAdjusted,
        ownershipUpdateSkipped,
        modeUpdateSkipped,
        effectiveUid: currentStats.uid,
        effectiveGid: currentStats.gid,
        effectiveMode: (currentStats.mode & 0o7777).toString(8)
      };
    }
    case `nginx.writeManagedSource`: {
      const targetPath = assertManagedNginxPath(String(payload.targetPath ?? ``));
      const content = String(payload.content ?? ``);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.writeFile(targetPath, content, `utf8`);
      return { targetPath };
    }
    case `nginx.removeManagedSource`: {
      const targetPath = assertManagedNginxPath(String(payload.targetPath ?? ``));
      await fs.promises.rm(targetPath, { force: true });
      return { targetPath };
    }
    case `nginx.ensureTenantLogFiles`: {
      const accessLogPath = String(payload.accessLogPath ?? ``).trim();
      const errorLogPath = String(payload.errorLogPath ?? ``).trim();
      const metadata = {
        owner: String(payload.owner ?? ``).trim() || null,
        group: String(payload.group ?? ``).trim() || null,
        directoryMode: String(payload.directoryMode ?? `2775`).trim() || `2775`,
        fileMode: String(payload.fileMode ?? `0664`).trim() || `0664`
      };
      const materializedAccessLogPath = accessLogPath
        ? await materializeTenantLogFile(accessLogPath, metadata)
        : null;
      const materializedErrorLogPath = errorLogPath
        ? await materializeTenantLogFile(errorLogPath, metadata)
        : null;
      const truncateResult = materializedAccessLogPath
        ? await truncateFileToLastLines(materializedAccessLogPath, Number(payload.truncateAccessLogLines ?? 200))
        : { truncated: false, lineCount: null };
      return {
        accessLogPath: materializedAccessLogPath,
        errorLogPath: materializedErrorLogPath,
        accessLogTruncated: truncateResult.truncated,
        accessLogLineCount: truncateResult.lineCount
      };
    }
    case `firewall.localProxy.on`:
      return await runFirewallCommand(`newtork_local_proxy.sh`, [
        `on`,
        String(payload.processUser ?? ``),
        String(payload.openLocalPortsCsv ?? ``),
        String(payload.proxyPortsCsv ?? ``)
      ].filter((value, index) => index < 3 || value !== ``));
    case `firewall.localProxy.off`:
      return await runFirewallCommand(`newtork_local_proxy.sh`, [`off`, String(payload.processUser ?? ``)]);
    case `firewall.localProxy.offAll`:
      return await runFirewallCommand(`newtork_local_proxy.sh`, [`off`, `all`]);
    case `firewall.wanBlock.on`:
      return await runFirewallCommand(`newtork_wan_block.sh`, [
        `on`,
        String(payload.processUser ?? ``),
        String(payload.label ?? `unknown`)
      ]);
    case `firewall.wanBlock.off`:
      return await runFirewallCommand(`newtork_wan_block.sh`, [
        `off`,
        String(payload.processUser ?? ``),
        String(payload.label ?? `unknown`)
      ]);
    case `firewall.wanBlock.offAll`:
      return await runFirewallCommand(`newtork_wan_block.sh`, [`off`, `all`]);
    case `nginx.validate`: {
      const [binary, ...args] = Array.isArray(payload.testCommand) && payload.testCommand.length > 0
        ? payload.testCommand.map((entry) => String(entry))
        : [`nginx`, `-t`];
      return await runHostCommand(binary, args);
    }
    case `nginx.reload`: {
      const [reloadBinary, ...reloadArgs] = Array.isArray(payload.reloadCommand) && payload.reloadCommand.length > 0
        ? payload.reloadCommand.map((entry) => String(entry))
        : [`systemctl`, `reload`, `nginx`];
      const reloaded = await runHostCommand(reloadBinary, reloadArgs);
      return {
        tested: null,
        reloaded
      };
    }
    case `certificate.issueLetsEncrypt`: {
      const domain = String(payload.domain ?? ``).trim().toLowerCase();
      if (!domain) {
        throw new Error(`certificate.issueLetsEncrypt requires a domain`);
      }

      const issueCommand = normalizeCommandEntries(payload.issueCommandTemplate ?? [], {
        placeholderDomain: domain
      });
      const [issueBinary, ...issueArgs] = issueCommand;
      const started = await runDetachedHostCommand(issueBinary, issueArgs);

      return {
        domain,
        started: true,
        pid: started.pid ?? null
      };
    }
    default: {
      const error = new Error(`Unsupported privileged host operation "${operation}"`);
      error.code = `UNSUPPORTED_PRIVILEGED_HOST_OPERATION`;
      throw error;
    }
  }
}

function attachPrivilegedBridge(mainChild) {
  mainChild.on(`message`, async (message) => {
    if (!message || message.type !== PRIVILEGED_HOST_BRIDGE_REQUEST) return;
    try {
      console.log(`[PRIVILEGED HOST] root handling operation=${message.operation}`);
      const result = await handlePrivilegedBridgeOperation(message.operation, message.payload ?? {});
      console.log(`[PRIVILEGED HOST] root completed operation=${message.operation}`);
      mainChild.send({
        type: PRIVILEGED_HOST_BRIDGE_RESPONSE,
        requestId: message.requestId,
        success: true,
        result
      });
    } catch (error) {
      console.error(`[PRIVILEGED HOST] root failed operation=${message.operation}`);
      console.error(error);
      mainChild.send({
        type: PRIVILEGED_HOST_BRIDGE_RESPONSE,
        requestId: message.requestId,
        success: false,
        error: {
          code: error?.code ?? null,
          message: error?.message ?? String(error),
          details: error?.details ?? null
        }
      });
    }
  });
}

module.exports = {
  attachPrivilegedBridge,
  clearStaleFirewallStateBeforeBoot,
  handlePrivilegedBridgeOperation
};

Object.freeze(module.exports);
