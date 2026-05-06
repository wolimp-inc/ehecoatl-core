# CLI Reference

The packaged `ehecoatl` command dispatches by explicit scope:

- `ehecoatl core ...`
- `ehecoatl tenant ...`
- `ehecoatl app ...`
- `ehecoatl firewall ...`

## Authorization

Authorization is group-based:

- `root` can run every scope
- `g_superScope` can run `core`
- `g_{tenant_id}` can run `tenant`
- `g_{tenant_id}_{app_id}` can run `app`
- `firewall` remains root-only

Tenant and app commands resolve their target from the current working directory by default.

Tenant commands also accept an explicit tenant selector right after the scope:

- `ehecoatl tenant "@<domain>" ...`

When that selector is present, the CLI ignores the current directory for tenant resolution and targets the tenant resolved by the explicit domain instead. Non-root users still need membership in `g_{tenant_id}` for the resolved tenant.

App commands also accept an explicit app selector right after the scope:

- `ehecoatl app "<app_name>@<domain>" ...`
- `ehecoatl app "<app_name>@<tenant_id>" ...`

When that selector is present, the CLI ignores the current directory for app resolution and targets the app resolved by the explicit selector instead. Non-root users still need membership in `g_{tenant_id}_{app_id}` for the resolved app.

## Core

- `ehecoatl core start`
- `ehecoatl core stop`
- `ehecoatl core restart`
- `ehecoatl core status`
- `ehecoatl core log`
- `ehecoatl core list`
- `ehecoatl core rescan tenants`
- `ehecoatl core deploy tenant "@<domain>" -t "<tenant_kit>"`
- `ehecoatl core delete tenant "@<domain>"|"@<tenant_id>"`
- `ehecoatl core generate login "<username>" [--password "<password>"] --scope "<selector>"...`
- `ehecoatl core delete login "<username>" [--purge-home]`

## Tenant

- `ehecoatl tenant ["@<domain>"] deploy app "<app_name>" -a "<app_kit>"`
- `ehecoatl tenant ["@<domain>"] delete app "<app_name>"`
- `ehecoatl tenant ["@<domain>"] list`
- `ehecoatl tenant ["@<domain>"] status`
- `ehecoatl tenant ["@<domain>"] log`
- `ehecoatl tenant ["@<domain>"] config [--get "<key>"] [--set "<key>" "<value>"]`
- `ehecoatl tenant ["@<domain>"] enable`
- `ehecoatl tenant ["@<domain>"] disable`
- `ehecoatl tenant ["@<domain>"] make plugin "<name>"`

Kit names accepted by deploy commands point to folders or `.zip` archives in the relevant kit root. For example, `-t "test"` resolves to `tenant-kits/test/` or `tenant-kits/test.zip`. Custom app deploys still resolve `-a "<app_kit>"` from `app-kits/<app_kit>/` or `app-kits/<app_kit>.zip`, but the packaged `test` tenant kit already carries the default `www` app as an embedded `app_www/` source; there is no bundled `test` app kit to deploy separately.

If a kit is not found in the built-in kit root or the supervision-scope custom kit root, deploy checks the public GitHub fallback under the `ehecoatl` organization. Tenant kits use `https://github.com/ehecoatl/tenant-kit-<kitname>.git`; app kits use `https://github.com/ehecoatl/app-kit-<kitname>.git`. When found, the repo is cloned into the matching custom kit root as `<kitname>/` and then deployed as a normal custom folder kit.

Tenant kits may also carry embedded apps as top-level `app_<name>/` folders. During `core deploy tenant`, each embedded folder is deployed as app `<name>` without using an app kit, then removed from the tenant root after successful app creation.

Zip kits must contain kit files directly at the archive root, not inside a wrapper folder.

## App

- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<tenant_id>"] status`
- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<tenant_id>"] log`
- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<tenant_id>"] config [--get "<key>"] [--set "<key>" "<value>"]`
- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<tenant_id>"] enable`
- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<tenant_id>"] disable`
- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<tenant_id>"] make <middleware|plugin|action> "<name>"`

## Firewall

- `ehecoatl firewall newtork_wan_block <on|off> "<username>" [process-label] [input-chain]`
- `ehecoatl firewall newtork_local_proxy <on|off> "<username>[:<port>[,<port>...]]"`

These commands remain narrow privileged primitives. Automatic runtime use is configured through `runtime.network`: `defaultWanBlock` controls WAN fencing, `wanOpenApps` lists app exceptions as `appName@tenantDomain`, and `openLocalPorts` supplies the local-proxy allowlist.

## Notes

- Tenant and app deploy commands trigger a direct `director` rescan through `ehecoatl core rescan tenants` after filesystem and ACL changes complete.
- Runtime scope users such as `u_supervisor`, `u_tenant_*`, and `u_app_*` are `nologin`.
- Human shell access is created separately through `core generate login`.
- Managed human logins keep `/home/<username>` as the real shell home and get a curated workspace under `~/ehecoatl`.
- `~/ehecoatl` exposes only the roots granted by the requested scope selectors.
- Tenant links use canonical names like `~/ehecoatl/tenants/tenant_<domain>`.
- `core generate login` accepts only `--scope super`, `--scope "@<domain>"`, and `--scope "@<tenant_id>"`.
- App-specific login generation is intentionally not exposed; use a tenant-scoped login and change into the desired app root when app CLI work is needed.
- Tenant and app commands are intended to be run after changing into one of the linked scope roots, unless a tenant command is using the explicit `"@<domain>"` override or an app command is using the explicit `"<app_name>@<domain>"|"<app_name>@<tenant_id>"` override.
