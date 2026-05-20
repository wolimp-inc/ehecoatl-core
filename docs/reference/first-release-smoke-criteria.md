# First Release Smoke Criteria

This checklist describes the minimum packaged-runtime verification expected before a release is treated as installable.

## Preconditions

Confirm that:

- the source checkout is available locally or through `ehecoatl-core.sh --download "<release>"`
- `systemd` is available
- `/opt/ehecoatl` can be managed by the install/bootstrap flow

## Setup Validation

Run:

```bash
./setup/install.sh --dry-run
./setup/install.sh
```

Confirm that setup:

- publishes `/usr/local/bin/ehecoatl`
- writes install metadata
- writes the internal install registry record
- creates `ehecoatl:ehecoatl`
- creates `g_superScope`
- creates `g_directorScope`
- creates `u_supervisor` as `nologin`
- enables `ehecoatl.service`

## Runtime Control Validation

Verify:

```bash
ehecoatl core start
ehecoatl core status
ehecoatl core log
ehecoatl core stop
```

## Deployment Validation

Verify a tenant and app deploy path:

```bash
ehecoatl core deploy tenant "@example.com" -t "test"
```

Confirm that the deploy path creates the tenant, promotes the embedded default `www` app from the project kit, and triggers the direct `director` tenant rescan successfully.

```bash
ehecoatl app "www@example.com" status
```

When zip kit artifacts are available, repeat the same deploy path with `test.zip` in the project-kits root. Zip kits must contain kit files directly at the archive root.
