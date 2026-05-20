#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
Usage: ehecoatl core rescan projects [options]

Requests a director project registry rescan and prints the result.

Options:
  --json        Print the RPC response as JSON.
  -h, --help    Show this help message.
EOF
    exit 0
    ;;
esac

exec node "$CLI_DIR/lib/director-rpc-cli.js" rescan-projects "$@"
