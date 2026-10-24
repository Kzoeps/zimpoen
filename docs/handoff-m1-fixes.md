# Handoff: M1 review fixes + browser verification

You are a fresh implementation worker. The coordinator is the technical lead; the user is asleep.
Repo `/home/kzoeps/Projects/personal/assistant`, branch `scaffold/pa-foundation`, all files untracked (no commits yet).

Read: `docs/PLAN.md`, `docs/handoff-m1.md`, `docs/handoff-m1-web.md`, then the review `/tmp/assistant-review-m1.md`
(copy it to `docs/review-m1.md` first so it lives in the repo). Durable source: `/home/kzoeps/Projects/personal/pi/packages/durable`.

## Coordinator adjudication (approved fixes)
Fix all of these, each with a behavior test where feasible (use the reviewer's repro scripts as test seeds):
- **C1** canonicalize (realpath) all policy roots at config load (data dir, workspace, secrets, allowlist); deny check on canonical paths.
- **C3** auth: validate `Host` against an allowlist (127.0.0.1:<port>, localhost:<port>, configured tailnet host
  `ASSISTANT_PUBLIC_HOST`); reject otherwise. Require `Sec-Fetch-Site` same-origin/none when present on mutating requests.
- **C4** `ASSISTANT_AUTH=off` is refused when `NODE_ENV=production` (startup error with actionable message). `pnpm dev` must not
  override a caller-provided value (use defaults only when unset).
- **C5** migration runner: reject async `up` (type it sync; runtime check thenable → throw before recording).
- **C6** web: one `requestId` per user message, reused across retries of that message; update the pinning test.
- **C7** separate data dirs by default: dev `./data-dev`, prod `./data` (or require explicit `ASSISTANT_DATA_DIR` in prod).
  Add `GET/PUT /api/settings/agents/:id` (model, thinkingLevel via `configure()`), validated against the models catalog,
  plus a minimal settings page/dialog in web. Agents created in faux mode must be fixable via this.
- **U1** acquire an exclusive lock on the data dir (lockfile with pid, O_EXCL, stale-pid detection) and bind the port
  BEFORE opening Durable/resuming. Clear error if locked.
- **U3** ensureAgents crash window: follow spec §2.2 (write agent id via `init`, find before create).
- **U4** stale SSE: send heartbeat as a named event (`event: ping`), client inactivity timer (e.g. 40s) → reconnect;
  reconnect on `visibilitychange`/`online`.
- **U5** persist the reason a submission got no answer so it survives reload (derive from submission records in the
  snapshot/history if Durable exposes them; else store in app.sqlite) and render it.
- **U6** surface parked tasks: log loudly + expose count in `GET /api/agents` health; no auto-retry.
- **U8** deny list case-insensitive; add `*.pem`, `*.key`, `.netrc`, `.npmrc`, `.aws/**`, `.git-credentials`, `.gnupg/**`, `id_*`.
- **U9** credential store: in-process mutex + cross-process lockfile on `modify`, temp-file cleanup on startup, fsync dir.
- **U12** document the CSRF rule; design note for M2 uploads (Host allowlist + Sec-Fetch-Site), no upload code now.
- **U13** add a SIGKILL child-process crash test of the counted-restart path.
- Nits C2, C8–C14: fix where < ~15 min each; README must match reality (C8).
- U2, U7, U10, U11: fix U7 (cheap) and U10 (body size limit before parse, cap concurrent SSE watches e.g. 8); U2 note in docs only.

## Then: browser verification gaps
Do `docs/handoff-m1-web.md` §2 item 2 (a)–(f) using the `agent-browser` CLI (see `/home/kzoeps/.agents/skills/agent-browser/SKILL.md`)
against local dev servers on 127.0.0.1. Save screenshots to `/tmp/assistant-shots/`. Fix what you find. Stop every dev server you start.
`apps/web/AGENTS.md`: set `agentRules: false` in next.config and delete the generated file (you created it).

## Constraints
Treat the coordinator's explicit handoff as the approved scope. Make routine implementation decisions within that scope
without pausing to reconfirm. If information is missing or a decision exceeds scope, ask the coordinator. No git commit/push
(the coordinator commits). No network calls to OpenAI/Google/TypeSafe, no logins. npm registry installs allowed.
Context hygiene: if you pass ~55% context, finish the current item, write `docs/handoff-m1-fixes-2.md` with remaining
items and state, reply DONE-HANDOFF and stop.

## Done when
All items above fixed or explicitly deferred with reason; `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green;
append a report to `docs/progress-m1.md` (each item: fixed/deferred, test name); reply DONE-FIXES.
