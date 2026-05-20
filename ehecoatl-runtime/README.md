# Ehecoatl Runtime

This folder is the packaged runtime payload copied into `/opt/ehecoatl` during installation.

## Main Areas

- `index.js`
  Root runtime entrypoint.
- `bootstrap/`
  Runtime bootstrap entrypoints and launcher logic.
- `config/`
  Default configuration, user-config merge, and adapter loading.
- `contracts/`
  Source-of-truth structural contracts used by runtime and setup.
- `cli/`
  Packaged CLI dispatcher, commands, and helpers.
- `_core/`
  Kernels, runtimes, resolvers, services, managers, and orchestrators.
- `builtin-extensions/`
  Packaged adapters, plugins, middlewares, project kits, and app kits.
- `systemd/`
  The packaged systemd unit template.

## Startup Chain

The canonical startup path is:

```text
systemd
  -> index.js
    -> bootstrap/bootstrap.js
      -> fork bootstrap/process-main.js (main)
        -> spawn director
        -> reconcile transport and isolated app runtimes
```

`main` is the root supervisor. `director` is the first supervised child and owns tenancy reconciliation.

## Security And Isolation

- The service unit starts as `root`.
- The bootstrap path applies the configured runtime identity internally.
- `main` retains only the capability boundary needed for supervision handoff.
- `director`, `transport`, and `isolated-runtime` drop inherited capabilities and then apply the seccomp no-spawn boundary.
- That boundary blocks `fork`, `vfork`, `execve`, and `execveat` while preserving normal thread creation required by the Node.js runtime.

## Bootstrap Load Policy

The packaged runtime does not support lazy-loading arbitrary core bootstrap or runtime files as an extension pattern. Core composition is expected to load eagerly during bootstrap and kernel assembly.

The supervised processes intentionally flush `require.cache` as part of bootstrap finalization:

- `main`, `director`, and `transport` call `clearRequireCache()` after their `READY` path completes
- `isolated-runtime` calls `clearRequireCache()` before weak-loading the app entrypoint and runtime-served action modules
- `clearRequireCache()` also clears `weakRequire` tracking state

The intentional runtime exceptions are deployment-facing extension surfaces:

- isolated app entrypoints
- app action modules
- shared tenant action fallbacks
- tenant and app middleware modules

Those surfaces are refreshed through `weakRequire`, which reloads by absolute file path when the source-file modification time changes and clears stale cache state when a file disappears or a reload fails.

## Isolated Runtime App Surface

The isolated runtime exposes the same `services` object to:

- the app entrypoint `index.js` boot context
- HTTP actions
- WS actions

The currently supported service surface includes:

- `services.storage`
- `services.fluentFs`
- `services.cache`
- `services.rpc`
- `services.ws`

`services.fluentFs` is the preferred path resolver for app code. It supports property-based roots plus nested path segments, for example:

```js
services.fluentFs.app.http.actions.path(`hello.js`);
services.fluentFs.assets.static.htm.path(`index.htm`);
services.fluentFs.storage.uploads.path(`file.txt`);
```

Current fallback policy:

- `app` resolves app-local first, then tenant shared under `shared/app`
- `assets` resolves app-local first, then tenant shared under `shared/assets`
- `storage` stays app-local only

HTTP actions also support first-class template rendering by returning:

```js
{
  status: 200,
  render: {
    template: `static/htm/page.e.htm`,
    view: { title: `Hello` },
    i18n: [`assets/i18n/page.override.json`]
  }
}
```

The action middleware resolves that template from app assets with app/shared fallback, merges route `i18n` first and action `render.i18n` second, and renders the final response through `eRendererRuntime`.

The template engine also supports `@markdown('docs/page.md')`, which resolves the Markdown file from the same assets root boundary used by `@include(...)` and inserts the rendered HTML directly into the template output.

## Contracts

Contracts under [contracts/](./contracts/) define:

- runtime paths
- process labels
- setup identities
- topology derivation
- CLI structure

The setup layer consumes those contracts instead of maintaining a second topology model in parallel.
