# CLI

This folder contains the packaged `ehecoatl` command-line interface shipped with the runtime.

## Structure

- `ehecoatl.sh`
  Top-level dispatcher installed as `/usr/local/bin/ehecoatl`.
- `commands/`
  Scope-specific shell commands for `core`, `tenant`, `app`, and `firewall`.
- `lib/`
  Shared helpers used by command implementations.

## Command Model

The CLI dispatches by explicit scope:

- `ehecoatl core ...`
- `ehecoatl tenant ...`
- `ehecoatl app ...`
- `ehecoatl firewall ...`

Tenant and app targeting is derived from the current working directory by default rather than from a persistent shell session or context file.

Tenant commands may also use an explicit domain target immediately after the `tenant` scope:

```bash
ehecoatl tenant "@example.test" status
ehecoatl tenant "@example.test" list
```

When that override is present, tenant resolution ignores the current directory and uses the explicit domain. Non-root users still need membership in the resolved tenant group.

App commands may also use an explicit app target immediately after the `app` scope:

```bash
ehecoatl app "www@example.test" status
ehecoatl app "www@aaaaaaaaaaaa" config --get "appEnabled"
```

When that override is present, app resolution ignores the current directory and uses the explicit app selector. Non-root users still need membership in the resolved app group.

Deploy commands accept kit names directly and can use folder or `.zip` kit artifacts: `-p "test"` resolves to `project-kits/test/` or `project-kits/test.zip`, while custom app deploys resolve `-a "<app_kit>"` from app kit roots. The packaged `test` project kit already carries the default app as an embedded `app_www/` source, so there is no bundled `test` app kit to deploy separately. Missing kits are checked in custom extension kit roots and then public fallback repos such as `https://github.com/ehecoatl/project-kit-blog.git` or `https://github.com/ehecoatl/app-kit-panel.git`; matching repos are cloned into the custom kit root. Legacy `-t|--tenant-kit`, `tenant-kits/` roots, and `tenant-kit-*` remotes remain compatibility fallbacks. Zip kits must place kit files directly at the archive root. Project kits may include top-level `app_<name>/` folders; these are auto-deployed as apps during tenant deploy.

## Related Sources

- [CLI contracts](../contracts/cli-specs/README.md)
- [Reference CLI documentation](../../docs/reference/cli.md)
