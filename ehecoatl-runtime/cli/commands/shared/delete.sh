#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../lib/cli-common.sh"
cli_init "$0"

DELETE_SCOPE="${1:-}"
[ "$#" -gt 0 ] && shift || true
TARGET_ALIAS="${1:-}"
DIRECTOR_RPC_CLI="$SCRIPT_DIR/../../lib/director-rpc-cli.js"

json_field_optional() {
  json_field "$1" "$2" 2>/dev/null || true
}

shutdown_supervised_process() {
  local label="$1"
  local reason="${2:-cli_delete_shutdown}"
  local timeout_ms="${3:-30000}"

  [ -n "$label" ] || return 0
  sudo node "$DIRECTOR_RPC_CLI" shutdown-process "$label" \
    --reason "$reason" \
    --timeout-ms "$timeout_ms" \
    >/dev/null
}

delete_tenant() {
  [ -n "$TARGET_ALIAS" ] || {
    echo "Usage: ehecoatl core delete project @<domain>|@<project_id>"
    exit 1
  }

  local tenant_json tenant_root tenant_id app_pairs app_user app_group
  if [[ "$TARGET_ALIAS" =~ ^@([a-z0-9]{12})$ ]]; then
    tenant_json="$(node "$TENANT_LAYOUT_CLI" find-tenant-json-by-id "$TENANTS_BASE" "${BASH_REMATCH[1]}")"
  elif [[ "$TARGET_ALIAS" =~ ^@([a-z0-9.-]+)$ ]]; then
    tenant_json="$(node "$TENANT_LAYOUT_CLI" find-tenant-json-by-domain "$TENANTS_BASE" "${BASH_REMATCH[1]}")"
  else
    echo "delete project accepts @<domain> or @<project_id>"
    exit 1
  fi

  [ -n "$tenant_json" ] && [ "$tenant_json" != "null" ] || {
    echo "Project '$TARGET_ALIAS' not found."
    exit 1
  }

  tenant_root="$(json_field "$tenant_json" tenantRoot)"
  tenant_id="$(json_field "$tenant_json" tenantId)"
  app_pairs="$(node -e '
    const tenant = JSON.parse(process.argv[1]);
    for (const app of tenant.apps ?? []) {
      process.stdout.write(`${app.tenantId}:${app.appId}\n`);
    }
  ' "$tenant_json")"

  if [ -n "$app_pairs" ]; then
    while IFS=: read -r app_tenant_id app_id; do
      [ -n "$app_tenant_id" ] && [ -n "$app_id" ] || continue
      shutdown_supervised_process "e_app_${app_tenant_id}_${app_id}" "cli_delete_tenant_app"
      app_user="u_app_${app_tenant_id}_${app_id}"
      app_group="g_${app_tenant_id}_${app_id}"
      sudo userdel -f "$app_user" >/dev/null 2>&1 || true
      sudo groupdel "$app_group" >/dev/null 2>&1 || true
    done <<< "$app_pairs"
  fi

  shutdown_supervised_process "e_transport_${tenant_id}" "cli_delete_tenant_transport"
  shutdown_supervised_process "e_project_transport_${tenant_id}" "cli_delete_project_transport"
  sudo userdel -f "u_project_${tenant_id}" >/dev/null 2>&1 || true
  sudo userdel -f "u_tenant_${tenant_id}" >/dev/null 2>&1 || true
  sudo groupdel "g_${tenant_id}" >/dev/null 2>&1 || true
  sudo rm -rf "$tenant_root"

  echo "Project '$TARGET_ALIAS' deleted successfully."
}

delete_app() {
  [ -n "$TARGET_ALIAS" ] || {
    echo "Usage: ehecoatl project delete app <app_name>"
    exit 1
  }

  local app_json app_root tenant_id app_id
  if [[ "$TARGET_ALIAS" =~ ^([a-z0-9._-]+)@([a-z0-9]{12})$ ]]; then
    app_json="$(node "$TENANT_LAYOUT_CLI" find-app-json-by-tenant-id-and-app-name "$TENANTS_BASE" "${BASH_REMATCH[2]}" "${BASH_REMATCH[1]}")"
  elif [[ "$TARGET_ALIAS" =~ ^([a-z0-9._-]+)@([a-z0-9.-]+)$ ]]; then
    app_json="$(node "$TENANT_LAYOUT_CLI" find-app-json-by-domain-and-app-name "$TENANTS_BASE" "${BASH_REMATCH[2]}" "${BASH_REMATCH[1]}")"
  else
    echo "delete app accepts <app_name>@<domain> or <app_name>@<tenant_id>"
    exit 1
  fi

  [ -n "$app_json" ] && [ "$app_json" != "null" ] || {
    echo "App '$TARGET_ALIAS' not found."
    exit 1
  }

  app_root="$(json_field "$app_json" appRoot)"
  tenant_id="$(json_field "$app_json" tenantId)"
  app_id="$(json_field "$app_json" appId)"

  shutdown_supervised_process "e_app_${tenant_id}_${app_id}" "cli_delete_app"
  sudo userdel -f "u_app_${tenant_id}_${app_id}" >/dev/null 2>&1 || true
  sudo groupdel "g_${tenant_id}_${app_id}" >/dev/null 2>&1 || true
  sudo rm -rf "$app_root"

  echo "App '$TARGET_ALIAS' deleted successfully."
}

case "$DELETE_SCOPE" in
  project|tenant) delete_tenant ;;
  app) delete_app ;;
  *)
    echo "Unknown delete scope: ${DELETE_SCOPE:-"(missing)"}"
    exit 1
    ;;
esac
