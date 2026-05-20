# Application Delivery Surface

This experience lets a deployed app expose HTTP actions, assets, templates, i18n output, WS routes, and WS actions through one packaged runtime model.

## Experience

- App code is organized around deployable runtime surfaces instead of custom ad hoc folder conventions.
- HTTP and WebSocket behavior both resolve through the same isolated app runtime boundary.
- Templates, assets, and action handlers stay part of the app delivery model rather than side channels.

## Implementation

- Tenancy and route metadata resolve app-local folders for assets, actions, middlewares, and routes.
- The isolated runtime executes HTTP and WS action modules from the app surface.
- The default app embedded in the example project kit demonstrates the packaged delivery model through routes, actions, and WS handlers.

## Key Files

- [`docs/core-concepts/tenancy.md`](../../core-concepts/tenancy.md)
- `ehecoatl-runtime/bootstrap/process-isolated-runtime.js`
- `ehecoatl-runtime/builtin-extensions/project-kits/test/app_www/config/default.json`
- `ehecoatl-runtime/builtin-extensions/project-kits/test/app_www/app/ws/actions/hello.js`

## Related Docs

- [App Kits](app-kits.md)
- [WS Action Dispatch](ws-action-dispatch.md)
- [Tenancy](../../core-concepts/tenancy.md)
