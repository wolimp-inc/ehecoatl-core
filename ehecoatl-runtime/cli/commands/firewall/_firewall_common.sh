#!/bin/bash

firewall_log() {
  printf '[FIREWALL] %s\n' "$1"
}

firewall_run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return $?
  fi

  "$@"
}

firewall_run_rule() {
  firewall_run_root "$@" >/dev/null 2>&1 || true
}

firewall_chain_exists() {
  local table="$1"
  local chain="$2"

  firewall_run_root iptables -t "$table" -nL "$chain" >/dev/null 2>&1
}

firewall_chain_matches_prefix() {
  local chain_name="$1"
  shift || true

  for prefix in "$@"; do
    case "$chain_name" in
      "${prefix}"*)
        return 0
        ;;
    esac
  done

  return 1
}

firewall_sanitize_identifier() {
  printf '%s' "$1" | tr '[:lower:].-' '[:upper:]__' | tr -cd 'A-Z0-9_'
}

firewall_hash_id() {
  printf '%s' "$1" | sha1sum | cut -c1-10 | tr '[:lower:]' '[:upper:]'
}

firewall_resolve_input_chain() {
  local user_name="$1"
  local process_label="${2:-unknown}"
  local sanitized legacy_chain fingerprint

  sanitized="$(firewall_sanitize_identifier "$user_name")"
  [ -n "$sanitized" ] || sanitized="UNKNOWN"
  legacy_chain="EHECOATL_FW_INPUT_${sanitized}"

  if [ "${#legacy_chain}" -le 28 ]; then
    printf '%s\n' "$legacy_chain"
    return 0
  fi

  fingerprint="$(firewall_hash_id "${user_name}:${process_label}")"
  printf 'EHECOATL_FW_I_%s\n' "$fingerprint"
}

firewall_resolve_output_chain() {
  local user_name="$1"
  local process_label="${2:-unknown}"
  local sanitized legacy_chain fingerprint

  sanitized="$(firewall_sanitize_identifier "$user_name")"
  [ -n "$sanitized" ] || sanitized="UNKNOWN"
  legacy_chain="EHECOATL_FW_OUTPUT_${sanitized}"

  if [ "${#legacy_chain}" -le 28 ]; then
    printf '%s\n' "$legacy_chain"
    return 0
  fi

  fingerprint="$(firewall_hash_id "${user_name}:${process_label}:output")"
  printf 'EHECOATL_FW_O_%s\n' "$fingerprint"
}

firewall_resolve_proxy_filter_chain() {
  local user_name="$1"
  local sanitized legacy_chain fingerprint

  sanitized="$(firewall_sanitize_identifier "$user_name")"
  [ -n "$sanitized" ] || sanitized="UNKNOWN"
  legacy_chain="EHECOATL_PROXY_FILTER_${sanitized}"

  if [ "${#legacy_chain}" -le 28 ]; then
    printf '%s\n' "$legacy_chain"
    return 0
  fi

  fingerprint="$(firewall_hash_id "proxy-filter:${user_name}")"
  printf 'EHECOATL_PF_%s\n' "$fingerprint"
}

firewall_resolve_proxy_consumer_chain() {
  local user_name="$1"
  local sanitized legacy_chain fingerprint

  sanitized="$(firewall_sanitize_identifier "$user_name")"
  [ -n "$sanitized" ] || sanitized="UNKNOWN"
  legacy_chain="EHECOATL_PROXY_CONSUMER_${sanitized}"

  if [ "${#legacy_chain}" -le 28 ]; then
    printf '%s\n' "$legacy_chain"
    return 0
  fi

  fingerprint="$(firewall_hash_id "proxy-consumer:${user_name}")"
  printf 'EHECOATL_PC_%s\n' "$fingerprint"
}

firewall_resolve_proxy_nat_chain() {
  local user_name="$1"
  local sanitized legacy_chain fingerprint

  sanitized="$(firewall_sanitize_identifier "$user_name")"
  [ -n "$sanitized" ] || sanitized="UNKNOWN"
  legacy_chain="EHECOATL_PROXY_NAT_${sanitized}"

  if [ "${#legacy_chain}" -le 28 ]; then
    printf '%s\n' "$legacy_chain"
    return 0
  fi

  fingerprint="$(firewall_hash_id "proxy-nat:${user_name}")"
  printf 'EHECOATL_PN_%s\n' "$fingerprint"
}

firewall_validate_port() {
  local port="$1"

  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

firewall_parse_csv_ports() {
  local csv="${1:-}"
  local item
  local -a ports=()

  [ -n "$csv" ] || return 0

  IFS=',' read -r -a items <<< "$csv"
  for item in "${items[@]}"; do
    item="$(printf '%s' "$item" | tr -d '[:space:]')"
    [ -n "$item" ] || continue
    firewall_validate_port "$item" || return 1
    ports+=("$item")
  done

  [ "${#ports[@]}" -gt 0 ] || return 0
  printf '%s\n' "${ports[@]}" | sort -n -u
}

firewall_read_runtime_open_local_ports() {
  local script_dir install_root

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  install_root="$(cd "$script_dir/../../.." && pwd)"
  [ -f "$install_root/config/default.user.config.js" ] || return 0

  (
    cd "$install_root" || exit 0
    node -r module-alias/register - <<'NODE'
(async () => {
  try {
    const loadUserConfig = require(`./config/default.user.config`);
    const { normalizeRuntimeNetworkConfig } = require(`@/utils/config/runtime-network-config`);
    const config = await loadUserConfig();
    const { openLocalPorts } = normalizeRuntimeNetworkConfig(config);
    for (const port of openLocalPorts) {
      console.log(String(port));
    }
  } catch {
  }
})();
NODE
  ) || true
}

firewall_extract_tcp_ports_for_user() {
  local user_name="$1"
  local ports=()
  local line local_addr proc_field pid owner port

  while IFS= read -r line; do
    local_addr="$(printf '%s' "$line" | awk '{print $4}')"
    proc_field="$(printf '%s' "$line" | awk '{print $NF}')"
    pid="$(printf '%s' "$proc_field" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n1)"
    [ -n "$pid" ] || continue

    owner="$(ps -o user= -p "$pid" 2>/dev/null | awk '{print $1}')"
    [ "$owner" = "$user_name" ] || continue

    port="${local_addr##*:}"
    firewall_validate_port "$port" || continue
    ports+=("$port")
  done < <(firewall_run_root ss -H -ltnp 2>/dev/null || true)

  [ "${#ports[@]}" -gt 0 ] || return 0
  printf '%s\n' "${ports[@]}" | sort -u
}

firewall_remove_output_chain_jumps_for_user() {
  local user_name="$1"
  local chain_prefix="$2"
  local resolved_uid line chain_name delete_rule

  resolved_uid="$(id -u "$user_name" 2>/dev/null || true)"
  [ -n "$resolved_uid" ] || return 0

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    chain_name="$(printf '%s\n' "$line" | sed -n 's/.*-j \(EHECOATL_[A-Z0-9_]*\)$/\1/p')"
    [ -n "$chain_name" ] || continue
    case "$chain_name" in
      "${chain_prefix}"*) ;;
      *) continue ;;
    esac
    delete_rule="$(printf '%s\n' "$line" | sed 's/^-A /-D /')"
    firewall_run_rule iptables -t filter ${delete_rule}
  done < <(
    firewall_run_root iptables -t filter -S OUTPUT \
      | grep -- "-m owner --uid-owner ${resolved_uid} " \
      | grep -- "-j ${chain_prefix}" || true
  )
}

firewall_remove_chain_jumps_by_prefix() {
  local table="$1"
  local parent_chain="$2"
  shift 2 || true
  local prefixes=("$@")
  local line chain_name

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    chain_name="$(printf '%s\n' "$line" | sed -n 's/.*-j \([A-Z0-9_][A-Z0-9_]*\)$/\1/p')"
    [ -n "$chain_name" ] || continue
    firewall_chain_matches_prefix "$chain_name" "${prefixes[@]}" || continue

    read -r -a rule_parts <<< "$line"
    rule_parts[0]="-D"
    firewall_run_rule iptables -t "$table" "${rule_parts[@]}"
  done < <(firewall_run_root iptables -t "$table" -S "$parent_chain" 2>/dev/null || true)
}

firewall_flush_delete_chains_by_prefix() {
  local table="$1"
  shift || true
  local prefixes=("$@")
  local chain_name

  while IFS= read -r chain_name; do
    [ -n "$chain_name" ] || continue
    firewall_chain_matches_prefix "$chain_name" "${prefixes[@]}" || continue
    firewall_run_rule iptables -t "$table" -F "$chain_name"
    firewall_run_rule iptables -t "$table" -X "$chain_name"
  done < <(
    firewall_run_root iptables -t "$table" -S 2>/dev/null \
      | awk '$1=="-N"{print $2}'
  )
}
