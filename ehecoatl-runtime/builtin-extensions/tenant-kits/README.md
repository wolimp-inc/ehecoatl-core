# Legacy Tenant Kits

This folder is the legacy compatibility home for built-in Tenant Kits.
New built-in kits should live in `../project-kits`.

The current topology reference for Project Kits comes from the Tenant Scope Layer Contract in [tenant-scope.contract.js](../../contracts/layers/tenant-scope.contract.js).

## Contract Topology

At contract level, a tenant ingress root is organized around these roots:

```text
<tenant_root>/
  .ehecoatl/
    logs/
      error/
      boot/
    ssl/
    lib/
    backups/

  shared/
    config/
    routes/
    plugins/
    app/
      http/actions/
      ws/actions/
      utils/
      scripts/
    assets/
```

## Notes

- The contract now declares the shared tenant roots plus the shared action and helper subtrees used by app fallback.
- `shared/config/`, `shared/routes/`, and `shared/plugins/` are modeled by the contract as override roots.
- `shared/app/` and `shared/assets/` are modeled by the contract as shared extension roots.
- `shared/app/http/actions`, `shared/app/ws/actions`, `shared/app/utils`, and `shared/app/scripts` are now contract-declared paths.
- The tenant root `config.json` used by the current kit implementation is not declared as a contract path root yet.
- The default project kit now carries `.ehecoatl/lib/nginx.e.conf`, and the web-server service always renders nginx from the tenant-local copy of that template.
- Legacy tenant kits remain accepted as secondary fallback sources for existing installs.
