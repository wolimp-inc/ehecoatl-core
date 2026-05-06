# Configuration

Ehecoatl is configured from `ehecoatl-runtime/config/default.config.js` plus grouped JSON overrides under `/etc/opt/ehecoatl/config`.

## Load Model

The runtime:

1. loads `default.config.js`
2. reads grouped JSON overrides from the external config tree
3. replaces matching top-level sections
4. derives adapter lookup paths into `config._adapters`

Overrides are section-based, not deep-merged across arbitrary files.

## Main Configuration Areas

### `runtime`

Defines runtime paths and grouped configuration roots such as:

- custom config
- custom adapters
- custom plugins

`runtime.security.seccomp.mode` controls the protected child-process no-spawn boundary:

- `enforce`
- `warn`

`runtime.network` controls automatic process firewall behavior:

```json
{
  "defaultWanBlock": true,
  "wanOpenApps": ["www@testa.ehecoatl.com.br"],
  "openLocalPorts": [6379, 3306, 15010]
}
```

- `defaultWanBlock` enables automatic WAN-facing TCP fencing for supervised process users. When set to `false`, the runtime skips new automatic WAN block setup and clears existing Ehecoatl WAN firewall chains during the next main runtime boot/sync.
- `wanOpenApps` lists app exceptions in `appName@tenantDomain` format. Exceptions apply only to app isolated runtimes while `defaultWanBlock` is `true`.
- `openLocalPorts` keeps the local-proxy allowlist behavior and is the only supported path for that setting. The old `runtime.openlocalports` key is no longer supported.
- In split config, the network block is stored at `/etc/opt/ehecoatl/config/runtime/network.json`.

### `plugins`

Controls packaged and custom plugin enablement plus plugin-specific settings such as:

- logger runtime behavior
- session runtime behavior
- process firewall integration

### `adapters`

Holds configuration for adapter-backed runtime components and services, including:

- `rpcRuntime`
- `ingressRuntime`
- `tenantDirectoryResolver`
- `tenantRegistryResolver`
- `tenantRouteMatcherCompiler`
- `requestUriRoutingRuntime`
- `middlewareStackRuntime`
- `processForkRuntime`
- `storageService`
- `sharedCacheService`
- `webServerService`

## Selected Adapter Sections

### `adapters.requestUriRoutingRuntime`

Controls route matching against the active tenancy registry, default app resolution, and route match caching behavior.

### `adapters.middlewareStackRuntime`

Controls middleware execution settings, input-size limits, queue behavior, and question names used by request execution.

The `queue` subsection currently controls the app action queue. `actionMaxConcurrent` is the effective per-resolved-app action concurrency limit. If it is not set, the runtime falls back to `perTenantMaxConcurrent`, then `5`.

The current runtime does not treat `perTenantMaxConcurrent` as a global tenant-wide cap across every request type. Static assets usually complete in `core-static-asset-serve` before `core-queue`, so `staticMaxConcurrent` and `staticWaitTimeoutMs` are configuration placeholders in this snapshot rather than active static-asset queue controls.

The `diskLimit.trackedPaths` entries are relative to the resolved app route root, exposed as `tenantRoute.folders.rootFolder`. The default tracked paths follow the app-local runtime support layout: `.ehecoatl/.cache`, `.ehecoatl/log`, and `.ehecoatl/.spool`. The response-cache materializer writes cache artifacts under `.ehecoatl/.cache`, so older shorthand names such as `.cache` do not cover the active cache folder.

The action queue wait path uses `actionWaitTimeoutMs`, then `waitTimeoutMs`, then `1000`. `retryAfterMs` is used to build the `Retry-After` header on action queue overload responses.

When response caching is enabled through route `cache` definitions, `maxResponseCacheTTL` is expressed in seconds and clamps the route-derived cache lifetime before it is converted to the internal shared-cache millisecond TTL.

Explicit response-cache materialization also uses director-side queue coordination, but it is independent of the action queue settings: cache misses are serialized per cache key with one active materializer and a hard-coded wait window in the cache middleware.

### `adapters.ingressRuntime`

Controls the packaged ingress adapter and its internal HTTP/WebSocket ports. The `limiter` subsection applies before route resolution. In the default UWS HTTP adapter, `capacity` is the token-bucket burst size and `time` is currently used as the token refill rate per second. Exhausted buckets return `429 Too Many Requests`.

### `adapters.processForkRuntime`

Controls supervised child-process boot paths, timeouts, and process coordination questions.

It also controls the default resource boundary for supervised children. The default configuration is:

```js
adapters: {
  processForkRuntime: {
    nodeMaxOldSpaceSizeMb: 192,
    cgroups: {
      enabled: true,
      memoryMaxMb: 192,
      cpuMaxPercent: 50,
      cleanupIntervalMs: 30000,
      delegateSubgroup: "supervisor",
      registryFile: "/var/lib/ehecoatl/registry/managed-cgroups.json"
    }
  }
}
```

Important settings:

- `nodeMaxOldSpaceSizeMb` sets Node.js `--max-old-space-size` for supervised child processes. This is a V8 heap limit, not a whole-process memory limit.
- `cgroups.enabled` turns managed per-process cgroups on or off.
- `cgroups.memoryMaxMb` sets the hard cgroup memory limit for each supervised process. The default is `192MiB`.
- `cgroups.cpuMaxPercent` sets the cgroup CPU quota for each supervised process. The default `50` means `50%` of one CPU core, rendered as cgroup v2 `cpu.max = "50000 100000"`.
- `cgroups.cleanupIntervalMs` controls how often the privileged launcher scans and removes unused managed cgroups.
- `cgroups.delegateSubgroup` must match the systemd unit `DelegateSubgroup=` value. The packaged unit uses `supervisor`.
- `cgroups.registryFile` stores the managed cgroup registry used for cleanup and restart reconciliation.

When a supervised child exceeds `cgroups.memoryMaxMb`, the kernel cgroup memory controller enforces `memory.max`. If memory cannot be reclaimed, the process cgroup is OOM-killed. Because managed cgroups set `memory.oom.group=1`, descendants in the same cgroup are killed with the process. The supervisor then observes the exit and relaunches the process into a new cgroup.

When a supervised child exceeds `cgroups.cpuMaxPercent`, the kernel throttles the process. CPU overuse does not kill the process by itself.

### `adapters.tenantDirectoryResolver`

Controls tenancy scan roots, scan cadence, registry refresh behavior, and forced rescan question names.

### `adapters.sharedCacheService`

Controls the shared-cache backend and operation-level failure policy.

## Notes

- The seccomp boundary for protected child processes blocks `fork`, `vfork`, `execve`, and `execveat`.
- Thread creation required by the Node.js runtime remains allowed.
- Seccomp and process identity are only part of the runtime security model; the bootstrap load policy and supported weak-load exceptions are documented in [Architecture](../core-concepts/architecture.md#load-policy) and [Runtime Logic Overview](../logic.md#load-policy).
- Direct CLI-triggered tenant rescans are handled by the `director` process through its local RPC socket.
