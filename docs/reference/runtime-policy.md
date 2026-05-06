# Runtime Policy

Ehecoatl keeps an operational policy in `ehecoatl-runtime/config/runtime-policy.json` for CLI and setup-oriented consumers. The Node runtime itself now derives process identity directly from the layer contracts.

## Why It Exists

Without a shared policy file, setup and CLI scripts would duplicate:

- filesystem roots,
- tenant ownership rules,
- firewall command names,
- ACL expectations.

The runtime policy keeps those concerns aligned.

## Main Sections

### `system`

Defines the shared runtime user and group.

### `paths`

Defines the standard installation roots:

- tenants base
- var base
- srv base
- etc base

### `processUsers`

Defines compatibility-facing runtime identity defaults for:

- `main`
- `director`
- `transport`
- `isolatedRuntime`

The live Node runtime no longer uses this section as a fallback during child bootstrap. Child process identity is rendered from the layer contracts and passed through supervised fork env vars instead.

### `tenantLayout`

Defines default owners, groups, and modes for:

- domain base folders
- app folders

### `tenantAccess`

Defines ACL rules for director, transport, and isolated-runtime access into tenant folders. The bundled policy grants director read access to `config.json` and static-asset reads from `assets`, while transport and isolated-runtime access are scoped to `assets` and runtime-owned support folders under `.ehecoatl/` such as `.ehecoatl/.cache`, `.ehecoatl/log`, `.ehecoatl/.spool`, `.ehecoatl/.backups`, and functional internal folders like `.ehecoatl/auth` when an app stores private runtime data there. Tenant provisioning scripts consume these rules to apply read and write access for the correct runtime users.

### `firewall`

Defines the CLI commands used to set up and release inbound firewall rules for process isolation hooks.

Those commands are intentionally deterministic single-purpose shell entrypoints. They are not documented as general shell extension hooks.

## Where It Is Consumed

Current consumers include:

- `ehecoatl-runtime/cli/lib/runtime-policy.sh`
- `setup/install.sh`
- `ehecoatl-runtime/cli/commands/shared/deploy.sh`
- `ehecoatl-runtime/cli/commands/firewall/newtork_wan_block.sh`
- `ehecoatl-runtime/cli/commands/firewall/newtork_local_proxy.sh`
- `ehecoatl-runtime/contracts/derive-runtime-policy.js`

## Practical Effect

Changing runtime policy affects CLI/setup behavior. Treat it as an operational compatibility contract, not as the runtime source of truth for supervised child identity.

For firewall behavior in particular, policy should continue to describe narrowly scoped setup and release commands rather than arbitrary command execution. The network-administration privilege used by those commands is intentionally isolated to the launcher side of the runtime bootstrap flow.

Automatic firewall behavior is governed by runtime configuration, not by policy. `runtime.network.defaultWanBlock` enables or disables automatic WAN fencing, `runtime.network.wanOpenApps` defines app exceptions in `appName@tenantDomain` format, and `runtime.network.openLocalPorts` defines the local-proxy allowlist.
