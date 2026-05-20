# Tenancy

Ehecoatl resolves tenants from the filesystem. The director process scans the configured tenants directory and builds route metadata for each domain and app.

## Default Tenant Root

The bundled configuration and runtime policy point tenancy to:

```text
/var/opt/ehecoatl/tenants
```

The default tenancy adapter reads this tree as:

```text
<tenantsBase>/
  <domain>/
    <app_name>/
      config.json
      index.js
      actions/
      middlewares/
      routes/
      assets/
      .ehecoatl/
        auth/
        .backups/
        .cache/
        .lib/
        log/
        .spool/
        .ssh/
        .tmp/
```

The packaged CLI `core deploy tenant` command creates the tenant layout and promotes any embedded `app_<name>/` folders from the project kit into normal app roots. Custom app kits can still be deployed later with `tenant deploy app` when a tenant needs additional apps. In the repository, the dispatcher lives under `ehecoatl-runtime/cli/` and now routes user-facing commands into scoped folders such as `ehecoatl-runtime/cli/commands/core/` and `ehecoatl-runtime/cli/commands/tenant/`.

Ehecoatl reserves `.ehecoatl/` as the tenant-local system area. Runtime artifacts such as cache files, logs, spooled data, backups, and other internal support folders live there so app code, actions, and assets remain uncluttered at the app root. Functional internal folders may also live there when they are not part of the public asset surface; the example auth flow stores its credentials under `.ehecoatl/auth/credentials.json`.

## App Configuration

The tenancy scanner reads `config.json` inside each app directory and also merges any `.json` files found under that app's `routes/` folder into the effective `routesAvailable` map for that app.

The app-level config may also define:

- `appEnabled`: when set to `false` in `config.json`, the app is ignored during tenant scan and will not be routable

If an app config is malformed or invalid, that app is excluded from routing during scan, and the scanner writes a structured error file at `config.validation.error.json` inside that app folder. Other apps continue scanning normally.

## App Labels

Each tenant app is resolved as:

```text
<app_name>.<domain>
```

Examples:

- `www.example.com`
- `api.example.com`

The resolved structural identity is also used to reconcile isolated runtime processes. Canonical process labels now use ids derived from the folder topology:

- tenant transport: `e_transport_{tenant_id}`
- isolated app runtime: `e_app_{tenant_id}_{app_id}`

When the requested hostname does not have an exact tenant app match in `subdomain` mode, the default tenancy adapter also retries it as `www.<requested-hostname>`. That means a tenant created as `www.example.com` is also reachable through `example.com`, and a scaffolded `www.localhost` app is also reachable through `localhost`.

## Route Definitions

Routes are read from the `routesAvailable` property in the merged app config. The scanner starts with any inline `routesAvailable` object from `config.json`, then merges every `.json` file under `routes/` into that map. Each entry maps a URI pattern to route metadata. The optional app-level `methodsAvailable` array is checked before any matched route-level `methods` array. If either property is omitted, it falls back to `["GET"]`.

The transport runtime applies native HTTP method semantics on top of those declared methods:

- `HEAD` is implicitly allowed anywhere `GET` is allowed
- matched routes can answer `OPTIONS` natively for capability discovery and CORS preflight
- `CONNECT` and `TRACE` are blocked by the engine even if they appear in route config

Static example:

```json
{
  "methodsAvailable": ["GET"],
  "routesAvailable": {
    "/": {
      "methods": ["GET"],
      "contentTypes": [],
      "pointsTo": "run > home@index"
    }
  }
}
```

Dynamic example:

```json
{
  "methodsAvailable": ["GET", "POST"],
  "routesAvailable": {
    "/blog/{slug}": {
      "methods": ["GET"],
      "contentTypes": [],
      "pointsTo": "run > blog@show",
      "cache": "no-cache"
    }
  }
}
```

Dynamic placeholders use `{name}` syntax. During matching, the route compiler turns those patterns into regular expressions and replaces placeholder references in string route values.

Matched placeholder values are also exposed at runtime through `route.params.<name>`. For example, a request that matches `"/blog/{slug}"` can read the normalized slug value in templates as `{{route.params.slug}}`, while legacy string substitutions like `"{slug}"` in route config values continue to work.

Prefix-group route files can also nest route fragments under path keys:

```json
{
  "/api": {
    "/v1": {
      "/users": {
        "pointsTo": "run > users@index"
      },
      "/assets/{file}": {
        "pointsTo": "asset > api/{file}"
      }
    }
  }
}
```

Each valid child path is concatenated with its parent group path, and repeated `/` characters are normalized away during route resolution.

## Public Route Fields

Tenant route JSON supports these public fields:

- `pointsTo`
- `i18n`
- `cache`
- `session`
- `methodsAvailable`
- `methods`
- `contentTypes`
- `upload`
- `maxInputBytes`
- `origin`
- `folders`

`cache` accepts these forms:

- `no-cache`
- a numeric value in seconds, for example `60`
- a full `Cache-Control` definition, for example `public, max-age=60, stale-while-revalidate=30`

Numeric `cache` values produce a default `Cache-Control: public, max-age=<seconds>` response header unless the response already set its own `Cache-Control`. Route cache defaults never override an explicit response header.

`pointsTo` is the canonical route target field and must use one of these forms:

- `run > {resource}@{action}`
- `asset > relative/file.ext`
- `redirect > /path/or/url`
- `redirect 301 > /path/or/url`
- `redirect 302 > /path/or/url`
- `redirect 307 > /path/or/url`
- `redirect 308 > /path/or/url`

Spaces around `>` are accepted and normalized. Redirects default to `302` when the inline status code is omitted. Older public route keys such as `run`, `asset`, `redirect`, and `status` are rejected during tenancy scan.

Internally, the runtime still derives normalized action, asset, and redirect metadata from `pointsTo` so request handling behavior stays the same. On the in-memory `ProjectRoute`, that normalized route metadata is grouped under `projectRoute.meta.target`, and the same grouped target information is also exposed on `projectRoute.target`. Legacy `TenantRoute` imports remain as wrappers for compatibility.

Grouped route metadata currently uses these shapes:

- `target: { type, value, asset, run, redirect }`
  `asset` resolves to `{ path } | null`
  `redirect` resolves to `{ location, status } | null`
- `contentTypes: string[] | null`
- `upload: { uploadPath, uploadTypes, diskLimit, diskLimitBytes }`
- `origin: { hostname, appURL, domain, appName }`
- `folders: { rootFolder, actionsRootFolder, assetsRootFolder, middlewaresRootFolder, routesRootFolder }`

## Static Assets

If a route resolves from `pointsTo: "asset > ..."` and does not set `i18n`, the route is treated as a static asset route. The tenant route resolves the absolute file path from the tenant `assets` tree.

## Domain Aliases

The tenancy adapter supports `domainAlias` files at the tenants root. When an entry in the tenants root is a file instead of a directory, it is parsed as a domain-alias configuration:

```json
{
  "enabled": true,
  "point": "domain.com"
}
```

When enabled, the alias domain mirrors the canonical tenant domain without duplicating compiled routes in the registry. For example:

- `www.alias.com` resolves like `www.domain.com`
- `alias.com` resolves like the configured default app on `domain.com`

Per-domain routing is configured in `tenants/{domain}/config.json` with:

- `appRoutingMode`: `subdomain` or `path`
- `appRouting.mode`: `subdomain` or `path`
- `defaultAppName`: optional default-app override
- `appRouting.defaultAppName`: optional override for that domain

The scanner accepts the flat `appRoutingMode` / `defaultAppName` shape and the nested `appRouting.mode` / `appRouting.defaultAppName` shape. The bundled tenant template uses the flat form.

In `subdomain` mode, `domain.com` falls back to the default app, but `admin.domain.com` does not fall back if `admin` is missing. In `path` mode, the runtime accepts both `domain.com` and `www.domain.com`, first tries `/{app_name}{route}`, and, if that app is missing or absent, falls back to `/{defaultAppName}{uri}`.

Resolved route data distinguishes:

- `origin.hostname`: the exact hostname used in the request, including aliases
- `origin.appURL`: the canonical app address resolved by the router

Successful tenancy rescans also invalidate the shared route and response-cache keys. When an enabled app changes, the director asks the main process to reload only the affected `e_app_{tenant_id}_{app_id}` process. That change detection includes both `config.json` updates and `index.js` modification-time changes. When an app disappears or becomes disabled, the director asks the main process to stop that isolated runtime. When a tenant disappears or becomes disabled, the director also stops its `e_transport_{tenant_id}` process and any `e_app_{tenant_id}_{app_id}` children that belong to it.

## Tenant Action Loading

When transport needs action execution, it sends the route and request to the target `e_app_{tenant_id}_{app_id}` process. That process:

- resolves the resource path relative to `<tenantRoot>/actions`
- weak-loads the module by absolute file path and reloads it when the source-file modification time changes
- resolves `pointsTo: "run > {resource}@{action}"` into a module and exported function
- falls back to `index` when the run target omits `@{action}`
- chooses the handler by explicit action export, `default`, or module export function
- passes a context containing the route, request, tenant metadata, and shared services

If the source file changes or disappears, `weakRequire` clears stale `require.cache` state before the next load attempt. If the changed file fails to load, the runtime does not preserve the previous stale export.

Custom middleware scripts should live under `<tenantRoot>/middlewares`. Route JSON fragments should live under `<tenantRoot>/routes` and are merged during tenancy scan before route compilation.

Tenant and app middleware follow the same weak-load model. These runtime-loaded extension surfaces are intentional exceptions for deployment-facing code, not a general lazy-loading rule for core runtime internals. See [Architecture](architecture.md#load-policy) for the canonical policy.

## Operational Policy

Runtime policy controls tenant ownership and access rules for:

- domain base folders
- app folders
- director read access
- transport read and write access
- per-tenant process user naming

See [Runtime Policy](../reference/runtime-policy.md) for the operational side of tenancy.
