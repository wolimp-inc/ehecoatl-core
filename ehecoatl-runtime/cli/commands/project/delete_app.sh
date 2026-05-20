#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../lib/cli-common.sh"
cli_init "$0"

APP_NAME="${1:-}"
[ -n "$APP_NAME" ] || {
  echo "Usage: ehecoatl project [@<domain>] delete app <app_name>"
  echo
  echo "Deletes one app from the selected project."
  echo
  echo "Options:"
  echo "  -h, --help   Show this help message."
  exit 1
}
[ "$APP_NAME" != "-h" ] && [ "$APP_NAME" != "--help" ] || {
  echo "Usage: ehecoatl project [@<domain>] delete app <app_name>"
  echo
  echo "Deletes one app from the selected project."
  echo
  echo "Options:"
  echo "  -h, --help   Show this help message."
  exit 0
}

PROJECT_JSON="$(resolve_project_scope_target_json)"
PROJECT_ID="$(json_field "$PROJECT_JSON" projectId)"
[ -n "$PROJECT_ID" ] || {
  echo "No project target could be resolved from the current directory or explicit @<domain>."
  exit 1
}

exec "$SCRIPT_DIR/../shared/delete.sh" app "${APP_NAME}@${PROJECT_ID}"
