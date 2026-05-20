# Project Kits

This experience gives a project-level packaging surface for shared middleware, shared assets, and project-wide conventions before any one app is deployed.

## Experience

- Project kits define the default behavior shared across apps inside one project.
- Shared middleware and configuration live at the project layer instead of being duplicated per app.
- Project kits make the first deploy useful by shipping opinionated starting behavior.

## Implementation

- Project kit content is copied into the project layout during deploy.
- Project kits may be stored as folders or `.zip` archives. Zip project kits must place project files directly at the zip root.
- Project kit resolution checks built-in kits, then `PATHS.EXTENSIONS.customProjectKits`, then `https://github.com/ehecoatl/project-kit-<kitname>.git`.
- Legacy `tenant-kits` roots, `customTenantKits`, and `tenant-kit-<kitname>` remotes remain supported as secondary compatibility fallbacks.
- Remote fallback kits are cloned into the custom project-kit root as `<kitname>/` and are not auto-updated on later deploys.
- Project kits may include top-level `app_<name>/` folders. Each matching folder is reserved as an embedded app source and is auto-deployed as app `<name>` during project deploy.
- Embedded app folders are copied into generated app roots, then removed from the project root after successful app creation.
- Project-shared middleware becomes part of the runtime middleware resolution flow for deployed apps.
- The example project kit demonstrates project-level security and request policy composition.

## Key Files

- [`ehecoatl-runtime/builtin-extensions/project-kits/test/config.json`](../../ehecoatl-runtime/builtin-extensions/project-kits/test/config.json)
- [`ehecoatl-runtime/builtin-extensions/project-kits/test/shared/app/http/middlewares/auth.js`](../../ehecoatl-runtime/builtin-extensions/project-kits/test/shared/app/http/middlewares/auth.js)
- [`ehecoatl-runtime/builtin-extensions/project-kits/test/shared/app/http/middlewares/cors.js`](../../ehecoatl-runtime/builtin-extensions/project-kits/test/shared/app/http/middlewares/cors.js)
- [`ehecoatl-runtime/cli/commands/shared/deploy.sh`](../../ehecoatl-runtime/cli/commands/shared/deploy.sh)

## Related Docs

- [Project Kits](project-kits.md)
- [Middleware and Route Policy Composition](middleware-and-route-policy-composition.md)
- [Tenancy](../core-concepts/tenancy.md)
