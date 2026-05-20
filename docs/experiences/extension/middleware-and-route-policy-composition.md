# Middleware and Route Policy Composition

This experience lets route metadata and middleware stacks express runtime policy close to the application surface for HTTP and WebSocket workloads.

## Experience

- Route metadata and middleware labels compose real runtime behavior for HTTP and WebSocket execution.
- Tenant-shared and app-local middleware can be layered without bypassing the packaged runtime stack.
- Higher-level request policy examples such as session/auth/CSRF/CORS are demonstrated concretely through packaged kits and example middleware, not claimed here as one fixed global policy preset.

## Implementation

- Middleware stack resolution loads core, tenant, and app middleware in a consistent runtime pipeline.
- Route metadata drives policy decisions such as auth scope and CORS exposure.
- WS upgrade and message handling preserve route context so the same runtime can dispatch isolated action handlers safely.

## Key Files

- `ehecoatl-runtime/_core/resolvers/middleware-stack-resolver/middleware-stack-resolver.js`
- `ehecoatl-runtime/_core/runtimes/middleware-stack-runtime/middleware-stack-runtime.js`
- `ehecoatl-runtime/builtin-extensions/project-kits/test/shared/app/http/middlewares/session.js`
- `ehecoatl-runtime/builtin-extensions/adapters/inbound/ingress-runtime/uws/ws-handler.js`

## Related Docs

- [Request Lifecycle](../../core-concepts/request-lifecycle.md)
- [WS Action Dispatch](ws-action-dispatch.md)
- [Project Kits](project-kits.md)
