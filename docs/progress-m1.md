# M1 progress log (worker → coordinator)

## Milestone A — workspace skeleton, packages/db, config validation (done)
- pnpm workspace (`apps/server`, `apps/web` pending, `packages/{shared,db,extensions}`); root scripts, Biome, Vitest, TS 7.0.2 strict/ESM; Durable/pi-ai/chord pinned `1.4.0`.
- `packages/db`: `node:sqlite` wrapper (WAL, FK on, nestable transactions), ordered idempotent migration runner (`_migrations`, one transaction per migration), core `agents` table + helpers. 13 tests.
- `apps/server/src/config.ts`: env parsing + fs verification, aggregated actionable errors, data dirs created (`secrets` 0700). 22 tests.
- `pnpm test` 35/35, `tsc --noEmit` clean for db/server, `biome check` clean.
- Next: harness runtime (faux + openai wiring, file credential store), agents, scoped env, stream + HTTP API, then web.

## Milestone B — server runtime, API, streaming, restart (done)
- Harness on `durable.sqlite`, faux dev model (infinite scripted echo, streams with thinking block) and `openai` wiring with a file-backed 0600 `CredentialStore` (no login, no network); `ensureAgents` (idempotent, re-applies code-owned extensions/instructions, never overwrites model/thinking); scoped file env (allowlist read, workspace write, deny globs, no shell).
- Hono API: agents, history paging, messages (requestId dedupe), abort, SSE via `stream.ts` (only `watchEvents` user; drops `pi.system` + opaque signatures, 15 s heartbeat, stops on disconnect); Tailscale-login auth middleware; esbuild bundle `apps/server/dist/main.js`.
- Restart mid-run verified with the real process (SIGTERM) and in tests: partial kept as `aborted` assistant entry, run regenerates, user message not duplicated, submission settles `done`.
- 142 tests green (`pnpm exec vitest run`), `tsc --noEmit` and `biome check` clean.
- Next: web app (Next + assistant-ui external store), then README and final verification.

## Milestone C — web chat, README, final verification (done)
- Next 16 App Router + `@assistant-ui/react` `useExternalStoreRuntime` (no Vercel AI SDK); zustand store fed by `EventSource`; pure `applyEvent` reducer → `toUiMessages` → `convertMessage`; sidebar with busy dots, one thread per agent, composer with send/stop, "Load earlier", reconnect banner, phone layout.
- Verified in headless Chromium against the real `pnpm dev`: streaming, stop, switching agents, server restart mid-answer (banner, then interrupted partial + complete answer), 390 px layout, loading 110-turn history through "Load earlier".
- Web tests replay four event streams recorded from the real server (`apps/server/scripts/record-fixtures.ts`) plus a fake-`EventSource` test of the store's reconnect and send logic.
- Gates (repo and a fresh copy with `pnpm install --frozen-lockfile`): `pnpm typecheck`, `pnpm lint`, `pnpm test` (16 files, 176 tests), `pnpm build` all pass.
- Next: final report below.

---

# FINAL REPORT — Milestone 1

Branch `scaffold/pa-foundation`. Nothing committed or pushed. No OpenAI/Google/TypeSafe call, no login, no `railway`, nothing
written outside this repository (screenshots and scratch data went to `/tmp` and were removed).

## 1. Changed files and directories

All new except two small edits to `docs/PLAN.md` (see 2.1). Top level: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
`.npmrc` (exact pins, engine-strict), `.gitignore`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `README.md`.

```text
packages/db/           src/{app-db,migrate,core,index}.ts            tests: app-db, migrate, core
packages/shared/       src/{agents,api,stream,index}.ts               API DTOs, error shape, stream event types
packages/extensions/   src/{profile,index}.ts                         tests: profile
apps/server/
  src/main.ts server.ts runtime.ts config.ts agents.ts credentials.ts dev-model.ts stream.ts wire.ts paths.ts
  src/env/{path-policy,scoped-env}.ts       src/http/{app,auth,errors,validation}.ts
  scripts/{build.mjs,record-fixtures.ts}    test/*.test.ts + support.ts
apps/web/              next.config.ts, src/app/**, src/components/**, src/lib/**, test/**, test/fixtures/*.json
docs/                  progress-m1.md (this file), PLAN.md (2 edits)
```

`apps/web/AGENTS.md` and `next-env.d.ts` are written by `next dev` (the first is Next 16's note for AI agents; I left it, the
second is git-ignored).

## 2. Decisions and deviations from PLAN

### 2.1 Durable / pi-ai facts that differ from PLAN or from the repo's docs (code follows the installed 1.4.0 types)
- `createConversation` requires `ownership`: `createConversation({ ownership: { kind: "ownerless" }, agent }, ctx)`. **PLAN §5.1 edited.**
- Durable ids are integers: `agents.conversation_id` is `INTEGER NOT NULL UNIQUE`. **PLAN §7 edited.** (First agent conversation is id 2; 1 is the reserved root.)
- The published `@earendil-works/pi-durable@1.4.0` is behind the checkout in `~/Projects/personal/pi`: `WatchEnd.reason` is
  `session_closed` / `session_failed` there, whereas the README and source at HEAD say `ended` / `failed`. `harness.closed` uses
  `closed` / `failed` in both. `stream.ts` has a comment; if you upgrade, the compiler will flag it.
- `resume()` is required after open (open recovers state but runs nothing). `ensureAgents` runs before `resume()`, as the spec asks.
- **Restart semantics, observed (real process + tests):** the answer being written when the process stops stays in the transcript as a
  `pi.assistant` entry with `stopReason: "aborted"` holding the partial text; after `resume()` the generation requests the model
  again from the same user message and appends a complete answer; the submission settles `done`; the `pi.user` entry exists once;
  re-POSTing the same `requestId` returns the same submission id. `close()` mid-stream took ~40 ms with the faux model.
- faux provider consumes one scripted response per request, so the dev echo re-queues itself (plus 8 spare).

### 2.2 Design choices
- **Workspace packages ship TypeScript source** (`exports: ./src/index.ts`); Node 24 runs it directly in dev, Next uses `transpilePackages`
  for `shared`, and `pnpm build` bundles the server with esbuild (workspace code inlined, npm deps external). Chosen over per-package `tsc`
  + `dist` + export conditions, which would make `next dev` depend on a prior build.
- **Tooling** (latest on npm, all verified working together): TypeScript 7.0.2 (native; Next 16.4 type-checks through the `tsc` CLI by default),
  Next 16.4.3, React 19.3.1, @assistant-ui/react 0.15.31, Vitest 5.0.5, Biome 2.6.3 (markdown excluded), Hono 4.13.13, `@hono/node-server` 2.1.5.
  Durable, pi-ai and chord are pinned to exactly `1.4.0`; `.npmrc` sets `save-exact`.
- **Wire protocol:** every SSE frame is `event: events`, `data: <JSON array of events>`; the first event of a connection is a `snapshot`
  (newest 200 entries, `hasEarlier` flag), later frames are Durable's agent events of one commit each. `stream.ts` is the only `watchEvents`
  user. `wire.ts` removes `pi.system` entries and opaque provider signatures (`thinkingSignature`, `textSignature`, `thoughtSignature`) before
  anything reaches the browser. Types are Durable's own, re-exported (type-only) from `@assistant/shared`.
- **`AgentSummary` has no `unread`** (PLAN §5.5 lists it): it needs a read marker, which nothing in M1 writes. Add with M2's notifications.
- **`ensureAgents` also re-applies code-owned `extensions` and `instructions` to existing conversations** (never model / thinking level, which
  are user settings). Without it, giving `pa` a tools extension in M2 would never reach the conversation created in M1. It also warns when an
  agent's stored model cannot be served in the current mode (dev data dir used with `openai`, or the reverse), instead of failing later with `no_model`.
- **Dev model is `faux/faux-1`** in `faux` mode; the agents' `openai/gpt-6.1-sol` default only applies in `openai` mode.
- **Scoped file environment** (rule 4): `ExecutionEnv` wrapper over `NodeExecutionEnv`. Read = read paths + workspace (an agent must read
  back what it wrote for `edit`); write = workspace only; deny globs match a path or any ancestor, are checked on the path as given and after
  symlink resolution; dangling symlinks refused; denied names hidden from listings; `exec` always fails (`shell_unavailable`); temp files,
  `watch` and `listFiles` unavailable. **Startup rejects a read path that contains the data dir, or sits inside it outside `files/`/`workspace/`.**
- **Auth:** default `on`; `pnpm dev` sets `ASSISTANT_AUTH=off` explicitly. On: loopback peer and `Tailscale-User-Login` equal to
  `ASSISTANT_OWNER_LOGIN` (case-insensitive), else 401 with a message that says why.
- **CSRF (not in PLAN):** every POST must send `Content-Type: application/json` (415 otherwise). Tailscale identifies the owner by device, so
  without this any website could post to the API from the owner's browser.
- **Env names I picked:** `ASSISTANT_DATA_DIR`, `ASSISTANT_READ_PATHS` (`:`-separated), `ASSISTANT_AUTH`, `ASSISTANT_OWNER_LOGIN`,
  `ASSISTANT_MODEL_MODE`, `ASSISTANT_TIMEZONE`, `ASSISTANT_CURRENCY`, `ASSISTANT_OWNER_NAME`, `ASSISTANT_PORT`, `ASSISTANT_API_ORIGIN` (web).
  Server scripts `cd` to the repo root, so the default `./data` is `<repo>/data` and a Node-style `.env` is not auto-loaded (export variables or use a systemd unit).
- **Credential store:** one JSON file (pi `auth.json` shape), 0600, atomic replace, per-provider serialized `modify`; a corrupt file is an error,
  never "empty", so tokens are not overwritten. No cross-process lock: the future login command must run while the server is stopped or share the lock.
- **Web:** busy dots by polling `GET /api/agents` every 4 s (paused when hidden, refreshed when the open thread starts/stops a run). The composer is
  disabled while a run is in progress (Stop instead of Send), so M1 never queues follow-ups. A cut-short answer followed by another answer
  is labelled "Interrupted by a restart"; a lone aborted answer is "Stopped".

## 3. Commands run and results

| Command | Result |
|---|---|
| `pnpm install` / `pnpm install --frozen-lockfile` (fresh copy) | ok (pnpm notes ignored build scripts of esbuild, protobufjs, @google/genai; none needed) |
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm lint` | `Checked 82 files … No fixes applied` |
| `pnpm test` | **16 files, 176 tests passed** (~7 s); re-run 3×, and twice concurrently under load: stable |
| `pnpm build` | server bundle 55.9 kB; `next build` compiled, TypeScript ok, routes `/`, `/_not-found`, `/chat/[agentId]` |
| Fresh copy of the tree in `/tmp` (git init, frozen-lockfile install, typecheck, lint, test, build) | all pass |
| Manual smoke with root `pnpm dev` (default `./data`), curl against :3001 and the :3000 proxy | below |

Smoke highlights: `GET /api/agents` 200 (also via :3000); SSE during `POST …/messages` showed
`snapshot → message_start → message_end(user) → submission(placed) → run_start → turn_start → message_start → message_update ×18 → message_end →
turn_end → run_end → submission(done)`, no system entries; the same `requestId` twice → same `submissionId` (202); missing `requestId` 400,
`text/plain` POST 415, unknown conversation 404, bad id 400, all with the JSON error shape; abort mid-answer 200 → aborted entry;
`touch apps/server/src/main.ts` mid-answer (watch restart, SIGTERM, graceful close) → after restart `[user, assistant(aborted), assistant(stop)]`
and the same `requestId` returns the same submission. Production build checked too: `pnpm start` with auth on gives 401 without the header
and for another user, 200 for the owner (also through `next start`), and SSE through `next start` (gzip on) arrives incrementally
(`Cache-Control: no-cache, no-transform` is what makes that true). SIGTERM logs `[shutdown]` and exits.
Browser (headless Chromium via agent-browser, `--no-sandbox` because Ubuntu's AppArmor blocks the sandbox): streaming with the busy dot and
stop button, stop, agent switching, restart banner and resumed answer, 390 px layout, history loading.

## 4. Could not verify
- Anything against real OpenAI: the `openai` provider is wired and `gpt-6.1-sol` exists in the installed catalog, but no login or request was
  made (by instruction). OAuth refresh running inside `FileCredentialStore.modify` is covered only by the in-process contract tests.
- Tailscale Serve itself (HTTPS, header injection, the `/api` path split): simulated with headers and the Next proxy.
- Real Android/Chrome, keyboard behavior, PWA (out of scope). Only headless desktop Chromium at 390 px.
- "Load earlier" was verified in the browser against a throwaway 110-turn backend, not as a committed test (the reducer and store parts are tested).
- Behavior of Durable's `restartLimit` parking, compaction, tools and multi-tab queued follow-ups: not exercised in M1.

## 5. Known risks
- Durable, Chord and `watchEvents` are experimental and the published 1.4.0 already differs from the repo's docs (2.1). Re-record
  `apps/web/test/fixtures` (`node apps/server/scripts/record-fixtures.ts`) after any upgrade and read the diff.
- `ensureAgents` writes two databases in sequence: a crash between them on the very first start leaves one empty, unreferenced conversation.
- File policy compares paths after symlink resolution but cannot stop a swap between check and use; nothing the agents can call creates links.
  `createTempDir`/`createTempFile` are denied, which M7's codemode will need handled (a `.tmp` under the workspace is the obvious answer).
- With `ASSISTANT_AUTH=off` any local web page could reach the API (DNS rebinding); it exists only for `pnpm dev`.
- `node --watch` restarts the server on every saved file, interrupting an answer each time. Intentional (it exercises recovery) but visible
  as "Interrupted" messages in dev chats.
- The history endpoint returns whole raw pages with system entries removed, so a page can hold fewer than `limit` entries; the client follows the returned cursor.
- No request logging, no rate limiting, no body-size limit beyond the 20 000-character message cap.
- TypeScript 7, Vitest 5 and Biome 2.6 are brand new; pins are exact in the lockfile but expect churn.

## Milestone C (partial) — web handoff at worker rotation
- `apps/web` is fully implemented (sidebar, per-agent threads, streaming, stop, reconnect, load earlier, notices); gates green at handoff: `pnpm typecheck`, `pnpm lint`, `pnpm test` (16 files, 176 tests, 33 of them web), `pnpm build`. No code is half-written. This entry qualifies the "(done)" wording above: implementation is complete, sign-off verification is not.
- Verified in headless Chromium: streaming, stop, agent switching, restart mid-answer, 390 px layout, load earlier. NOT seen in a browser: console warnings, error/retry notices, text restore after a failed send, the "Interrupted" label (added after the restart check), light theme, `next start` pages.
- Remaining for M1, in order: coordinator acceptance, the browser checks above, decide on the generated `apps/web/AGENTS.md`, commit (the worker did not commit).
- All dev servers and background processes stopped; only `/tmp/m1-*.png` screenshots remain. Details: `docs/handoff-m1-web.md`.

---

# FIXES REPORT — review fixes and browser verification (worker → coordinator)

Handoff: `docs/handoff-m1-fixes.md`; review copied to `docs/review-m1.md`. Branch `scaffold/pa-foundation`, still no commit.
Gates at the end: `pnpm typecheck` (5 packages) · `pnpm lint` (94 files) · `pnpm test` **20 files, 272 tests** (was 16 / 176, three
runs in a row stable) · `pnpm build` all green. Only the C1 tests (config + scoped-env) and the U9 tests (cross-writer, stale
lock) were run against the unfixed code and seen to fail; the other new tests were written after their fix and were not run red.

## Item by item (all fixed unless marked)

| Item | Status | What changed | Test(s) |
|---|---|---|---|
| C1 | fixed | `loadConfig` resolves data dir, workspace, secrets, files through symlinks (`canonicalizeDataPaths`); the write root and the secrets deny glob are real paths | `config.test` "resolves a symlinked data directory…"; `scoped-env.test` "a data directory behind a symlink… still lets agents write their workspace and still protects the secrets" |
| C2 | fixed | deny globs compile with `s` (and `i`) | `path-policy.test` "cannot be bypassed by a newline in a directory name…" |
| C3 | fixed | new `http/guard.ts`: `Host` allowlist (`127.0.0.1/localhost/[::1]:<actual port>` + `ASSISTANT_PUBLIC_HOST`), `X-Forwarded-Host` checked too (Next's proxy rewrites `Host`), `Sec-Fetch-Site` must be same-origin/none on state-changing requests; both auth modes; 403 `forbidden` with the fix in the message | `api.test` "who may talk to the API (Host and Sec-Fetch-Site)" (4 tests, 13 cases) |
| C4 | fixed | `ASSISTANT_AUTH=off` + `NODE_ENV=production` is a config error (actionable text, nothing created); dev script is `ASSISTANT_AUTH=${ASSISTANT_AUTH:-off}` | `config.test` "refuses ASSISTANT_AUTH=off in production…"; script checked by hand: `ASSISTANT_AUTH=on pnpm --filter @assistant/server dev` fails with the missing-owner error, unset starts with auth off. Also seen in the built bundle |
| C5 | fixed | `Migration.up` typed so `async` does not compile; runtime thenable check throws inside the transaction (rolled back, nothing recorded, no unhandled rejection) | `migrate.test` "refuses an async migration…" (with `@ts-expect-error`) |
| C6 | fixed | store keeps `{conversation, text, requestId}` of the last unsent message and reuses the id for the same text; spent on success, new for edited text or another conversation | `thread-store.test` "keeps one requestId for one message across retries…", "gives an edited message a new requestId…", "posts the message with a requestId… gives the next message a new one" (old pin inverted) |
| C7 | fixed | dev data dir `./data-dev`, prod `./data`. `GET /api/settings/agents`, `GET|PUT /api/settings/agents/:id` (model + thinking level through `configure()`, validated against the served catalog and the model's supported levels, level clamped when the model changes). Web: `/settings` page (route group `(app)`), sidebar link, "unavailable model" warning per agent | `config.test` "keeps development and production data apart…"; `api.test` "agent settings" (6 tests incl. the faux-created agent fixed in openai mode); `settings-form.test` (8). Browser: in openai mode over a faux data dir all four agents warned, `pa` saved to GPT-6.1 Sol, API confirmed |
| U1 | fixed | `<data>/server.lock` (`file-lock.ts`: link-based atomic create, pid + Linux start time, stale takeover by rename) taken first; the port is bound **before** app.sqlite/Durable open (503 "starting" meanwhile); clear error naming the pid | `e2e.test` "two servers on one data directory" (2), "reports a busy port…" (now also asserts neither database was created); `file-lock.test` (8, incl. 12 contenders, recycled pid) |
| U3 | fixed | conversations are created with `init` writing `app.agent-key`; an agent without a row first adopts a tagged conversation (`adopted` in the result, warned in the log) | `agents.test` "adopts the conversations a crashed start created…", "adopts only the agents that lost their row…" |
| U4 | fixed | heartbeat is a named `ping` event (`STREAM_PING_EVENT_NAME`); client watchdog 40 s, reconnect on `visibilitychange` after 20 s of silence and on `online` | `stream.test` "keeps a quiet connection alive with named `ping` events…"; `thread-store.test` "a connection that dies without a word" (6) |
| U5 | fixed | snapshots carry `unanswered` (read from Durable's stored submission records through `Storage.scanSubmissions`, `unanswered.ts`); the reason is shown under the user's message and survives reload; no notice when the message is attached | `stream.test` "tells a reconnecting client why a message was never answered…"; `thread-state.test` "replaying a message that gets no answer" (4, one replays a recorded reload). Browser: no_model line shown and still there after reload |
| U6 | fixed | `task_parked` logged as `error` with what it means, repeated at every start; `GET /api/agents` → `{ agents, health: { parkedTasks } }`; banner in the web shell; nothing retries | `crash.test` "parks the task once it hit the restart limit…"; `api.test` "…reports a healthy server". Banner not seen in a browser |
| U7 | fixed | `threadFor(state, conversationId)` used by the view | `thread-store.test` "showing a thread…" |
| U8 | fixed | deny list case-insensitive; added `*.pem *.key .netrc .npmrc .aws/** .git-credentials .gnupg/** id_*` | `path-policy.test` credential files (8), "ignores letter case…" |
| U9 | fixed | one in-process queue + cross-process `credentials.json.lock` around `modify`/`delete` (30 s wait), `cleanupTempFiles()` at startup, directory fsync after rename | `credentials.test` "keeps two writers that share no memory…", "recovers from a lock its writer died holding", "removes temp files a crashed write left behind…". The fsync itself is not observable in a test |
| U10 | fixed | 256 KB body limit before parsing (declared and chunked), 8 concurrent event streams (429, slot freed on abort) | `api.test` "request limits" (2) |
| U12 | fixed (docs) | rule documented in `validation.ts`, `guard.ts`, README and the new `docs/design-notes.md` (incl. the M2 upload plan); no upload code | n/a |
| U13 | fixed | real child process (`test/support/crash-child.ts`) killed with SIGKILL; parent takes over the stale lock, sees `restarts === 1`, answer completes once | `crash.test` "takes over the stale lock, counts the restart, and finishes the interrupted answer exactly once" |
| U2 | docs only | `docs/design-notes.md` "Two databases, two durability levels" (revisit in M2) | n/a |
| C8 | fixed | snapshot and `agent_changed` drop `instructions` and `cwd`; README corrected; fixtures re-recorded | `wire.test` (2), `stream.test` "never sends the system prompt…" extended |
| C9 | fixed | `body?.error?.code`; a body-less 5xx now says the server may be restarting | web `api.test` (4) |
| C10 | fixed | heartbeat `write` that throws synchronously cannot escape the timer; already-aborted signal and abort during the snapshot write end quietly as `disconnected` | `stream.test` "survives a client that is already gone…", "survives a write that throws on a heartbeat…" |
| C11 | fixed | port is digits only; set-but-empty `ASSISTANT_READ_PATHS` is an error; data dir chmod 0700 at every start | `config.test` (4 new table rows, "tightens an existing data directory to 0700…") |
| C12 | partly | savepoint counter moves after BEGIN; a failed ROLLBACK no longer hides the original error (`AggregateError`). **Deferred:** checking that recorded migration ids are a prefix of the declared order: a policy decision for M2 when domain modules arrive (adding a domain mid-array would trip it) | `app-db.test` "reports the original error when SQLite had already rolled…" |
| C13 | fixed | `.gitignore`: `/data/`, `/data-dev/`, `.vitest/`; `agentRules: false` and `apps/web/AGENTS.md` deleted (not regenerated by `next dev`); README says `ASSISTANT_API_ORIGIN` is baked at build | n/a |
| C14 | fixed | snapshot slices before copying | existing "keeps the newest entries…"; no timing test |
| U11 | not testable offline | Tailscale header stripping, real `X-Forwarded-Host` from Serve | n/a |

## Browser verification (`docs/handoff-m1-web.md` §2 item 2), headless Chromium via agent-browser, screenshots in `/tmp/assistant-shots/`

- (a) console and page errors on `/chat/pa` and `/settings`, dev and production build: nothing but the React DevTools hint, HMR and Fast Refresh logs (dev). No hydration warnings.
- (b) `no_model`: the agent models were faux, the server restarted in `ASSISTANT_MODEL_MODE=openai` (no credentials, no network); the message shows "This agent has no model it can use…" under it in red (`b-no-model.png`) and **still after a reload**. Settings then fixed an agent (`settings-after.png`). I did not send anything to the repaired agent.
- (c) send failure with the server down: red `role=alert` notice, the text is back in the composer. The Next proxy answered a bodyless 500, which read "The server answered 500…"; changed to "The assistant server is not answering properly (HTTP 500). It may be restarting…" (`c-send-failure.png` shows the old wording).
- (d) restart mid-answer: "Reconnecting…" chip, then "Interrupted by a restart. The answer below replaces it." on the first partial (`d-reconnecting.png`, `e-light-390.png`).
- (e) light scheme and 390 px: white theme, agent pills on top, composer fully visible (bottom 780 of 780), no dev badge (`e-light-390.png`).
- (f) production build in a browser (`node apps/server/dist/main.js` with `ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux`, no `NODE_ENV`, plus `next start`): `/` redirects, streaming works, Settings has four cards, reload keeps the thread, console clean (`f-production.png`). `pnpm start` itself now refuses auth off, as intended; README explains the way to try the build locally.
- Every dev and production server and the browser session started here were stopped; nothing listens on 3000–3009; scratch data dirs under `/tmp` removed (only `/tmp/assistant-shots/` is left).

## Deviations from PLAN.md (not edited; fold in if you agree)

- §5.5: heartbeat is a named `ping` event, not a comment. `GET /api/agents` returns `{ agents, health }`. Settings routes: `GET /api/settings/agents`, `GET|PUT /api/settings/agents/:id`. New error codes `forbidden`, `payload_too_large`, `too_many_requests`.
- §5.5 Auth: besides `Tailscale-User-Login`, every API request is subject to the `Host` allowlist and `Sec-Fetch-Site` rule (`ASSISTANT_PUBLIC_HOST` must be set for Tailscale Serve, otherwise the API answers 403 with that instruction).
- §2 rule 4: deny globs extended (U8). Default data dir differs between dev and production (C7).

## Remaining risks

- **Parked tasks cannot be retried** from anywhere yet (no command, no endpoint; by instruction nothing retries automatically). The banner and log say so. A `retryTask` command is M2 material.
- The parked-tasks banner and the `ping`/visibility reconnects were verified by unit tests only, not in a browser.
- Two processes taking over one stale lock at the same instant remain possible in theory (narrowed; `design-notes.md`).
- `ASSISTANT_PUBLIC_HOST` and Serve's actual `Host`/`X-Forwarded-Host` are unverified without Tailscale (U11).
- The model list on the settings page is pi-ai's whole OpenAI catalog (42 entries, some odd ones). Curating it is a product decision.
- Dependencies of the crash tests: they start two child Node processes (about 2 s each) and need `/proc` only for the recycled-pid test (skipped elsewhere).
