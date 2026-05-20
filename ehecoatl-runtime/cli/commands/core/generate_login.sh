#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../lib/cli-common.sh"
cli_init "$0"

INTERNAL_USER="$(policy_value 'system.sharedUser')"
INTERNAL_GROUP="$(policy_value 'system.sharedGroup')"
WORKSPACE_PLANNER="$SCRIPT_DIR/../../lib/managed-login-workspace.js"
SSHD_MANAGED_LOGINS_CONFIG="/etc/ssh/sshd_config.d/90-ehecoatl-managed-logins.conf"

print_help() {
  cat <<'EOF'
Usage: ehecoatl core generate login <username> [options]

Creates a managed Linux login and a scoped workspace at /home/<username>/ehecoatl.

Options:
  --password <password>   Set the login password immediately.
  --scope <selector>      Add one scope selector. Repeat to grant multiple scopes.
                         Accepted selectors: super, @<domain>, @<project_id>,
                         <appname>@<domain>, <appname>@<project_id>.
                         Legacy tenant ids remain accepted.
  -h, --help              Show this help message.

Scope selectors:
  super                   Grant supervision workspace access.
  @example.test           Grant access to the project resolved by domain.
  @<project_id>           Grant access to the project resolved by opaque id.
  www@example.test        Grant access to one app resolved by project domain.
  www@<project_id>        Grant access to one app resolved by project id.

Examples:
  ehecoatl core generate login operator --scope super
  ehecoatl core generate login editor --scope @example.test
  ehecoatl core generate login appdev --scope www@example.test
  ehecoatl core generate login admin --scope super --scope @example.test
EOF
}

USERNAME="${1:-}"
[ -n "$USERNAME" ] || {
  print_help
  exit 1
}
[ "$USERNAME" != "-h" ] && [ "$USERNAME" != "--help" ] || { print_help; exit 0; }
shift || true

PASSWORD=""
declare -a SCOPE_SELECTORS=()

if [[ ! "$USERNAME" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "Invalid username '$USERNAME'. Use lowercase letters, digits, underscores, or dashes."
  exit 1
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --password)
      PASSWORD="${2:-}"
      [ -n "$PASSWORD" ] || { echo "Missing value for --password"; exit 1; }
      shift 2
      ;;
    --scope)
      [ -n "${2:-}" ] || { echo "Missing value for --scope"; exit 1; }
      SCOPE_SELECTORS+=("$2")
      shift 2
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

[ "${#SCOPE_SELECTORS[@]}" -gt 0 ] || {
  echo "At least one --scope selector is required."
  exit 1
}

WORKSPACE_HOME="/home/$USERNAME/ehecoatl"
RESOLVED_PLAN_JSON="$(node - "$WORKSPACE_PLANNER" "$PROJECTS_BASE" "$LEGACY_TENANTS_BASE" "$WORKSPACE_HOME" "$(printf '%s\n' "${SCOPE_SELECTORS[@]}")" <<'EOF'
try {
  const planner = require(process.argv[2]);
  const projectsBase = process.argv[3];
  const legacyTenantsBase = process.argv[4];
  const workspaceHome = process.argv[5];
  const selectors = process.argv[6]
    ? process.argv[6].split(`\n`).map((entry) => entry.trim()).filter(Boolean)
    : [];

  const plan = planner.buildManagedLoginWorkspacePlan({
    projectsBase,
    tenantsBase: legacyTenantsBase,
    legacyTenantsBase,
    workspaceHome,
    scopeSelectors: selectors
  });

  process.stdout.write(JSON.stringify(plan));
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exit(1);
}
EOF
)"

mapfile -t RESOLVED_GROUPS < <(printf '%s' "$RESOLVED_PLAN_JSON" | node -e '
  const fs = require(`node:fs`);
  const plan = JSON.parse(fs.readFileSync(0, `utf8`));
  for (const groupName of plan.resolvedGroups ?? []) {
    process.stdout.write(`${groupName}\n`);
  }
')

PRIMARY_GROUP="${RESOLVED_GROUPS[0]}"
SUPPLEMENTARY_GROUPS="$(printf '%s' "$RESOLVED_PLAN_JSON" | node -e '
  const fs = require(`node:fs`);
  const plan = JSON.parse(fs.readFileSync(0, `utf8`));
  process.stdout.write((plan.resolvedGroups ?? []).slice(1).join(`,`));
')"

for group_name in "${RESOLVED_GROUPS[@]}"; do
  getent group "$group_name" >/dev/null 2>&1 || {
    echo "Required scope group '$group_name' does not exist yet."
    exit 1
  }
done

if id "$USERNAME" >/dev/null 2>&1; then
  echo "User '$USERNAME' already exists."
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  command -v sudo >/dev/null 2>&1 || { echo "sudo is required."; exit 1; }
  SUDO="sudo"
fi

refresh_managed_login_sshd_config() {
  command -v sshd >/dev/null 2>&1 || return 0

  local temp_file
  temp_file="$(mktemp)"
  node - "$MANAGED_LOGINS_DIR" > "$temp_file" <<'EOF'
const fs = require(`node:fs`);
const path = require(`node:path`);

const registryDir = process.argv[2];
const usernames = [];
let entries = [];

try {
  entries = fs.readdirSync(registryDir, { withFileTypes: true });
} catch {
}

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(`.json`)) continue;

  try {
    const payload = JSON.parse(fs.readFileSync(path.join(registryDir, entry.name), `utf8`));
    const username = String(payload?.username ?? ``).trim();
    if (payload?.passwordAuthentication === true && /^[a-z_][a-z0-9_-]*$/.test(username)) {
      usernames.push(username);
    }
  } catch {
  }
}

usernames.sort((left, right) => left.localeCompare(right));

process.stdout.write(`# Managed by Ehecoatl. Allows password auth only for managed logins created with --password.\n`);
if (usernames.length > 0) {
  process.stdout.write(`Match User ${usernames.join(`,`)}\n`);
  process.stdout.write(`  PubkeyAuthentication yes\n`);
  process.stdout.write(`  PasswordAuthentication yes\n`);
  process.stdout.write(`  KbdInteractiveAuthentication no\n`);
}
EOF

  $SUDO install -o root -g root -m 0644 "$temp_file" "$SSHD_MANAGED_LOGINS_CONFIG"
  rm -f "$temp_file"
  $SUDO sshd -t
  $SUDO systemctl reload ssh >/dev/null 2>&1 || $SUDO systemctl reload sshd >/dev/null 2>&1 || true
}

$SUDO mkdir -p "$MANAGED_LOGINS_DIR"

USERADD_ARGS=(useradd --create-home --home-dir "/home/$USERNAME" --shell /bin/bash --gid "$PRIMARY_GROUP")
[ -n "$SUPPLEMENTARY_GROUPS" ] && USERADD_ARGS+=(--groups "$SUPPLEMENTARY_GROUPS")

$SUDO "${USERADD_ARGS[@]}" "$USERNAME"

if [ -n "$PASSWORD" ]; then
  printf '%s:%s\n' "$USERNAME" "$PASSWORD" | $SUDO chpasswd
else
  $SUDO passwd -l "$USERNAME" >/dev/null
fi

$SUDO install -d -o "$USERNAME" -g "$PRIMARY_GROUP" -m 0750 "$WORKSPACE_HOME"

while IFS=$'\t' read -r relative_path target_path; do
  [ -n "$relative_path" ] || continue
  parent_dir="$(dirname "$WORKSPACE_HOME/$relative_path")"
  $SUDO install -d -o "$USERNAME" -g "$PRIMARY_GROUP" -m 0750 "$parent_dir"
  $SUDO ln -sfn "$target_path" "$WORKSPACE_HOME/$relative_path"
done < <(printf '%s' "$RESOLVED_PLAN_JSON" | node -e '
  const fs = require(`node:fs`);
  const plan = JSON.parse(fs.readFileSync(0, `utf8`));
  for (const link of plan.workspaceLinks ?? []) {
    process.stdout.write(`${link.relativePath}\t${link.targetPath}\n`);
  }
')

PASSWORD_AUTH_FLAG=0
[ -n "$PASSWORD" ] && PASSWORD_AUTH_FLAG=1

$SUDO node -e '
  const fs = require(`node:fs`);
  const path = require(`node:path`);
  const [dirPath, username, primaryGroup, groupsCsv, selectorsCsv, planJson, passwordAuthFlag] = process.argv.slice(1);
  const filePath = path.join(dirPath, `${username}.json`);
  const plan = JSON.parse(planJson);
  const payload = {
    username,
    home: `/home/${username}`,
    workspaceHome: plan.workspaceHome,
    shell: `/bin/bash`,
    primaryGroup,
    supplementaryGroups: groupsCsv ? groupsCsv.split(`,`).filter(Boolean) : [],
    resolvedGroups: plan.resolvedGroups ?? [],
    scopeSelectors: selectorsCsv ? selectorsCsv.split(`\n`).filter(Boolean) : [],
    workspaceLinks: plan.workspaceLinks ?? [],
    passwordAuthentication: passwordAuthFlag === `1`,
    createdAt: new Date().toISOString()
  };
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + `\n`, `utf8`);
' "$MANAGED_LOGINS_DIR" "$USERNAME" "$PRIMARY_GROUP" "$SUPPLEMENTARY_GROUPS" "$(printf '%s\n' "${SCOPE_SELECTORS[@]}")" "$RESOLVED_PLAN_JSON" "$PASSWORD_AUTH_FLAG"
$SUDO chown "$INTERNAL_USER:$INTERNAL_GROUP" "$MANAGED_LOGINS_DIR/$USERNAME.json"
$SUDO chmod 0640 "$MANAGED_LOGINS_DIR/$USERNAME.json"

if [ -n "$PASSWORD" ]; then
  refresh_managed_login_sshd_config
fi

echo "Managed login '$USERNAME' created."
echo "Home: /home/$USERNAME"
echo "Workspace: $WORKSPACE_HOME"
echo "Primary group: $PRIMARY_GROUP"
[ -n "$SUPPLEMENTARY_GROUPS" ] && echo "Supplementary groups: $SUPPLEMENTARY_GROUPS"
[ -n "$PASSWORD" ] || echo "Password state: locked"
