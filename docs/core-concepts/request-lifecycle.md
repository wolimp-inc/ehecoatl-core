# Request Lifecycle

This page describes the current HTTP request path implemented by the packaged ingress runtime and middleware stack.

## 1. Network Acceptance

The tenant transport process accepts HTTP requests through the configured ingress adapter. In the default packaged flow, that adapter is the UWS runtime.

Before the request reaches application code, the transport process:

- resolves the client address
- applies HTTP request limiting
- builds an `ExecutionContext`

The packaged UWS HTTP ingress uses an in-process token bucket keyed by client IP. `adapters.ingressRuntime.limiter.capacity` is the burst size and `adapters.ingressRuntime.limiter.time` is currently used as the token refill rate per second. When a client exhausts its bucket, ingress returns `429 Too Many Requests` before route resolution or middleware execution.

This ingress limiter is separate from the middleware action queue described below. It is a request admission guard, not a tenant/app capacity budget.

## 2. Request Normalization

The execution context builds normalized request data including:

- method
- path
- headers
- query string
- parsed cookies
- request body
- client IP

The request path is normalized before route matching, including canonical slash handling.

## 3. Route Resolution

The project transport process asks `director` to resolve the active route through `requestUriRoutingRuntime`.

That resolution step uses the active project registry maintained by `projectDirectoryResolver` and returns a normalized `ProjectRoute` model. Legacy `tenantDirectoryResolver` adapters remain accepted as compatibility aliases.

## 4. Middleware Execution

HTTP middleware execution is coordinated by `middlewareStackRuntime`.

The packaged transport flow includes middleware for:

- static asset delivery
- response-cache lookup
- queue coordination
- project action execution
- asynchronous cache materialization

In the current packaged HTTP stack, static asset middleware runs before queue coordination. A static asset route usually returns from `core-static-asset-serve` and does not enter the action queue.

The `core-queue` middleware currently queues app action execution only. It checks for an action target, then asks `director` to reserve a queue slot before `core-tenant-action` sends the request to the isolated runtime. The queue label is derived from the resolved app identity as `actionQueue:{projectId}:{appId}`. If older or synthetic route metadata only includes tenant IDs, that legacy identity is still accepted as a fallback.

The action queue uses `adapters.middlewareStackRuntime.queue.actionMaxConcurrent`, falling back to `perTenantMaxConcurrent`, then `5`. Today `perTenantMaxConcurrent` is a fallback name for action concurrency, not a global cap across all static, cached, WebSocket, and action work for a tenant. `staticMaxConcurrent` and `staticWaitTimeoutMs` are present in the default config but are not wired into `core-static-asset-serve` in this snapshot.

If the action queue is full, the middleware returns `503 Service Unavailable`. If a request waits longer than the configured wait timeout, it returns `504 Gateway Timeout`. Both overload responses include `Retry-After` when `retryAfterMs` is configured.

Response-cache materialization uses the same director queue broker for a narrower purpose: explicit cache misses are serialized per cache key with one concurrent materializer. If that cache queue cannot be acquired, the request continues instead of returning an overload response.

Project and app middleware remain separate from core transport middleware. They are represented in route metadata and project-local middleware files.

Project and app middleware are one of the few intentional runtime weak-load surfaces. They are loaded from absolute file paths through `weakRequire`, which compares source-file modification time, clears stale `require.cache` state when the file changes or disappears, and reloads on the next stack build. This exception exists for deployment-facing extension code only; it does not extend to arbitrary core runtime files. See [Architecture](architecture.md#load-policy) for the canonical load-policy rule.

## 5. Action Execution

When the route points to an app action, the transport process sends the request to the canonical `e_app_{project_id}_{app_id}` isolated runtime process for that application. Existing legacy labels using tenant-derived IDs continue to be recognized.

The isolated runtime executes the action and returns the response payload back to transport.

The isolated runtime also weak-loads the app entrypoint and action modules by design. Those files are reloaded through `weakRequire` when their source modification time changes, and stale exports are not preserved after a changed-file load failure.

## 6. Response Writing

After middleware execution completes, the transport process writes:

- status
- headers
- cookies
- body

Objects are serialized as JSON automatically. Streamed and cached responses are also finalized in the transport process.

## 7. WebSocket Upgrade Path

WebSocket upgrades now follow the same request bootstrap principles up to the upgrade decision:

- build execution context
- normalize request data
- resolve the route first
- run the dedicated WebSocket upgrade middleware path

If the final response status is `200`, the transport performs the upgrade. Otherwise it returns a normal HTTP rejection response.

Live channel coordination after upgrade is handled by `wsHubManager`, while isolated apps interact through `services.ws` backed by `wsAppRuntime`.
