#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../lib/cli-common.sh"
cli_init "$0"

DEPLOY_SCOPE="${1:-}"
[ "$#" -gt 0 ] && shift || true

PROJECT_KIT_NAME=""
APP_KIT_NAME=""
TARGET_ALIAS=""

VAR_BASE_DIR="$TENANTS_BASE"
TENANT_LAYOUT_CLI="$SCRIPT_DIR/../../lib/tenant-layout-cli.js"
CONTRACT_IDENTITY_CLI="$SCRIPT_DIR/../../lib/contract-identity-cli.js"
CLI_SPEC_CLI="$SCRIPT_DIR/../../lib/cli-spec-cli.js"
PROJECT_KITS_BASE="$SCRIPT_DIR/../../../builtin-extensions/project-kits"
LEGACY_TENANT_KITS_BASE="$SCRIPT_DIR/../../../builtin-extensions/tenant-kits"
APP_KITS_BASE="$SCRIPT_DIR/../../../builtin-extensions/app-kits"
KIT_GITHUB_ORG_URL="https://github.com/ehecoatl"
DEFAULT_PROJECT_KIT_NAME="empty"
DEFAULT_APP_KIT_NAME="empty"
usage() {
  cat <<'EOF_USAGE'
Internal shared deploy helper:
  deploy.sh project @<domain> -p <project_kit>
  deploy.sh app <app_name>@<domain> -a <app_kit>
  deploy.sh app <app_name>@<project_id> -a <app_kit>

Kit sources may be directories or .zip archives. Zip kits must contain the kit
files directly at the archive root.

Kit resolution checks built-in kits first, custom extension kit paths second,
and then public GitHub fallback repos under https://github.com/ehecoatl.

Project kits may include top-level app_<name>/ folders. These folders are
auto-deployed as apps during project deploy, without using an app kit.

Legacy -t|--tenant-kit options, tenant-kits roots, and tenant-kit-* remote
repositories are still accepted as compatibility fallbacks.
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

make_tree_public_readable() {
  local root_path="$1"
  local dir_mode="${2:-2755}"
  local file_mode="${3:-0644}"

  [ -d "$root_path" ] || return 0
  sudo find "$root_path" -type d -exec chmod "$dir_mode" {} +
  sudo find "$root_path" -type f -exec chmod "$file_mode" {} +
}

apply_contract_tree_mode() {
  local root_path="$1"
  local contract_json="$2"
  local mode_value file_mode recursive_flag owner_name group_name path_type

  [ -e "$root_path" ] || return 0
  mode_value="$(json_field "$contract_json" mode 2>/dev/null || true)"
  recursive_flag="$(json_field "$contract_json" recursive 2>/dev/null || true)"
  owner_name="$(json_field "$contract_json" owner 2>/dev/null || true)"
  group_name="$(json_field "$contract_json" group 2>/dev/null || true)"
  path_type="$(json_field "$contract_json" type 2>/dev/null || true)"
  [ -n "$mode_value" ] || return 0

  if [ "$path_type" = "file" ] || [ -f "$root_path" ]; then
    file_mode="$(dir_mode_to_file_mode "$mode_value")"
    if [ -n "$owner_name" ] && [ -n "$group_name" ]; then
      sudo chown "$owner_name:$group_name" "$root_path"
    fi
    sudo chmod "$file_mode" "$root_path"
    return 0
  fi

  file_mode="$(dir_mode_to_file_mode "$mode_value")"

  if [ "$recursive_flag" = "true" ]; then
    if [ -n "$owner_name" ] && [ -n "$group_name" ]; then
      sudo chown -R "$owner_name:$group_name" "$root_path"
    fi
    make_tree_public_readable "$root_path" "$mode_value" "$file_mode"
    return 0
  fi

  if [ -z "$owner_name" ]; then
    owner_name="$(sudo stat -c '%U' "$root_path")"
  fi
  if [ -z "$group_name" ]; then
    group_name="$(sudo stat -c '%G' "$root_path")"
  fi
  set_owner_group_mode "$root_path" "$owner_name" "$group_name" "$mode_value"
}

contract_path_entry_keys() {
  local layer_key="$1"

  case "$layer_key" in
    projectScope|tenantScope)
      cat <<'EOF_KEYS'
LOGS root
LOGS error
LOGS boot
RUNTIME root
RUNTIME lib
RUNTIME cache
RUNTIME ssl
RUNTIME backups
OVERRIDES config
OVERRIDES routes
OVERRIDES plugins
SHARED root
SHARED app
SHARED utils
SHARED scripts
SHARED httpActions
SHARED wsActions
SHARED assets
SHARED assetStatic
SHARED httpMiddlewares
SHARED wsMiddlewares
EOF_KEYS
      ;;
    appScope)
      cat <<'EOF_KEYS'
LOGS error
LOGS debug
LOGS boot
LOGS report
RUNTIME root
RUNTIME storage
RUNTIME logs
RUNTIME backups
RUNTIME uploads
RUNTIME cache
RUNTIME internal
RUNTIME internalArtifacts
RUNTIME internalTmp
OVERRIDES config
OVERRIDES routes
OVERRIDES plugins
RESOURCES app
RESOURCES utils
RESOURCES scripts
RESOURCES httpMiddlewares
RESOURCES wsMiddlewares
RESOURCES assets
RESOURCES assetStatic
EOF_KEYS
      ;;
  esac
}

materialize_contract_path_entry() {
  local contract_json="$1"
  local target_path path_type

  target_path="$(json_field "$contract_json" path 2>/dev/null || true)"
  [ -n "$target_path" ] || return 0

  path_type="$(json_field "$contract_json" type 2>/dev/null || true)"
  if [ "$path_type" = "file" ]; then
    sudo mkdir -p "$(dirname "$target_path")"
    return 0
  fi

  sudo mkdir -p "$target_path"
}

materialize_scope_contract_paths() {
  local layer_key="$1"
  local tenant_id="$2"
  local app_id="${3:-}"
  local tenant_domain="${4:-}"
  local app_name="${5:-}"
  local category_key item_key contract_json

  while read -r category_key item_key; do
    [ -n "${category_key:-}" ] || continue
    [ -n "${item_key:-}" ] || continue
    contract_json="$(resolve_contract_path_entry "$layer_key" "$category_key" "$item_key" "$tenant_id" "$app_id" "$tenant_domain" "$app_name" || true)"
    materialize_contract_path_entry "$contract_json"
  done < <(contract_path_entry_keys "$layer_key")
}

apply_app_permissions() {
  local app_dir="$1"
  local owner_user="$2"
  local owner_group="$3"
  local tenant_id="$4"
  local app_id="$5"
  local tenant_domain="$6"
  local app_name="$7"
  local app_root_json app_root_mode app_root_file_mode
  local asset_static_json asset_static_dir
  local uploads_json uploads_dir log_debug_json log_debug_dir report_json report_path
  local config_json routes_json config_dir routes_dir

  app_root_json="$(resolve_contract_path_entry appScope RUNTIME root "$tenant_id" "$app_id" "$tenant_domain" "$app_name" || true)"
  app_root_mode="$(json_field "$app_root_json" mode 2>/dev/null || true)"
  [ -n "$app_root_mode" ] || app_root_mode="2775"
  app_root_file_mode="$(dir_mode_to_file_mode "$app_root_mode")"
  asset_static_json="$(resolve_contract_path_entry appScope RESOURCES assetStatic "$tenant_id" "$app_id" "$tenant_domain" "$app_name" || true)"
  asset_static_dir="$(json_field "$asset_static_json" path 2>/dev/null || true)"
  uploads_json="$(resolve_contract_path_entry appScope RUNTIME uploads "$tenant_id" "$app_id" "$tenant_domain" "$app_name" || true)"
  uploads_dir="$(json_field "$uploads_json" path 2>/dev/null || true)"
  log_debug_json="$(resolve_contract_path_entry appScope LOGS debug "$tenant_id" "$app_id" "$tenant_domain" "$app_name" || true)"
  log_debug_dir="$(json_field "$log_debug_json" path 2>/dev/null || true)"
  report_json="$(resolve_contract_path_entry appScope LOGS report "$tenant_id" "$app_id" "$tenant_domain" "$app_name" || true)"
  report_path="$(json_field "$report_json" path 2>/dev/null || true)"
  config_json="$(resolve_contract_path_entry appScope OVERRIDES config "$tenant_id" "$app_id" "$tenant_domain" "$app_name" || true)"
  routes_json="$(resolve_contract_path_entry appScope OVERRIDES routes "$tenant_id" "$app_id" "$tenant_domain" "$app_name" || true)"
  config_dir="$(json_field "$config_json" path 2>/dev/null || true)"
  routes_dir="$(json_field "$routes_json" path 2>/dev/null || true)"

  apply_tree_mode "$app_dir" "$owner_user" "$owner_group" "$app_root_mode" "$app_root_file_mode"
  apply_contract_tree_mode "$uploads_dir" "$uploads_json"
  apply_contract_tree_mode "$log_debug_dir" "$log_debug_json"
  apply_contract_tree_mode "$report_path" "$report_json"
  apply_contract_tree_mode "$asset_static_dir" "$asset_static_json"
  apply_contract_tree_mode "$config_dir" "$config_json"
  apply_contract_tree_mode "$routes_dir" "$routes_json"
  return 0
}

apply_tenant_permissions() {
  local tenant_dir="$1"
  local owner_user="$2"
  local owner_group="$3"
  local tenant_id="$4"
  local tenant_domain="$5"
  local tenant_runtime_root_json tenant_runtime_root_path
  local tenant_runtime_lib_json tenant_runtime_lib_path
  local tenant_runtime_ssl_json tenant_runtime_ssl_path
  local tenant_runtime_backups_json tenant_runtime_backups_path
  local tenant_config_json tenant_config_path
  local asset_static_json shared_assets_static_dir
  local config_json routes_json config_dir routes_dir shared_dir
  local tenant_subpath

  tenant_runtime_root_json="$(resolve_contract_path_entry projectScope RUNTIME root "$tenant_id" "" "$tenant_domain" || true)"
  tenant_runtime_root_path="$(json_field "$tenant_runtime_root_json" path 2>/dev/null || true)"
  tenant_runtime_lib_json="$(resolve_contract_path_entry projectScope RUNTIME lib "$tenant_id" "" "$tenant_domain" || true)"
  tenant_runtime_lib_path="$(json_field "$tenant_runtime_lib_json" path 2>/dev/null || true)"
  tenant_runtime_ssl_json="$(resolve_contract_path_entry projectScope RUNTIME ssl "$tenant_id" "" "$tenant_domain" || true)"
  tenant_runtime_ssl_path="$(json_field "$tenant_runtime_ssl_json" path 2>/dev/null || true)"
  tenant_runtime_backups_json="$(resolve_contract_path_entry projectScope RUNTIME backups "$tenant_id" "" "$tenant_domain" || true)"
  tenant_runtime_backups_path="$(json_field "$tenant_runtime_backups_json" path 2>/dev/null || true)"
  tenant_config_json="$(resolve_contract_path_entry projectScope RUNTIME config "$tenant_id" "" "$tenant_domain" || true)"
  tenant_config_path="$(json_field "$tenant_config_json" path 2>/dev/null || true)"
  asset_static_json="$(resolve_contract_path_entry projectScope SHARED assetStatic "$tenant_id" "" "$tenant_domain" || true)"
  shared_assets_static_dir="$(json_field "$asset_static_json" path 2>/dev/null || true)"
  config_json="$(resolve_contract_path_entry projectScope OVERRIDES config "$tenant_id" "" "$tenant_domain" || true)"
  routes_json="$(resolve_contract_path_entry projectScope OVERRIDES routes "$tenant_id" "" "$tenant_domain" || true)"
  config_dir="$(json_field "$config_json" path 2>/dev/null || true)"
  routes_dir="$(json_field "$routes_json" path 2>/dev/null || true)"
  shared_dir="$(resolve_json_field "$(resolve_contract_path_entry projectScope SHARED root "$tenant_id" "" "$tenant_domain")" path)"

  [ -d "$tenant_dir" ] || return 0
  sudo chown "$owner_user:$owner_group" "$tenant_dir"
  set_owner_group_mode "$tenant_dir" "$owner_user" "$owner_group" "2755"
  while IFS= read -r tenant_subpath; do
    [ -n "$tenant_subpath" ] || continue
    [ "$tenant_subpath" = "$shared_dir" ] && continue
    sudo chown -R "$owner_user:$owner_group" "$tenant_subpath"
    sudo find "$tenant_subpath" -type d -exec chmod 2770 {} +
    sudo find "$tenant_subpath" -type f -exec chmod 0660 {} +
  done < <(sudo find "$tenant_dir" -mindepth 1 -maxdepth 1 \
    ! -name 'app_*' \
    ! -name 'shared' \
    -print)
  if [ -d "$shared_dir" ]; then
    apply_tree_mode "$shared_dir" "$owner_user" "$owner_group" "2750" "0640"
    set_owner_group_mode "$shared_dir" "$owner_user" "$owner_group" "2751"
    [ -d "$shared_dir/assets" ] && set_owner_group_mode "$shared_dir/assets" "$owner_user" "$owner_group" "2751"
  fi
  apply_contract_tree_mode "$tenant_runtime_root_path" "$tenant_runtime_root_json"
  apply_contract_tree_mode "$tenant_runtime_lib_path" "$tenant_runtime_lib_json"
  apply_contract_tree_mode "$tenant_runtime_ssl_path" "$tenant_runtime_ssl_json"
  apply_contract_tree_mode "$tenant_runtime_backups_path" "$tenant_runtime_backups_json"
  apply_contract_tree_mode "$tenant_config_path" "$tenant_config_json"
  apply_contract_tree_mode "$shared_assets_static_dir" "$asset_static_json"
  apply_contract_tree_mode "$config_dir" "$config_json"
  apply_contract_tree_mode "$routes_dir" "$routes_json"
  return 0
}

resolve_json_field() {
  local json_payload="$1"
  local field_path="$2"
  json_field "$json_payload" "$field_path"
}

resolve_contract_path_entry() {
  local layer_key="$1"
  local category_key="$2"
  local item_key="$3"
  local tenant_id="${4:-}"
  local app_id="${5:-}"
  local tenant_domain="${6:-}"
  local app_name="${7:-}"

  node "$CONTRACT_IDENTITY_CLI" path-entry "$layer_key" "$category_key" "$item_key" "$tenant_id" "$app_id" "$tenant_domain" "$app_name"
}

dir_mode_to_file_mode() {
  local dir_mode="${1:-2775}"
  local mode_digits="${dir_mode: -3}"
  local owner=$(( (8#${mode_digits:0:1}) & 6 ))
  local group=$(( (8#${mode_digits:1:1}) & 6 ))
  local other=$(( (8#${mode_digits:2:1}) & 6 ))
  printf '0%01o%01o%01o' "$owner" "$group" "$other"
}

ensure_kit_exists() {
  local kit_path="$1"
  local description="$2"
  [ -d "$kit_path" ] || [ -f "$kit_path" ] || {
    echo "${description} not found: $kit_path"
    exit 1
  }
}

normalize_kit_name_for_remote() {
  local requested_kit_name="$1"
  local normalized_kit_name

  normalized_kit_name="$(normalize_lower "$requested_kit_name")"
  case "$normalized_kit_name" in
    *.zip) normalized_kit_name="${normalized_kit_name%.zip}" ;;
  esac

  if [[ ! "$normalized_kit_name" =~ ^[a-z0-9._-]+$ ]] || [[ "$normalized_kit_name" = *..* ]]; then
    echo "Invalid kit name '$requested_kit_name'. Kit names used for remote fallback must match [a-z0-9._-]+ and cannot contain '..'." >&2
    exit 1
  fi

  printf '%s' "$normalized_kit_name"
}

resolve_local_kit_source() {
  local kits_base="$1"
  local requested_kit_name="$2"
  local direct_template_dir direct_template_zip

  direct_template_dir="$kits_base/$requested_kit_name"
  if [ -d "$direct_template_dir" ]; then
    printf 'dir\t%s' "$direct_template_dir"
    return 0
  fi

  direct_template_zip="$direct_template_dir"
  case "$direct_template_zip" in
    *.zip) ;;
    *) direct_template_zip="${direct_template_zip}.zip" ;;
  esac
  if [ -f "$direct_template_zip" ]; then
    printf 'zip\t%s' "$direct_template_zip"
    return 0
  fi

  return 1
}

resolve_supervision_extension_path() {
  local item_key="$1"
  resolve_json_field "$(resolve_contract_path_entry supervisionScope EXTENSIONS "$item_key")" path
}

materialize_remote_kit_source() {
  local custom_kits_base="$1"
  local remote_repo_prefix="$2"
  local requested_kit_name="$3"
  local description="$4"

  if materialize_remote_kit_source_optional "$custom_kits_base" "$remote_repo_prefix" "$requested_kit_name" "$description"; then
    return 0
  fi

  local normalized_kit_name
  normalized_kit_name="$(normalize_kit_name_for_remote "$requested_kit_name")"
  echo "$description '$requested_kit_name' was not found in built-in kits, custom kits, or remote fallback $KIT_GITHUB_ORG_URL/${remote_repo_prefix}-${normalized_kit_name}.git." >&2
  exit 1
}

materialize_remote_kit_source_optional() {
  local custom_kits_base="$1"
  local remote_repo_prefix="$2"
  local requested_kit_name="$3"
  local description="$4"
  local normalized_kit_name remote_url target_dir

  normalized_kit_name="$(normalize_kit_name_for_remote "$requested_kit_name")"
  remote_url="${KIT_GITHUB_ORG_URL}/${remote_repo_prefix}-${normalized_kit_name}.git"
  target_dir="$custom_kits_base/$normalized_kit_name"

  command -v git >/dev/null 2>&1 || return 1

  if ! GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "$remote_url" >/dev/null 2>&1; then
    return 1
  fi

  sudo mkdir -p "$custom_kits_base"
  if [ -e "$target_dir" ]; then
    return 0
  fi

  echo "$description '$requested_kit_name' not found locally. Cloning $remote_url into $target_dir." >&2
  if ! sudo env GIT_TERMINAL_PROMPT=0 git clone --depth 1 "$remote_url" "$target_dir"; then
    echo "Failed to clone $description fallback repository $remote_url into $target_dir." >&2
    return 1
  fi
  return 0
}

resolve_kit_source() {
  local builtin_kits_base="$1"
  local custom_kits_base="$2"
  local requested_kit_name="$3"
  local remote_repo_prefix="$4"
  local description="$5"
  local normalized_kit_name

  normalized_kit_name="$(normalize_kit_name_for_remote "$requested_kit_name")"

  if resolve_local_kit_source "$builtin_kits_base" "$requested_kit_name"; then
    return 0
  fi

  if resolve_local_kit_source "$custom_kits_base" "$requested_kit_name"; then
    return 0
  fi

  materialize_remote_kit_source "$custom_kits_base" "$remote_repo_prefix" "$requested_kit_name" "$description"

  if resolve_local_kit_source "$custom_kits_base" "$normalized_kit_name"; then
    return 0
  fi

  echo "$description '$requested_kit_name' could not be resolved after remote fallback." >&2
  echo "Checked:" >&2
  echo "  Built-in: $builtin_kits_base/$requested_kit_name" >&2
  echo "  Custom:   $custom_kits_base/$requested_kit_name" >&2
  echo "  Remote:   $KIT_GITHUB_ORG_URL/${remote_repo_prefix}-${normalized_kit_name}.git" >&2
  exit 1
}

resolve_project_kit_source() {
  local requested_kit_name="$1"
  local primary_custom_kits_base="$2"
  local legacy_custom_kits_base="$3"
  local normalized_kit_name

  normalized_kit_name="$(normalize_kit_name_for_remote "$requested_kit_name")"

  if resolve_local_kit_source "$PROJECT_KITS_BASE" "$requested_kit_name"; then
    return 0
  fi

  if resolve_local_kit_source "$primary_custom_kits_base" "$requested_kit_name"; then
    return 0
  fi

  if resolve_local_kit_source "$LEGACY_TENANT_KITS_BASE" "$requested_kit_name"; then
    return 0
  fi

  if resolve_local_kit_source "$legacy_custom_kits_base" "$requested_kit_name"; then
    return 0
  fi

  if materialize_remote_kit_source_optional "$primary_custom_kits_base" "project-kit" "$requested_kit_name" "Project kit"; then
    if resolve_local_kit_source "$primary_custom_kits_base" "$normalized_kit_name"; then
      return 0
    fi
  fi

  if materialize_remote_kit_source_optional "$legacy_custom_kits_base" "tenant-kit" "$requested_kit_name" "Legacy tenant kit"; then
    if resolve_local_kit_source "$legacy_custom_kits_base" "$normalized_kit_name"; then
      return 0
    fi
  fi

  echo "Project kit '$requested_kit_name' could not be resolved after project-kit and legacy tenant-kit fallback checks." >&2
  echo "Checked:" >&2
  echo "  Built-in project kits: $PROJECT_KITS_BASE/$requested_kit_name" >&2
  echo "  Custom project kits:   $primary_custom_kits_base/$requested_kit_name" >&2
  echo "  Built-in tenant kits:  $LEGACY_TENANT_KITS_BASE/$requested_kit_name" >&2
  echo "  Custom tenant kits:    $legacy_custom_kits_base/$requested_kit_name" >&2
  echo "  Remote project kit:    $KIT_GITHUB_ORG_URL/project-kit-${normalized_kit_name}.git" >&2
  echo "  Remote tenant kit:     $KIT_GITHUB_ORG_URL/tenant-kit-${normalized_kit_name}.git" >&2
  exit 1
}

validate_zip_kit_entries() {
  local zip_path="$1"
  local entry zip_entries archive_base first_segment wrapper_candidate=1 found_entry=0

  command -v unzip >/dev/null 2>&1 || {
    echo "unzip is required to deploy zip kits."
    exit 1
  }

  if ! zip_entries="$(unzip -Z1 "$zip_path")"; then
    echo "Could not inspect zip kit: $zip_path"
    exit 1
  fi

  archive_base="$(basename "$zip_path" .zip)"

  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    found_entry=1
    case "$entry" in
      /*|*"/../"*|../*|*"/.."|..)
        echo "Unsafe zip kit entry '$entry' in $zip_path"
        exit 1
        ;;
    esac

    first_segment="${entry%%/*}"
    if [ "$first_segment" != "$archive_base" ] || [ "$entry" = "$first_segment" ]; then
      wrapper_candidate=0
    fi
  done <<EOF_ZIP_ENTRIES
$zip_entries
EOF_ZIP_ENTRIES

  if [ "$found_entry" -eq 0 ]; then
    echo "Zip kit is empty: $zip_path"
    exit 1
  fi

  if [ "$wrapper_candidate" -eq 1 ]; then
    echo "Zip kit $zip_path appears to contain a wrapper folder '$archive_base/'. Put kit files directly at the zip root."
    exit 1
  fi
}

materialize_kit_source() {
  local source_type="$1"
  local source_path="$2"
  local target_dir="$3"

  case "$source_type" in
    dir)
      sudo cp -R "$source_path/." "$target_dir/"
      ;;
    zip)
      validate_zip_kit_entries "$source_path"
      sudo unzip -q "$source_path" -d "$target_dir"
      ;;
    *)
      echo "Unsupported kit source type: $source_type"
      exit 1
      ;;
  esac
}

discover_embedded_app_dirs() {
  local tenant_dir="$1"
  [ -d "$tenant_dir" ] || return 0
  sudo find "$tenant_dir" -mindepth 1 -maxdepth 1 -type d -name 'app_*' -print | sort
}

validate_embedded_app_dirs() {
  local tenant_dir="$1"
  local embedded_dir embedded_name app_name seen_names=""

  while IFS= read -r embedded_dir; do
    [ -n "$embedded_dir" ] || continue
    embedded_name="$(basename "$embedded_dir")"
    app_name="${embedded_name#app_}"
    if [[ ! "$app_name" =~ ^[a-z0-9._-]+$ ]]; then
      echo "Invalid embedded app folder '$embedded_name'. Expected app_<name> where <name> matches [a-z0-9._-]+."
      exit 1
    fi
    case "
$seen_names
" in
      *"
$app_name
"*)
        echo "Duplicate embedded app name '$app_name' in project kit."
        exit 1
        ;;
    esac
    seen_names="${seen_names}
$app_name"
  done < <(discover_embedded_app_dirs "$tenant_dir")
}

resolve_tenant_template_source() {
  local selected_kit_name="${PROJECT_KIT_NAME:-$DEFAULT_PROJECT_KIT_NAME}"
  resolve_project_kit_source "$selected_kit_name" "$(resolve_supervision_extension_path customProjectKits)" "$(resolve_supervision_extension_path customTenantKits)"
}

resolve_app_template_source() {
  local selected_kit_name="${APP_KIT_NAME:-$DEFAULT_APP_KIT_NAME}"
  resolve_kit_source "$APP_KITS_BASE" "$(resolve_supervision_extension_path customAppKits)" "$selected_kit_name" "app-kit" "App template"
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

  getent group "$tenant_group" >/dev/null 2>&1 || {
    echo "Failed to materialize tenant group '$tenant_group'."
    exit 1
  }
  id "$tenant_user" >/dev/null 2>&1 || {
    echo "Failed to materialize tenant user '$tenant_user'."
    exit 1
  }
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

  getent group "$app_group" >/dev/null 2>&1 || {
    echo "Failed to materialize app group '$app_group'."
    exit 1
  }
  id "$app_user" >/dev/null 2>&1 || {
    echo "Failed to materialize app user '$app_user'."
    exit 1
  }
}

parse_deploy_scope() {
  DEPLOY_SCOPE="$(normalize_lower "$DEPLOY_SCOPE")"
  case "$DEPLOY_SCOPE" in
    -h|--help)
      usage
      exit 0
      ;;
    project|tenant|app) ;;
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
        [ -z "$PROJECT_KIT_NAME" ] || { echo "Project kit was already provided."; exit 1; }
        PROJECT_KIT_NAME="${2:-}"
        [ -n "$PROJECT_KIT_NAME" ] || { echo "Missing value for $1"; exit 1; }
        shift 2
        ;;
      -t|--tenant-kit)
        [ -z "$PROJECT_KIT_NAME" ] || { echo "Project kit was already provided."; exit 1; }
        PROJECT_KIT_NAME="${2:-}"
        [ -n "$PROJECT_KIT_NAME" ] || { echo "Missing value for $1"; exit 1; }
        shift 2
        ;;
      -a|--app-kit)
        APP_KIT_NAME="${2:-}"
        [ -n "$APP_KIT_NAME" ] || { echo "Missing value for $1"; exit 1; }
        shift 2
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

run_after_cli_commands() {
  local scope_name="$1"
  local command_name="$2"
  local tenant_id="${3:-}"
  local app_id="${4:-}"
  local tenant_domain="${5:-}"
  local app_name="${6:-}"

  local vars_json
  vars_json="$(node -e '
    const payload = {
      tenant_id: process.argv[1] || null,
      app_id: process.argv[2] || null,
      tenant_domain: process.argv[3] || null,
      app_name: process.argv[4] || null
    };
    process.stdout.write(JSON.stringify(payload));
  ' "$tenant_id" "$app_id" "$tenant_domain" "$app_name")"

  local command_json
  command_json="$(node "$CLI_SPEC_CLI" after-cli "$scope_name" "$command_name" "$vars_json")"

  local command_count
  command_count="$(node -e 'const data = JSON.parse(process.argv[1] || `[]`); process.stdout.write(String(data.length));' "$command_json")"
  [ "$command_count" -gt 0 ] || return 0

  node -e 'const data = JSON.parse(process.argv[1] || `[]`); for (const cmd of data) console.log(cmd);' "$command_json" \
    | while IFS= read -r command; do
      [ -n "$command" ] || continue
      if [ "$(id -u)" -eq 0 ]; then
        bash -lc "$command"
      else
        sudo bash -lc "$command"
      fi
    done
}

deploy_app_from_source() {
  local tenant_id="$1"
  local tenant_dir="$2"
  local target_domain="$3"
  local target_app_name="$4"
  local source_type="$5"
  local source_path="$6"
  local source_label="$7"
  local target_label="$8"
  local run_after_cli="${9:-true}"
  local apply_tenant_permissions_after="${10:-true}"

  local tenant_fs_json tenant_owner tenant_owner_group app_json app_id app_dir app_user app_group app_owner app_owner_group app_shell_json app_fs_json tenant_host

  app_json="$(node "$TENANT_LAYOUT_CLI" find-app-json-by-domain-and-app-name "$VAR_BASE_DIR" "$target_domain" "$target_app_name" || true)"
  if [ -n "${app_json:-}" ] && [ "$app_json" != "null" ]; then
    echo "App '$target_app_name' already exists in project '$target_domain'."
    exit 1
  fi

  app_id="$(node "$TENANT_LAYOUT_CLI" generate-unique-id app_ "$tenant_dir")"
  app_dir="$tenant_dir/app_${target_app_name}"
  tenant_fs_json="$(node "$CONTRACT_IDENTITY_CLI" tenant-filesystem "$tenant_id" "$target_domain")"
  tenant_owner="$(resolve_json_field "$tenant_fs_json" owner)"
  tenant_owner_group="$(resolve_json_field "$tenant_fs_json" group)"
  app_shell_json="$(node "$CONTRACT_IDENTITY_CLI" shell-identity appScope "$tenant_id" "$app_id")"
  app_fs_json="$(node "$CONTRACT_IDENTITY_CLI" app-filesystem "$tenant_id" "$app_id" "$target_domain" "$target_app_name")"
  app_user="$(resolve_json_field "$app_shell_json" user)"
  app_group="$(resolve_json_field "$app_shell_json" group)"
  app_owner="$(resolve_json_field "$app_fs_json" owner)"
  app_owner_group="$(resolve_json_field "$app_fs_json" group)"
  tenant_host="${target_app_name}.${target_domain}"

  echo "Deploying app:"
  echo "  Target: $target_label"
  echo "  Source: $source_label"
  echo "  Domain:  $target_domain"
  echo "  Project: project_${target_domain}"
  echo "  App:     $target_app_name"
  echo "  Folder:  app_${target_app_name}"
  echo "  AppId:   app_${app_id}"
  echo "  Route:   $tenant_host"
  echo "  User:    $app_user"
  echo "  Group:   $app_group"

  create_app_shell_identity "$app_user" "$app_group"

  sudo mkdir -pv "$app_dir"
  materialize_kit_source "$source_type" "$source_path" "$app_dir"
  sudo mkdir -p "$app_dir/config"
  if [ ! -f "$app_dir/config/app.json" ]; then
    echo '{}' | sudo tee "$app_dir/config/app.json" >/dev/null
  fi
  sudo node "$TENANT_LAYOUT_CLI" patch-app-config "$app_dir/config/app.json" "$app_id" "$target_app_name" >/dev/null

  materialize_scope_contract_paths appScope "$tenant_id" "$app_id" "$target_domain" "$target_app_name"
  apply_app_permissions "$app_dir" "$app_owner" "$app_owner_group" "$tenant_id" "$app_id" "$target_domain" "$target_app_name"

  if [ "$apply_tenant_permissions_after" = "true" ]; then
    materialize_scope_contract_paths projectScope "$tenant_id" "" "$target_domain"
    apply_tenant_permissions "$tenant_dir" "$tenant_owner" "$tenant_owner_group" "$tenant_id" "$target_domain"
  fi

  if [ "$run_after_cli" = "true" ]; then
    run_after_cli_commands "project" "deploy app" "$tenant_id" "$app_id" "$target_domain" "$target_app_name"
  fi
}

deploy_embedded_apps() {
  local tenant_id="$1"
  local tenant_dir="$2"
  local tenant_domain="$3"
  local embedded_dir embedded_name app_name staged_embedded_dir

  validate_embedded_app_dirs "$tenant_dir"

  while IFS= read -r embedded_dir; do
    [ -n "$embedded_dir" ] || continue
    embedded_name="$(basename "$embedded_dir")"
    app_name="${embedded_name#app_}"
    staged_embedded_dir="${embedded_dir}.embedded-staging"
    sudo rm -rf "$staged_embedded_dir"
    sudo mv "$embedded_dir" "$staged_embedded_dir"
    echo "Found embedded app '$app_name' in project kit."
    deploy_app_from_source \
      "$tenant_id" \
      "$tenant_dir" \
      "$tenant_domain" \
      "$app_name" \
      "dir" \
      "$staged_embedded_dir" \
      "embedded project app: $embedded_name" \
      "${app_name}@${tenant_domain}" \
      "false" \
      "false"
    sudo rm -rf "$staged_embedded_dir"
    echo "Embedded app '$app_name' deployed and staging folder '$embedded_name' removed."
  done < <(discover_embedded_app_dirs "$tenant_dir")
}

deploy_tenant() {
  [ -n "$TARGET_ALIAS" ] || { usage; exit 1; }
  [ -n "$PROJECT_KIT_NAME" ] || { echo "deploy project requires -p|--project-kit (legacy -t|--tenant-kit is accepted)"; exit 1; }
  [ -z "$APP_KIT_NAME" ] || { echo "deploy project does not accept -a|--app-kit"; exit 1; }

  local normalized_target tenant_domain tenant_id tenant_dir tenant_user tenant_group tenant_owner tenant_owner_group tenant_shell_json tenant_fs_json project_kit_source project_kit_type project_kit_path existing_tenant_json selected_project_kit_name
  normalized_target="$(normalize_lower "$TARGET_ALIAS")"
  if [[ ! "$normalized_target" =~ ^@([a-z0-9.-]+)$ ]]; then
    echo "deploy project requires target shape @<domain>"
    usage
    exit 1
  fi

  tenant_domain="${BASH_REMATCH[1]}"
  project_kit_source="$(resolve_tenant_template_source)"
  project_kit_type="${project_kit_source%%$'\t'*}"
  project_kit_path="${project_kit_source#*$'\t'}"
  selected_project_kit_name="$(basename "$project_kit_path")"

  existing_tenant_json="$(node "$TENANT_LAYOUT_CLI" find-tenant-json-by-domain "$VAR_BASE_DIR" "$tenant_domain" || true)"
  if [ -n "${existing_tenant_json:-}" ] && [ "$existing_tenant_json" != "null" ]; then
    echo "Project '$tenant_domain' already exists."
    exit 1
  fi

  tenant_id="$(node "$TENANT_LAYOUT_CLI" generate-unique-id project_ "$VAR_BASE_DIR")"
  tenant_dir="$VAR_BASE_DIR/project_${tenant_domain}"
  tenant_shell_json="$(node "$CONTRACT_IDENTITY_CLI" shell-identity projectScope "$tenant_id")"
  tenant_fs_json="$(node "$CONTRACT_IDENTITY_CLI" tenant-filesystem "$tenant_id" "$tenant_domain")"
  tenant_user="$(resolve_json_field "$tenant_shell_json" user)"
  tenant_group="$(resolve_json_field "$tenant_shell_json" group)"
  tenant_owner="$(resolve_json_field "$tenant_fs_json" owner)"
  tenant_owner_group="$(resolve_json_field "$tenant_fs_json" group)"

  echo "Deploying project:"
  echo "  Target: $TARGET_ALIAS"
  echo "  Project kit: $selected_project_kit_name"
  echo "  Domain: $tenant_domain"
  echo "  Folder: project_${tenant_domain}"
  echo "  ProjectId: project_${tenant_id}"
  echo "  User:   $tenant_user"
  echo "  Group:  $tenant_group"

  create_tenant_shell_identity "$tenant_user" "$tenant_group"

  sudo mkdir -pv "$tenant_dir"
  materialize_kit_source "$project_kit_type" "$project_kit_path" "$tenant_dir"
  [ -f "$tenant_dir/config.json" ] || echo '{}' | sudo tee "$tenant_dir/config.json" >/dev/null
  sudo node "$TENANT_LAYOUT_CLI" patch-tenant-config "$tenant_dir/config.json" "$tenant_id" "$tenant_domain" >/dev/null

  materialize_scope_contract_paths projectScope "$tenant_id" "" "$tenant_domain"
  deploy_embedded_apps "$tenant_id" "$tenant_dir" "$tenant_domain"
  apply_tenant_permissions "$tenant_dir" "$tenant_owner" "$tenant_owner_group" "$tenant_id" "$tenant_domain"
  run_after_cli_commands "core" "deploy project" "$tenant_id" "" "$tenant_domain" ""

  echo "Project '$TARGET_ALIAS' deployed successfully."
}

deploy_app() {
  [ -n "$TARGET_ALIAS" ] || { usage; exit 1; }
  [ -n "$APP_KIT_NAME" ] || { echo "deploy app requires -a|--app-kit"; exit 1; }
  [ -z "$PROJECT_KIT_NAME" ] || { echo "deploy app does not accept -p|--project-kit or legacy -t|--tenant-kit"; exit 1; }

  local normalized_target target_app_name target_domain target_tenant_id target_mode tenant_json tenant_dir tenant_id app_json app_kit_source app_kit_type app_kit_path selected_app_kit_name
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
    echo "deploy app requires target shape <app_name>@<domain> or <app_name>@<project_id>"
    usage
    exit 1
  fi

  app_kit_source="$(resolve_app_template_source)"
  app_kit_type="${app_kit_source%%$'\t'*}"
  app_kit_path="${app_kit_source#*$'\t'}"
  selected_app_kit_name="$(basename "$app_kit_path")"

  if [ "$target_mode" = "tenant_id" ]; then
    tenant_json="$(node "$TENANT_LAYOUT_CLI" find-tenant-json-by-id "$VAR_BASE_DIR" "$target_tenant_id" || true)"
    [ -n "${tenant_json:-}" ] && [ "$tenant_json" != "null" ] || {
      echo "Project '$target_tenant_id' not found."
      exit 1
    }
    tenant_id="$(json_field "$tenant_json" tenantId)"
    target_domain="$(json_field "$tenant_json" tenantDomain)"
    tenant_dir="$(json_field "$tenant_json" tenantRoot)"
    app_json="$(node "$TENANT_LAYOUT_CLI" find-app-json-by-tenant-id-and-app-name "$VAR_BASE_DIR" "$tenant_id" "$target_app_name" || true)"
  else
    tenant_json="$(node "$TENANT_LAYOUT_CLI" find-tenant-json-by-domain "$VAR_BASE_DIR" "$target_domain" || true)"
    [ -n "${tenant_json:-}" ] && [ "$tenant_json" != "null" ] || {
      echo "Project '$target_domain' not found. Deploy the project first."
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

  deploy_app_from_source \
    "$tenant_id" \
    "$tenant_dir" \
    "$target_domain" \
    "$target_app_name" \
    "$app_kit_type" \
    "$app_kit_path" \
    "app kit: $selected_app_kit_name" \
    "$TARGET_ALIAS" \
    "true" \
    "true"

  echo "App '$TARGET_ALIAS' deployed successfully."
}

parse_deploy_scope
parse_args "$@"

case "$DEPLOY_SCOPE" in
  project|tenant) deploy_tenant ;;
  app) deploy_app ;;
esac
