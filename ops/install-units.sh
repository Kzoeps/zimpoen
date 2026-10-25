#!/usr/bin/env bash
# ops/install-units.sh — install the two systemd units with the lines marked CHANGE filled in, and start them.
#
#   ops/install-units.sh --dry-run     print the units as they will be installed and the commands; change nothing
#   ops/install-units.sh               install into /etc/systemd/system (asks for sudo), make the data folder, enable and start both
#   ops/install-units.sh --out DIR     only write the two filled-in units into DIR (no sudo, no systemctl)
#
# Filled in from this checkout and the machine, each overridable: --user (default: you), --repo (default: the checkout this script is
# in), --node (default: `command -v node`: the Node 24 that built it) and --data-dir (default: ASSISTANT_DATA_DIR from the settings
# file --env-file, default /etc/assistant/assistant.env, else <repo>/data; it must be the folder the server uses).
# The units in ops/systemd/ stay as they are, so `git pull` never conflicts with an edit of yours.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
USER_NAME="$(id -un)"
NODE_BIN="$(command -v node || true)"
ENV_FILE="/etc/assistant/assistant.env"
DATA_DIR=""
UNIT_DIR="/etc/systemd/system"
OUT=""
DRY_RUN=0

usage() {
	sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--out) OUT="${2:-}"; shift ;;
		--user) USER_NAME="${2:-}"; shift ;;
		--repo) REPO="${2:-}"; shift ;;
		--node) NODE_BIN="${2:-}"; shift ;;
		--data-dir) DATA_DIR="${2:-}"; shift ;;
		--env-file) ENV_FILE="${2:-}"; shift ;;
		-h | --help)
			usage
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
	echo "$1" >&2
	exit 1
}

[ -n "$NODE_BIN" ] || die "Node was not found on the PATH. Install Node 24 (docs/SETUP.md, step 2) or pass --node /absolute/path/to/node."
case "$NODE_BIN" in /*) ;; *) die "--node must be an absolute path, got '$NODE_BIN'." ;; esac
[ -f "$REPO/apps/server/dist/main.js" ] || [ "$DRY_RUN" -eq 1 ] || [ -n "$OUT" ] || die "$REPO/apps/server/dist/main.js does not exist: run 'pnpm build' in $REPO first (docs/SETUP.md, step 3)."

# The data folder the server will use: the one the settings file names, as an absolute path (a relative one is relative to the repository).
if [ -z "$DATA_DIR" ] && [ -r "$ENV_FILE" ]; then
	DATA_DIR="$(grep -E '^ASSISTANT_DATA_DIR=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" || true)"
fi
[ -n "$DATA_DIR" ] || DATA_DIR="${ASSISTANT_DATA_DIR:-$REPO/data}"
case "$DATA_DIR" in /*) ;; *) DATA_DIR="$REPO/$DATA_DIR" ;; esac

# render UNIT_FILE WORKING_DIRECTORY WRITABLE_PATH: the unit with its CHANGE lines filled in, everything else as it is.
render() {
	local line
	while IFS= read -r line; do
		case "$line" in
			User=CHANGE_ME) echo "User=$USER_NAME" ;;
			WorkingDirectory=*) echo "WorkingDirectory=$2" ;;
			ReadWritePaths=*) echo "ReadWritePaths=$3" ;;
			"ExecStart=/usr/bin/node "*) echo "ExecStart=$NODE_BIN ${line#ExecStart=/usr/bin/node }" ;;
			*) printf '%s\n' "$line" ;;
		esac
	done < "$1"
}

SERVER_UNIT="$HERE/systemd/assistant-server.service"
WEB_UNIT="$HERE/systemd/assistant-web.service"
render_server() { render "$SERVER_UNIT" "$REPO" "$DATA_DIR"; }
render_web() { render "$WEB_UNIT" "$REPO/apps/web" "$REPO/apps/web/.next"; }

if [ -n "$OUT" ]; then
	mkdir -p "$OUT"
	render_server > "$OUT/assistant-server.service"
	render_web > "$OUT/assistant-web.service"
	echo "Wrote $OUT/assistant-server.service and $OUT/assistant-web.service."
	exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
	echo "Dry run: nothing is changed. User=$USER_NAME, repository $REPO, Node $NODE_BIN, data folder $DATA_DIR."
	echo
	echo "--- $UNIT_DIR/assistant-server.service"
	render_server
	echo
	echo "--- $UNIT_DIR/assistant-web.service"
	render_web
	echo
	echo "Commands that would run:"
	echo "+ sudo install -d -m 0700 -o $USER_NAME $DATA_DIR"
	echo "+ sudo install -m 0644 <the two units above> $UNIT_DIR/"
	echo "+ sudo systemctl daemon-reload"
	echo "+ sudo systemctl enable --now assistant-server assistant-web"
	exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
render_server > "$TMP/assistant-server.service"
render_web > "$TMP/assistant-web.service"

# The folder is made here because ReadWritePaths= needs it to exist: systemd would stop the server's start without it. 0700, the service user's.
sudo install -d -m 0700 -o "$USER_NAME" "$DATA_DIR"
sudo install -m 0644 "$TMP/assistant-server.service" "$TMP/assistant-web.service" "$UNIT_DIR/"
sudo systemctl daemon-reload
sudo systemctl enable --now assistant-server assistant-web
echo "Installed and started. Look at them with: systemctl status assistant-server assistant-web"
echo "Logs: journalctl -u assistant-server -n 40 --no-pager"
