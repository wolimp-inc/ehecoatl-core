# Ehecoatl Core Experience Design

`EXPERIENCE_DESIGN.md` is the high-level map of what Ehecoatl is designed to make easy, safe, and extensible for developers and operators.

Each item below links to a more detailed page under `docs/experiences/` that explains the implementation and points to the main scripts, modules, and contracts involved.

## Surface Experiences

- [Setup, Install, and Uninstall Lifecycle](docs/experiences/host-lifecycle-management.md) - The packaged setup surface makes bootstrap, install, uninstall, and purge feel like one explicit host lifecycle.
- [Version Manager and Release Dispatch](docs/experiences/version-manager-and-release-dispatch.md) - `ehecoatl-core.sh` gives developers and operators one release-aware entrypoint for download, install, installed-version inspection, and uninstall handoff.
- [Scoped CLI Operations](docs/experiences/scoped-cli-operations.md) - Operational commands are organized by scope so control surfaces stay explicit and identity-aware.
- [Human Access and Scoped Workspaces](docs/experiences/human-access-and-scoped-workspaces.md) - Managed human logins get scoped shell access and curated workspaces instead of sharing runtime identities directly.
- [Edge and Host Integration](docs/experiences/edge-and-host-integration.md) - The packaged runtime can integrate with host services such as Nginx, Let's Encrypt, and Redis through optional managed bootstraps.
- [Configuration and Admin Operations](docs/experiences/configuration-and-admin-operations.md) - Config, enable, disable, delete, and status flows are exposed through the CLI across core, tenant, and app scopes.
- [Tenant and App Deployment Flow](docs/experiences/tenant-and-app-deployment-flow.md) - Tenant and app rollout follows a repeatable CLI pipeline with contract-backed post-deploy actions.
- [Registry Scan and Reconciliation](docs/experiences/registry-scan-and-reconciliation.md) - Director state is rebuilt from filesystem and registry inputs instead of hidden in-memory state.
- [Operational Observability](docs/experiences/operational-observability.md) - Operators get first-class status, logs, and service-manager visibility, while metrics and alerting remain separate missing experiences.

Key sub-experiences:

- [Core Service Lifecycle](docs/experiences/core-service-lifecycle.md) - Service start, stop, restart, status, and package installation are exposed as stable lifecycle operations.
- [Director Rescan and Registry Sync](docs/experiences/director-rescan-and-registry-sync.md) - The director can be forced to reconcile tenancy state immediately through its direct RPC surface.
- [Scoped Logging and Status](docs/experiences/scoped-logging-and-status.md) - Runtime health and logs are surfaced through packaged commands instead of ad hoc host inspection.

## Extension Experiences

- [Adapter Replaceability](docs/experiences/adapter-replaceability.md) - Core behavior is written against ports so infrastructure can be swapped without changing use-case code.
- [Plugin Hooks and Context Isolation](docs/experiences/plugin-hooks-and-context-isolation.md) - Hooks and plugin boundaries expose a real extension surface, even though the built-in plugin catalog remains intentionally small.
- [Tenant and App Kits](docs/experiences/tenant-and-app-kits.md) - Starter kits provide a packaged way to stand up tenants and apps quickly.
- [Application Delivery Surface](docs/experiences/application-delivery-surface.md) - Apps can deliver HTTP actions, assets, templates, i18n output, WS routes, and WS actions inside one packaged execution model.
- [Request Security Composition](docs/experiences/request-security-composition.md) - Session, auth, CSRF, CORS, and `authScope` are deliverable through the middleware and route surface, mainly as packaged runtime primitives plus kit-driven examples.
- [Middleware and Route Policy Composition](docs/experiences/middleware-and-route-policy-composition.md) - Route metadata and middleware stacks express runtime policy close to the application surface, with some higher-level policies demonstrated through kits rather than enforced globally.
- [Developer Iteration and Live Refresh](docs/experiences/developer-iteration-and-live-refresh.md) - Deploy, rescan, weak-load, and reload behavior support a code-change loop without redefining the runtime topology.

Key sub-experiences:

- [Project Kits](docs/experiences/project-kits.md) - Project kits define shared tenant-level assets, middleware, and conventions before app deployment starts.
- [App Kits](docs/experiences/app-kits.md) - App kits package routes, actions, assets, and example runtime behavior for fast deploy.
- [WS Action Dispatch](docs/experiences/ws-action-dispatch.md) - WebSocket routes can expose inbound action surfaces through `wsActionsAvailable` and isolated action handlers.

## Service Nucleus Experiences

- [Process Supervision and Restart Policy](docs/experiences/process-supervision-and-restart-policy.md) - Child processes are supervised, drained, and relaunched when they become unhealthy or crash.
- [Process Isolation and Identity Model](docs/experiences/process-isolation-and-identity-model.md) - Runtime identities, scope groups, and privilege drops isolate each process to its intended surface.
- [Contracts-Driven Topology](docs/experiences/contracts-driven-topology.md) - Filesystem layout, ownership, and permissions are derived from contracts instead of hand-maintained scripts.
- [Tenancy and Addressing Model](docs/experiences/tenancy-and-addressing-model.md) - Domains, aliases, default apps, routing modes, and opaque tenant/app identifiers define how deployable topology becomes addressable runtime state.
- [Network Isolation Helpers](docs/experiences/network-isolation-helpers.md) - Firewall commands and launcher-side network helpers form a narrow privileged network-control surface.
- [Runtime State and Support Folders](docs/experiences/runtime-state-and-support-folders.md) - Tenant-local support folders and shared runtime state surfaces keep caches, logs, spools, and support artifacts out of the app root.
- [RPC and Runtime Topology](docs/experiences/rpc-and-runtime-topology.md) - `main`, `director`, `transport`, and `isolatedRuntime` coordinate through explicit runtime roles and RPC channels.

Key sub-experiences:

- [Heartbeat and Reload Flow](docs/experiences/heartbeat-and-reload-flow.md) - Heartbeats and watchdog reload rules define how unhealthy child processes are detected and replaced.
- [Runtime Isolation After Bootstrap](docs/experiences/runtime-isolation-after-bootstrap.md) - Transport and isolated runtimes shed bootstrap-only access after startup completes.
- [Require Cache Flush and Weak Loading](docs/experiences/require-cache-flush-and-weak-loading.md) - Post-bootstrap cache flushes and weak loading keep runtime-late code loading explicit and isolated.

## Design Topics Not Delivered Today

These topics matter to product maturity, but the current repository does not deliver them as first-class packaged experiences yet.

### Urgent

- [Operational Audit Trail and Change Registry](docs/experiences/operational-audit-trail-and-change-registry.md) - The runtime does not yet keep a first-class audit record of administrative changes such as deploys, rescans, login changes, uninstall, or purge.
- [Metrics, Health Export, and Alerting](docs/experiences/metrics-health-export-and-alerting.md) - Status, logs, and heartbeats exist, but there is no packaged metrics export or alert surface for operators today.
- [Backup and Restore Workflow](docs/experiences/backup-and-restore-workflow.md) - State folders and backup-like paths exist, but there is no first-class backup, restore, or validation workflow.

### Important

- [Upgrade and Rollback Orchestration](docs/experiences/upgrade-and-rollback-orchestration.md) - Install and cleanup flows exist, but there is no packaged upgrade and rollback path for controlled change management.
- [Secrets and Certificate Lifecycle Management](docs/experiences/secrets-and-certificate-lifecycle-management.md) - Host integration exists, but secret and certificate lifecycle handling is not a first-class tracked operator experience.
- [Retention and Cleanup Policy](docs/experiences/retention-and-cleanup-policy.md) - Runtime support folders exist, but no packaged retention, pruning, or storage-hygiene policy is implemented today.
- [Operator Healthcheck and Smoke Tooling](docs/experiences/operator-healthcheck-and-smoke-tooling.md) - Smoke checks exist in docs and engineering practice, but not as a packaged operator tool.
- [Abuse Control and Capacity Governance](docs/experiences/future/abuse-control-and-capacity-governance.md) - The runtime has lower-level ingress limiting and action queueing, but does not yet expose quotas or tenant/app resource-governance as a first-class experience.
