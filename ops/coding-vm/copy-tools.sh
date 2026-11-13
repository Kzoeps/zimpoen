#!/usr/bin/env bash
# ops/coding-vm/copy-tools.sh — copy herdr, hc, hc-board and herdr-lead from the zimpoen HOST to the coding VM (upgrade plan §6).
# Runs on the host, before provision.sh. The VM's firewall blocks the host, so the VM cannot fetch them itself: the host pushes.
#
#   copy-tools.sh --vm coder@coding-vm --dest /root/zimpoen-vm-tools    copy the host's installed tools into --dest on the VM
#   copy-tools.sh --vm root@coding-vm --dest /root/zimpoen-vm-tools --dry-run   say what would be copied; change nothing
#
# The tools come from this host's PATH (`command -v`), symlinks resolved, so the VM runs what the owner runs. They must be
# executables that work on the VM's CPU and OS (native builds of the same architecture; a script that needs something else
# installed on the host will not run there). Put the same --dest in ZCV_TOOLS_DIR in vm.env; provision.sh installs from it.
# Nothing here carries a credential: only the four programs are copied.
set -euo pipefail

VM=""
DEST=""
DRY_RUN=0
TOOLS=(herdr hc hc-board herdr-lead)

while [ $# -gt 0 ]; do
	case "$1" in
		--vm) VM="${2:-}"; shift ;;
		--dest) DEST="${2:-}"; shift ;;
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
	echo "copy-tools.sh: $1" >&2
	exit 1
}

[[ "$VM" =~ ^[a-z][a-z0-9-]*@[A-Za-z0-9.-]+$ ]] || die "--vm must be user@host, got '$VM'."
[[ "$DEST" =~ ^/[A-Za-z0-9._/-]+$ && "$DEST" != *..* ]] || die "--dest must be an absolute path on the VM without '..', got '$DEST'."

PATHS=()
for tool in "${TOOLS[@]}"; do
	found="$(command -v "$tool" || true)"
	[ -n "$found" ] || die "'$tool' is not on this host's PATH. Install it here first (herdr, hc, hc-board and herdr-lead)."
	real="$(readlink -f "$found")"
	[ -f "$real" ] && [ -x "$real" ] || die "'$tool' resolves to $real, which is not an executable file."
	PATHS+=("$real")
done

if [ "$DRY_RUN" -eq 1 ]; then
	printf 'would copy to %s:%s :' "$VM" "$DEST"
	printf ' %s' "${PATHS[@]}"
	printf '\n'
	exit 0
fi

# Each program is stored under its command name, whatever file it resolved to.
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -T "$VM" "mkdir -p $(printf '%q' "$DEST")" ||
	die "could not reach $VM over ssh to make $DEST."
for index in "${!TOOLS[@]}"; do
	scp -q -p -o BatchMode=yes -o StrictHostKeyChecking=yes "${PATHS[$index]}" "$VM:$DEST/${TOOLS[$index]}" ||
		die "could not copy ${TOOLS[$index]} to $VM:$DEST."
done
echo "copy-tools.sh: copied ${TOOLS[*]} to $VM:$DEST. Set ZCV_TOOLS_DIR=$DEST in vm.env, then run provision.sh on the VM."
