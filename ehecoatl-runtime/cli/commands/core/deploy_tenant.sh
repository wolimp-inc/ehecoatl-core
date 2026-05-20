#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
case "${1:-}" in
  -h|--help)
    cat <<'EOF'
Usage: ehecoatl core deploy tenant @<domain> -p <project_kit>

Legacy alias for `core deploy project`. Deploys a project from a project kit.
Kits may be folders or .zip files.
Top-level app_<name>/ folders inside the project kit are auto-deployed as apps.
Missing kits are looked up in built-in kits, custom extension kits, then
https://github.com/ehecoatl/project-kit-<name>.git.

Options:
  -p, --project-kit <name>  Project kit folder or .zip name to copy/extract.
                            The .zip extension is optional.
                            Zip kits must contain files directly at the zip root.
                            Missing kits may be cloned into custom project kits
                            from ehecoatl/project-kit-<name>.
                            Top-level app_<name>/ folders are reserved for
                            embedded apps and are removed after app deploy.
  -t, --tenant-kit <name>   Legacy alias for --project-kit. Legacy tenant-kits
                            roots and ehecoatl/tenant-kit-<name> remotes remain
                            compatibility fallbacks.
  -h, --help                Show this help message.
EOF
    exit 0
    ;;
esac
exec "$SCRIPT_DIR/../shared/deploy.sh" tenant "$@"
