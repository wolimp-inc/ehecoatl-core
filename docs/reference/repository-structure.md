# Repository Structure

This page describes the current repository layout.

## Top-Level Directories

- `ehecoatl-core.sh`
  Standalone release manager that lists releases, downloads source checkouts into `~/ehecoatl/<release>`, and can trigger the bootstrap-driven install flow from cached downloads.
- `ehecoatl-runtime/`
  Runtime source code, config, contracts, CLI, templates, systemd unit, built-in extensions, and other installation/runtime assets that live under `/opt/ehecoatl`.
- `setup/`
  Shell entrypoints for bootstrap, install, uninstall, and purge flows. This layer consumes contracts as structural source of truth; it does not define an independent runtime topology.
- `docs/`
  Project documentation.

## Setup Scripts

The packaged setup area currently includes:

- `ehecoatl-core.sh`
- `setup/bootstrap.sh`
- `setup/bootstraps/bootstrap-nginx.sh`
- `setup/bootstraps/bootstrap-lets-encrypt.sh`
- `setup/bootstraps/bootstrap-redis.sh`
- `setup/install.sh`
- `setup/uninstall.sh`
- `setup/uninstall/uninstall-redis.sh`
- `setup/uninstall/purge-data.sh`
- `ehecoatl-runtime/cli/lib/runtime-policy.sh`
- `ehecoatl-runtime/systemd/ehecoatl.service`
- `ehecoatl-runtime/builtin-extensions/project-kits/`
- `ehecoatl-runtime/builtin-extensions/app-kits/`
- `ehecoatl-runtime/templates/nginx/hostname.conf.template`
- `ehecoatl-runtime/builtin-extensions/`
- `setup/README.md`

## CLI

The packaged CLI now lives under `ehecoatl-runtime/cli/`. It includes the dispatcher at `ehecoatl-runtime/cli/ehecoatl.sh` and command files under `ehecoatl-runtime/cli/commands/*.sh`. The installed symlink remains `/usr/local/bin/ehecoatl`, so user-facing commands do not include `.sh`.

Runtime and operational commands currently include:

- `core start`
- `core stop`
- `core restart`
- `core status`
- `core log`
- `core deploy tenant`
- `firewall newtork_wan_block`
- `firewall newtork_local_proxy`

The firewall shell commands are deterministic single-purpose network-isolation helpers. They are part of the narrow privileged boundary used by the launcher and main-supervisor flow, not a general privileged shell extension surface.

## Structural Source of Truth

The runtime topology, process identities, and layer semantics are defined in `ehecoatl-runtime/contracts/`.

In practice:

- `contracts/` define structure and identity
- `setup/` installs and maintains from that structure
- `ehecoatl-runtime/` is the packaged payload installed into `/opt/ehecoatl`
