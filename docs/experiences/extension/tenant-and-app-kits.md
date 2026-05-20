# Tenant and App Kits

This experience gives developers packaged starting points for deploying tenants and apps without rebuilding the runtime surface from scratch.

## Experience

- Project kits establish shared tenant-level behavior and may include default embedded apps for first deploy.
- App kits package routes, actions, assets, and runtime behavior for custom app rollout.
- Kits keep starter behavior aligned with the same deploy and reconciliation flows used in production topology.

## Implementation

- Deploy commands copy kit content into contract-backed runtime locations.
- Kits can be stored as directories or `.zip` archives under the built-in kit roots. Zip archives must contain the kit files directly at the archive root.
- Project kits may bundle apps as top-level `app_<name>/` folders; these are promoted to normal apps during tenant deploy without becoming global app kits.
- The example project kit embeds the default app and exercises middleware, HTTP, and WS behavior inside the packaged runtime model.
- Kit content is organized so tenant-level concerns stay distinct from app-local concerns.

## Key Files

- `ehecoatl-runtime/builtin-extensions/project-kits/test/config.json`
- `ehecoatl-runtime/builtin-extensions/project-kits/test/app_www/config/default.json`
- `ehecoatl-runtime/cli/commands/shared/deploy.sh`

## Related Docs

- [Project Kits](project-kits.md)
- [App Kits](app-kits.md)
- [Tenant and App Deployment Flow](../surface/tenant-and-app-deployment-flow.md)
