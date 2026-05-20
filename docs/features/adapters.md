# Adapters

Ehecoatl uses adapters to keep core runtime behavior separate from transport and backend-specific implementation details.

## Resolution Model

At startup, the runtime:

1. loads `default.config.js`
2. loads grouped JSON overrides from `/etc/opt/ehecoatl/config`
3. derives adapter lookup paths into `config._adapters`

Each adaptable module then loads its configured adapter lazily through its port contract or adaptable base.

## Packaged Adapter Surface

### Main

- `processForkRuntime`: child-process supervision adapter

### Director And Routing

- `projectDirectoryResolver`
- `projectRegistryResolver`
- `projectRouteMatcherCompiler`
- `requestUriRoutingRuntime`
- `webServerService`

### Transport And Request Execution

- `ingressRuntime`
- `middlewareStackRuntime`

### Shared Services

- `rpcRuntime`
- `storageService`
- `sharedCacheService`

## What The Packaged Adapters Cover

- process supervision and fork management
- HTTP and WebSocket ingress
- project scan and active registry persistence
- route compilation and request routing
- storage and shared cache backends
- ingress web-server integration

Session and CSRF behavior are no longer described as standalone adapter-backed runtime components. They live in the packaged session plugin and cooperate with the request and cache layers.

## Custom Adapters

Custom adapters can be loaded from the runtime's custom adapter path without modifying the packaged runtime files. This keeps backend integration flexible while preserving the packaged runtime boundary.

Legacy tenant-named adapter keys and module paths remain available as compatibility aliases, but new adapter configuration should use the project-named resolver and compiler surfaces.
