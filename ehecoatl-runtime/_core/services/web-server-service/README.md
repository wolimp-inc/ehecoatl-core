# Web Server Service

## Purpose

Director-owned service use case for external TLS/web-server setup and tenant-source-driven host updates.

## Context

- Kernel context: `DIRECTOR`
- Core file: `web-server-service.js`
- Adapter-backed: yes
- Default config adapter: `nginx`

## Current Behavior

- Exposes `setupServer()`, `updateSource(source, routeType)`, `removeSource(sourceKey)`, and `flushChanges()`.
- Syncs one managed web-server source per tenant rather than pushing the whole registry in one adapter call.
- The bundled adapter code in this repo is `nginx`.

## Ambiguities

- The nginx adapter assumes the tenant-local template `.ehecoatl/lib/nginx.e.conf` exists or can be materialized from the default project kit.
- The default template still contains legacy `@t(...)` tokens, so the adapter keeps compatibility replacements while also supporting the newer `{{TOKEN}}` form.

## Not Implemented Yet

- Certificate issuance and renewal are still outside this service; the rendered nginx config first looks for `/etc/letsencrypt/live/<rawdomain>/fullchain.pem` and `privkey.pem`, then falls back to the internal placeholder certificate.
