# Network Isolation Helpers

This experience gives the runtime a narrow privileged network-control surface without turning firewall behavior into a general-purpose extension mechanism.

## Experience

- Firewall operations are explicit commands instead of hidden side effects in unrelated setup logic.
- Privileged network-control behavior remains launcher-side and tightly scoped.
- The runtime describes automatic network-isolation intent through `runtime.network` without broadening the privileged surface arbitrarily.

## Implementation

- Root-only firewall commands implement deterministic WAN-block and local-proxy helpers.
- Runtime policy names the command entrypoints used by the launcher side of the runtime.
- `runtime.network.defaultWanBlock` controls whether automatic WAN fencing is applied; when disabled, the main runtime clears existing Ehecoatl WAN chains on the next boot/sync.
- `runtime.network.wanOpenApps` lists app isolated runtime exceptions as `appName@tenantDomain`.
- `runtime.network.openLocalPorts` defines the local-proxy allowlist.
- Documentation treats these helpers as privileged infrastructure controls, not as a general admin shell surface.

## Key Files

- [`docs/reference/runtime-policy.md`](../../reference/runtime-policy.md)
- [`docs/reference/cli.md`](../../reference/cli.md)
- `ehecoatl-runtime/cli/commands/firewall/newtork_wan_block.sh`
- `ehecoatl-runtime/cli/commands/firewall/newtork_local_proxy.sh`

## Related Docs

- [Process Isolation and Identity Model](process-isolation-and-identity-model.md)
- [Runtime Policy](../../reference/runtime-policy.md)
- [Scoped CLI Operations](../surface/scoped-cli-operations.md)
