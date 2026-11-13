#!/usr/bin/env bash
# ops/shell-egress.sh — egress rules for the sandboxed shell's network (ZIMPOEN_SHELL_NETWORK, docs/ARCHITECTURE.md §5.8).
#
#   sudo ops/shell-egress.sh                       create the network if missing, apply nftables rules, write the marker
#   sudo ops/shell-egress.sh --backend iptables    the same with iptables/ip6tables
#   ops/shell-egress.sh --dry-run                  print what would run; change nothing (no root needed)
#   sudo ops/shell-egress.sh --remove              remove the rules and the marker (the server then refuses to start)
#   options: --network NAME (zimpoen-shell)  --bridge IFNAME (zs-br0)  --subnet CIDR (172.31.250.0/24)
#            --engine docker|podman (docker)  --marker PATH (/run/zimpoen-shell/egress.ok)
#
# Only needed with ZIMPOEN_SHELL_NETWORK set to a network; the default (none) has no network to filter.
# From the sandbox bridge it drops: everything to this host (INPUT), traffic between sandboxes, and forwarding to private,
# loopback, link-local, ULA and tailnet ranges. Public internet stays reachable. The marker in /run is how the server
# knows the rules were applied; /run is emptied at boot, like these rules, so run this again after every boot
# (for example from a oneshot systemd unit ordered before assistant-server.service).
set -euo pipefail

NETWORK=zimpoen-shell
BRIDGE=zs-br0
SUBNET=172.31.250.0/24
ENGINE=docker
BACKEND=nft
MARKER=/run/zimpoen-shell/egress.ok
DRY_RUN=0
REMOVE=0

# Keep in sync with BLOCKED_EGRESS_RANGES in packages/extensions/src/shell/check.ts: the server compares the marker to it.
BLOCKED4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8 100.64.0.0/10"
BLOCKED6="fc00::/7 fe80::/10 fd7a:115c:a1e0::/48"

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
	case "$1" in
		--network) NETWORK="$2"; shift 2 ;;
		--bridge) BRIDGE="$2"; shift 2 ;;
		--subnet) SUBNET="$2"; shift 2 ;;
		--engine) ENGINE="$2"; shift 2 ;;
		--backend) BACKEND="$2"; shift 2 ;;
		--marker) MARKER="$2"; shift 2 ;;
		--dry-run) DRY_RUN=1; shift ;;
		--remove) REMOVE=1; shift ;;
		-h | --help) usage; exit 0 ;;
		*) echo "Unknown option '$1'." >&2; usage >&2; exit 2 ;;
	esac
done

case "$BACKEND" in nft | iptables) ;; *) echo "--backend is nft or iptables, not '$BACKEND'." >&2; exit 2 ;; esac
case "$ENGINE" in docker | podman) ;; *) echo "--engine is docker or podman, not '$ENGINE'." >&2; exit 2 ;; esac
[[ "$NETWORK" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$ ]] || { echo "Bad --network '$NETWORK'." >&2; exit 2; }
[[ "$BRIDGE" =~ ^[a-zA-Z0-9_.-]{1,15}$ ]] || { echo "Bad --bridge '$BRIDGE' (at most 15 characters)." >&2; exit 2; }
if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
	echo "Run as root (sudo), or with --dry-run to see what it would do." >&2
	exit 1
fi

# Every command goes through here, so --dry-run prints exactly what a real run executes.
run() {
	if [ "$DRY_RUN" -eq 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi
}

nft_rules() {
	local v4 v6
	v4=$(echo "$BLOCKED4" | sed 's/ /, /g')
	v6=$(echo "$BLOCKED6" | sed 's/ /, /g')
	cat <<EOF
table inet zimpoen_shell {
	set blocked4 { type ipv4_addr; flags interval; elements = { $v4 } }
	set blocked6 { type ipv6_addr; flags interval; elements = { $v6 } }
	chain input {
		type filter hook input priority -10; policy accept;
		iifname "$BRIDGE" drop
	}
	chain forward {
		type filter hook forward priority -10; policy accept;
		iifname "$BRIDGE" oifname "$BRIDGE" drop
		iifname "$BRIDGE" ip daddr @blocked4 drop
		iifname "$BRIDGE" ip6 daddr @blocked6 drop
	}
}
EOF
}

remove_nft() {
	if [ "$DRY_RUN" -eq 1 ] || nft list table inet zimpoen_shell >/dev/null 2>&1; then
		run nft delete table inet zimpoen_shell
	fi
}

apply_nft() {
	remove_nft
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "+ nft -f - <<'RULES'"
		nft_rules
		echo "RULES"
	else
		nft_rules | nft -f -
	fi
}

# iptables: one chain per family, jumped to first from INPUT and FORWARD for traffic from the bridge.
remove_iptables() {
	local tool
	for tool in iptables ip6tables; do
		if [ "$DRY_RUN" -eq 1 ] || "$tool" -n -L ZIMPOEN-SHELL >/dev/null 2>&1; then
			run "$tool" -D INPUT -i "$BRIDGE" -j DROP || true
			run "$tool" -D FORWARD -i "$BRIDGE" -j ZIMPOEN-SHELL || true
			run "$tool" -F ZIMPOEN-SHELL
			run "$tool" -X ZIMPOEN-SHELL
		fi
	done
}

apply_iptables() {
	local range
	remove_iptables
	run iptables -N ZIMPOEN-SHELL
	run iptables -A ZIMPOEN-SHELL -o "$BRIDGE" -j DROP
	for range in $BLOCKED4; do run iptables -A ZIMPOEN-SHELL -d "$range" -j DROP; done
	run iptables -I FORWARD 1 -i "$BRIDGE" -j ZIMPOEN-SHELL
	run iptables -I INPUT 1 -i "$BRIDGE" -j DROP
	run ip6tables -N ZIMPOEN-SHELL
	run ip6tables -A ZIMPOEN-SHELL -o "$BRIDGE" -j DROP
	for range in $BLOCKED6; do run ip6tables -A ZIMPOEN-SHELL -d "$range" -j DROP; done
	run ip6tables -I FORWARD 1 -i "$BRIDGE" -j ZIMPOEN-SHELL
	run ip6tables -I INPUT 1 -i "$BRIDGE" -j DROP
}

ensure_network() {
	if [ "$DRY_RUN" -eq 0 ] && "$ENGINE" network inspect "$NETWORK" >/dev/null 2>&1; then return; fi
	if [ "$ENGINE" = docker ]; then
		run docker network create --driver bridge --subnet "$SUBNET" \
			--opt "com.docker.network.bridge.name=$BRIDGE" --opt com.docker.network.bridge.enable_icc=false "$NETWORK"
	else
		run podman network create --driver bridge --subnet "$SUBNET" --interface-name "$BRIDGE" "$NETWORK"
	fi
}

write_marker() {
	local blocked
	blocked=$(echo "$BLOCKED4 $BLOCKED6" | tr ' ' ',')
	run install -d -m 0755 -o root -g root "$(dirname "$MARKER")"
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "+ write $MARKER: network=$NETWORK bridge=$BRIDGE backend=$BACKEND blocked=$blocked"
		return
	fi
	local tmp
	tmp=$(mktemp "$(dirname "$MARKER")/.egress.XXXXXX")
	printf 'network=%s\nbridge=%s\nbackend=%s\nblocked=%s\napplied_at=%s\n' \
		"$NETWORK" "$BRIDGE" "$BACKEND" "$blocked" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$tmp"
	chown root:root "$tmp"
	chmod 0644 "$tmp"
	mv -f "$tmp" "$MARKER"
}

if [ "$REMOVE" -eq 1 ]; then
	run rm -f "$MARKER"
	if [ "$BACKEND" = nft ]; then remove_nft; else remove_iptables; fi
	echo "Removed the sandbox egress rules and $MARKER."
	exit 0
fi

# The marker goes first so a failure part-way leaves none (the server then refuses to start).
run rm -f "$MARKER"
ensure_network
if [ "$BACKEND" = nft ]; then apply_nft; else apply_iptables; fi
write_marker
echo "Sandbox egress rules applied on $BRIDGE ($NETWORK); marker $MARKER written."
