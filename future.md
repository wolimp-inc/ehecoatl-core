# Internal Future Work

This file is an internal planning note. It is not part of the canonical product documentation surface.

## High Priority

- purge-data robustness after uninstall removes the installed runtime
- nested adapter dependency packaging policy and lifecycle
- standardized artifact helper for app storage with folder auto-create
- renderer regression coverage for template parser and action render paths
- built-in health and smoke command in `ehecoatl-core.sh`
- clearer permission model for root service, capabilities, and privileged-host boundaries
- adapter-local dependency install reporting and failure diagnostics
- supervised outbound HTTPS proxy channel for app web calls with firewall-controlled egress policy
- self-hosted agile control panel for debug `Ehecoatl Panel` project-kit

## Medium Priority

- route artifact persistence for faster restarts
- customizable topology translation for tenant and app layout
- additional CLI generators for starter kits and extension types
- organize metrics, request, and performance tracing in standardized files via plugin
- clearer app and tenant disk, memory, and CPU limits with overload policies
- nginx managed include self-healing and publish diagnostics
- kit scaffolding that already includes `app/utils`, `app/scripts`, `shared/app/utils`, and `shared/app/scripts`
- first-class artifact cache conventions for routes, templates, and compiled metadata

## Lower Priority

- richer SSH user management experience carrying multiple scopes and shortcuts in the home folder
- managed SSH users with no-password keypair generation and setup
- optional raw TCP or UDP exposure for selected app workloads
- app-facing background job or scheduled task model
- structured audit log for privileged operations and app-triggered CLI commands
- app and tenant quota reporting surfaced to governance apps
- safer contract for optional extension package boundaries beyond adapters
- end-to-end install, uninstall, and purge test automation on clean host snapshots
