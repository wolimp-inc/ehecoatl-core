# Ehecoatl Core

Ehecoatl Core is a Linux-oriented multi-tenant runtime for HTTP and WebSocket workloads. Operators organize workloads as projects and apps, while the runtime still provides multi-tenant isolation underneath.

## What The Repository Contains

- `docs/`
  Canonical narrative documentation for architecture, features, and operations.
- `setup/`
  Bootstrap, install, optional host-component bootstraps, uninstall, and purge scripts.
- `ehecoatl-runtime/`
  The packaged runtime payload copied into `/opt/ehecoatl`, including the runtime code, CLI, contracts, systemd unit, adapters, plugins, and starter kits.
- `report/`
  Structured local analysis reports used for engineering review.

## Runtime Model

- `main` is the root supervisor process.
- `director` maintains active project/app routing state, reconciliation, and shared coordination.
- `e_project_transport_{project_id}` handles ingress for one project.
- `e_app_{project_id}_{app_id}` runs one isolated application runtime.
- Contracts under `ehecoatl-runtime/contracts/` define topology, identities, runtime paths, and setup derivation.

## Installation

For a quick install, run the following commands to get the releases manager:

```bash
mkdir -p ~/ehecoatl && \
curl -fsSL \
  -H "Accept: application/vnd.github.raw+json" \
  "https://api.github.com/repos/ehecoatl/core/contents/ehecoatl-core.sh" \
  -o ~/ehecoatl/ehecoatl-core.sh && \
chmod +x ~/ehecoatl/ehecoatl-core.sh
```

The commands above will download the latest version manager, and then you can run the following command options for quick install/uninstall options

```bash
sudo bash ~/ehecoatl/ehecoatl-core.sh --help
sudo bash ~/ehecoatl/ehecoatl-core.sh --releases
sudo bash ~/ehecoatl/ehecoatl-core.sh --pre-releases
sudo bash ~/ehecoatl/ehecoatl-core.sh --download "<release>"
sudo bash ~/ehecoatl/ehecoatl-core.sh --install "<release>"
sudo bash ~/ehecoatl/ehecoatl-core.sh --installed-version
sudo bash ~/ehecoatl/ehecoatl-core.sh --uninstall
```

From an already downloaded local checkout, manual installation is also available at:

```bash
sudo bash ~/ehecoatl/{release}/setup/bootstrap.sh --complete
```

That flow installs the packaged runtime under `/opt/ehecoatl`, writes grouped JSON config under `/etc/opt/ehecoatl/config`, publishes the `ehecoatl` CLI, and enables `ehecoatl.service`.

## Operations

Core runtime control is exposed through the packaged CLI:

```bash
ehecoatl core start
ehecoatl core status
ehecoatl core log
ehecoatl core stop
```

Project and app deployment is performed through:

```bash
ehecoatl core deploy project "@example.test" -p "test"
```

The packaged `test` project kit includes the default `www` app as an embedded app source, so no separate `test` app kit deploy is needed.
Legacy `core deploy tenant` and `-t|--tenant-kit` remain accepted for compatibility.

## Security And Isolation Notes

- The service unit starts as `root` and the bootstrap applies the runtime process identity internally.
- `main` retains only the capability needed to hand off runtime identities and supervision.
- `director`, `transport`, and `isolated-runtime` apply a no-spawn seccomp boundary during bootstrap.
- The seccomp boundary blocks `fork`, `vfork`, `execve`, and `execveat`, while allowing normal thread creation required by the Node.js runtime.

## License

2026 © Wolimp, All Rights Reserved

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.

See the License for the specific language governing permissions and
limitations under the License.
