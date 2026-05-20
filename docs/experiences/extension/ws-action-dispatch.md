# WS Action Dispatch

This experience lets a WebSocket route expose a bounded inbound action surface that resolves to isolated WS action handlers instead of arbitrary socket event code.

## Experience

- A WS route can declare exactly which inbound actions it accepts through `wsActionsAvailable`.
- Incoming messages are validated early so malformed or disallowed action traffic is discarded quickly.
- Valid WS actions run inside the isolated runtime and can reply directly or use the WS service surface.

## Implementation

- Upgrade handling stores route and session context on the live WS connection.
- The WS hub and middleware runtime validate inbound messages before dispatch.
- WS action handlers are loaded from the app WS actions surface inside `isolatedRuntime`.

## Key Files

- `ehecoatl-runtime/builtin-extensions/adapters/inbound/ingress-runtime/uws/ws-handler.js`
- `ehecoatl-runtime/_core/managers/ws-hub-manager/ws-hub-manager.js`
- `ehecoatl-runtime/bootstrap/process-isolated-runtime.js`
- `ehecoatl-runtime/builtin-extensions/project-kits/test/app_www/app/ws/actions/hello.js`

## Related Docs

- [Middleware and Route Policy Composition](middleware-and-route-policy-composition.md)
- [Request Lifecycle](../../core-concepts/request-lifecycle.md)
- [App Kits](app-kits.md)
