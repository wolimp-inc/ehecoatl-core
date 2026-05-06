#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
source "$SCRIPT_DIR/_firewall_common.sh"

STATE="${1:-}"
[ "$#" -gt 0 ] && shift || true

usage() {
  echo "Usage: ehecoatl firewall newtork_local_proxy <on|off> <username|all> [openLocalPorts_csv] [proxyports_csv]"
}

NGINX_PROXY_USER="${EHECOATL_PROXY_CONSUMER_USER:-www-data}"

case "$STATE" in
  on)
    [ "$#" -ge 2 ] || {
      usage
      exit 1
    }
    USER_NAME="$1"
    OPENLOCALPORTS_SPEC="${2-}"
    PROXY_PORT_SPEC="${3-}"

    OPENLOCALPORTS="$(firewall_parse_csv_ports "$OPENLOCALPORTS_SPEC")" || {
      echo "Invalid runtime network openLocalPorts list: ${OPENLOCALPORTS_SPEC:-<empty>}"
      exit 1
    }
    PROXY_PORTS="$(firewall_parse_csv_ports "$PROXY_PORT_SPEC")" || {
      echo "Invalid proxy port list: ${PROXY_PORT_SPEC:-<empty>}"
      exit 1
    }
    PORTS="$(printf '%s\n%s\n' "${OPENLOCALPORTS:-}" "${PROXY_PORTS:-}" | sed '/^$/d' | sort -n -u)"
    [ -n "${PORTS:-}" ] || {
      echo "At least one local allowlist port is required for 'on'."
      exit 1
    }

    FILTER_CHAIN="$(firewall_resolve_proxy_filter_chain "$USER_NAME")"
    CONSUMER_CHAIN="$(firewall_resolve_proxy_consumer_chain "$USER_NAME")"

    firewall_log "Applying loopback proxy restriction for user '$USER_NAME'"

    firewall_run_rule iptables -t filter -D OUTPUT -p tcp -m owner --uid-owner "$USER_NAME" -j "$FILTER_CHAIN"
    if firewall_chain_exists filter "$FILTER_CHAIN"; then
      firewall_run_rule iptables -t filter -F "$FILTER_CHAIN"
      firewall_run_rule iptables -t filter -X "$FILTER_CHAIN"
    fi
    firewall_run_rule iptables -t filter -D OUTPUT -p tcp -m owner --uid-owner "$NGINX_PROXY_USER" -j "$CONSUMER_CHAIN"
    if firewall_chain_exists filter "$CONSUMER_CHAIN"; then
      firewall_run_rule iptables -t filter -F "$CONSUMER_CHAIN"
      firewall_run_rule iptables -t filter -X "$CONSUMER_CHAIN"
    fi

    if firewall_chain_exists filter "$FILTER_CHAIN"; then
      firewall_run_root iptables -t filter -F "$FILTER_CHAIN"
    else
      firewall_run_root iptables -t filter -N "$FILTER_CHAIN"
    fi
    if firewall_chain_exists filter "$CONSUMER_CHAIN"; then
      firewall_run_root iptables -t filter -F "$CONSUMER_CHAIN"
    else
      firewall_run_root iptables -t filter -N "$CONSUMER_CHAIN"
    fi

    while IFS= read -r port; do
      [ -n "$port" ] || continue
      firewall_run_root iptables -t filter -A "$FILTER_CHAIN" -p tcp -d 127.0.0.1 --dport "$port" -j ACCEPT
      firewall_run_root iptables -t filter -A "$FILTER_CHAIN" -p tcp -d 127.0.0.1 --sport "$port" -j ACCEPT
    done <<< "$PORTS"

    firewall_run_root iptables -t filter -A "$FILTER_CHAIN" -p tcp -d 127.0.0.1 -j REJECT
    firewall_run_root iptables -t filter -A "$FILTER_CHAIN" -j RETURN
    firewall_run_root iptables -t filter -A OUTPUT -p tcp -m owner --uid-owner "$USER_NAME" -j "$FILTER_CHAIN"

    if [ -n "${PROXY_PORTS:-}" ]; then
      while IFS= read -r port; do
        [ -n "$port" ] || continue
        firewall_run_root iptables -t filter -A "$CONSUMER_CHAIN" -p tcp -d 127.0.0.1 --dport "$port" -j ACCEPT
      done <<< "$PROXY_PORTS"
      firewall_run_root iptables -t filter -A "$CONSUMER_CHAIN" -j RETURN
      firewall_run_root iptables -t filter -A OUTPUT -p tcp -m owner --uid-owner "$NGINX_PROXY_USER" -j "$CONSUMER_CHAIN"
    fi
    ;;
  off)
    [ "$#" -ge 1 ] || {
      usage
      exit 1
    }
    USER_NAME="$1"

    if [ "$USER_NAME" = "all" ]; then
      firewall_log "Removing all Ehecoatl loopback proxy restrictions"
      firewall_remove_chain_jumps_by_prefix filter OUTPUT "EHECOATL_PROXY_FILTER_" "EHECOATL_PF_" "EHECOATL_PROXY_CONSUMER_" "EHECOATL_PC_"
      firewall_flush_delete_chains_by_prefix filter "EHECOATL_PROXY_FILTER_" "EHECOATL_PF_" "EHECOATL_PROXY_CONSUMER_" "EHECOATL_PC_"
      exit 0
    fi

    FILTER_CHAIN="$(firewall_resolve_proxy_filter_chain "$USER_NAME")"
    CONSUMER_CHAIN="$(firewall_resolve_proxy_consumer_chain "$USER_NAME")"

    firewall_log "Removing loopback proxy restriction for user '$USER_NAME'"

    firewall_run_rule iptables -t filter -D OUTPUT -p tcp -m owner --uid-owner "$USER_NAME" -j "$FILTER_CHAIN"
    firewall_run_rule iptables -t filter -D OUTPUT -p tcp -m owner --uid-owner "$NGINX_PROXY_USER" -j "$CONSUMER_CHAIN"
    if firewall_chain_exists filter "$FILTER_CHAIN"; then
      firewall_run_rule iptables -t filter -F "$FILTER_CHAIN"
      firewall_run_rule iptables -t filter -X "$FILTER_CHAIN"
    fi
    if firewall_chain_exists filter "$CONSUMER_CHAIN"; then
      firewall_run_rule iptables -t filter -F "$CONSUMER_CHAIN"
      firewall_run_rule iptables -t filter -X "$CONSUMER_CHAIN"
    fi
    ;;
  *)
    usage
    exit 1
    ;;
esac
