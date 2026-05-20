# Getting Started

This guide covers the first successful install and deploy path for a local or test environment.

## Install

The standard packaged flow is:

```bash
sudo bash ehecoatl-core.sh --download "<release>"
sudo bash ehecoatl-core.sh --install "<release>"
sudo bash ehecoatl-core.sh --installed-version
```

That flow installs the runtime under `/opt/ehecoatl`, writes grouped JSON config under `/etc/opt/ehecoatl/config`, enables `ehecoatl.service`, and creates the base runtime identities:

- `ehecoatl:ehecoatl`
- `g_superScope`
- `g_directorScope`
- `u_supervisor`

Project and app identities are created later when those scopes are deployed.

## Start And Inspect The Service

```bash
ehecoatl core start
ehecoatl core status
ehecoatl core log
```

## Deploy A Project And App

Create a project:

```bash
ehecoatl core deploy project "@example.test" -p "test"
```

The packaged `test` project kit includes the default `www` app as an embedded app source, so no separate `test` app kit deploy is needed.

Project deploy finishes by triggering `ehecoatl core rescan projects`, so the running `director` process picks up the new topology immediately. Legacy `core deploy tenant` and `core rescan tenants` aliases remain accepted for old automation.

Kit sources may be folders or `.zip` archives. A zip project kit such as `test.zip` must place kit files directly at the archive root.

## Human Logins

Human shell access is created explicitly through the CLI:

```bash
ehecoatl core generate login "operator" --scope super
```

You can attach more than one scope:

```bash
ehecoatl core generate login "editor" --scope super --scope "@example.test"
```

Managed logins still land in `/home/<username>` as their real shell home. The command also creates a scoped workspace at `~/ehecoatl` with symlinks into the service, project, and app roots that the assigned scopes allow.

Login scopes support `super`, `"@<domain>"`, and `"@<project_id>"`; legacy tenant ids remain accepted. App-specific login generation is intentionally not exposed; app commands can be reached from project-granted workspaces after changing into an app root. Project commands also support an explicit `"@<domain>"` override immediately after `project` when you want to target a project without relying on the current directory.

## Remove The Runtime

To remove the runtime while preserving project and legacy tenant data:

```bash
sudo bash ehecoatl-core.sh --uninstall
```

To remove the persisted data as well:

```bash
./setup/uninstall.sh --purge
```
