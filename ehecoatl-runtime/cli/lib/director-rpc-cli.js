'use strict';

require(`../../utils/register-module-aliases`);

const net = require(`node:net`);

const loadUserConfig = require(`../../config/default.user.config`);
const { getDirectorRpcSocketPath } = require(`../../utils/process/director-rpc-socket`);

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  const wantsJson = args.includes(`--json`);

  switch (command) {
    case `rescan-projects`:
    case `rescan-tenants`: {
      const config = await loadUserConfig();
      const question = config.adapters.projectDirectoryResolver?.question?.forceRescanNow
        ?? config.adapters.tenantDirectoryResolver?.question?.forceRescanNow
        ?? `projectRescanNow`;
      const socketPath = getDirectorRpcSocketPath();
      const response = await sendDirectorQuestion({
        socketPath,
        question,
        data: {
          reason: `cli_core_rescan_projects`
        }
      });

      if (wantsJson) {
        process.stdout.write(JSON.stringify(response, null, 2) + `\n`);
      } else {
        printRescanSummary(response, socketPath);
      }

      if (!response.success) process.exit(1);
      if (response.data?.success === false) process.exit(1);
      return;
    }
    case `shutdown-process`: {
      const label = args.find((value) => !value.startsWith(`--`)) ?? null;
      if (!label) {
        throw new Error(`shutdown-process requires <label>`);
      }

      const config = await loadUserConfig();
      const question = config.adapters.projectDirectoryResolver?.question?.shutdownProcessNow
        ?? config.adapters.tenantDirectoryResolver?.question?.shutdownProcessNow
        ?? `projectShutdownProcessNow`;
      const timeoutMs = readFlagValue(args, `--timeout-ms`);
      const reason = readFlagValue(args, `--reason`) ?? `cli_shutdown_process`;
      const socketPath = getDirectorRpcSocketPath();
      const response = await sendDirectorQuestion({
        socketPath,
        question,
        data: {
          label,
          reason,
          ...(timeoutMs == null ? {} : { timeoutMs: Number(timeoutMs) })
        }
      });

      if (wantsJson) {
        process.stdout.write(JSON.stringify(response, null, 2) + `\n`);
      } else {
        printShutdownSummary(response, socketPath, label);
      }

      if (!response.success) process.exit(1);
      if (response.data?.success === false) process.exit(1);
      return;
    }
    default:
      throw new Error(`Unknown director-rpc-cli command: ${command ?? `(missing)`}`);
  }
}

function readFlagValue(args, flagName) {
  const index = args.indexOf(flagName);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

async function sendDirectorQuestion({
  socketPath,
  question,
  data = {},
  timeoutMs = 130_000
}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let buffer = ``;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    socket.setEncoding(`utf8`);
    socket.setTimeout(timeoutMs, () => {
      fail(new Error(`Timed out waiting for director response after ${timeoutMs}ms`));
    });

    socket.once(`connect`, () => {
      socket.write(JSON.stringify({ question, data }) + `\n`);
    });

    socket.on(`data`, (chunk) => {
      buffer += chunk;
    });

    socket.once(`error`, (error) => {
      if ([`ENOENT`, `ECONNREFUSED`].includes(error?.code)) {
        fail(new Error(`Director RPC socket is not available at ${socketPath}`));
        return;
      }
      fail(error);
    });

    socket.once(`end`, () => {
      try {
        finish(JSON.parse(String(buffer ?? ``).trim() || `{}`));
      } catch (error) {
        fail(new Error(`Invalid director RPC response: ${error?.message ?? error}`));
      }
    });

    socket.once(`close`, () => {
      if (!settled) {
        try {
          finish(JSON.parse(String(buffer ?? ``).trim() || `{}`));
        } catch (error) {
          fail(new Error(`Invalid director RPC response: ${error?.message ?? error}`));
        }
      }
    });
  });
}

function printRescanSummary(response, socketPath) {
  if (!response.success) {
    process.stderr.write(`Director RPC request failed via ${socketPath}: ${response.error ?? `unknown error`}\n`);
    return;
  }

  const data = response.data ?? {};
  if (data.success === false) {
    process.stderr.write(`Director forced rescan failed: ${data.error ?? `unknown error`}\n`);
    return;
  }

  const summary = data.scanSummary ?? {};
  const changedHosts = Array.isArray(summary.changedHosts) ? summary.changedHosts.length : 0;
  const removedHosts = Array.isArray(summary.removedHosts) ? summary.removedHosts.length : 0;
  const invalidHosts = Array.isArray(summary.invalidHosts) ? summary.invalidHosts.length : 0;

  process.stdout.write([
    `Director tenancy rescan completed.`,
    `Socket: ${socketPath}`,
    `Waited for active scan: ${data.waitedForActiveScan === true ? `yes` : `no`}`,
    `Coalesced repeated requests: ${data.coalesced === true ? `yes` : `no`}`,
    `Duration: ${data.durationMs ?? 0}ms`,
    `Changed hosts: ${changedHosts}`,
    `Removed hosts: ${removedHosts}`,
    `Invalid hosts: ${invalidHosts}`
  ].join(`\n`) + `\n`);

  if (invalidHosts > 0) {
    process.stdout.write(formatInvalidHosts(summary.invalidHosts));
  }
}

function formatInvalidHosts(invalidHostEntries = []) {
  const lines = [`Invalid host details:`];
  for (const entry of invalidHostEntries) {
    const errorCode = entry?.error?.code ? ` (${entry.error.code})` : ``;
    lines.push([
      `- scope=${entry?.scope ?? `unknown`}`,
      `host=${entry?.host ?? `unknown`}`,
      `root=${entry?.rootFolder ?? `unknown`}`,
      `config=${entry?.appConfigPath ?? `unknown`}`,
      `error=${entry?.error?.message ?? `unknown error`}${errorCode}`
    ].join(` `));
  }

  const output = `${lines.join(`\n`)}\n`;
  return shouldUseRedText() ? `\x1b[31m${output}\x1b[0m` : output;
}

function shouldUseRedText() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== `0`) return true;
  return process.stdout.isTTY === true;
}

function printShutdownSummary(response, socketPath, label) {
  if (!response.success) {
    process.stderr.write(`Director RPC request failed via ${socketPath}: ${response.error ?? `unknown error`}\n`);
    return;
  }

  const data = response.data ?? {};
  if (data.success === false) {
    process.stderr.write(`Director shutdown request failed for ${label}: ${data.reason ?? data.error ?? `unknown error`}\n`);
    return;
  }

  process.stdout.write([
    `Director shutdown request completed.`,
    `Socket: ${socketPath}`,
    `Label: ${label}`,
    `Action: ${data.action ?? `shutdown`}`,
    `Reason: ${data.reason ?? `shutdown`}`,
    `Success: ${data.success === true ? `yes` : `no`}`,
    `Skipped: ${data.skipped === true ? `yes` : `no`}`,
    `Missing: ${data.missing === true ? `yes` : `no`}`
  ].join(`\n`) + `\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(1);
  });
}

module.exports = {
  sendDirectorQuestion,
  printRescanSummary,
  formatInvalidHosts
};

Object.freeze(module.exports);
