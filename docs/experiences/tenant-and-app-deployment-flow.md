# Tenant and App Deployment Flow

This experience turns tenant and app rollout into a repeatable CLI flow that applies layout, permissions, and post-deploy runtime reconciliation automatically.

## Experience

- Tenant deployment creates the filesystem surface the runtime expects before traffic is routed.
- App deployment attaches application code to an existing tenant without bypassing permission or topology rules.
- Post-deploy hooks can trigger follow-up actions, such as direct director rescans, without manual operator steps.

## Implementation

- Internal shared deploy logic handles filesystem copy, ownership, ACL, and post-deploy command execution.
- The runtime CLI exposes scoped `core deploy tenant` and `tenant deploy app` commands on top of that internal helper path; there is no public `ehecoatl shared ...` scope.
- Director reconciliation re-reads deployed tenant state so the live runtime model follows what is now on disk.
- Kit sources may be folders or `.zip` archives. Folder kits are copied; zip kits are extracted and must contain kit files directly at the archive root.
- Missing kits are resolved from built-in kits first, custom extension kit roots second, and public GitHub fallback repos under `https://github.com/ehecoatl` last.
- Project kits can bundle apps with top-level `app_<name>/` folders. These embedded folders are deployed as normal apps without resolving an app kit, then removed from the tenant root after successful creation.

## Key Files

- [`ehecoatl-runtime/cli/commands/shared/deploy.sh`](../../ehecoatl-runtime/cli/commands/shared/deploy.sh)
- [`ehecoatl-runtime/cli/commands/core/rescan_tenants.sh`](../../ehecoatl-runtime/cli/commands/core/rescan_tenants.sh)
- [`ehecoatl-runtime/builtin-extensions/adapters/inbound/tenant-directory-resolver/default-tenancy.js`](../../ehecoatl-runtime/builtin-extensions/adapters/inbound/tenant-directory-resolver/default-tenancy.js)
- [`ehecoatl-runtime/contracts/derive-setup-topology.js`](../../ehecoatl-runtime/contracts/derive-setup-topology.js)

## Related Docs

- [Scoped CLI Operations](scoped-cli-operations.md)
- [Registry Scan and Reconciliation](registry-scan-and-reconciliation.md)
- [Tenant and App Kits](tenant-and-app-kits.md)
