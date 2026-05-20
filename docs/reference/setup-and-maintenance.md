# Setup And Maintenance

This page describes the packaged install, bootstrap, and cleanup model used by Ehecoatl.

## Standard Install Flow

The standard host flow is:

1. `ehecoatl-core.sh`
2. `setup/bootstrap.sh`
3. `setup/install.sh`
4. optional bootstraps for Nginx, Redis, and Let's Encrypt

`bootstrap.sh --complete` runs the full packaged flow in one command.

## What `install.sh` Does

`install.sh` configures the runtime under `/opt/ehecoatl`. It:

- loads runtime policy and contract-derived topology
- resolves or generates one install identifier
- creates the packaged runtime identities
- publishes `/usr/local/bin/ehecoatl`
- writes grouped JSON config under `/etc/opt/ehecoatl/config`
- writes install metadata with mode `0644` and the internal install registry record
- installs and enables `ehecoatl.service`
- installs nested built-in extension dependencies for adapters, plugins, app kits, and project kits that declare their own `package.json`
- verifies the native seccomp addon is built successfully on Linux

## Service Resource Boundaries

The packaged `ehecoatl.service` runs with a total service memory ceiling and delegated child cgroup management:

- `MemoryMax=1G` limits the whole service tree to 1GB.
- `OOMPolicy=continue` keeps the service unit running when a supervised child process is OOM-killed.
- `Delegate=yes` and `DelegateSubgroup=supervisor` let the privileged launcher manage child cgroups under the service cgroup while keeping the supervisor processes in the `supervisor` subgroup.
- `MemoryAccounting=yes`, `CPUAccounting=yes`, and `TasksAccounting=yes` expose resource accounting to systemd.

Each supervised process launch gets a fresh managed cgroup named with the `ehecoatl-managed_...` prefix. A restart creates a new cgroup rather than reusing the old one.

Default per-process limits come from `adapters.processForkRuntime.cgroups`:

- memory: `memoryMaxMb: 192`
- CPU: `cpuMaxPercent: 50`

The CPU setting is a cgroup quota, not a kill threshold. At the default value, an overloaded process is throttled to about half of one CPU core.

The memory setting is a hard cgroup limit. If a process exceeds it and the kernel cannot reclaim memory, the cgroup is OOM-killed. Managed cgroups use `memory.oom.group=1`, so descendants inside the same cgroup are killed together. The supervisor records the exit and relaunches the supervised process into a new managed cgroup.

The managed cgroup registry is stored at `/var/lib/ehecoatl/registry/managed-cgroups.json`. The privileged launcher periodically scans that registry and removes empty stale cgroups, including leftovers from service restarts.

Useful verification commands:

```bash
systemctl show ehecoatl.service \
  -p MemoryMax \
  -p OOMPolicy \
  -p Delegate \
  -p DelegateSubgroup

systemctl status ehecoatl.service

cat /var/lib/ehecoatl/registry/managed-cgroups.json
```

## Identity Model

Base runtime identities:

- `ehecoatl:ehecoatl`
- `g_superScope`
- `g_directorScope`
- `u_supervisor`

Deployment-time identities:

- `u_tenant_{tenant_id}`
- `u_app_{tenant_id}_{app_id}`
- `g_{tenant_id}`
- `g_{tenant_id}_{app_id}`

Human shell access is created separately through `ehecoatl core generate login`.

## Optional Host Bootstraps

Optional bootstraps under `setup/bootstraps/` can provision or integrate:

- Nginx
- the Let's Encrypt client
- Redis

Each bootstrap records whether the component was installer-managed so uninstall can remove only what Ehecoatl actually installed.

## Uninstall

`setup/uninstall.sh` removes the packaged runtime while preserving persisted data. It removes runtime files, the CLI symlink, and the service unit, and it removes installer-created identities only when install metadata says they were created by Ehecoatl.

## Purge

`setup/uninstall/purge-data.sh` removes persisted data under the contract-derived `/etc`, `/var`, and `/srv` runtime roots. It is intended for full cleanup after uninstall.
