# M1 review (independent, read-only)

Repo `/home/kzoeps/Projects/personal/assistant`, branch `scaffold/pa-foundation`, no commits. Reviewed 2026-10-25.
Scope read: every file outside `node_modules`, `.next`, `dist`, `data` (CSS skimmed), the installed Durable 1.4.0 `dist`
(what actually runs), Chord, Hono 4.13.13, `@hono/node-server` 2.1.5, Next 16.4.3 proxy, assistant-ui `ComposerInput`, and the
checkout's Durable README/spec for semantics.

**Verdict: no blockers.** Gates are green and the M1 acceptance claims hold as far as read-only checks can show.
6 confirmed should-fix items (C1, C3-C7) and 1 high-priority unverified risk (U1) are worth fixing before the first commit or M2.

Tags: **[repro]** reproduced with an in-memory script (Appendix) · **[read]** proven from code/dependency source · **[unverified]**.
Path shorthands: `D` = `node_modules/.pnpm/@earendil-works+pi-durable@1.4.0_…/node_modules/@earendil-works/pi-durable/dist`,
`C` = `…/@earendil-works+chord@1.4.0/…/chord/dist`, `H` = `…/hono@4.13.13/node_modules/hono/dist`,
`N` = `…/@hono+node-server@2.1.5_hono@4.13.13/…/@hono/node-server/dist`.

## 0. Gate results (run by me)

| Command | Result |
|---|---|
| `pnpm typecheck` | pass: 5 packages, 0 errors (1.8 s) |
| `pnpm lint` | pass: `Checked 82 files … No fixes applied` |
| `pnpm test` | pass, run 3×: 16 files / 176 tests, 6.8-7.0 s each, no flake. A `--reporter=verbose` run reproduces the worker's per-file counts (server 127, web 33, db 14, extensions 2) |
| `pnpm build` | **not run** (outside the permitted set). `apps/server/dist/main.js` (00:57:06) and `apps/web/.next/BUILD_ID` (00:57:08) are newer than every source file; the bundle imports only `node:*` and third-party packages (no `@assistant/*` left) |

Repo untouched: sha256 of all 545 files outside `node_modules`/`.git` before and after the gates is identical
(`/tmp/assistant-review-manifest-{before,after}.txt`, my scratch files); `git status` unchanged; no `data/`, no `.vitest/`.
Test temp dirs under `/tmp` were removed by the tests. Appendix scripts are in-memory only (no server, network or file writes).

## 1. Findings at a glance

| ID | Sev | Where | One line |
|---|---|---|---|
| C1 | should-fix | `config.ts:92-93,143-161`, `scoped-env.ts:27-33` | write root and secrets deny glob are not canonical: a symlinked data dir breaks all workspace access and disables the secrets glob [repro] |
| C2 | nit | `path-policy.ts:120` | deny globs compile without the `s` flag: a newline in an ancestor dir name bypasses them [repro] |
| C3 | should-fix | `http/auth.ts:17-40` | identity header trusted from any loopback client; no Host/Origin check (DNS rebinding, local process) [repro] |
| C4 | should-fix | `config.ts:227-229`, `main.ts:8-10`, `apps/server/package.json:8` | `ASSISTANT_AUTH=off` accepted in production with one warning; dev script overrides the caller's value [repro] |
| C5 | should-fix | `packages/db/src/migrate.ts:14,79` | async `up` is recorded as applied and half-runs outside the transaction [repro] |
| C6 | should-fix | `web/src/lib/thread-store.ts:86` | new `requestId` per send attempt: server dedupe never protects a user retry; a test pins the behaviour [read] |
| C7 | should-fix | `apps/server/package.json:8,10`, `agents.ts:100`, README:75 | dev and prod share `./data`; a faux-created agent is unusable in `openai` mode and M1 has no way to change the model [read] |
| C8 | nit | `wire.ts:38-44`, README:110 | browser gets `agent.instructions` and `usage`; README says the system prompt never leaves [read] |
| C9 | nit | `web/src/lib/api.ts:37-38` | `body?.error.code` throws TypeError for a JSON error body without `error` [repro] |
| C10 | nit | `stream.ts:44-45,64` | sync-throwing `write` kills the process via the heartbeat timer; fast disconnects log stack traces [repro/read] |
| C11 | nit | `config.ts:122,201,257` | `ASSISTANT_PORT=0x10` means 16; empty `ASSISTANT_READ_PATHS` means "defaults"; data dir mode only set on create [repro] |
| C12 | nit | `packages/db/src/app-db.ts:68-84` | savepoint counter leaks if `BEGIN` fails; failed `ROLLBACK` masks the original error [read] |
| C13 | nit | `.gitignore:11`, `apps/web/AGENTS.md`, README:73 | `data/` ignore pattern too broad, `.vitest/` not ignored, generated `AGENTS.md`, README omits that `ASSISTANT_API_ORIGIN` is baked at build |
| C14 | nit | `wire.ts:39-43` | snapshot deep-copies the whole active transcript, then slices to 200 [repro] |
| U1 | **high** | `server.ts:70-72` | Durable is opened and resumed before the port is bound; a second instance on the same data dir can steal running tasks |
| U2 | medium | `app-db.ts:118` vs `C/sqlite/node.js:160` | `synchronous=FULL` (app) vs `NORMAL` (Durable): after power loss `agents` can outlive the conversations they point to |
| U3 | low (known) | `agents.ts:130,177` | crash between the two DB writes orphans a conversation; Durable's `init` hook is the intended fix |
| U4 | medium | `stream.ts:64`, `thread-store.ts:45-63` | comment heartbeat is invisible to `EventSource`; no staleness timer or visibility/online reconnect |
| U5 | med-low | `thread-state.ts:72,111-113` | "why was my message not answered" is only shown live; lost on reload |
| U6 | low-med | `server.ts:153-155` | tasks parked by `restartLimit` are only logged; chat silently stops answering |
| U7 | low | `thread-view.tsx:69-75`, `agent-thread.tsx:24` | first render after an agent switch may show the previous agent's thread for a frame |
| U8 | low | `path-policy.ts:3,120` | deny list is case-sensitive and exactly the plan's three globs |
| U9 | low (known) | `credentials.ts:121-130` | no cross-process lock, stale `.tmp` after a crash, no dir fsync |
| U10 | low | `app.ts:72-82,90-107` | no body-size cap, no cap on SSE connections |
| U11 | note | n/a | assumptions I could not test offline (Tailscale header handling, Next proxy idle timeout) |
| U12 | design note | `validation.ts:18-21` | blanket "POST must be JSON" will collide with M2 multipart uploads |
| U13 | test gap | `e2e.test.ts:111-112` | hard-crash (SIGKILL) recovery is never exercised |

Suggested order: U1 (lock/bind first) → C3+C4 (auth hardening, one PR) → C1+C2 (policy canonicalisation, one PR) → C5 → C6 → C7.

## 2. Confirmed bugs

### C1 [should-fix] Policy roots are not canonical
`config.ts:92-93` sets `writePath = <dataDir>/workspace` (resolved, not realpath'd); `verifyReadPaths` (`config.ts:143-161`) realpaths only `readPaths`;
`scoped-env.ts:27-33` feeds `writePath` and `${paths.secrets}/**` to the policy verbatim, while `#guard` (`scoped-env.ts:214`) compares **real** paths.
- Evidence [repro R1]: `ASSISTANT_DATA_DIR=/var/run/demo` (`/var/run` → `/run`): real target `/run/demo/workspace/note.md` → `check(…, "write").allowed === false`;
  real `/run/demo/secrets/credentials.json` → `isDenied() === false`. Realistic trigger: `./data` symlinked to a second disk.
  `scoped-env.test.ts:25` wraps `mkdtemp` in `realpath`, which hides this.
- Impact: M2 file tools fail closed (workspace unreadable and unwritable). Secrets stay safe only through the overlap check in `dataDirOverlap`;
  the "always denied `<data>/secrets/**`" layer silently stops working.
- Fix: realpath `dataDir`, `paths.*` and `writePath` in `loadConfig` after `prepareDataDirectories`, and return them; add a symlinked-data-dir test.

### C2 [nit] `**` deny globs do not match across newlines
`path-policy.ts:120` `new RegExp(`^${source}$`)` has no `s` flag, so `.*` stops at `\n`. [repro R4]
`/r/k\nk/.ssh/id_rsa` and `/r/k\nk/.env` are **not** denied (ancestors are tested, but the regex cannot match a prefix containing a newline).
Needs a newline-named directory under a read root; low likelihood, one-flag fix. Fix: add the `s` flag; add a test next to `path-policy.test.ts:11-33`.

### C3 [should-fix] Owner header is trusted from any loopback client; no Host/Origin validation
`auth.ts:17-40` checks (peer is loopback) AND (header equals owner). Nothing distinguishes Tailscale Serve from any other local client, and `Host` is never checked.
- Evidence [repro R3]: peer `127.0.0.1` + `Tailscale-User-Login: <owner>` + `Host: evil.example:3001` passes auth (404 from the no-route handler, vs 401 without the header).
- Mechanism: a local process, or a page whose hostname was DNS-rebound to 127.0.0.1 (same-origin JS may set this header; it is not a forbidden header name), acts as the owner on every route including SSE and POST /messages.
  Whether browsers still allow the rebinding depends on Private/Local Network Access enforcement [unverified]; a Host allowlist removes the dependency.
  With `ASSISTANT_AUTH=off` the same holds for everyone (worker already notes this).
- Fix: before auth, reject any request whose `Host` is not in `{127.0.0.1:<port>, localhost:<port>, [::1]:<port>} ∪ ASSISTANT_ALLOWED_HOSTS` (the `*.ts.net` name), in both auth modes, with an actionable message;
  optionally reject `Sec-Fetch-Site: cross-site`. Test: wrong Host → 403.

### C4 [should-fix] `ASSISTANT_AUTH=off` can be enabled in production with a warning; `pnpm dev` overrides the caller
`config.ts:227-229` has no `NODE_ENV` check; `main.ts:8-10` only `console.warn`s; `apps/server/package.json:8` hard-sets `env ASSISTANT_AUTH=off`, discarding an exported `ASSISTANT_AUTH=on`.
- Evidence [repro R3, line 1]: `parseConfig({NODE_ENV:"production", ASSISTANT_AUTH:"off"})` → `{mode:"off"}`, no problem raised.
- Impact: a dev env file or unit copied to the laptop silently exposes the API to every tailnet device (including shared nodes) once Serve points at it.
- Fix: in production refuse `off` unless a second, explicit flag is set (`ASSISTANT_ALLOW_INSECURE_AUTH_OFF=1`), or refuse outright; dev script `ASSISTANT_AUTH="${ASSISTANT_AUTH:-off}"`. Add a config test.

### C5 [should-fix] Migration runner accepts async `up` and half-applies it
`migrate.ts:14` types `up: (db) => void` (a `() => Promise<void>` is assignable); `:79` discards its return value; `AppDb.transaction` only inspects its own callback's return.
- Evidence [repro R2]: `up: async d => { d.exec("CREATE TABLE a(x)"); await 0; d.exec("CREATE TABLE b(x)"); throw … }` → report `applied:["demo/001"]`, tables `a` and `b` exist
  (`b` created after COMMIT), id recorded, the throw surfaces as `unhandledRejection` (process exit by default).
- Fix: in `applyOne`, `const r = migration.up(db); if (isPromiseLike(r)) throw new TypeError(…must be synchronous…)` (`isPromiseLike` is private at `app-db.ts:130`: export it); test it.

### C6 [should-fix] A user retry sends a new `requestId`; dedupe is never used
`thread-store.ts:86` calls `newRequestId()` on every `send()`. `thread-store.test.ts:197-198` asserts the ids differ.
- Mechanism: POST reaches the server, the response is lost (phone sleeps, Tailscale hiccup) → `fetch` rejects → `onNew` throws `MessageNotSentError` → composer text restored → user resends → two `pi.user` entries and two model runs.
- Fix: remember `{text, requestId}` of the last failed send and reuse the id when the same text is resent; clear on success or edit. Invert the test.

### C7 [should-fix] Dev and prod share `./data`; M1 cannot change an agent's model
Both scripts `cd ../..` (`apps/server/package.json:8,10`), so `pnpm dev` and `pnpm start` use `<repo>/data`. In `faux` mode agents are created on `faux/faux-1` (`agents.ts:100-101`).
README:75-76 says to "change the agent's model", but no route or CLI exists in M1 (`PUT /api/settings/agents/:id` is later).
- Effect: run `pnpm dev` once, later `pnpm start` on the same dir → all four agents are on an unavailable model, every message ends `no_model`, recovery = delete `data/`. Only a log warning (`server.ts:160-164`).
- Fix (cheap): default dev data dir `./data/dev`, or refuse to start in `openai` mode when an agent still holds the faux model and print the reset command; correct the README sentence.

### C8 [nit] Browser receives `agent.instructions` and `usage`; README claims otherwise
`wire.ts:38-44` removes `pi.system` entries and signatures only. `SnapshotEvent.agent` and `agent_changed` carry `AgentState.instructions`, which Durable renders into the system prompt (`D/harness/types.d.ts` `AgentState`).
Evidence [read]: `apps/web/test/fixtures/chat-turns.json` snapshot has `agent.instructions` = the full persona text. README:110 ("never sees the system prompt") is wrong.
Fix: drop `agent.instructions`/`cwd` in the snapshot and `agent_changed` projections (UI does not use them) and test it, or correct the README.

### C9 [nit] `ApiRequestError` mapping throws TypeError
`api.ts:37-38` `body?.error.code` guards `body` but not `error`. [repro R5] A `502 {"message":"Bad gateway"}` becomes `TypeError: Cannot read properties of undefined (reading 'code')`, not `ApiRequestError`; callers fall back to generic text. Fix: `body?.error?.code`, `body?.error?.message`.

### C10 [nit] `stream.ts` error-path hazards
(a) `stream.ts:64` `Promise.resolve(write(…))` evaluates `write` first; a synchronous throw (allowed by the `void | Promise<void>` type) escapes the `setInterval` callback and exits the process. Production `write` is `async` (`app.ts:98`), so unreachable today. [read]
(b) `stream.ts:44-45` `watch.start()` throws `Watch is stopped` if the client left during the snapshot write (`D/session/observation.js:178-179`) [repro R6], and `watchEvents` rethrows `signal.reason` when already aborted (`D/harness/events.js:63-66`).
Both reach Hono's `run()` → `console.error(e)` (`H/helper/streaming/sse.js`), e.g. on every React StrictMode double mount in dev. Fix: check `signal.aborted` before `start`, catch the abort around `watchEvents`, return `"disconnected"`.

### C11 [nit] Config parsing quirks [repro]
`config.ts:257` `Number(value)` accepts `0x10` → 16 and `1e3` → 1000 (use `/^\d+$/`). `config.ts:201` an empty `ASSISTANT_READ_PATHS=` silently selects the defaults (Documents + Downloads): the wider set, the wrong direction for an allowlist.
`config.ts:122` mode 0700 applies only when the data dir is created; README:105 says "created 0700", but a pre-existing 0755 dir leaves `app.sqlite`/`durable.sqlite` (0644) readable to other local users. Fix: chmod/warn when group/world bits are set.

### C12 [nit] `AppDb.transaction` and the runner
`app-db.ts:68` increments `#savepointDepth` before `BEGIN` (`:69`), so a `BEGIN IMMEDIATE` that times out leaks the counter. `:81` a failing `ROLLBACK` (SQLite already rolled back, e.g. SQLITE_FULL) replaces the original error;
Chord's adapter wraps both in `AggregateError` (`C/sqlite/node.js` `transaction()`). `migrate()` does not verify that recorded ids are a prefix of the array, so "never reorder" is unenforced.

### C13 [nit] Housekeeping
`.gitignore:11` `data/` matches any directory named `data` at any depth (use `/data/`); `.vitest/` is not ignored (worker's own note). `apps/web/AGENTS.md` is generated by `next dev` (decide: delete + `agentRules:false`, or commit).
README:73 `ASSISTANT_API_ORIGIN` is baked into `apps/web/.next/routes-manifest.json` at `next build` (verified there: destination `http://127.0.0.1:3001/api/:path*`), so changing it or `ASSISTANT_PORT` needs a web rebuild. Say so.

### C14 [nit] Snapshot cost
`wire.ts:39-43` `toWireEntries` deep-copies every entry of the active transcript before `slice(-200)`. [repro] 4 ms @500, 18 ms @5k, 53 ms @20k entries, synchronous, per connect and per lag-snapshot. Slice first, strip after.

## 3. Unverified risks

**U1 [high] Two processes on one data dir; the port is bound last.** `server.ts:70` `harness.resume()`, `:72` `listen()`. A second `pnpm start`/`pnpm dev` against the same `data/` opens Durable and resumes before it finds `EADDRINUSE`.
Durable has no cross-process fence: `openNodeSqliteDatabase` sets only WAL + busy_timeout (`C/sqlite/node.js:159-162`); `Scheduler.open()` unconditionally rewrites every `running` task to `pending` and bumps `restarts` (`D/harness/scheduler.js:195-199`);
the spec reserves `readOnly` for "a viewer of a session another process drives" (spec §2.2). Plausible outcomes: duplicate model calls/answers, tasks parked after 5 "restarts". Not reproduced (needs two live servers).
Fix: take `<data>/server.lock` (`open(…, "wx")` + pid liveness check) before `openRuntime`, or bind/probe the port first. Add a test that a second `startServer` fails before touching `durable.sqlite`.

**U2 [medium] Durability mismatch between the two databases.** `app.sqlite` is `synchronous=FULL` (`app-db.ts:118`); Durable's is `NORMAL` (`C/sqlite/node.js:160`), where a WAL tail can roll back after power loss.
Result: `agents` rows pointing at conversations Durable lost → `agents.ts:190-195` refuses to start ("out of sync"). Worse in M2 (rows referencing Durable task ids). The laptop is mains-powered but not UPS-backed.
Fix options: `exec("PRAGMA synchronous = FULL")` on the adapter that `openNodeSqliteDatabase` returns before `SqliteStorage.open`, or make `ensureAgents` self-heal an empty missing conversation.

**U3 [low, known] `ensureAgents` crash window.** `agents.ts:130,177`. Durable spec §2.2 names the fix: "a host that must survive a crash between the two calls first finds its conversation again, for example through a key written by `init`". Write the agent id in `init`, look it up before creating.

**U4 [medium] Stale SSE on phones.** The heartbeat is an SSE comment (`stream.ts:64`), which `EventSource` never surfaces; `thread-store.ts:45-63` has no inactivity timer, and only `use-agents.ts:41` listens for `visibilitychange`.
A half-open connection (Wi-Fi ↔ cellular, Android doze) keeps showing "live" with no updates until TCP gives up. Fix: also send a data frame every 15 s; reconnect after ~35 s of silence or when the tab becomes visible/online.

**U5 [med-low] The reason a message got no answer is ephemeral.** Only the live `submission` event sets the notice (`thread-state.ts:111-113`); a snapshot resets it (`:72`). `no_model` leaves no assistant entry (fixture `no-model.json`), so after a reload the message sits unanswered with no explanation.
Fix: include recent unanswered submissions (or the agent's model availability) in the snapshot/agents list.

**U6 [low-med] Parked tasks are invisible.** After 5 hard kills (OOM, SIGKILL) a task is parked (`D/harness/scheduler.js:172-211`); a graceful close is not counted (spec `docs/spec.md:1059`); `reportDurable` only logs (`server.ts:153-155`). Nothing surfaces it or calls `harness.retryTask`.

**U7 [low] Stale frame on agent switch.** `ThreadView` is keyed (`agent-thread.tsx:24`) but its first render reads the store before `disconnect()/connect()` run in effects (`thread-view.tsx:69-75`), so it can paint the previous agent's messages once.
Guard: `thread?.conversationId === agent.conversationId ? thread : undefined`. Not seen in a browser by me or the worker.

**U8 [low] Deny list.** Case-sensitive (`.SSH`, `.ENV`, `Auth.json` pass [repro R4 variant]): fine on ext4, bypass on vfat/ntfs/casefold mounts. The list is exactly the plan's three globs; `~/Downloads` often holds `*.pem`, `*.key`, `.netrc`, `.npmrc`, `.aws/credentials`, `.git-credentials`. Add the `i` flag and consider more patterns.

**U9 [low, known] `FileCredentialStore`.** pi-ai's contract asks for mutual exclusion "cross-process too where the backing store supports it" (`pi-ai/dist/auth/types.d.ts`, `modify`); there is none. A crash between `open(temp)` and `rename` leaves `credentials.json.<pid>.<hex>.tmp` with a token copy (`credentials.ts:121-130`); no directory fsync. Resolve before the login CLI exists.

**U10 [low] Limits.** `c.req.json()` buffers the whole body before the 20 000-char check; every SSE request opens a Durable watch with no cap. Owner-only today.

**U11 [note] Assumptions not testable offline.** (a) Tailscale Serve strips/overwrites client-sent `Tailscale-User-*` headers. (b) Next's rewrite proxy applies a 30 s idle `proxyTimeout` (`next/dist/server/lib/router-utils/proxy-request.js`): safe only because the heartbeat is 15 s.
(c) Disconnect propagation through Next was verified by reading (`res.on('close', () => proxyReq.destroy())`); node-server aborts `c.req.raw.signal` on socket close (`N/index.mjs:844-851`, registered at `:1029`).

**U12 [design note, M2] CSRF rule vs uploads.** `validation.ts:18-21` makes "POST must be `application/json`" the only CSRF defence; `POST /api/uploads` (multipart, PLAN §5.5) will need an explicit exemption and a replacement (Host allowlist from C3 + `Sec-Fetch-Site`). Decide now.

**U13 [test gap] Hard-crash recovery.** The restart tests call `server.close()` (`e2e.test.ts:111-112`), which Durable treats as "not a restart". A SIGKILLed child process exercises the counted-restart path and `restartLimit`.

## 4. Tests

Mostly behaviour-level: real HTTP + SSE sockets (`e2e.test.ts`), real Harness restart, reducers replayed against streams recorded from the real server, the file policy against a real temp tree with symlinks, credential store against a real file. Few mocks.

Coupled to implementation or misleading:
- `thread-store.test.ts:197-198` pins "fresh requestId per send" (C6).
- `stream.test.ts:150` covers "write fails → disconnected", a path production cannot take: Hono's `StreamingApi.write` swallows write errors (`H/utils/stream.js`, `write()` has `catch {}`). The real disconnect path (`c.req.raw.signal` from node-server) has **no** end-to-end test: nothing opens an SSE socket, drops it, and asserts the watch is released.
- `scoped-env.test.ts:25` `realpath(mkdtemp(…))` hides C1. `profile.test.ts:22` calls `render({} as never, {} as never)` (couples to the section signature).

Missing coverage of real risks:
1. Bind address is `127.0.0.1` (rule 10); `serve({hostname})` → `listen(port, hostname)` is verified by reading only (`N/index.mjs:1327`).
2. Auth: forged header / wrong Host (C3); `AUTH=off` in production (C4).
3. Policy: symlinked data dir (C1), newline and case (C2, U8), `~` and `file://` inputs (handled by `NodeExecutionEnv.resolvePath`, untested).
4. Migrations: async `up` (C5), two connections starting at once (the in-transaction re-check is claimed but untested), order drift.
5. Client: requestId reuse (C6), stale connection (U4), send while reconnecting (message appears only after reconnect), agent switch. No component tests: `thread-view.tsx` (228 lines) and `describeStatus` for `reason: "other"` are untested, as the worker notes.
6. Durable: SIGKILL recovery (U13), `restartLimit` parking (U6), second process (U1), crash between the two DB writes (U3).
7. API: `whenBusy` default `followUp` queueing over HTTP; `steer`; same `requestId` with different content (returns the original, undocumented); history page whose raw entries are all hidden (server returns `nextBefore` with `entries: []`).

Timing: the two restart tests need the answer to outlast first-partial → close (~3.8 s margin, documented by the worker); acceptable. No flake in 3 runs.

## 5. Scope and handoff conformance

All 11 in-scope items of `handoff-m1.md` are present; nothing out of scope was built (no tasks, push, approvals, file tools, PWA, systemd, login flow, backups). Worker claims checked: gates and test counts reproduce; PLAN.md edits are the two stated (§5.1 `ownership`, §7 INTEGER ids); no credentials or tokens in the tree; lockfile pins Durable, pi-ai and Chord to exactly 1.4.0 with no git/tarball resolutions.
Additions beyond the handoff, all documented: JSON-only POST rule (U12), `ensureAgents` re-applies `instructions`/`extensions` to existing conversations (tested, never touches model/thinking), `AgentSummary` without `unread`, `apps/web/AGENTS.md` (generated, unrequested), `docs/handoff-m1-web.md`.
Decisions for the coordinator: C4 (reject vs second flag), `AGENTS.md`, and whether the U1 lock lands in M1 or M2.

## 6. Checked, no finding

- `stream.ts` is the only `watchEvents` user (`rg`); no `child_process`/shell outside tests; `exec` always fails; the registry holds only `profile`, every agent selects `["profile"]` explicitly.
- Watch cleanup: `finally` → `stop()`; an aborted signal cancels the watch (`observeCancellation`); `Harness.close` ends watches with `session_closed`; shutdown force-exits after 15 s.
- `ensureAgents` passes model and thinking only at creation; reconcile `configure()`s `extensions`/`instructions` only (`agents.test.ts:84-103`).
- requestId dedupe holds across restart (`e2e.test.ts:116-122`); default `whenBusy` is `followUp` (spec §2.2), matching `SendMessageRequest`.
- History paging matches `EntryQuery` (descending, inclusive `maxEntryId`, `before - 1`, `nextBefore` = oldest raw id); hidden-only pages are handled by following the cursor (`thread-state.ts:132-145`).
- Auth runs before the JSON check; Hono matches the decoded path for middleware and routes, so percent-encoding cannot skip auth; error bodies never include internals (`errors.ts`).
- `resolveReal` is fail-closed for NUL bytes, `..`, `/proc/self/root`, dangling links; `~` and `file://` are normalised before the guard.
- `credentials.json` is 0600 from creation, replaced atomically with fsync; `secrets/` is chmod 0700 on every start; corrupt files are errors, never "empty".
- Reducer: `applyEvent` is pure, deduplicates entries by id, replaces state from every snapshot, orders by id (head marker case tested), and handles all four recorded flows. EventSource: no events after `close()`, timers cleared on switch/disconnect, backoff 1/2/4/8 s resets on open.

## Appendix: repro scripts (run from the repo root; in-memory, nothing written)

```bash
# R1 (C1) symlinked data dir. /var/run -> /run on Ubuntu. Parse + realpath/lstat only.
node --input-type=module - <<'EOF'
import { parseConfig } from "./apps/server/src/config.ts";
import { createPathPolicy, resolveReal } from "./apps/server/src/env/scoped-env.ts";
const config = parseConfig({ ASSISTANT_DATA_DIR: "/var/run/demo", ASSISTANT_AUTH: "off" }, { cwd: "/", homeDir: "/h" });
const policy = createPathPolicy(config);
const real = await resolveReal(`${config.writePath}/note.md`);
console.log(real.value, "write allowed:", policy.check(real.value, "write").allowed);          // false
const creds = await resolveReal(config.paths.credentials);
console.log(creds.value, "deny glob matches:", policy.isDenied(creds.value));                    // false
EOF

# R2 (C5) async migration
node --input-type=module - <<'EOF'
import { openAppDb, migrate } from "./packages/db/src/index.ts";
const db = openAppDb(":memory:");
process.on("unhandledRejection", (e) => console.log("unhandledRejection:", e.message));
console.log(JSON.stringify(migrate(db, [{ id: "demo/001", up: async (d) => { d.exec("CREATE TABLE a(x)"); await 0; d.exec("CREATE TABLE b(x)"); throw new Error("boom"); } }])));
await new Promise((r) => setTimeout(r, 10));
console.log(db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name).join(","), "| recorded:", db.all("SELECT id FROM _migrations").map((r) => r.id).join(","));
EOF
# -> {"applied":["demo/001"],"skipped":[]}  unhandledRejection: boom  _migrations,a,b | recorded: demo/001

# R3 (C3, C4) production + auth off; forged header with a hostile Host
node --input-type=module - <<'EOF'
import { parseConfig } from "./apps/server/src/config.ts";
import { createApp } from "./apps/server/src/http/app.ts";
console.log(JSON.stringify(parseConfig({ NODE_ENV: "production", ASSISTANT_AUTH: "off" }, { cwd: "/", homeDir: "/h" }).auth)); // {"mode":"off"}
const app = createApp({ harness: {}, db: {}, auth: { mode: "on", ownerLogin: "me@example.com" }, logger: { error() {} } });
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
for (const headers of [{}, { "Tailscale-User-Login": "me@example.com" }]) {
  const res = await app.request("http://evil.example:3001/api/nope", { headers }, peer);
  console.log(JSON.stringify(headers), "->", res.status, (await res.json()).error.code);                                          // 401, then 404 (auth passed)
}
EOF

# R4 (C2, U8) newline in an ancestor name; case variants
node --input-type=module - <<'EOF'
import { PathPolicy, DEFAULT_DENY_GLOBS } from "./apps/server/src/env/path-policy.ts";
const p = new PathPolicy({ readRoots: ["/r"], writeRoot: "/w", denyGlobs: DEFAULT_DENY_GLOBS });
for (const x of ["/r/k/.ssh/id_rsa", "/r/k\nk/.ssh/id_rsa", "/r/k\nk/.env", "/r/.SSH/id_rsa", "/r/.ENV"]) console.log(JSON.stringify(x), p.isDenied(x)); // true false false false false
EOF

# R5 (C9) error mapping
node --input-type=module - <<'EOF'
import { ApiRequestError, fetchAgents } from "./apps/web/src/lib/api.ts";
globalThis.fetch = async () => new Response('{"message":"Bad gateway"}', { status: 502 });
await fetchAgents().catch((e) => console.log(e.constructor.name, "|", e.message, "| ApiRequestError:", e instanceof ApiRequestError)); // TypeError … false
EOF

# R6 (C10b) watch.start() after the watch was cancelled
node --input-type=module - <<'EOF'
import { createRequire } from "node:module";
const durable = createRequire(import.meta.url).resolve("@earendil-works/pi-durable", { paths: ["./apps/server"] });
const { CommittedWatch } = await import(new URL("./session/observation.js", `file://${durable}`));
const watch = new CommittedWatch([], () => {}, () => {});
const ac = new AbortController(); watch.observeCancellation(ac.signal); ac.abort();
console.log(JSON.stringify(await watch.closed));                                      // {"reason":"cancelled"}
try { watch.start(async () => {}); } catch (e) { console.log("start():", e.message); } // Watch is stopped
EOF
```

C11 and C14 repros: `parseConfig({ASSISTANT_AUTH:"off", ASSISTANT_PORT:"0x10"}, ctx).http.port` → 16; `ASSISTANT_READ_PATHS: ""` → `["<home>/Documents","<home>/Downloads","<cwd>/data/files"]`;
`toStreamSnapshot` on synthetic transcripts of 500 / 5 000 / 20 000 entries → 4 / 18 / 53 ms.
