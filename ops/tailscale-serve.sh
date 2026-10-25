#!/usr/bin/env bash
# ops/tailscale-serve.sh — publish the assistant on your tailnet over HTTPS, and keep Funnel (the public internet) off.
#
#   ops/tailscale-serve.sh              apply
#   ops/tailscale-serve.sh --dry-run    print the commands, change nothing
#
# `tailscale serve` replaces the mapping of a path, so running this again changes nothing. It maps
#   https://<machine>.<tailnet>.ts.net/      -> the web app   http://127.0.0.1:3000
#   https://<machine>.<tailnet>.ts.net/api   -> the server    http://127.0.0.1:3001/api   (the target ends in /api: see below)
# Needs `sudo tailscale set --operator="$USER"` once, or run as root. Written from Tailscale's source (cmd/tailscale/cli/serve_v2.go,
# ipn/ipnlocal/serve.go) and its --help, and not run on a real tailnet: docs/SETUP.md says what to check.
set -euo pipefail

WEB_PORT="${ASSISTANT_WEB_PORT:-3000}"
API_PORT="${ASSISTANT_PORT:-3001}"
HTTPS_PORT=443
DRY_RUN=0

usage() {
	sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
	case "$arg" in
		--dry-run) DRY_RUN=1 ;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "Unknown option '$arg'. Use --dry-run or --help." >&2
			exit 2
			;;
	esac
done

# run: print the command, and run it unless this is a dry run. A command that fails ends the script, with the usual reason.
run() {
	echo "+ $*"
	if [ "$DRY_RUN" -eq 0 ] && ! "$@"; then
		echo >&2
		echo "That command failed. If Tailscale said access is denied, allow your user to manage it once with" >&2
		echo "  sudo tailscale set --operator=\"\$USER\"" >&2
		echo "and run this script again. (HTTPS certificates must also be on: Tailscale admin console -> DNS.)" >&2
		exit 1
	fi
}

if ! command -v tailscale > /dev/null 2>&1; then
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "(tailscale is not installed on this machine; the commands below are what would run)"
	else
		echo "tailscale is not installed. Install it (https://tailscale.com/download), run 'sudo tailscale up', and try again." >&2
		exit 1
	fi
fi

# The machine's name on the tailnet and the login of the person using it, for the URL and for the settings file.
HOST="<machine>.<tailnet>.ts.net"
LOGIN="<your Tailscale login>"
if [ "$DRY_RUN" -eq 0 ]; then
	if ! STATUS="$(tailscale status --json 2> /dev/null)"; then
		echo "Tailscale is not running or not signed in. Run 'sudo tailscale up' and try again." >&2
		exit 1
	fi
	IDENTITY="$(printf '%s' "$STATUS" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);const self=j.Self||{};const user=(j.User||{})[self.UserID]||{};process.stdout.write((self.DNSName||"").replace(/\.$/,"")+"\n"+(user.LoginName||""))}catch{}})')"
	HOST="$(printf '%s\n' "$IDENTITY" | sed -n 1p)"
	if [ -z "$HOST" ]; then
		echo "Tailscale did not report this machine's name (is MagicDNS and HTTPS enabled? Admin console -> DNS)." >&2
		exit 1
	fi
	LOGIN="$(printf '%s\n' "$IDENTITY" | sed -n 2p)"
	[ -n "$LOGIN" ] || LOGIN="<your Tailscale login>"
fi

# The two mappings. `--bg` keeps them after this script ends (they live in Tailscale's own config, not in this process).
#
# `--set-path=/api` removes `/api` from the path before it forwards (tailscale/tailscale#6571): a request for /api/agents reaches
# the target as /agents. The server routes only /api/*, so the target carries the prefix itself and the server sees /api/agents again.
run tailscale serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:${WEB_PORT}"
run tailscale serve --bg --https="$HTTPS_PORT" --set-path=/api "http://127.0.0.1:${API_PORT}/api"

# Funnel is the public internet; the assistant must never be on it (PLAN rule 10). Nothing here turns it on, and every
# `tailscale serve` run removes it from the port it serves, so it is off for port 443 now. There is no command to add:
# `tailscale funnel --https=443 off` would delete the mappings above, not only Funnel.
if [ "$DRY_RUN" -eq 0 ]; then
	echo
	tailscale serve status
	echo
	# Verify rather than trust: read the configuration back. Both mappings are what this script sets, and Funnel is off.
	if ! verdict="$(tailscale serve status --json 2> /dev/null | node -e '
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
	let config = {};
	try { config = JSON.parse(s || "{}"); } catch { /* an unreadable answer is a failed check below */ }
	const web = Object.values(config.Web || {});
	const proxy = (mount) => web.map((w) => ((w.Handlers || {})[mount] || {}).Proxy).find((p) => p !== undefined);
	const funnel = Object.values(config.AllowFunnel || {}).some((on) => on === true);
	const problems = [];
	if (proxy("/") !== process.argv[1]) problems.push("/ goes to " + (proxy("/") || "nowhere") + ", not " + process.argv[1]);
	if (proxy("/api") !== process.argv[2]) problems.push("/api goes to " + (proxy("/api") || "nowhere") + ", not " + process.argv[2]);
	if (funnel) problems.push("Funnel is ON: the assistant is reachable from the public internet");
	process.stdout.write(problems.join("; "));
	process.exit(problems.length === 0 ? 0 : 1);
});' "http://127.0.0.1:${WEB_PORT}" "http://127.0.0.1:${API_PORT}/api")"; then
		echo "FAIL: Tailscale does not hold the configuration this script set (${verdict:-it could not be read}). Run 'tailscale serve status' to see it." >&2
		echo "If Funnel is on, 'tailscale funnel reset' clears every Serve and Funnel setting; run this script again afterwards." >&2
		exit 1
	fi
	echo "Checked: / and /api are mapped as intended, and Funnel is off."
else
	echo "(then it reads the configuration back: both mappings as above, and Funnel off)"
fi

echo
echo "The assistant is at:  https://${HOST}/"
echo
echo "Now make sure the server knows this name and who you are. In /etc/assistant/assistant.env:"
echo "  ASSISTANT_PUBLIC_HOST=${HOST}"
echo "  ASSISTANT_OWNER_LOGIN=${LOGIN}"
echo "and restart the server if it is already running (sudo systemctl restart assistant-server). Without them the server refuses every"
echo "request that arrives by that name, or from you."
echo "Check everything with: ops/check.sh --env-file /etc/assistant/assistant.env"
