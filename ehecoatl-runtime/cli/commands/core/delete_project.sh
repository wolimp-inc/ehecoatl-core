#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
case "${1:-}" in
  -h|--help)
    cat <<'EOF'
Usage: ehecoatl core delete project @<domain>|@<project_id>

Deletes one managed project.

Arguments:
  @<domain>       Delete by project domain.
  @<project_id>    Delete by project id.
EOF
    exit 0
    ;;
esac
exec "$SCRIPT_DIR/../shared/delete.sh" project "$@"
