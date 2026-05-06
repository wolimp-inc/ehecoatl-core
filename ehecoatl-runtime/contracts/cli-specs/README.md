# CLI Spec Contracts

`cli.spec.*.js` files describe the exposed prefixed CLI surfaces.

## Current Specs

- `cli.spec.core.js`
  Supervision/service commands under `core`.
- `cli.spec.tenant.js`
  Tenant-only commands under `tenant`.
- `cli.spec.app.js`
  App-only commands under `app`.
- `cli.spec.firewall.js`
  Root-only firewall commands under `firewall`.
- `cli.spec.shared.js`
  Reusable command definitions for `status`, `log`, and `config`. It is not exposed directly.

## Current Flattened Command List

- `core deploy tenant`
- `core delete tenant`
- `core list`
- `core start`
- `core stop`
- `core restart`
- `core status`
- `core log`
- `core generate login`
- `core delete login`
- `tenant deploy app`
- `tenant delete app`
- `tenant list`
- `tenant enable`
- `tenant disable`
- `tenant make`
- `tenant status`
- `tenant log`
- `tenant config`
- `app enable`
- `app disable`
- `app make`
- `app status`
- `app log`
- `app config`
- `firewall newtork_wan_block <on|off> <username> [process-label] [input-chain]`
- `firewall newtork_local_proxy <on|off> <username>[:<port>[,<port>...]]`

## Notes

- `groupsAllowed` is the declarative gate for each spec surface.
- The dispatcher does the real authorization check from the current user groups.
- `core` no longer includes `enter tenant` or `enter app`.
- `tenant` no longer includes `enter app` or app-target overrides.
- Tenant and app targeting now comes from the working directory, not from saved CLI context.
- `firewall newtork_wan_block` manages deterministic WAN-facing TCP fencing for one process owner.
- `firewall newtork_local_proxy` manages the loopback-only allowlist for one process owner and accepts a comma-separated port list.
- Automatic runtime use of those firewall commands is configured by `runtime.network`, including `defaultWanBlock`, `wanOpenApps`, and `openLocalPorts`.
