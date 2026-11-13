#!/usr/bin/env bash
# ops/computer-use/run-desktop.sh — start one computer-use desktop for ONE approved task (upgrade plan §8, phase 5).
# Runs on the zimpoen host. Prints the container name and the host port of the viewer; never prints the passwords.
#
#   run-desktop.sh --task-id ct_ab12 --approval-id a_cd34 --network zimpoen-shell [--image zimpoen-desktop:local] \
#                  [--engine docker|podman] [--dry-run]
#
# Approval per task: the server calls this only after the owner approved the task's `computer_use` request
# (pending_actions, docs/computer-use.md). This script cannot check the database; it requires the approval id so every
# container carries it as a label, and refuses to start a second desktop for the same task.
#
# Hardening is the shell sandbox's (gVisor --runtime=runsc, read-only root, --cap-drop=ALL, no-new-privileges, cpu/memory/
# pids limits, tmpfs scratch, never a pull) plus: the network must be the filtered sandbox network (ops/shell-egress.sh),
# never host, bridge or default; the viewer port is published on 127.0.0.1 only; no host path and no volume is mounted, so
# the desktop starts empty and everything in it is gone when it stops; --stop-timeout and a wall-clock cap end it.
#
# The two one-time viewer passwords are read from stdin (two lines: takeover, then view) and passed through the
# container's environment file in a 0600 temp file that is deleted right after start.
set -euo pipefail

ENGINE=docker
IMAGE="zimpoen-desktop:local"
NETWORK=""
TASK_ID=""
APPROVAL_ID=""
DRY_RUN=0
# Hard limits for one desktop.
MEMORY=2g
CPUS=2
PIDS=512
TMPFS_SIZE=1g
MAX_SECONDS=3600

while [ $# -gt 0 ]; do
	case "$1" in
		--engine) ENGINE="${2:-}"; shift ;;
		--image) IMAGE="${2:-}"; shift ;;
		--network) NETWORK="${2:-}"; shift ;;
		--task-id) TASK_ID="${2:-}"; shift ;;
		--approval-id) APPROVAL_ID="${2:-}"; shift ;;
		--dry-run) DRY_RUN=1 ;;
		-h | --help)
			sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
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
	echo "run-desktop.sh: $1" >&2
	exit 1
}

case "$ENGINE" in docker | podman) ;; *) die "--engine must be docker or podman." ;; esac
[[ "$TASK_ID" =~ ^[a-z][a-z0-9_]{1,40}$ ]] || die "--task-id '$TASK_ID' is not a task id (like ct_ab12)."
[[ "$APPROVAL_ID" =~ ^[a-z][a-z0-9_]{1,40}$ ]] ||
	die "--approval-id is required: every desktop needs the owner's approval for its task (docs/computer-use.md)."
[[ "$IMAGE" =~ ^[a-z0-9][a-z0-9._/:@-]{0,254}$ ]] || die "--image '$IMAGE' is not an image reference."
[ -n "$NETWORK" ] || die "--network is required: the filtered sandbox network made by ops/shell-egress.sh."
case "$NETWORK" in
	host | bridge | default | none | podman | slirp4netns* | pasta* | container:*)
		die "--network '$NETWORK' is not allowed: use the filtered sandbox network (ops/shell-egress.sh). 'none' leaves no way to reach the viewer."
		;;
esac
[[ "$NETWORK" =~ ^[a-z0-9][a-z0-9_.-]{0,62}$ ]] || die "--network '$NETWORK' is not a network name."

NAME="zimpoen-desktop-$TASK_ID"

ARGV=(
	"$ENGINE" run --detach --rm --pull=never
	--runtime=runsc
	--read-only
	--cap-drop=ALL
	--security-opt=no-new-privileges
	"--pids-limit=$PIDS" "--memory=$MEMORY" "--memory-swap=$MEMORY" "--cpus=$CPUS"
	"--network=$NETWORK"
	--publish "127.0.0.1::6080"
	--tmpfs "/tmp:rw,nosuid,nodev,size=$TMPFS_SIZE"
	--tmpfs "/home/desktop:rw,nosuid,nodev,size=256m,uid=10001,gid=10001"
	--shm-size=256m
	--stop-timeout=10
	--user=10001
	--hostname=desktop
	"--name=$NAME"
	--label=zimpoen.computer-use=1
	"--label=zimpoen.task=$TASK_ID"
	"--label=zimpoen.approval=$APPROVAL_ID"
)

if [ "$DRY_RUN" -eq 1 ]; then
	printf 'would run:'
	printf ' %q' "${ARGV[@]}" --env-file "<0600 temp file>" "$IMAGE"
	printf '\n'
	exit 0
fi

if "$ENGINE" container inspect "$NAME" >/dev/null 2>&1; then
	die "a desktop for task $TASK_ID is already running ($NAME). Stop it first: $ENGINE stop $NAME"
fi

IFS= read -r TAKEOVER || true
IFS= read -r VIEW || true
[ "${#TAKEOVER}" -ge 12 ] || die "pass two one-time passwords (12+ characters) on stdin: takeover, then view."
[ "${#VIEW}" -ge 12 ] || die "pass two one-time passwords (12+ characters) on stdin: takeover, then view."
[ "$TAKEOVER" != "$VIEW" ] || die "the takeover and view passwords must differ."

ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
chmod 0600 "$ENV_FILE"
printf 'ZCU_VNC_TAKEOVER=%s\nZCU_VNC_VIEW=%s\n' "$TAKEOVER" "$VIEW" >"$ENV_FILE"

"${ARGV[@]}" --env-file "$ENV_FILE" "$IMAGE" >/dev/null
rm -f "$ENV_FILE"

# Wall-clock cap: stop it after MAX_SECONDS even if the server forgets.
(sleep "$MAX_SECONDS" && "$ENGINE" stop "$NAME" >/dev/null 2>&1) </dev/null >/dev/null 2>&1 &
disown

PORT="$("$ENGINE" port "$NAME" 6080/tcp | head -n 1 | sed 's/.*://')"
echo "container=$NAME viewer=127.0.0.1:$PORT"
