#!/bin/bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
COMMANDS_DIR="$BASE_DIR/commands"

# shellcheck source=/dev/null
source "$BASE_DIR/lib/cli-common.sh"
cli_init "$0"

resolve_auth_scope() {
  if [ "$(id -u)" -eq 0 ]; then
    printf 'root'
    return 0
  fi

  local scopes=()
  user_has_group g_superScope && scopes+=("core")
  user_has_group_regex '^g_[a-z0-9]+$' && scopes+=("project")
  user_has_group_regex '^g_[a-z0-9]+_[a-z0-9]+$' && scopes+=("app")

  if [ "${#scopes[@]}" -eq 0 ]; then
    printf 'none'
  else
    local joined=''
    local scope_name
    for scope_name in "${scopes[@]}"; do
      if [ -n "$joined" ]; then
        joined="$joined+$scope_name"
      else
        joined="$scope_name"
      fi
    done
    printf '%s' "$joined"
  fi
}

allowed_scopes_for_auth_scope() {
  if [ "$1" = "root" ]; then
    printf 'core project tenant app firewall'
    return 0
  fi

  local allowed=()
  case "$1" in
    *core*) allowed+=("core") ;;
  esac
  case "$1" in
    *project*) allowed+=("project" "tenant") ;;
    *tenant*) allowed+=("tenant" "project") ;;
  esac
  case "$1" in
    *app*) allowed+=("app") ;;
  esac

  printf '%s' "${allowed[*]}"
}

user_has_group() {
  local expected_group="$1"
  local group_name
  for group_name in $EHECOATL_CLI_GROUPS; do
    [ "$group_name" = "$expected_group" ] && return 0
  done
  return 1
}

user_has_matching_group() {
  local pattern="$1"
  local group_name
  for group_name in $EHECOATL_CLI_GROUPS; do
    case "$group_name" in
      $pattern) return 0 ;;
    esac
  done
  return 1
}

user_has_group_regex() {
  local pattern="$1"
  local group_name
  for group_name in $EHECOATL_CLI_GROUPS; do
    if printf '%s\n' "$group_name" | grep -Eq "$pattern"; then
      return 0
    fi
  done
  return 1
}

is_known_scope() {
  case "$1" in
    core|project|tenant|app|firewall)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

scope_is_allowed() {
  local requested_scope="$1"
  local allowed_scopes="$2"
  case " $allowed_scopes " in
    *" $requested_scope "*) return 0 ;;
    *) return 1 ;;
  esac
}

required_group_hint_for_scope() {
  case "$1" in
    core)
      printf 'root or g_superScope'
      ;;
    project)
      printf 'root or g_{project_id}'
      ;;
    tenant)
      printf 'root or g_{project_id} (legacy tenant alias)'
      ;;
    app)
      printf 'root or g_{project_id}_{app_id}'
      ;;
    firewall)
      printf 'root'
      ;;
    *)
      printf 'recognized Ehecoatl scope group'
      ;;
  esac
}

print_not_authorized() {
  local requested_scope="$1"
  local requested_command="$2"
  echo "Not authorized to run 'ehecoatl $requested_scope ${requested_command}'."
  echo "Current user: $EHECOATL_CLI_USERNAME"
  echo "Current scope: $AUTH_SCOPE"
  echo "Current groups: $EHECOATL_CLI_GROUPS"
  echo "Current directory scope: $(describe_cwd_scope)"
  if [ -n "${EHECOATL_CLI_EXPLICIT_PROJECT_TARGET:-${EHECOATL_CLI_EXPLICIT_TENANT_TARGET:-}}" ]; then
    echo "Explicit project target: ${EHECOATL_CLI_EXPLICIT_PROJECT_TARGET:-$EHECOATL_CLI_EXPLICIT_TENANT_TARGET}"
  fi
  if [ -n "${EHECOATL_CLI_EXPLICIT_APP_TARGET:-}" ]; then
    echo "Explicit app target: $EHECOATL_CLI_EXPLICIT_APP_TARGET"
  fi
  echo "Required scope: $requested_scope"
  echo "Allowed group for that scope: $(required_group_hint_for_scope "$requested_scope")"
}

list_scope_command_names() {
  local scope_name="$1"
  find "$COMMANDS_DIR/$scope_name" -maxdepth 1 -type f -name '*.sh' -printf '%f\n' 2>/dev/null \
    | sed 's/\.sh$//' \
    | grep -v '^_' \
    | sed 's/_/ /g' \
    | sort
}

print_scope_help() {
  local scope_name="$1"
  if [ "$scope_name" = "project" ] || [ "$scope_name" = "tenant" ]; then
    if [ -n "${EHECOATL_CLI_EXPLICIT_PROJECT_TARGET:-${EHECOATL_CLI_EXPLICIT_TENANT_TARGET:-}}" ]; then
      echo "Project target override: ${EHECOATL_CLI_EXPLICIT_PROJECT_TARGET:-$EHECOATL_CLI_EXPLICIT_TENANT_TARGET}"
    else
      echo "Project commands may also use an explicit target override:"
      echo "  ehecoatl project @<domain> ..."
    fi
    if [ "$scope_name" = "tenant" ]; then
      echo "Legacy alias: prefer 'ehecoatl project ...'."
    fi
    echo
  elif [ "$scope_name" = "app" ]; then
    if [ -n "${EHECOATL_CLI_EXPLICIT_APP_TARGET:-}" ]; then
      echo "App target override: $(describe_explicit_app_target)"
    else
      echo "App commands may also use an explicit target override:"
      echo "  ehecoatl app <app_name>@<domain> ..."
      echo "  ehecoatl app <app_name>@<project_id> ..."
    fi
    echo
  fi
  echo "Available '$scope_name' commands:"
  list_scope_command_names "$scope_name"
}

print_help() {
  echo "Current user: $EHECOATL_CLI_USERNAME"
  echo "Current scope: $AUTH_SCOPE"
  echo "Current groups: $EHECOATL_CLI_GROUPS"
  echo "Current directory scope: $(describe_cwd_scope)"
  if [ -n "${EHECOATL_CLI_EXPLICIT_PROJECT_TARGET:-${EHECOATL_CLI_EXPLICIT_TENANT_TARGET:-}}" ]; then
    echo "Explicit project target: ${EHECOATL_CLI_EXPLICIT_PROJECT_TARGET:-$EHECOATL_CLI_EXPLICIT_TENANT_TARGET}"
  fi
  if [ -n "${EHECOATL_CLI_EXPLICIT_APP_TARGET:-}" ]; then
    echo "Explicit app target: $EHECOATL_CLI_EXPLICIT_APP_TARGET"
  fi
  echo
  echo "Available scopes:"

  for scope_name in core project tenant app firewall; do
    if scope_is_allowed "$scope_name" "$ALLOWED_SCOPES"; then
      echo "- $scope_name"
      list_scope_command_names "$scope_name" | sed 's/^/  - /'
    fi
  done
}

is_help_flag() {
  case "${1:-}" in
    -h|--help|help)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

REQUESTED_SCOPE="${1:-help}"
[ "$#" -gt 0 ] && shift || true

AUTH_SCOPE="$(resolve_auth_scope)"
ALLOWED_SCOPES="$(allowed_scopes_for_auth_scope "$AUTH_SCOPE")"

if is_help_flag "$REQUESTED_SCOPE"; then
  print_help
  exit 0
fi

is_known_scope "$REQUESTED_SCOPE" || {
  echo "Unknown CLI scope '$REQUESTED_SCOPE'."
  echo
  print_help
  exit 1
}

if ! scope_is_allowed "$REQUESTED_SCOPE" "$ALLOWED_SCOPES"; then
  print_not_authorized "$REQUESTED_SCOPE" "$*"
  exit 1
fi

if [ "$REQUESTED_SCOPE" = "project" ] && [ "$#" -gt 0 ]; then
  case "${1:-}" in
    @*)
      export EHECOATL_CLI_EXPLICIT_PROJECT_TARGET="$1"
      shift
      ;;
  esac
fi

if [ "$REQUESTED_SCOPE" = "tenant" ] && [ "$#" -gt 0 ]; then
  case "${1:-}" in
    @*)
      export EHECOATL_CLI_EXPLICIT_TENANT_TARGET="$1"
      export EHECOATL_CLI_EXPLICIT_PROJECT_TARGET="$1"
      shift
      ;;
  esac
fi

if [ "$REQUESTED_SCOPE" = "app" ] && [ "$#" -gt 0 ]; then
  case "${1:-}" in
    *@*)
      export EHECOATL_CLI_EXPLICIT_APP_TARGET="$1"
      shift
      ;;
  esac
fi

if [ "$#" -eq 0 ] || is_help_flag "${1:-}"; then
  print_scope_help "$REQUESTED_SCOPE"
  exit 0
fi

COMMAND_TOKEN_1="${1:-}"
COMMAND_TOKEN_2="${2:-}"
COMMAND_FILE=""

if [ -n "$COMMAND_TOKEN_2" ] && [ -f "$COMMANDS_DIR/$REQUESTED_SCOPE/${COMMAND_TOKEN_1}_${COMMAND_TOKEN_2}.sh" ]; then
  COMMAND_FILE="$COMMANDS_DIR/$REQUESTED_SCOPE/${COMMAND_TOKEN_1}_${COMMAND_TOKEN_2}.sh"
  shift 2
elif [ -f "$COMMANDS_DIR/$REQUESTED_SCOPE/${COMMAND_TOKEN_1}.sh" ]; then
  COMMAND_FILE="$COMMANDS_DIR/$REQUESTED_SCOPE/${COMMAND_TOKEN_1}.sh"
  shift
else
  echo "Command not found under scope '$REQUESTED_SCOPE'."
  echo
  print_scope_help "$REQUESTED_SCOPE"
  exit 1
fi

export EHECOATL_CLI_AUTH_SCOPE="$AUTH_SCOPE"
export EHECOATL_CLI_USERNAME
export EHECOATL_CLI_GROUPS

exec "$COMMAND_FILE" "$@"
