#!/usr/bin/env bash
# ops/check.sh — is the assistant set up and running as the checklist (docs/SETUP.md) says?
#
#   ops/check.sh                          check this machine
#   ops/check.sh --dry-run                list what would be checked; read and contact nothing
#   ops/check.sh --env-file /etc/assistant/assistant.env     take ASSISTANT_* settings from the unit's environment file
#   ops/check.sh --data-dir DIR --api-port N --web-port N    where things are, when not the defaults
#   ops/check.sh --only files             run only these groups, or leave some out with --skip (the later of the two wins)
#   ops/check.sh --skip lock,ports,api,web,tailscale,systemd,power
#   groups: files lock host ports api web tailscale systemd power
#
# One line per check: PASS, FAIL (something to fix: the line says what), WARN (worth knowing) or SKIP. Exits 1 if any check FAILed.
# It changes nothing on this machine and never prints a key or a token. It does print the public host name and the addresses of
# Google accounts that need connecting again. Its requests to the server (GET /api/agents, here and through Tailscale Serve) are
# ordinary reads; the server may take a usage reading for them.
set -u

DATA_DIR="${ASSISTANT_DATA_DIR:-}"
API_PORT="${ASSISTANT_PORT:-3001}"
WEB_PORT=3000
OWNER_LOGIN="${ASSISTANT_OWNER_LOGIN:-}"
PUBLIC_HOST="${ASSISTANT_PUBLIC_HOST:-}"
ENV_FILE=""
SKIP=","
DRY_RUN=0

GROUPS_ALL="files lock host ports api web tailscale systemd power"

usage() {
	sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

# The groups named on the command line must exist: a typo must not quietly skip nothing.
known_groups() {
	local group
	for group in $(printf '%s' "$1" | tr ',' ' '); do
		case " $GROUPS_ALL " in
			*" $group "*) ;;
			*)
				echo "Unknown group '$group'. The groups are: $GROUPS_ALL." >&2
				exit 2
				;;
		esac
	done
}

# --only: skip every group that is not listed.
only() {
	local group
	known_groups "$1"
	SKIP=","
	for group in $GROUPS_ALL; do
		case ",$1," in
			*",$group,"*) ;;
			*) SKIP="$SKIP$group," ;;
		esac
	done
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--env-file) ENV_FILE="${2:-}"; shift ;;
		--data-dir) DATA_DIR="${2:-}"; shift ;;
		--api-port) API_PORT="${2:-}"; shift ;;
		--web-port) WEB_PORT="${2:-}"; shift ;;
		--skip) known_groups "${2:-}"; SKIP=",${2:-},"; shift ;;
		--only) only "${2:-}"; shift ;;
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

FAILS=0
pass() { echo "PASS  $1"; }
warn() { echo "WARN  $1"; }
skip() { echo "SKIP  $1"; }
fail() {
	echo "FAIL  $1"
	FAILS=$((FAILS + 1))
}
skipped() { case "$SKIP" in *",$1,"*) return 0 ;; *) return 1 ;; esac }

# A setting from the environment file, without running the file as a shell script.
from_env_file() {
	[ -n "$ENV_FILE" ] && [ -r "$ENV_FILE" ] || return 0
	grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

if [ "$DRY_RUN" -eq 1 ]; then
	echo "Dry run: nothing is read or contacted. These would be checked:"
	echo "WOULD CHECK  files:     the data directory and <data>/secrets are private (0700); every secret file is 0600"
	echo "WOULD CHECK  files:     the OpenAI sign-in is saved (credentials.json), the push keys exist (vapid.json)"
	echo "WOULD CHECK  files:     Google accounts and whether any needs to be connected again; Jev key or rules mode; the invoice template"
	echo "WOULD CHECK  lock:      <data>/server.lock names a running process"
	echo "WOULD CHECK  host:      ASSISTANT_OWNER_LOGIN and ASSISTANT_PUBLIC_HOST are set"
	echo "WOULD CHECK  ports:     the API (${API_PORT}) and the web app (${WEB_PORT}) listen on 127.0.0.1 and nowhere else"
	echo "WOULD CHECK  api:       GET /api/agents answers with four agents, no parked task, no agent over its weekly limit"
	echo "WOULD CHECK  web:       the web app answers"
	echo "WOULD CHECK  tailscale: serve maps / to the web app and /api to the server, Funnel is off, and https://<your host>/api/agents answers"
	echo "WOULD CHECK  systemd:   assistant-server and assistant-web are active"
	echo "WOULD CHECK  power:     the machine cannot suspend (a suspended laptop reminds nobody)"
	exit 0
fi

# A settings file that cannot be read would leave every default in place and every check below misleading: say so, and stop.
if [ -n "$ENV_FILE" ] && [ ! -r "$ENV_FILE" ]; then
	fail "cannot read the environment file $ENV_FILE: it must be readable by the user who runs this check (docs/SETUP.md, step 4: the folder is root:<your group> 0750 and the file is yours, mode 0600)"
	echo
	echo "$FAILS check(s) FAILED."
	exit 1
fi

[ -n "$DATA_DIR" ] || DATA_DIR="$(from_env_file ASSISTANT_DATA_DIR)"
[ -n "$DATA_DIR" ] || DATA_DIR="./data"
[ -n "$OWNER_LOGIN" ] || OWNER_LOGIN="$(from_env_file ASSISTANT_OWNER_LOGIN)"
[ -n "$PUBLIC_HOST" ] || PUBLIC_HOST="$(from_env_file ASSISTANT_PUBLIC_HOST)"
SECRETS="$DATA_DIR/secrets"

# json_check FILE JS: run a JavaScript expression over the parsed file (`j`) with Node; prints its result, never the file.
json_check() {
	node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))}catch(e){process.stdout.write("unreadable")}' "$1" "$2" 2> /dev/null
}

mode_of() { stat -c '%a' "$1" 2> /dev/null; }

check_files() {
	if [ ! -d "$DATA_DIR" ]; then
		fail "the data directory $DATA_DIR does not exist. Start the server once (it creates it), or pass --data-dir / --env-file."
		return
	fi
	local mode
	mode="$(mode_of "$DATA_DIR")"
	if [ "$mode" = "700" ]; then pass "the data directory is private (mode 700)"; else fail "the data directory $DATA_DIR has mode $mode; it holds the databases: chmod 700 '$DATA_DIR'"; fi
	if [ ! -d "$SECRETS" ]; then
		fail "$SECRETS does not exist: no sign-in is saved yet (docs/SETUP.md, OpenAI)."
		return
	fi
	mode="$(mode_of "$SECRETS")"
	if [ "$mode" = "700" ]; then pass "the secrets folder is private (mode 700)"; else fail "the secrets folder has mode $mode: chmod 700 '$SECRETS'"; fi

	local file loose=0
	for file in credentials.json vapid.json google-accounts.json google-oauth.json jev.json; do
		[ -e "$SECRETS/$file" ] || continue
		mode="$(mode_of "$SECRETS/$file")"
		if [ "$mode" != "600" ]; then
			fail "secrets/$file has mode $mode: chmod 600 '$SECRETS/$file'"
			loose=1
		fi
	done
	[ "$loose" -eq 0 ] && pass "every secret file is mode 600"

	if [ ! -e "$SECRETS/credentials.json" ]; then
		fail "no OpenAI sign-in: run 'pnpm login:openai' (docs/SETUP.md)."
	else
		case "$(json_check "$SECRETS/credentials.json" 'j.openai && j.openai.type==="oauth" && !!j.openai.refresh ? "ok" : "missing"')" in
			ok) pass "the OpenAI sign-in is saved (credentials.json)" ;;
			unreadable) fail "credentials.json is not valid JSON: delete it and run 'pnpm login:openai'" ;;
			*) fail "credentials.json has no OpenAI sign-in: run 'pnpm login:openai'" ;;
		esac
	fi

	if [ -e "$SECRETS/vapid.json" ] && [ "$(json_check "$SECRETS/vapid.json" '!!j.publicKey && !!j.privateKey')" = "true" ]; then
		pass "the push keys exist (vapid.json; back it up: a new pair means every phone enables notifications again)"
	elif [ ! -e "$SECRETS/vapid.json" ] && [ ! -e "$DATA_DIR/server.lock" ]; then
		warn "no push keys yet (vapid.json): the server creates them at its first start"
	else
		fail "no push keys (vapid.json): the server creates them at its first start; if it ran, the file is damaged"
	fi

	if [ ! -e "$SECRETS/google-accounts.json" ]; then
		warn "no Google account is connected (pnpm connect:google, docs/setup-google.md): the Inbox agent has nothing to read"
	else
		local summary
		summary="$(json_check "$SECRETS/google-accounts.json" 'const a=Object.values(j.accounts||{});const bad=a.filter(x=>x&&x.status&&x.status!=="ok").map(x=>x.email);a.length+" connected"+(bad.length?"; NEEDS TO BE CONNECTED AGAIN: "+bad.join(", "):"")')"
		case "$summary" in
			unreadable) fail "google-accounts.json is not valid JSON" ;;
			*"NEEDS TO BE"*) fail "Google accounts: $summary (run 'pnpm connect:google --login-hint <address>')" ;;
			*) pass "Google accounts: $summary" ;;
		esac
	fi
	if [ ! -e "$SECRETS/google-oauth.json" ]; then warn "no Google OAuth client file (secrets/google-oauth.json): no account can be connected yet"; fi

	if [ -e "$SECRETS/jev.json" ] && [ "$(json_check "$SECRETS/jev.json" '!!j.JEV_API_KEY')" = "true" ]; then
		pass "Jev mode: a Jev key is saved (mail is classified by Jev, the rules answer when it cannot)"
	else
		warn "Rules mode: no Jev key (secrets/jev.json), mail is classified by local rules"
	fi
	for program in pdfinfo pdftotext pdftoppm soffice; do
		if ! command -v "$program" > /dev/null 2>&1; then
			warn "$program is not installed: PDFs or Office documents cannot be read (docs/SETUP.md, Documents and web search)"
		fi
	done
	if [ -e "$DATA_DIR/templates/invoice.html" ]; then pass "an invoice template is in place (templates/invoice.html)"; else warn "no invoice template yet: the server writes a default at its first start (docs/setup-invoice.md)"; fi
}

check_lock() {
	local lock="$DATA_DIR/server.lock" pid
	if [ ! -e "$lock" ]; then
		fail "no server.lock: the server is not running on $DATA_DIR (sudo systemctl status assistant-server)"
		return
	fi
	pid="$(json_check "$lock" 'j.pid')"
	if [ -n "$pid" ] && [ "$pid" != "unreadable" ] && kill -0 "$pid" 2> /dev/null; then
		pass "the server is running (process $pid holds server.lock)"
	else
		fail "server.lock names a process that is gone: the server crashed or was killed. It takes over a stale lock when it starts."
	fi
}

# What ops/assistant.env.example ships: the server accepts them, and the phone is then refused.
EXAMPLE_LOGIN="you@example.com"
EXAMPLE_HOST="my-laptop.tail1234.ts.net"

check_host() {
	if [ -z "$OWNER_LOGIN" ]; then
		fail "ASSISTANT_OWNER_LOGIN is not set (here or in --env-file): the server refuses to start without it"
	elif [ "$OWNER_LOGIN" = "$EXAMPLE_LOGIN" ]; then
		fail "ASSISTANT_OWNER_LOGIN is still the example value ($EXAMPLE_LOGIN): put your own Tailscale login there, or every request from your phone is refused (401)"
	else
		pass "ASSISTANT_OWNER_LOGIN is set"
	fi
	if [ -z "$PUBLIC_HOST" ]; then
		warn "ASSISTANT_PUBLIC_HOST is not set: the server refuses requests that arrive by the Tailscale name (ops/tailscale-serve.sh prints it)"
	elif [ "$PUBLIC_HOST" = "$EXAMPLE_HOST" ]; then
		fail "ASSISTANT_PUBLIC_HOST is still the example value ($EXAMPLE_HOST): ops/tailscale-serve.sh prints the name of this machine"
	else
		pass "ASSISTANT_PUBLIC_HOST is set ($PUBLIC_HOST)"
	fi
}

# listen_check PORT NAME: listening on 127.0.0.1 only.
listen_check() {
	local port="$1" name="$2" lines
	if ! command -v ss > /dev/null 2>&1; then
		skip "$name port: 'ss' is not installed"
		return
	fi
	lines="$(ss -H -ltn "sport = :$port" 2> /dev/null | awk '{print $4}')"
	if [ -z "$lines" ]; then
		fail "nothing listens on port $port ($name)"
	elif printf '%s\n' "$lines" | grep -vE '^(127\.0\.0\.1|\[::1\]):' > /dev/null; then
		fail "$name port $port listens on more than 127.0.0.1 ($(printf '%s' "$lines" | tr '\n' ' ')): it must be reachable only through Tailscale Serve"
	else
		pass "$name port $port listens on 127.0.0.1 only"
	fi
}

check_ports() {
	listen_check "$API_PORT" "API"
	listen_check "$WEB_PORT" "web"
}

check_api() {
	if ! command -v curl > /dev/null 2>&1; then
		skip "api: curl is not installed"
		return
	fi
	local body code args=(-sS -m 10 -o /dev/null -w '%{http_code}')
	[ -n "$OWNER_LOGIN" ] && args+=(-H "Tailscale-User-Login: $OWNER_LOGIN")
	code="$(curl "${args[@]}" "http://127.0.0.1:${API_PORT}/api/agents" 2> /dev/null)"
	case "$code" in
		200) ;;
		401) fail "the API refused the owner (401): ASSISTANT_OWNER_LOGIN here must equal the server's"; return ;;
		000 | "") fail "the API does not answer on 127.0.0.1:${API_PORT}"; return ;;
		*) fail "GET /api/agents answered HTTP $code (the server's log says why)"; return ;;
	esac
	args=(-sS -m 10)
	[ -n "$OWNER_LOGIN" ] && args+=(-H "Tailscale-User-Login: $OWNER_LOGIN")
	body="$(curl "${args[@]}" "http://127.0.0.1:${API_PORT}/api/agents" 2> /dev/null)"
	local report
	report="$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);const o=(j.budget&&j.budget.over||[]).map(x=>x.name).join(", ");process.stdout.write(j.agents.length+" "+((j.health||{}).parkedTasks||0)+" "+o)}catch{process.stdout.write("bad")}})')"
	local agents parked over
	agents="${report%% *}"
	parked="$(printf '%s' "$report" | cut -d' ' -f2)"
	over="$(printf '%s' "$report" | cut -d' ' -f3-)"
	if [ "$report" = "bad" ]; then fail "GET /api/agents did not answer with the expected JSON"; return; fi
	if [ "$agents" = "4" ]; then pass "the API answers with four agents"; else fail "the API lists $agents agents, not four"; fi
	if [ "$parked" = "0" ]; then pass "no task is parked after repeated crashes"; else fail "$parked task(s) are parked after repeated crashes: find out why the server died, then press Retry in the app"; fi
	if [ -n "$over" ]; then warn "over the weekly token limit: $over (background jobs post plain cards until the week turns; raise it under Usage)"; fi
}

check_web() {
	if ! command -v curl > /dev/null 2>&1; then
		skip "web: curl is not installed"
		return
	fi
	local code
	code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/" 2> /dev/null)"
	case "$code" in
		200 | 307 | 308) pass "the web app answers on 127.0.0.1:${WEB_PORT}" ;;
		*) fail "the web app does not answer properly on 127.0.0.1:${WEB_PORT} (HTTP ${code:-none}): sudo systemctl status assistant-web" ;;
	esac
}

# What `tailscale serve status --json` says about the two mappings and Funnel: "<what / goes to> <what /api goes to> <on|off>".
serve_summary() {
	node -e '
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
	try {
		const config = JSON.parse(s || "{}");
		const web = Object.values(config.Web || {});
		const proxy = (mount) => web.map((w) => ((w.Handlers || {})[mount] || {}).Proxy).find((p) => p !== undefined) || "nothing";
		const funnel = Object.values(config.AllowFunnel || {}).some((on) => on === true);
		process.stdout.write(proxy("/") + " " + proxy("/api") + " " + (funnel ? "on" : "off"));
	} catch {
		process.stdout.write("unreadable unreadable unreadable");
	}
});' 2> /dev/null
}

check_tailscale() {
	if ! command -v tailscale > /dev/null 2>&1; then
		skip "tailscale is not installed here"
		return
	fi
	local json web api funnel
	if ! json="$(tailscale serve status --json 2>&1)"; then
		fail "tailscale serve status failed: is Tailscale running and signed in? ($(printf '%s' "$json" | head -n 1))"
		return
	fi
	read -r web api funnel <<< "$(printf '%s' "$json" | serve_summary)"
	if [ "$web" = "http://127.0.0.1:${WEB_PORT}" ]; then
		pass "tailscale serve maps / to the web app ($web)"
	else
		fail "tailscale serve maps / to ${web:-nothing}, not http://127.0.0.1:${WEB_PORT}: run ops/tailscale-serve.sh"
	fi
	if [ "$api" = "http://127.0.0.1:${API_PORT}/api" ]; then
		pass "tailscale serve maps /api to the server ($api)"
	elif [ "$api" = "http://127.0.0.1:${API_PORT}" ]; then
		fail "tailscale serve maps /api to $api: Tailscale removes the /api prefix before it forwards, so the server would see /agents and answer 404 to every call of the app. The target must end in /api: run ops/tailscale-serve.sh (it sets it)"
	else
		fail "tailscale serve maps /api to ${api:-nothing}, not http://127.0.0.1:${API_PORT}/api: run ops/tailscale-serve.sh"
	fi
	if [ "$funnel" = "on" ]; then
		fail "Funnel is ON: the assistant is reachable from the public internet. Run ops/tailscale-serve.sh (every Serve run removes Funnel from its port), or 'tailscale funnel reset' and then ops/tailscale-serve.sh"
	else
		pass "Funnel is off"
	fi
	check_through_serve
}

# The page loads whatever /api does: ask for the list of agents the way the phone does, through Serve.
check_through_serve() {
	if [ -z "$PUBLIC_HOST" ] || [ "$PUBLIC_HOST" = "$EXAMPLE_HOST" ] || ! command -v curl > /dev/null 2>&1; then
		skip "https://<public host>/api/agents: ASSISTANT_PUBLIC_HOST is not set (or curl is missing)"
		return
	fi
	local answer rc code body
	answer="$(curl -sS -m 15 -w '\n%{http_code}' "https://${PUBLIC_HOST}/api/agents" 2> /dev/null)"
	rc=$?
	code="${answer##*$'\n'}"
	body="${answer%$'\n'*}"
	if [ "$rc" -ne 0 ]; then
		warn "could not reach https://${PUBLIC_HOST}/api/agents from this machine (curl exit $rc): open https://${PUBLIC_HOST}/ on your phone instead, or leave this out with --skip tailscale"
	elif [ "$code" = "200" ] && [ "$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).agents.length))}catch{process.stdout.write("bad")}})' 2> /dev/null)" = "4" ]; then
		pass "https://${PUBLIC_HOST}/api/agents answers with four agents: the /api mapping works end to end"
	else
		fail "https://${PUBLIC_HOST}/api/agents answered HTTP ${code} without the agents list: the page may load, but nothing the app asks of /api will work. 401: ASSISTANT_OWNER_LOGIN is not the Tailscale login of the person using this machine; 403: ASSISTANT_PUBLIC_HOST is not this machine's name; 404: the /api mapping (ops/tailscale-serve.sh)"
	fi
}

check_systemd() {
	if ! command -v systemctl > /dev/null 2>&1; then
		skip "systemd is not available here"
		return
	fi
	local unit
	for unit in assistant-server assistant-web; do
		if systemctl is-active --quiet "$unit" 2> /dev/null; then pass "$unit is active"; else warn "$unit is not an active systemd unit here (fine if you start it another way)"; fi
	done
}

check_power() {
	if ! command -v systemctl > /dev/null 2>&1; then
		skip "power: systemd is not available here"
		return
	fi
	if [ "$(systemctl is-enabled sleep.target 2> /dev/null)" = "masked" ]; then pass "the machine cannot suspend (sleep.target is masked)"; else warn "the machine can suspend: a suspended laptop fires no reminder (docs/OPS.md, keep the machine awake)"; fi
}

skipped files || check_files
skipped lock || check_lock
skipped host || check_host
skipped ports || check_ports
skipped api || check_api
skipped web || check_web
skipped tailscale || check_tailscale
skipped systemd || check_systemd
skipped power || check_power

echo
if [ "$FAILS" -eq 0 ]; then
	echo "All checks passed."
else
	echo "$FAILS check(s) FAILED."
	exit 1
fi
