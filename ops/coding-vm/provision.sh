#!/usr/bin/env bash
# ops/coding-vm/provision.sh — turn a fresh Debian/Ubuntu VM into zimpoen's coding VM (upgrade plan §6). Runs ON THE VM, as root.
#
#   provision.sh --config /root/vm.env            provision (idempotent: running it again converges)
#   provision.sh --config /root/vm.env --dry-run  validate the settings and print what would be done; change nothing
#
# What it does: installs git, nftables and Node; installs pi from npm and herdr, hc, hc-board and herdr-lead from pinned
# release files (sha256 checked); creates the unprivileged user that runs the lead; loads the egress firewall
# (egress.sh) and a unit that reloads it at boot; installs herdr-lead's unit, which refuses to start without those rules;
# copies the TEST VALUES file (never real secrets) into the user's config; makes git refuse to push from the VM.
#
# It never receives a credential. Pushes happen on the zimpoen host (host-push.sh) with a broker-minted token. See
# docs/coding-vm.md and ops/coding-vm/vm.env.example for every setting.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG=""
DRY_RUN=0

while [ $# -gt 0 ]; do
	case "$1" in
		--config) CONFIG="${2:-}"; shift ;;
		--dry-run) DRY_RUN=1 ;;
		-h | --help)
			sed -n '2,/^set -euo pipefail$/{/^#/p}' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "Unknown option '$1'. Try --help." >&2
			exit 2
			;;
	esac
	shift
done

die() {
	echo "provision.sh: $1" >&2
	exit 1
}

# run CMD...: do it, or with --dry-run only say it.
run() {
	if [ "$DRY_RUN" -eq 1 ]; then
		printf 'would run:'
		printf ' %q' "$@"
		printf '\n'
	else
		"$@"
	fi
}

# Anything that looks like a real credential. The VM holds test values only (plan §6); a match stops provisioning.
SECRET_PATTERNS='gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(ql)?://[^:/@ ]+:[^@ ]+@'

# refuse_secrets FILE: stop if FILE contains a credential-shaped value. Prints only the line number, never the value.
refuse_secrets() {
	local hits
	hits="$(grep -nE "$SECRET_PATTERNS" "$1" | cut -d: -f1 | tr '\n' ' ' || true)"
	[ -z "$hits" ] || die "$1 looks like it holds a real credential (line(s) $hits). The coding VM gets test values only; remove it."
}

[ -n "$CONFIG" ] || die "--config is required (copy ops/coding-vm/vm.env.example)."
[ -r "$CONFIG" ] || die "cannot read $CONFIG."
refuse_secrets "$CONFIG"
# shellcheck disable=SC1090
. "$CONFIG"

# Required settings.
for v in ZCV_USER ZCV_RELAY ZCV_HOST_ADDRS ZCV_NODE_VERSION ZCV_NODE_SHA256 ZCV_PI_VERSION ZCV_TOOLS_URL ZCV_TOOLS_SHA256 ZCV_TEST_VALUES_FILE; do
	[ -n "${!v:-}" ] || die "$v is not set in $CONFIG (see ops/coding-vm/vm.env.example)."
done
[[ "$ZCV_USER" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || die "ZCV_USER '$ZCV_USER' is not a plain user name."
[[ "$ZCV_NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "ZCV_NODE_VERSION must look like v24.11.0."
[[ "$ZCV_NODE_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "ZCV_NODE_SHA256 must be 64 hex characters."
[[ "$ZCV_TOOLS_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "ZCV_TOOLS_SHA256 must be 64 hex characters."
[[ "$ZCV_PI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "ZCV_PI_VERSION must be an exact version (no ranges)."
case "$ZCV_TOOLS_URL" in https://*) ;; *) die "ZCV_TOOLS_URL must be https://." ;; esac
[ -r "$ZCV_TEST_VALUES_FILE" ] || die "cannot read ZCV_TEST_VALUES_FILE '$ZCV_TEST_VALUES_FILE'."
refuse_secrets "$ZCV_TEST_VALUES_FILE"
grep -q '^ZIMPOEN_VM_TEST_VALUES_ONLY=1$' "$ZCV_TEST_VALUES_FILE" ||
	die "$ZCV_TEST_VALUES_FILE must contain the line ZIMPOEN_VM_TEST_VALUES_ONLY=1, to say every value in it is a test value."

# The egress settings are validated by egress.sh itself.
ZCV_RELAY="$ZCV_RELAY" ZCV_HOST_ADDRS="$ZCV_HOST_ADDRS" ZCV_DNS="${ZCV_DNS:-}" ZCV_EXTRA_BLOCK="${ZCV_EXTRA_BLOCK:-}" \
	bash "$HERE/egress.sh" --print >/dev/null

# Everything above only read and checked; from here on it changes the machine.
[ "$DRY_RUN" -eq 1 ] || [ "$(id -u)" -eq 0 ] || die "run as root (or use --dry-run)."

LIB=/usr/local/lib/zimpoen-vm
ETC=/etc/zimpoen-vm
HOME_DIR="/home/$ZCV_USER"
ARCH="$(uname -m)"
case "$ARCH" in x86_64) NODE_ARCH=x64 ;; aarch64) NODE_ARCH=arm64 ;; *) die "unsupported CPU '$ARCH'." ;; esac

# fetch URL SHA256 DEST: download and check; a mismatch deletes the file and stops.
fetch() {
	run curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error -o "$3" "$1"
	if [ "$DRY_RUN" -eq 0 ] && ! echo "$2  $3" | sha256sum --check --status; then
		rm -f "$3"
		die "checksum mismatch for $1. Expected $2."
	fi
}

echo "== packages"
run apt-get update
run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git nftables curl ca-certificates openssh-server xz-utils

echo "== egress firewall (before anything else reaches the network as the lead)"
run install -d -m 0755 "$LIB" "$ETC"
run install -m 0755 "$HERE/egress.sh" "$LIB/egress.sh"
if [ "$DRY_RUN" -eq 0 ]; then
	umask 022
	{
		echo "ZCV_RELAY=$ZCV_RELAY"
		echo "ZCV_HOST_ADDRS=$ZCV_HOST_ADDRS"
		echo "ZCV_DNS=${ZCV_DNS:-}"
		echo "ZCV_EXTRA_BLOCK=${ZCV_EXTRA_BLOCK:-}"
	} >"$ETC/egress.env"
else
	echo "would write $ETC/egress.env"
fi
run install -m 0644 "$HERE/systemd/zimpoen-vm-egress.service" /etc/systemd/system/zimpoen-vm-egress.service
run systemctl daemon-reload
run systemctl enable --now zimpoen-vm-egress.service
run env ZCV_RELAY="$ZCV_RELAY" ZCV_HOST_ADDRS="$ZCV_HOST_ADDRS" ZCV_DNS="${ZCV_DNS:-}" ZCV_EXTRA_BLOCK="${ZCV_EXTRA_BLOCK:-}" "$LIB/egress.sh" --check

echo "== node $ZCV_NODE_VERSION"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
NODE_TGZ="node-$ZCV_NODE_VERSION-linux-$NODE_ARCH.tar.xz"
fetch "https://nodejs.org/dist/$ZCV_NODE_VERSION/$NODE_TGZ" "$ZCV_NODE_SHA256" "$TMP/$NODE_TGZ"
run tar -xJf "$TMP/$NODE_TGZ" -C /usr/local --strip-components=1

echo "== pi $ZCV_PI_VERSION"
run /usr/local/bin/npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$ZCV_PI_VERSION"

echo "== herdr, hc, hc-board, herdr-lead"
fetch "$ZCV_TOOLS_URL" "$ZCV_TOOLS_SHA256" "$TMP/tools.tar.gz"
run tar -xzf "$TMP/tools.tar.gz" -C /usr/local/bin herdr hc hc-board herdr-lead

echo "== user $ZCV_USER (no sudo, no credentials)"
if ! id "$ZCV_USER" >/dev/null 2>&1; then
	run useradd --create-home --shell /bin/bash "$ZCV_USER"
fi
run install -d -m 0700 -o "$ZCV_USER" -g "$ZCV_USER" "$HOME_DIR/.config" "$HOME_DIR/.config/zimpoen-vm" "$HOME_DIR/work"
run install -m 0600 -o "$ZCV_USER" -g "$ZCV_USER" "$ZCV_TEST_VALUES_FILE" "$HOME_DIR/.config/zimpoen-vm/test-values.env"

echo "== git: no credentials, no pushes from the VM"
# A push from the VM is rewritten to a URL that cannot work. Pushes go through the host (host-push.sh). This is a speed
# bump against an agent's habit, not the security boundary: the VM holds no token, so a push could not authenticate anyway.
run git config --system credential.helper ""
run git config --system url."file:///zimpoen-vm/pushes-go-through-the-host/".pushInsteadOf "https://"
run git config --system --add url."file:///zimpoen-vm/pushes-go-through-the-host/".pushInsteadOf "git@"
run git config --system --add url."file:///zimpoen-vm/pushes-go-through-the-host/".pushInsteadOf "ssh://"

echo "== herdr-lead unit"
if [ "$DRY_RUN" -eq 0 ]; then
	sed "s/CHANGE_ME/$ZCV_USER/g" "$HERE/systemd/herdr-lead.service" >/etc/systemd/system/herdr-lead.service
else
	echo "would write /etc/systemd/system/herdr-lead.service (User=$ZCV_USER)"
fi
run systemctl daemon-reload
run systemctl enable --now herdr-lead.service

echo "provision.sh: done. Next: docs/coding-vm.md, 'Check it'."
