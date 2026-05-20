#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../lib/cli-common.sh"
cli_init "$0"

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
Usage: ehecoatl project [@<domain>] list

Lists apps inside the selected project.

Options:
  -h, --help   Show this help message.
EOF
    exit 0
    ;;
esac

PROJECT_JSON="$(resolve_project_scope_target_json)"
PROJECT_ID="$(json_field "$PROJECT_JSON" projectId)"

node -e '
  const apps = JSON.parse(process.argv[1] ?? `[]`);
  if (!Array.isArray(apps) || apps.length === 0) {
    console.log(`No apps found in the current project.`);
    process.exit(0);
  }
  for (const app of apps) {
    console.log(`${app.appName}\t${app.appId}\t${app.hostname ?? ``}`.trim());
  }
' "$(node "$TENANT_LAYOUT_CLI" list-apps-by-tenant-id "$PROJECTS_BASE" "$PROJECT_ID")"
