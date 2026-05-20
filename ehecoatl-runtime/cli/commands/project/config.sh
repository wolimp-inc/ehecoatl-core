#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
case "${1:-}" in
  -h|--help)
    cat <<'EOF'
Usage: ehecoatl project [@<domain>] config [--get <key.path> | --set <key.path> <json_or_string_value>]

Reads or updates the selected project config.

Options:
  --get <key.path>                Read one config value.
  --set <key.path> <value>        Write one config value.
  -h, --help                      Show this help message.
EOF
    exit 0
    ;;
esac
exec "$SCRIPT_DIR/../shared/config.sh" project "$@"
