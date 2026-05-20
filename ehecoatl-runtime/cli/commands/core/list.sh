#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../lib/cli-common.sh"
cli_init "$0"

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
Usage: ehecoatl core list

Lists all managed projects.

Options:
  -h, --help   Show this help message.
EOF
    exit 0
    ;;
esac

node -e '
  const projects = JSON.parse(process.argv[1] ?? `[]`);
  if (!Array.isArray(projects) || projects.length === 0) {
    console.log(`No projects found.`);
    process.exit(0);
  }
  for (const project of projects) {
    console.log(`@${project.projectDomain ?? project.tenantDomain}\t${project.projectId ?? project.tenantId}\tapps:${project.appCount}`);
  }
' "$(node "$TENANT_LAYOUT_CLI" list-tenants "$TENANTS_BASE")"
