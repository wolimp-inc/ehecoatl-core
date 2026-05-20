#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
source "$SCRIPT_DIR/../lib/runtime-policy.sh"
policy_init "$0"

DEPLOY_SCOPE="${1:-}"
[ "$#" -gt 0 ] && shift || true

PROJECT_KIT_NAME=""
APP_KIT_NAME=""
REPO_URL=""
ENTER_AFTER_CREATE=0
TARGET_ALIAS=""

VAR_BASE_DIR="$(policy_value 'paths.tenantsBase')"
VAR_ROOT_DIR="$(policy_value 'paths.varBase')"
DEFAULT_OWNER="$(policy_value 'tenantLayout.domainBaseOwner')"
DEFAULT_GROUP="$(policy_value 'tenantLayout.domainBaseGroup')"
DOMAIN_BASE_MODE="$(policy_value 'tenantLayout.domainBaseMode')"
APP_MODE="$(policy_value 'tenantLayout.appMode')"
APP_WRITABLE_DIR_MODE="$(policy_value 'tenantLayout.appWritableDirMode')"
APP_FILE_MODE="$(policy_value 'tenantLayout.appFileMode')"
APP_CONFIG_MODE="$(policy_value 'tenantLayout.appConfigMode')"
DIRECTOR_USER="$(policy_value 'processUsers.director.user')"
TRANSPORT_USER="$(policy_value 'processUsers.transport.user')"
TENANT_LAYOUT_CLI="$SCRIPT_DIR/../lib/tenant-layout-cli.js"
PROJECT_KITS_BASE="$SCRIPT_DIR/../../builtin-extensions/project-kits"
APP_KITS_BASE="$SCRIPT_DIR/../../builtin-extensions/app-kits"
DEFAULT_PROJECT_KIT_NAME="empty-project-kit"
DEFAULT_APP_KIT_NAME="empty-app-kit"

usage() {
  cat <<'EOF_USAGE'
Usage:
  ehecoatl deploy tenant @<domain> [--repo <repo_url>] [-p <project_kit>] [-e]
  ehecoatl deploy app <app_name>@<domain> [--repo <repo_url>] [-a <app_kit>] [-e]
  ehecoatl deploy app <app_name>@<tenant_id> [--repo <repo_url>] [-a <app_kit>] [-e]
EOF_USAGE
}

normalize_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

json_field() {
  node -e '
    const data = JSON.parse(process.argv[1]);
    const key = process.argv[2];
    const value = data?.[key];
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(String(value));
  ' "$1" "$2"
}

apply_acl_permission() {
  local target_path="$1"
  local user_name="$2"
  local permission="$3"

  if [ ! -e "$target_path" ] || ! command -v setfacl >/dev/null 2>&1; then
    return 0
  fi

  if [ -d "$target_path" ]; then
    sudo setfacl -R -m "u:${user_name}:${permission}" "$target_path" >/dev/null 2>&1 || true
    sudo setfacl -R -d -m "u:${user_name}:${permission}" "$target_path" >/dev/null 2>&1 || true
  else
    sudo setfacl -m "u:${user_name}:${permission}" "$target_path" >/dev/null 2>&1 || true
  fi
}

ensure_directory_search_permission() {
  local target_dir="$1"
  local user_name="$2"

  if [ ! -d "$target_dir" ] || ! command -v setfacl >/dev/null 2>&1; then
    return 0
  fi

  sudo setfacl -m "u:${user_name}:--x" "$target_dir" >/dev/null 2>&1 || true
}

grant_path_traversal() {
  local tenant_app_dir="$1"
  local user_name="$2"
  local target_path="$3"
  local current_dir

  [ -d "$tenant_app_dir" ] || return 0

  ensure_directory_search_permission "$tenant_app_dir" "$user_name"

  if [ -d "$target_path" ]; then
    current_dir="$target_path"
  else
    current_dir="$(dirname "$target_path")"
  fi

  while [ "$current_dir" != "$tenant_app_dir" ] && [ "$current_dir" != "/" ]; do
    case "$current_dir" in
      "$tenant_app_dir"/*)
        ensure_directory_search_permission "$current_dir" "$user_name"
        ;;
      *)
        break
        ;;
    esac
    current_dir="$(dirname "$current_dir")"
  done
}

grant_tenant_runtime_traversal() {
  local tenant_user="$1"
  local tenant_dir="$2"

  ensure_directory_search_permission "$VAR_ROOT_DIR" "$tenant_user"
  ensure_directory_search_permission "$VAR_BASE_DIR" "$tenant_user"
  ensure_directory_search_permission "$tenant_dir" "$tenant_user"
}

apply_role_acl() {
  local tenant_app_dir="$1"
  local role_user="$2"
  local role_path="$3"
  local relative_path absolute_path

  [ -n "$role_user" ] || return 0

  while IFS= read -r relative_path; do
    [ -n "$relative_path" ] || continue
    absolute_path="$tenant_app_dir/$relative_path"
    grant_path_traversal "$tenant_app_dir" "$role_user" "$absolute_path"
    apply_acl_permission "$absolute_path" "$role_user" "rX"
  done < <(policy_array_lines "$role_path.read" 2>/dev/null || true)

  while IFS= read -r relative_path; do
    [ -n "$relative_path" ] || continue
    absolute_path="$tenant_app_dir/$relative_path"
    grant_path_traversal "$tenant_app_dir" "$role_user" "$absolute_path"
    apply_acl_permission "$absolute_path" "$role_user" "rwX"
  done < <(policy_array_lines "$role_path.write" 2>/dev/null || true)
}

set_owner_group_mode() {
  local target_path="$1"
  local owner_name="$2"
  local group_name="$3"
  local mode_value="$4"

  [ -e "$target_path" ] || return 0
  sudo chown "$owner_name:$group_name" "$target_path"
  sudo chmod "$mode_value" "$target_path"
}

apply_tree_mode() {
  local root_path="$1"
  local owner_name="$2"
  local group_name="$3"
  local dir_mode="$4"
  local file_mode="$5"

  [ -d "$root_path" ] || return 0
  sudo chown -R "$owner_name:$group_name" "$root_path"
  sudo find "$root_path" -type d -exec chmod "$dir_mode" {} +
  sudo find "$root_path" -type f -exec chmod "$file_mode" {} +
}

apply_app_permissions() {
  local app_dir="$1"
  local tenant_dir="$2"
  local owner_user="$3"
  local owner_group="$4"
  local system_dir="$app_dir/.ehecoatl"

  set_owner_group_mode "$tenant_dir" "$DEFAULT_OWNER" "$DEFAULT_GROUP" "$DOMAIN_BASE_MODE"
  apply_tree_mode "$app_dir" "$owner_user" "$owner_group" "$APP_MODE" "$APP_FILE_MODE"
  set_owner_group_mode "$system_dir" "$owner_user" "$owner_group" "$APP_MODE"
  set_owner_group_mode "$system_dir/.cache" "$owner_user" "$owner_group" "$APP_WRITABLE_DIR_MODE"
  set_owner_group_mode "$system_dir/.log" "$owner_user" "$owner_group" "$APP_WRITABLE_DIR_MODE"
  set_owner_group_mode "$system_dir/.spool" "$owner_user" "$owner_group" "$APP_WRITABLE_DIR_MODE"
  set_owner_group_mode "$system_dir/.backups" "$owner_user" "$owner_group" "$APP_WRITABLE_DIR_MODE"
  set_owner_group_mode "$app_dir/config.json" "$owner_user" "$owner_group" "$APP_CONFIG_MODE"
}

ensure_kit_exists() {
  local kit_path="$1"
  local description="$2"
  [ -d "$kit_path" ] || {
    echo "${description} not found: $kit_path"
    exit 1
  }
}

resolve_tenant_template_dir() {
  local selected_kit_name="${PROJECT_KIT_NAME:-$DEFAULT_PROJECT_KIT_NAME}"
  local template_dir="$PROJECT_KITS_BASE/$selected_kit_name"
  ensure_kit_exists "$template_dir" "Tenant template"
  printf '%s' "$template_dir"
}

resolve_app_template_dir() {
  local selected_kit_name="${APP_KIT_NAME:-$DEFAULT_APP_KIT_NAME}"
  local template_dir="$APP_KITS_BASE/$selected_kit_name"
  ensure_kit_exists "$template_dir" "App template"
  printf '%s' "$template_dir"
}

create_tenant_shell_identity() {
  local tenant_user="$1"
  local tenant_group="$2"

  if ! getent group "$tenant_group" >/dev/null 2>&1; then
    sudo groupadd --system "$tenant_group"
  fi

  if ! id "$tenant_user" >/dev/null 2>&1; then
    sudo useradd --system \
      --gid "$tenant_group" \
      --no-create-home \
      --shell /usr/sbin/nologin \
      "$tenant_user"
  fi
}

create_app_shell_identity() {
  local app_user="$1"
  local app_group="$2"

  if ! getent group "$app_group" >/dev/null 2>&1; then
    sudo groupadd --system "$app_group"
  fi

  if ! id "$app_user" >/dev/null 2>&1; then
    sudo useradd --system \
      --gid "$app_group" \
      --no-create-home \
      --shell /usr/sbin/nologin \
      "$app_user"
  fi
}

parse_deploy_scope() {
  DEPLOY_SCOPE="$(normalize_lower "$DEPLOY_SCOPE")"
  case "$DEPLOY_SCOPE" in
    -h|--help)
      usage
      exit 0
      ;;
    tenant|app) ;;
    *)
      usage
      exit 1
      ;;
  esac
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -p|--project-kit)
        PROJECT_KIT_NAME="${2:-}"
        [ -n "$PROJECT_KIT_NAME" ] || { echo "Missing value for $1"; exit 1; }
        shift 2
        ;;
      -a|--app-kit)
        APP_KIT_NAME="${2:-}"
        [ -n "$APP_KIT_NAME" ] || { echo "Missing value for $1"; exit 1; }
        shift 2
        ;;
      --repo)
        REPO_URL="${2:-}"
        [ -n "$REPO_URL" ] || { echo "Missing value for $1"; exit 1; }
        shift 2
        ;;
      -e|--enter)
        ENTER_AFTER_CREATE=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        if [ -z "$TARGET_ALIAS" ]; then
          TARGET_ALIAS="$1"
        else
          echo "Unknown argument: $1"
          exit 1
        fi
        shift
        ;;
    esac
  done
}

deploy_tenant() {
  [ -n "$TARGET_ALIAS" ] || { usage; exit 1; }
  [ -n "$PROJECT_KIT_NAME" ] || [ -n "$REPO_URL" ] || { echo "deploy tenant requires -p|--project-kit and/or --repo"; exit 1; }
  [ -z "$APP_KIT_NAME" ] || { echo "deploy tenant does not accept -a|--app-kit"; exit 1; }

  local normalized_target tenant_domain tenant_id tenant_dir tenant_user tenant_group project_kit_dir existing_tenant_json selected_project_kit_name
  normalized_target="$(normalize_lower "$TARGET_ALIAS")"
  if [[ ! "$normalized_target" =~ ^@([a-z0-9.-]+)$ ]]; then
    echo "deploy tenant requires target shape @<domain>"
    usage
    exit 1
  fi

  tenant_domain="${BASH_REMATCH[1]}"
  project_kit_dir="$(resolve_tenant_template_dir)"
  selected_project_kit_name="$(basename "$project_kit_dir")"

  existing_tenant_json="$(node "$TENANT_LAYOUT_CLI" find-tenant-json-by-domain "$VAR_BASE_DIR" "$tenant_domain" || true)"
  if [ -n "${existing_tenant_json:-}" ] && [ "$existing_tenant_json" != "null" ]; then
    echo "Tenant '$tenant_domain' already exists."
    exit 1
  fi

  tenant_id="$(node "$TENANT_LAYOUT_CLI" generate-unique-id tenant_ "$VAR_BASE_DIR")"
  tenant_dir="$VAR_BASE_DIR/tenant_${tenant_id}"
  tenant_user="tenant_${tenant_id}"
  tenant_group="$tenant_user"

  echo "Deploying tenant:"
  echo "  Target: $TARGET_ALIAS"
  echo "  Project kit: $selected_project_kit_name"
  [ -n "$REPO_URL" ] && echo "  Repo:   $REPO_URL"
  echo "  Domain: $tenant_domain"
  echo "  Tenant: tenant_${tenant_id}"
  echo "  User:   $tenant_user"

  create_tenant_shell_identity "$tenant_user" "$tenant_group"

  sudo mkdir -pv "$tenant_dir"
  sudo cp -R "$project_kit_dir/." "$tenant_dir/"
  [ -f "$tenant_dir/config.json" ] || echo '{}' | sudo tee "$tenant_dir/config.json" >/dev/null
  sudo node "$TENANT_LAYOUT_CLI" patch-tenant-config "$tenant_dir/config.json" "$tenant_id" "$tenant_domain" "$REPO_URL" >/dev/null

  set_owner_group_mode "$tenant_dir" "$DEFAULT_OWNER" "$DEFAULT_GROUP" "$DOMAIN_BASE_MODE"
  grant_tenant_runtime_traversal "$tenant_user" "$tenant_dir"

  echo "Tenant '$TARGET_ALIAS' deployed successfully."
}

deploy_app() {
  [ -n "$TARGET_ALIAS" ] || { usage; exit 1; }
  [ -n "$APP_KIT_NAME" ] || [ -n "$REPO_URL" ] || { echo "deploy app requires -a|--app-kit and/or --repo"; exit 1; }
  [ -z "$PROJECT_KIT_NAME" ] || { echo "deploy app does not accept -t|--project-kit"; exit 1; }

  local normalized_target target_app_name target_domain target_tenant_id target_mode tenant_json tenant_dir tenant_id app_json app_id app_dir app_user app_group tenant_user app_kit_dir tenant_host selected_app_kit_name
  normalized_target="$(normalize_lower "$TARGET_ALIAS")"

  if [[ "$normalized_target" =~ ^([a-z0-9._-]+)@([a-z0-9]{12})$ ]]; then
    target_mode="tenant_id"
    target_app_name="${BASH_REMATCH[1]}"
    target_tenant_id="${BASH_REMATCH[2]}"
  elif [[ "$normalized_target" =~ ^([a-z0-9._-]+)@([a-z0-9.-]+)$ ]]; then
    target_mode="domain"
    target_app_name="${BASH_REMATCH[1]}"
    target_domain="${BASH_REMATCH[2]}"
  else
    echo "deploy app requires target shape <app_name>@<domain> or <app_name>@<tenant_id>"
    usage
    exit 1
  fi

  app_kit_dir="$(resolve_app_template_dir)"
  selected_app_kit_name="$(basename "$app_kit_dir")"

  if [ "$target_mode" = "tenant_id" ]; then
    tenant_json="$(node "$TENANT_LAYOUT_CLI" find-tenant-json-by-id "$VAR_BASE_DIR" "$target_tenant_id" || true)"
    [ -n "${tenant_json:-}" ] && [ "$tenant_json" != "null" ] || {
      echo "Tenant '$target_tenant_id' not found."
      exit 1
    }
    tenant_id="$(json_field "$tenant_json" tenantId)"
    target_domain="$(json_field "$tenant_json" tenantDomain)"
    tenant_dir="$(json_field "$tenant_json" tenantRoot)"
    app_json="$(node "$TENANT_LAYOUT_CLI" find-app-json-by-tenant-id-and-app-name "$VAR_BASE_DIR" "$tenant_id" "$target_app_name" || true)"
  else
    tenant_json="$(node "$TENANT_LAYOUT_CLI" find-tenant-json-by-domain "$VAR_BASE_DIR" "$target_domain" || true)"
    [ -n "${tenant_json:-}" ] && [ "$tenant_json" != "null" ] || {
      echo "Tenant '$target_domain' not found. Deploy the tenant first."
      exit 1
    }
    tenant_id="$(json_field "$tenant_json" tenantId)"
    tenant_dir="$(json_field "$tenant_json" tenantRoot)"
    app_json="$(node "$TENANT_LAYOUT_CLI" find-app-json-by-domain-and-app-name "$VAR_BASE_DIR" "$target_domain" "$target_app_name" || true)"
  fi

  if [ -n "${app_json:-}" ] && [ "$app_json" != "null" ]; then
    echo "App '$target_app_name' already exists in target '$TARGET_ALIAS'."
    exit 1
  fi

  app_id="$(node "$TENANT_LAYOUT_CLI" generate-unique-id app_ "$tenant_dir")"
  app_dir="$tenant_dir/app_${app_id}"
  app_user="app_${tenant_id}_${app_id}"
  app_group="$app_user"
  tenant_user="tenant_${tenant_id}"
  tenant_host="${target_app_name}.${target_domain}"

  echo "Deploying app:"
  echo "  Target: $TARGET_ALIAS"
  echo "  App kit: $selected_app_kit_name"
  [ -n "$REPO_URL" ] && echo "  Repo:    $REPO_URL"
  echo "  Domain:  $target_domain"
  echo "  Tenant:  tenant_${tenant_id}"
  echo "  App:     $target_app_name"
  echo "  AppId:   app_${app_id}"
  echo "  Route:   $tenant_host"
  echo "  User:    $app_user"

  create_app_shell_identity "$app_user" "$app_group"

  sudo mkdir -pv "$app_dir"
  sudo cp -R "$app_kit_dir/." "$app_dir/"
  [ -f "$app_dir/config.json" ] || echo '{}' | sudo tee "$app_dir/config.json" >/dev/null
  sudo node "$TENANT_LAYOUT_CLI" patch-app-config "$app_dir/config.json" "$app_id" "$target_app_name" "$REPO_URL" >/dev/null

  apply_app_permissions "$app_dir" "$tenant_dir" "$app_user" "$app_group"
  grant_tenant_runtime_traversal "$tenant_user" "$tenant_dir"
  apply_role_acl "$app_dir" "$DIRECTOR_USER" "tenantAccess.director"
  apply_role_acl "$app_dir" "$TRANSPORT_USER" "tenantAccess.transport"

  echo "App '$TARGET_ALIAS' deployed successfully."
}

parse_deploy_scope
parse_args "$@"

case "$DEPLOY_SCOPE" in
  tenant) deploy_tenant ;;
  app) deploy_app ;;
esac

if [ "$ENTER_AFTER_CREATE" -eq 1 ]; then
  echo "--enter is declared by contract but not implemented yet."
fi
