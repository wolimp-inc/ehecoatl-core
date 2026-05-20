#!/bin/bash

cli_init() {
  CLI_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CLI_BASE_DIR="$(cd "$CLI_LIB_DIR/.." && pwd)"
  RUNTIME_DIR="$(cd "$CLI_BASE_DIR/.." && pwd)"

  # shellcheck source=/dev/null
  source "$CLI_LIB_DIR/runtime-policy.sh"
  policy_init "$CLI_BASE_DIR/ehecoatl.sh"

  PROJECTS_BASE="$(policy_value 'paths.projectsBase' 2>/dev/null || true)"
  LEGACY_TENANTS_BASE="$(policy_value 'paths.tenantsBase')"
  TENANTS_BASE="${PROJECTS_BASE:-$LEGACY_TENANTS_BASE}"
  export EHECOATL_LEGACY_TENANTS_BASE="$LEGACY_TENANTS_BASE"
  TENANT_LAYOUT_CLI="$CLI_LIB_DIR/tenant-layout-cli.js"
  INTERNAL_REGISTRY_DIR="$(node -e 'const utils = require(process.argv[1]); process.stdout.write(utils.getInternalScopePath(`RUNTIME`, `registry`) ?? ``);' "$RUNTIME_DIR/contracts/utils.js")"
  MANAGED_LOGINS_DIR="$(node -e 'const utils = require(process.argv[1]); process.stdout.write(utils.getSupervisionScopePath(`RUNTIME`, `managedLogins`) ?? ``);' "$RUNTIME_DIR/contracts/utils.js")"

  EHECOATL_CLI_USERNAME="${EHECOATL_CLI_USERNAME:-$(id -un)}"
  EHECOATL_CLI_GROUPS="${EHECOATL_CLI_GROUPS:-$(id -Gn)}"
}

current_user_has_group() {
  local expected_group="$1"
  local group_name
  for group_name in $EHECOATL_CLI_GROUPS; do
    [ "$group_name" = "$expected_group" ] && return 0
  done
  return 1
}

json_field() {
  node -e '
    const data = JSON.parse(process.argv[1]);
    const pathSegments = String(process.argv[2] ?? ``).split(`.`);
    let current = data;
    for (const segment of pathSegments) current = current?.[segment];
    if (current === undefined || current === null) process.exit(1);
    process.stdout.write(typeof current === `object` ? JSON.stringify(current) : String(current));
  ' "$1" "$2"
}

resolve_scope_by_path_json() {
  local target_path="${1:-$PWD}"
  node "$TENANT_LAYOUT_CLI" resolve-scope-by-path "$TENANTS_BASE" "$target_path"
}

resolve_project_scope_target_json() {
  local target_json kind explicit_target explicit_domain tenant_id required_group
  explicit_target="${EHECOATL_CLI_EXPLICIT_PROJECT_TARGET:-${EHECOATL_CLI_EXPLICIT_TENANT_TARGET:-}}"

  if [ -n "$explicit_target" ]; then
    case "$explicit_target" in
      @*)
        explicit_domain="${explicit_target#@}"
        ;;
      *)
        echo "Explicit project target must use the shape @<domain>." >&2
        return 1
        ;;
    esac

    [ -n "$explicit_domain" ] || {
      echo "Explicit project target must use the shape @<domain>." >&2
      return 1
    }

    target_json="$(node "$TENANT_LAYOUT_CLI" find-tenant-json-by-domain "$TENANTS_BASE" "$explicit_domain")"
    [ -n "$target_json" ] && [ "$target_json" != "null" ] || {
      echo "No project could be found for explicit target: $explicit_target" >&2
      return 1
    }

    tenant_id="$(json_field "$target_json" tenantId 2>/dev/null || true)"
    [ -n "$tenant_id" ] || {
      echo "Unable to resolve projectId for explicit target: $explicit_target" >&2
      return 1
    }

    if [ "$(id -u)" -ne 0 ]; then
      required_group="g_${tenant_id}"
      current_user_has_group "$required_group" || {
        echo "Explicit project target $explicit_target requires membership in $required_group." >&2
        return 1
      }
    fi

    printf '%s' "$target_json"
    return 0
  fi

  target_json="$(resolve_scope_by_path_json)"
  [ -n "$target_json" ] && [ "$target_json" != "null" ] || {
    echo "No project scope could be derived from the current directory: $PWD" >&2
    return 1
  }

  kind="$(json_field "$target_json" kind 2>/dev/null || true)"
  [ "$kind" = "project" ] || [ "$kind" = "tenant" ] || {
    echo "Project commands must be run from a project scope root or shared project path, not from inside an app scope." >&2
    return 1
  }

  printf '%s' "$target_json"
}

resolve_tenant_scope_target_json() {
  resolve_project_scope_target_json
}

resolve_app_scope_explicit_target_json() {
  local explicit_target app_name target_selector target_json tenant_id app_id required_group
  explicit_target="${EHECOATL_CLI_EXPLICIT_APP_TARGET:-}"

  case "$explicit_target" in
    *@*)
      app_name="${explicit_target%@*}"
      target_selector="${explicit_target#*@}"
      ;;
    *)
      echo "Explicit app target must use the shape <app_name>@<domain> or <app_name>@<project_id>." >&2
      return 1
      ;;
  esac

  [ -n "$app_name" ] && [ -n "$target_selector" ] || {
    echo "Explicit app target must use the shape <app_name>@<domain> or <app_name>@<project_id>." >&2
    return 1
  }

  if printf '%s\n' "$target_selector" | grep -Eq '^[a-z0-9]{12}$'; then
    target_json="$(node "$TENANT_LAYOUT_CLI" find-app-json-by-tenant-id-and-app-name "$TENANTS_BASE" "$target_selector" "$app_name")"
  else
    target_json="$(node "$TENANT_LAYOUT_CLI" find-app-json-by-domain-and-app-name "$TENANTS_BASE" "$target_selector" "$app_name")"
  fi

  [ -n "$target_json" ] && [ "$target_json" != "null" ] || {
    echo "No app could be found for explicit target: $explicit_target" >&2
    return 1
  }

  tenant_id="$(json_field "$target_json" tenantId 2>/dev/null || true)"
  app_id="$(json_field "$target_json" appId 2>/dev/null || true)"
  [ -n "$tenant_id" ] && [ -n "$app_id" ] || {
    echo "Unable to resolve projectId/appId for explicit target: $explicit_target" >&2
    return 1
  }

  if [ "$(id -u)" -ne 0 ]; then
    required_group="g_${tenant_id}_${app_id}"
    current_user_has_group "$required_group" || {
      echo "Explicit app target $explicit_target requires membership in $required_group." >&2
      return 1
    }
  fi

  printf '%s' "$target_json"
}

resolve_app_scope_target_json() {
  local target_json kind explicit_target
  explicit_target="${EHECOATL_CLI_EXPLICIT_APP_TARGET:-}"

  if [ -n "$explicit_target" ]; then
    resolve_app_scope_explicit_target_json
    return $?
  fi

  target_json="$(resolve_scope_by_path_json)"
  [ -n "$target_json" ] && [ "$target_json" != "null" ] || {
    echo "No app scope could be derived from the current directory: $PWD" >&2
    return 1
  }

  kind="$(json_field "$target_json" kind 2>/dev/null || true)"
  [ "$kind" = "app" ] || {
    echo "App commands must be run from inside an app scope directory." >&2
    return 1
  }

  printf '%s' "$target_json"
}

describe_cwd_scope() {
  local target_json kind tenant_domain tenant_id app_name app_id
  target_json="$(resolve_scope_by_path_json 2>/dev/null || true)"
  [ -n "$target_json" ] && [ "$target_json" != "null" ] || {
    printf 'outside-managed-scopes'
    return 0
  }

  kind="$(json_field "$target_json" kind 2>/dev/null || true)"
  tenant_domain="$(json_field "$target_json" tenantDomain 2>/dev/null || true)"
  tenant_id="$(json_field "$target_json" tenantId 2>/dev/null || true)"
  app_name="$(json_field "$target_json" appName 2>/dev/null || true)"
  app_id="$(json_field "$target_json" appId 2>/dev/null || true)"

  case "$kind" in
    app)
      printf 'app:%s (%s, %s)' "${app_name:-unknown}" "${tenant_domain:-$tenant_id}" "${app_id:-unknown}"
      ;;
    tenant|project)
      printf 'project:%s (%s)' "${tenant_domain:-$tenant_id}" "${tenant_id:-unknown}"
      ;;
    *)
      printf 'outside-managed-scopes'
      ;;
  esac
}

describe_explicit_app_target() {
  local explicit_target app_name target_selector selector_type
  explicit_target="${EHECOATL_CLI_EXPLICIT_APP_TARGET:-}"
  [ -n "$explicit_target" ] || return 1

  case "$explicit_target" in
    *@*)
      app_name="${explicit_target%@*}"
      target_selector="${explicit_target#*@}"
      ;;
    *)
      printf '%s' "$explicit_target"
      return 0
      ;;
  esac

  if printf '%s\n' "$target_selector" | grep -Eq '^[a-z0-9]{12}$'; then
    selector_type='project-id'
  else
    selector_type='domain'
  fi

  printf 'app:%s (%s:%s)' "$app_name" "$selector_type" "$target_selector"
}

target_kind() {
  if json_field "$1" appId >/dev/null 2>&1; then
    printf 'app'
  else
    printf 'project'
  fi
}

target_config_path() {
  local app_config_path
  if json_field "$1" appConfigPath >/dev/null 2>&1; then
    app_config_path="$(json_field "$1" appConfigPath)"
    if [ -d "$app_config_path" ]; then
      printf '%s\n' "$app_config_path/app.json"
    else
      printf '%s\n' "$app_config_path"
    fi
  else
    json_field "$1" tenantConfigPath
  fi
}

read_target_config() {
  local config_path="$1"
  node -e '
    const fs = require(`node:fs`);
    const filePath = process.argv[1];
    const data = JSON.parse(fs.readFileSync(filePath, `utf8`));
    process.stdout.write(JSON.stringify(data));
  ' "$config_path"
}

config_get_value() {
  local config_path="$1"
  local key_path="$2"

  node -e '
    const fs = require(`node:fs`);
    const filePath = process.argv[1];
    const keyPath = String(process.argv[2] ?? ``).split(`.`);
    let current = JSON.parse(fs.readFileSync(filePath, `utf8`));
    for (const segment of keyPath) current = current?.[segment];
    if (current === undefined) process.exit(2);
    process.stdout.write(typeof current === `object` ? JSON.stringify(current, null, 2) : String(current));
  ' "$config_path" "$key_path"
}

config_set_value() {
  local config_path="$1"
  local key_path="$2"
  local raw_value="$3"

  node -e '
    const fs = require(`node:fs`);
    const filePath = process.argv[1];
    const keyPath = String(process.argv[2] ?? ``).split(`.`);
    const rawValue = process.argv[3];
    const data = JSON.parse(fs.readFileSync(filePath, `utf8`));
    let value = rawValue;
    try { value = JSON.parse(rawValue); } catch {}

    let cursor = data;
    while (keyPath.length > 1) {
      const segment = keyPath.shift();
      if (!cursor[segment] || typeof cursor[segment] !== `object` || Array.isArray(cursor[segment])) {
        cursor[segment] = {};
      }
      cursor = cursor[segment];
    }
    cursor[keyPath[0]] = value;

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + `\n`, `utf8`);
    process.stdout.write(JSON.stringify(data));
  ' "$config_path" "$key_path" "$raw_value"
}

tail_existing_logs() {
  local found=0
  local target_path
  for target_path in "$@"; do
    [ -f "$target_path" ] || continue
    found=1
    printf '==> %s <==\n' "$target_path"
    tail -n 40 "$target_path"
    printf '\n'
  done

  if [ "$found" -eq 0 ]; then
    echo "No log files found for the selected target."
    return 1
  fi
}
