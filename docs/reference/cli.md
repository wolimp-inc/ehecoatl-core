# CLI Reference

The packaged `ehecoatl` command dispatches by explicit scope:

- `ehecoatl core ...`
- `ehecoatl project ...`
- `ehecoatl tenant ...` (legacy alias)
- `ehecoatl app ...`
- `ehecoatl firewall ...`

## Authorization

Authorization is group-based:

- `root` can run every scope
- `g_superScope` can run `core`
- `g_{project_id}` can run `project` and the legacy `tenant` alias
- `g_{project_id}_{app_id}` can run `app`
- `firewall` remains root-only

Project and app commands resolve their target from the current working directory by default.

Project commands also accept an explicit project selector right after the scope:

- `ehecoatl project "@<domain>" ...`

When that selector is present, the CLI ignores the current directory for project resolution and targets the project resolved by the explicit domain instead. Non-root users still need membership in `g_{project_id}` for the resolved project. The legacy `ehecoatl tenant "@<domain>" ...` form remains accepted.

App commands also accept an explicit app selector right after the scope:

- `ehecoatl app "<app_name>@<domain>" ...`
- `ehecoatl app "<app_name>@<project_id>" ...`

When that selector is present, the CLI ignores the current directory for app resolution and targets the app resolved by the explicit selector instead. Non-root users still need membership in `g_{project_id}_{app_id}` for the resolved app. Legacy tenant ids remain accepted.

## Core

- `ehecoatl core start`
- `ehecoatl core stop`
- `ehecoatl core restart`
- `ehecoatl core status`
- `ehecoatl core log`
- `ehecoatl core list`
- `ehecoatl core rescan projects`
- `ehecoatl core deploy project "@<domain>" -p "<project_kit>"`
- `ehecoatl core delete project "@<domain>"|"@<project_id>"`
- `ehecoatl core generate login "<username>" [--password "<password>"] --scope "<selector>"...`
- `ehecoatl core delete login "<username>" [--purge-home]`

## Project

- `ehecoatl project ["@<domain>"] deploy app "<app_name>" -a "<app_kit>"`
- `ehecoatl project ["@<domain>"] delete app "<app_name>"`
- `ehecoatl project ["@<domain>"] list`
- `ehecoatl project ["@<domain>"] status`
- `ehecoatl project ["@<domain>"] log`
- `ehecoatl project ["@<domain>"] config [--get "<key>"] [--set "<key>" "<value>"]`
- `ehecoatl project ["@<domain>"] enable`
- `ehecoatl project ["@<domain>"] disable`
- `ehecoatl project ["@<domain>"] make plugin "<name>"`

The legacy `ehecoatl tenant ...` scope remains accepted as an alias for the project scope.

Kit names accepted by deploy commands point to folders or `.zip` archives in the relevant kit root. For example, `-p "test"` resolves to `project-kits/test/` or `project-kits/test.zip`. Custom app deploys still resolve `-a "<app_kit>"` from `app-kits/<app_kit>/` or `app-kits/<app_kit>.zip`, but the packaged `test` project kit already carries the default `www` app as an embedded `app_www/` source; there is no bundled `test` app kit to deploy separately.

If a kit is not found in the built-in kit root or the supervision-scope custom kit root, deploy checks the public GitHub fallback under the `ehecoatl` organization. Project kits use `https://github.com/ehecoatl/project-kit-<kitname>.git`; app kits use `https://github.com/ehecoatl/app-kit-<kitname>.git`. When found, the repo is cloned into the matching custom kit root as `<kitname>/` and then deployed as a normal custom folder kit.

Legacy `-t|--tenant-kit`, `tenant-kits/` roots, and `https://github.com/ehecoatl/tenant-kit-<kitname>.git` remotes remain supported as secondary compatibility fallbacks.

Project kits may also carry embedded apps as top-level `app_<name>/` folders. During `core deploy project`, each embedded folder is deployed as app `<name>` without using an app kit, then removed from the project root after successful app creation.

Zip kits must contain kit files directly at the archive root, not inside a wrapper folder.

## App

- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<project_id>"] status`
- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<project_id>"] log`
- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<project_id>"] config [--get "<key>"] [--set "<key>" "<value>"]`
- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<project_id>"] enable`
- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<project_id>"] disable`
- `ehecoatl app ["<app_name>@<domain>"|"<app_name>@<project_id>"] make <middleware|plugin|action> "<name>"`

## Firewall

- `ehecoatl firewall newtork_wan_block <on|off> "<username>" [process-label] [input-chain]`
- `ehecoatl firewall newtork_local_proxy <on|off> "<username>[:<port>[,<port>...]]"`

These commands remain narrow privileged primitives. Automatic runtime use is configured through `runtime.network`: `defaultWanBlock` controls WAN fencing, `wanOpenApps` lists app exceptions as `appName@tenantDomain`, and `openLocalPorts` supplies the local-proxy allowlist.

## Notes

- Project and app deploy commands trigger a direct `director` rescan through `ehecoatl core rescan projects` after filesystem and ACL changes complete.
- Runtime scope users such as `u_supervisor`, `u_project_*`, and `u_app_*` are `nologin`; legacy `u_tenant_*` users may still exist for old data.
- Human shell access is created separately through `core generate login`.
- Managed human logins keep `/home/<username>` as the real shell home and get a curated workspace under `~/ehecoatl`.
- `~/ehecoatl` exposes only the roots granted by the requested scope selectors.
- Project links use canonical names like `~/ehecoatl/projects/project_<domain>`.
- `core generate login` accepts `--scope super`, `--scope "@<domain>"`, and `--scope "@<project_id>"`; legacy tenant ids remain accepted.
- App-specific login generation is intentionally not exposed; use a project-scoped login and change into the desired app root when app CLI work is needed.
- Project and app commands are intended to be run after changing into one of the linked scope roots, unless a project command is using the explicit `"@<domain>"` override or an app command is using the explicit `"<app_name>@<domain>"|"<app_name>@<project_id>"` override.
