# Handoff: Milestone 1, web worker rotation

Written by the outgoing worker at the coordinator's request. Repo `/home/kzoeps/Projects/personal/assistant`, branch
`scaffold/pa-foundation`, **no commits** (every file is untracked; the worker was not allowed to commit).
Read this together with `docs/PLAN.md`, `docs/handoff-m1.md` (the original scope), `README.md` and the final report at the
end of `docs/progress-m1.md`.

Legend used below: **[V]** = exercised by code, tests or a live run in this repo; **[R]** = read from installed types or source only.

---

## 1. Exact current state

### 1.1 Gates (re-run just before writing this file, no code changed since)

| Check | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm lint` (Biome 2.6.3) | `Checked 82 files … No fixes applied` |
| `pnpm test` (Vitest 5.0.5) | **16 files, 176 tests, all pass** (~7 s) |
| `pnpm build` | passes (server esbuild bundle, `next build` incl. TypeScript step); last run after the final code change |
| Fresh copy of the tree, `pnpm install --frozen-lockfile` then typecheck, lint, test, build | all pass (run earlier in the session) |

Tests per area: server 127 (agents 10, api 22, config 22, credentials 10, dev-model 4, e2e 5, path-policy 23, scoped-env 14,
stream 7, wire 10), **web 33** (thread-state 21, thread-store 12), db 14, extensions 2.
No failing or skipped tests. One test (`stream.test.ts`, the first test) had a flaky assertion; it was wrong, not the code, and was fixed.

### 1.2 What `apps/web` contains

```text
apps/web/
  package.json        next 16.4.3, react/react-dom 19.3.1, @assistant-ui/react 0.15.31, zustand 5.0.16, @assistant/shared (workspace)
  next.config.ts      rewrites /api/* -> ASSISTANT_API_ORIGIN (default http://127.0.0.1:3001); transpilePackages ["@assistant/shared"];
                      turbopack.root + outputFileTracingRoot = repo root; devIndicators: false; reactStrictMode; poweredByHeader off
  tsconfig.json       extends ../../tsconfig.base.json; module ESNext / moduleResolution Bundler; jsx preserve; includes src, test
  src/app/
    layout.tsx        metadata, viewport (interactiveWidget "resizes-content" so the Android keyboard does not cover the composer, themeColor)
    page.tsx          redirect("/chat/pa")  (prerendered; 307)
    chat/layout.tsx   <ChatShell>
    chat/[agentId]/page.tsx   awaits `params` (a Promise in Next 15+), renders <AgentThread agentId>
    globals.css       plain CSS (no Tailwind); light/dark via prefers-color-scheme; below 760 px the sidebar becomes a scrolling row of pills
  src/components/
    chat-shell.tsx    owns the zustand store (one per app) and the polled agent list; sidebar + <main>
    chat-context.tsx  useChat(): { agents, error, refresh, store }
    agent-sidebar.tsx links /chat/<id>, avatar, name, pulsing busy dot
    agent-thread.tsx  resolves the agent, keys <ThreadView> by conversation id so switching agents rebuilds runtime + connection
    thread-view.tsx   useAgentThread() hook (connect/disconnect, useExternalStoreRuntime) + primitives + message components
  src/lib/
    thread-state.ts   PURE reducer: createThreadState, applyEvent(s), prependHistory, withConnection, unansweredMessage
    ui-messages.ts    ThreadState -> UiMessage[] (memoized per entry object; marks "interrupted")
    convert-message.ts UiMessage -> assistant-ui ThreadMessageLike
    thread-store.ts   zustand vanilla store: one EventSource at a time, retry/backoff, send / stop / loadEarlier
    api.ts            typed fetch helpers, ApiRequestError, newRequestId() (randomUUID with a getRandomValues fallback)
    use-agents.ts     polls GET /api/agents every 4 s (paused while the tab is hidden), refresh on visibility
  test/
    thread-state.test.ts, thread-store.test.ts, fixtures.ts, fixtures/{chat-turns,stop-midway,restart-resume,no-model}.json
```

Behaviour implemented: sidebar of the four agents (avatar, name, busy dot); one endless thread per agent at `/chat/<id>`; user bubbles;
assistant messages with streamed text and a collapsible "Thinking" block (open only while that part is running); status lines
(Stopped, Interrupted, Cut off, error text); three-dot indicator between send and first token; composer (Enter sends on desktop,
Send becomes Stop while running); "Load earlier messages" button; "Connecting… / Reconnecting…" chip; notice bar for retry,
unanswered-message and send errors; failed sends hand the text back to the composer (`MessageNotSentError`).

### 1.3 Verified

- **Reducer, [V]:** `applyEvent` is replayed against four event streams recorded from the real server over HTTP
  (two chat turns on a second connection, stop mid-answer, restart mid-answer across two connections, a `no_model` failure) plus hand-built
  edge cases (delta types, wrong-block deltas ignored, snapshot ordering with a head marker whose id is higher than later entries, history
  merging and gap detection, cursor following, error/cut-off/empty messages, duplicate entries, retry notice).
- **Store, [V]:** `thread-store.test.ts` drives the store with a fake `EventSource` and stubbed `fetch`: connect, go live, switch conversation,
  disconnect (no reconnect afterwards), drop and browser-side retry, refused connection with 1/2/4/8 s backoff that resets on success, send
  (fresh `requestId`, JSON header, error reporting), stop, load earlier (follows the server cursor).
- **Browser, [V]** (headless Chromium via agent-browser, real `pnpm dev`, dark colour scheme): page load and redirect, empty thread, Send
  disabled while empty, Enter and click to send, token streaming with the Thinking block, busy dot, Send turning into Stop, finished answer,
  switching agent (own empty thread), Stop (partial kept, "Stopped"), server restart mid-answer via `touch apps/server/src/main.ts` ("Reconnecting…"
  chip, then the cut-short partial followed by the complete answer), 390 px layout (agent pills on top, composer pinned at the bottom),
  "Load earlier" against a throwaway 110-turn backend (100 user messages shown, button added the other 10 then disappeared).
- **Proxy and production mode, [V], by curl only:** `/api/*` and SSE through the Next dev proxy and through `next start` (gzip on) arrive
  incrementally because the server sends `Cache-Control: no-cache, no-transform`; `/` answers 307 to `/chat/pa`.
- Accessible names seen in the browser snapshot: navigation "Agents", textbox "Message <Agent>", buttons "Send message" / "Stop answering" /
  "Load earlier messages".

### 1.4 NOT verified (do not assume these work)

- Browser console and hydration warnings were never inspected.
- Visual state of the notice bar (error, retry), the three-dot waiting indicator, and the text restore after a failed send. Their logic is
  unit-tested; the DOM was not looked at.
- The "Interrupted by a restart…" label. It was added after the restart check in the browser (which showed "Stopped" for the cut-short partial);
  covered by reducer and `convertMessage` tests, never seen on screen. The `describeStatus` mapping for `reason: "other"` in `thread-view.tsx` has no test.
- Light colour scheme; the phone layout after `devIndicators: false` (the earlier screenshot had the Next dev badge over the composer);
  `next start` pages in a browser (only curl); a real Android browser; Enter-key behaviour on touch devices (read in assistant-ui source, not tried).
- Message-id stability for real providers (see 5.3).

---

## 2. What remains for M1, in order

All eleven in-scope items of `docs/handoff-m1.md` are implemented. There is no half-written code and no unfinished implementation step.
What is left is acceptance work:

1. **Coordinator acceptance:** run the gates in section 6 and walk the original checklist; the final report in `docs/progress-m1.md` maps each item.
2. **Close the verification gaps in 1.4** with the dev servers up (about 20 minutes; recipes in section 6):
   (a) open the browser console and look for React, hydration or assistant-ui warnings on `/chat/pa`;
   (b) `no_model` notice: set an agent's model to something unknown (recorder script `noModel()` shows how) and send;
   (c) send failure: stop the server, send, expect the red notice and the text back in the composer;
   (d) restart mid-answer again and confirm the "Interrupted…" label replaces "Stopped" on the first partial once the second answer starts;
   (e) light scheme, and a 390 px screenshot to confirm the composer is no longer covered;
   (f) production build in a browser: `ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux pnpm start` plus `pnpm --filter @assistant/web start` (auth must be off, because a
   browser cannot add `Tailscale-User-Login` without Tailscale Serve; production defaults to the OpenAI model, which has no credentials here).
3. **Decide on `apps/web/AGENTS.md`:** `next dev` generates it (Next 16.4 note for AI agents). Commit it, or set `agentRules: false` in `next.config.ts` and delete it.
4. **Commit** (coordinator or user; the worker did not). No commit exists yet. A natural split into scoped commits: workspace scaffold and tooling, `db`,
   `shared` + `extensions`, `server`, `web`, `docs`.
5. **Start M2.** Places in M1 code M2 will touch are listed in 3.3.

Optional hardening, **not** requested by the handoff and not started: React component tests, a committed browser smoke script, Markdown
rendering for assistant text, per-message timestamps, a visible sidebar error after the first successful poll.

---

## 3. Known issues and failing checks

**Failing checks: none.** Known issues:

### 3.1 Web
- Tool-call blocks in assistant messages are dropped by `toUiMessages`, and an assistant message with no text and no error is hidden. `pi.tool-result` entries
  and other kinds (`app.reminder`, `app.notice`, `pi.compaction`, `pi.reset`) produce no bubble. Intentional in M1 (no tools); M2 must add tool cards and system cards.
- The composer is disabled while a run is in progress (Stop instead of Send), so M1 never queues follow-ups from this tab. Another tab can queue one; its
  `pi.user` entry only appears when Durable places it, because `inbox_update` carries ids and modes but not content.
- `useAgents` shows an error only while it has never succeeded. After a successful first poll, later poll failures are silent in the sidebar (the open thread
  still shows "Reconnecting…" from its own stream).
- Busy dots are polled (4 s), not streamed, except for the open thread (refresh on run start/end).
- "Stopped" vs "Interrupted" is a heuristic: an aborted answer followed by another assistant answer counts as interrupted. A user Stop is always last, so the
  heuristic fits Durable's behaviour, but nothing in the entry itself says why it was aborted.
- Assistant text is plain `pre-wrap`; no Markdown.
- Dev only: `node --watch` restarts the server whenever an imported file is saved, which interrupts a running answer each time (it resumes; chats show "Interrupted").
- Test timing risk: the restart tests use the dev model at 20 tokens/s (about 4 s per answer) and close the server right after the first partial. On a machine so slow
  that more than ~3.8 s pass in between, the interrupted answer would already be complete and those two tests would fail.

### 3.2 Server and Durable (details in the final report of `docs/progress-m1.md`)
- Durable, Chord and `watchEvents` are experimental, and the published 1.4.0 differs from the checkout's README (5.1).
- `ensureAgents` writes two databases in sequence: a crash between them on the very first start leaves one empty orphan conversation.
- File policy cannot stop a symlink swap between check and use; temp files, `watch`, `listFiles` are unavailable in the scoped environment.
- `FileCredentialStore` has no cross-process lock; a future login command must run while the server is stopped or share a lock.
- `ASSISTANT_AUTH=off` (the `pnpm dev` default) is open to DNS rebinding from local web pages. No request logging, no rate limiting.
- The history endpoint filters system entries after paging, so a page can hold fewer than `limit` entries (the client follows the cursor).

### 3.3 Places M2 will touch
- `AGENTS[].extensions` in `apps/server/src/agents.ts` (existing conversations pick new extensions up through `ensureAgents`).
- `apps/web/src/lib/ui-messages.ts` and `thread-view.tsx` for tool cards, approval cards, `app.reminder` / `app.notice` system cards.
- `AgentSummary` (`packages/shared/src/agents.ts`) needs `unread` plus a read marker.
- `scoped-env.ts` if any tool needs temp files (M7 codemode: a `.tmp` under the workspace).
- `apps/server/src/credentials.ts` before a login CLI exists.

---

## 4. Decisions and deviations from PLAN.md, with reasons

**PLAN.md edits (the only two):** §5.1 `createConversation` needs `ownership: { kind: "ownerless" }`; §7 `agents.conversation_id` is `INTEGER NOT NULL UNIQUE` (Durable ids are integers).

Web-specific:
- **Route per agent, `/chat/[agentId]`, with `/` redirecting to `/chat/pa`.** PLAN §6 does not pick one. Deep links per agent are free and the PWA share target (M4) needs them. The layout owns the sidebar and store, so switching agents keeps polling and the shell.
- **One `EventSource` at a time** (the open thread), agents list by polling. Four threads open at once would hold four connections for dots nobody needs live; unread badges (M2+) can revisit.
- **Plain CSS, no Tailwind or UI kit.** assistant-ui is headless; the layout is ~300 lines of CSS, and there is nothing to configure or upgrade.
- **Pipeline as PLAN §6 says:** zustand store, `EventSource`, pure `applyEvent`, `toUiMessages`, `convertMessage`, `useExternalStoreRuntime`. No Vercel AI SDK. `hasEarlier` / `onLoadEarlier` of the runtime carry "Load earlier", so no custom pagination UI.
- **Stable message identity:** assistant messages use `assistant-<request timestamp>` so a streaming message keeps its id when it turns into a committed entry (no remount, no scroll jump). User messages use `user-<entry id>`.
- **Only `pi.user` and `pi.assistant` entries are bubbles.** A compaction summary is stored as a user message; rendering by role alone showed it as something the user said (caught by a test).
- **Snapshot window and history cursor:** the server sends the newest 200 entries (`hasEarlier`); the client sorts by entry id (the view puts a head marker first even though its id is the highest) and keeps already-loaded history that still connects to a new snapshot.
- **`AgentSummary` without `unread`**, see 3.3.
- **Failed sends throw `MessageNotSentError`** so assistant-ui restores the composer text; the reason shows in the notice bar.
- **Next config:** `turbopack.root` and `outputFileTracingRoot` are set to the repo root because `/home/kzoeps/package.json` and `pnpm-lock.yaml` exist and Next would otherwise guess the wrong root; `devIndicators: false` because the dev badge overlays the phone composer.

Cross-cutting (server and tooling; full list in the final report):
- Workspace packages export TypeScript source; Node 24 type stripping in dev, `transpilePackages` for `shared`, esbuild bundle for the server build. All code obeys `erasableSyntaxOnly` (no enums or constructor parameter properties).
- Wire protocol: every SSE frame is `event: events` carrying a JSON array of events; the first event of a connection is a windowed `snapshot`. The server removes `pi.system` entries and opaque provider signatures before anything reaches the browser. Types are Durable's, re-exported type-only from `@assistant/shared`.
- Auth default `on`; `pnpm dev` sets `ASSISTANT_AUTH=off`. Every POST must be `application/json` (CSRF defence, since Tailscale identifies the owner by device). Not in PLAN.
- `ensureAgents` re-applies code-owned `extensions` and `instructions` to existing conversations and never touches model or thinking level.
- Dev model is `faux/faux-1` in faux mode; `openai/gpt-6.1-sol` applies only in openai mode.
- Exact pins for Durable, pi-ai, chord (1.4.0) and `save-exact` for everything else.

---

## 5. API facts verified (next worker needs these)

### 5.1 Durable 1.4.0 (installed package types win over the checkout's README)
- **[V]** `Harness.open(storage, { models, registry, env, onReport }, ctx)`; `openNodeSqliteStorage(path)` from `@earendil-works/pi-durable/storage/sqlite/node`;
  `BACKGROUND_CONTEXT` and `withAbortSignal(signal, ctx)` from `@earendil-works/chord/context`. `harness.resume()` is required after open (open runs nothing); seed before `resume()`.
- **[V]** `createConversation({ ownership: { kind: "ownerless" }, agent: { model, thinkingLevel, extensions, instructions } }, ctx)`; ids are numbers (branded in types only), the first is 2 (1 is the reserved root).
  `harness.conversation(id, ctx)`, `conversation.configure(change, ctx)` (a given field replaces the stored one; `null` clears it **[R]**), `conversation.abort(ctx)`, `harness.snapshot(AgentDoc | LiveDoc, id, ctx)`.
  Busy means `LiveDoc.run !== undefined`; an idle `LiveDoc` snapshot is `{}`.
- **[V]** `conversation.submit({ type: "input", content, requestId, whenBusy? }, ctx)` returns a `Submission` (`id`, `status()`, `wait()`, `abort()`). The same `requestId` returns the same submission, also after a restart.
- **[V]** `conversation.entries(query, limit, cursor, ctx)` is newest-first; `EntryQuery.maxEntryId` is inclusive; `Page.next` present means more pages. It returns `pi.system` entries too. That it also returns entries before a compaction/reset head is from the spec **[R]**: no compaction happened in M1.
- **[V]** `watchEvents(harness, id, ctx)` returns `{ snapshot, start(listener), stop(), closed }`. Write the snapshot before `start()` to keep order. Event batches are one per commit.
  `message_start` of an assistant message is the first committed partial, or the whole final message when none was committed (replies faster than the 100 ms commit interval produce no `message_update`);
  `message_end` carries the entry and clears the draft; `message_update.changes` types: `text_start | thinking_start | toolcall_start | block | text_delta | thinking_delta | toolcall_delta | message`.
  The snapshot's `entries` are the *active* transcript: a head marker (compaction/reset) comes first even though its id is the highest; they include `pi.system` entries.
- `WatchEnd.reason` in 1.4.0: `stopped | cancelled | session_closed | retired | listener_error | session_failed` (installed types **[R]**; `session_closed` seen in `stream.test.ts` **[V]**). `harness.closed` resolves `{ reason: "closed" | "failed", error? }` **[R]**. (The checkout's README says `ended`/`failed` for watches: it is newer than the npm package.)
- **[V]** Restart semantics: `harness.close()` mid-stream took ~40 ms; after reopening the same SQLite file and `resume()`, the committed partial becomes a `pi.assistant` entry with `stopReason: "aborted"`, the generation requests the model again from the same user message, appends a complete answer, and the submission settles `done`. One `pi.user` entry.
  A user abort ends the submission `unanswered` with reason `aborted`; a missing model ends it `unanswered` / `no_model`.
- **[R]** `ExecutionEnv` = `FileSystem` + `Shell` from `@earendil-works/pi-durable/env` (`ok`, `err`, `FileError`, `ExecutionError`); `HarnessOptions.env(target: EnvTarget)` is called per tool call and prompt render. Built-in `read` uses `absolutePath`, `openBinaryReader`; `edit`/`write` serialize on `env.id` + `canonicalPath`. `codemode` needs `createTempDir`.
- Section texts must render deterministically (a changed section appends a system delta and defeats prompt caching): the profile section contains no date.

### 5.2 pi-ai 1.4.0
- **[V]** `createModels({ credentials })` returns `MutableModels` (`setProvider`, `getModel(provider, id)`); providers from `@earendil-works/pi-ai/providers/{openai,faux}`. `openai/gpt-6.1-sol` exists in the installed catalog.
- **[V]** `fauxProvider({ provider, models, tokensPerSecond, tokenSize })`: one scripted response consumed per request; a `FauxResponseFactory(context, options, state, model)` may re-queue itself (`appendResponses`). `options.reasoning` is set when the agent's thinking level is not `off` (seen through Durable for `medium` and `low`; `off` not exercised).
- **[V]** `CredentialStore`: `read`, `list` (no secrets), `modify(providerId, fn)` is the only write path, `delete`; `Credential` is `{ type: "api_key", key?, env? }` or `{ type: "oauth", access, refresh, expires, … }`; pi's `auth.json` shape.
- Thinking levels: `off | minimal | low | medium | high | xhigh | max`. Opaque fields to never forward: `thinkingSignature`, `textSignature`, `thoughtSignature`.

### 5.3 assistant-ui 0.15.31 (`@assistant-ui/core` 0.3.31)
- **[V]** `useExternalStoreRuntime<T>({ messages, convertMessage, isRunning, isLoading, hasEarlier, onLoadEarlier, onNew, onCancel })`; `onNew(AppendMessage)` gets `content` as an array of parts (take `type === "text"`). Throwing `MessageNotSentError` from `onNew` restores the composer text.
- **[V]** Primitives used: `AssistantRuntimeProvider`; `ThreadPrimitive.Root | Viewport | Empty | Messages | LoadEarlier`; `MessagePrimitive.Root | Parts`; `ComposerPrimitive.Root | Input | Send | Cancel`; `useAuiState((s) => s.thread.isRunning | hasEarlier | isLoading | messages, s.message.status)`.
  `ThreadPrimitive.Messages` takes a render function `({ message }) => ReactNode` (`components` is deprecated). `MessagePrimitive.Parts components={{ Text, Reasoning }}` receives `{ text, status }`.
- **[V]** `ThreadMessageLike` content parts include `{ type: "text" }` and `{ type: "reasoning" }`; `status` is `running | requires-action | complete{reason} | incomplete{reason: cancelled | tool-calls | length | content-filter | other | error, error?}`.
- **[R]** `ComposerPrimitive.Input` consults a touch-primary media query so Enter does not submit on phones; `ThreadPrimitive.Viewport` auto-scrolls by default.
- **[assumption, not tested with a real provider]** assistant message ids are `assistant-<message.timestamp>`; the faux provider keeps `timestamp` equal on partial and final. pi-ai documents it as the request start time, so real providers should too. If not, the only effect is a remount at completion.
- Source for reference: `apps/web/node_modules/@assistant-ui/react/src/primitives/**`, and core under `node_modules/.pnpm/@assistant-ui+core@*/node_modules/@assistant-ui/core/src/`
  (`runtimes/external-store/external-store-adapter.ts`, `runtime/utils/thread-message-like.ts`, `react/primitives/thread/ThreadMessages.tsx`, `types/message.ts`, `types/error.ts`).

### 5.4 Next 16.4 / Hono / tooling
- **[V]** Next 16.4 docs ship in `apps/web/node_modules/next/dist/docs/`. `next build` type-checks through the project-local `tsc` CLI, which is why TypeScript 7.0.2 works. `params` is a Promise. `next dev` writes `AGENTS.md`.
- **[V]** `next start` gzips responses; the SSE route stays unbuffered thanks to `Cache-Control: no-cache, no-transform`. Hono's `streamSSE` sets its own `Cache-Control: no-cache`, so the server overrides it afterwards on the returned response.
- **[V]** Hono: `c.req.raw.signal` aborts on client disconnect; `getConnInfo` (`@hono/node-server/conninfo`) reads `c.env.incoming.socket.remoteAddress`. In tests pass `{ incoming: { socket: { remoteAddress } } }` as the third argument of `app.request(path, init, env)`.
- **[V]** Vitest 5 resolves `node:sqlite` and imports workspace TypeScript source fine; JSON fixtures are imported with `with { type: "json" }`.
- **[V]** agent-browser 0.34 on this machine needs `--args "--no-sandbox"` (Ubuntu AppArmor blocks the Chromium sandbox); use a named session; refs (`@eN`) go stale after navigation, so re-snapshot before `fill` (a `fill` on a stale ref silently did nothing once).

### 5.5 HTTP and stream contract the web relies on (`packages/shared`)
- `GET /api/agents` -> `AgentSummary[]` (`id, name, avatar, conversationId, busy`).
- `GET|POST /api/conversations/:id/messages`, `POST …/abort`, `GET …/stream`. Only conversations that belong to an agent are reachable (404 otherwise). Errors: `{ error: { code, message } }`.
- POST body `{ content, requestId, whenBusy? }`, `Content-Type: application/json` required (415 otherwise); response 202 `{ submissionId }`.
- History: `?before=<entryId>&limit=<1..200, default 50>` -> `{ entries (oldest first, system entries removed), nextBefore? }`.
- SSE: `event: events`, `data:` a JSON array of `StreamEvent`; first event of a connection is `snapshot` (`entries` newest <= 200 without `pi.system`, `hasEarlier`, `run?`, `generation?`, …); `: heartbeat` comment every 15 s; a slow client may get another `snapshot` mid-stream; reconnect = new snapshot.

---

## 6. Commands

```bash
pnpm install                          # needs Node 24 (v24.22.0 here) and pnpm 10.15.1; ~/.npmrc holds a registry token: never print it
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm exec vitest run apps/web         # web tests only; apps/server, packages/db, ... likewise
pnpm dev                              # server :3001 (node --watch, auth off, faux model, data in ./data) and web :3000
pnpm --filter @assistant/server dev   # one half only; same for @assistant/web
ASSISTANT_DATA_DIR=/tmp/x pnpm dev    # throwaway data dir; ASSISTANT_READ_PATHS=/a:/b if ~/Documents or ~/Downloads are missing
node apps/server/scripts/record-fixtures.ts   # re-record apps/web/test/fixtures/*.json from the real server (temp data dir, no network)
pnpm start                            # built server, production mode (auth on, OpenAI model); add ASSISTANT_OWNER_LOGIN=... and ASSISTANT_MODEL_MODE=faux to try it offline
pnpm --filter @assistant/web start    # built web app
```

Recipes that worked:
- **Start and stop dev servers safely:** `(setsid pnpm dev > /tmp/dev.log 2>&1 & echo $! > /tmp/dev.pid)`, stop with `kill -TERM -$(cat /tmp/dev.pid)` (negative pid = the whole group; the server logs `[shutdown]`).
  **Never `pkill -f <text that appears in your own command line>`**: it killed the worker's shell twice. Use pid files or `ss -ltnp | grep :3001`.
- **Browser check:** `export AGENT_BROWSER_SESSION=<name>`; `agent-browser --args "--no-sandbox" open http://127.0.0.1:3000`; `snapshot -i`; `fill @e3 "text"`; `press Enter` or `click @eN`;
  `find role button click --name "Stop answering"`; `set viewport 390 780`; `get count ".msg--user"`; `screenshot /tmp/x.png`; `close`. Do not `Read` a screenshot in the same parallel batch that creates it.
- **Restart mid-answer in dev:** send a message, wait about a second, `touch apps/server/src/main.ts`.
- **Long thread:** start `startServer(config, { devModel: { tokensPerSecond: 1_000_000 } })` on port 3002 with a temp data dir (script inside `apps/server` so imports resolve), POST 110 messages one after another, then run the web dev server with
  `ASSISTANT_API_ORIGIN=http://127.0.0.1:3002` (stop the other `next dev` first; Next refuses a second dev server in the same directory).
- **API by hand:** `curl -s http://127.0.0.1:3001/api/agents`; messages need `-H 'content-type: application/json'` and a `requestId`.

---

## 7. Temp files and processes

**Processes:** everything the worker started has been stopped, checked at handoff: nothing listens on 3000-3009; no `node`, `next`, `vitest`, `pnpm`, `agent-browser` or Chromium process of the worker is running;
`agent-browser session list` says "No active sessions". Started during the work, all stopped: root `pnpm dev` (server + Next), standalone `next dev` (twice, once with `ASSISTANT_API_ORIGIN` overridden),
`pnpm start` + `next start` production check, `node apps/server/src/main.ts` smoke servers, the throwaway 110-turn backend on :3002, and the agent-browser session `assistant-m1-worker`.

**Files outside the repo (the worker's, safe to delete):** `/tmp/m1-before-restart.png`, `m1-done.png`, `m1-empty.png`, `m1-inbox-empty.png`, `m1-long-top.png`, `m1-mobile.png`, `m1-reconnecting.png`, `m1-reconnecting2.png`,
`m1-resumed.png`, `m1-resumed2.png`, `m1-stopped.png`, `m1-streaming.png` (screenshots of the UI states described in 1.3). All other scratch files (logs, pid files, throwaway data directories, helper scripts, the JSON test report) were removed.
`/tmp/rekey-smoke` is not the worker's.

**Inside the repo, git-ignored build output:** `node_modules/` (root and per package), `apps/server/dist/`, `apps/web/.next/`, `apps/web/next-env.d.ts`, `apps/web/tsconfig.tsbuildinfo`. There is no `data/` directory (the dev data created for the smoke test was deleted).
Generated and *not* ignored: `apps/web/AGENTS.md` (see 2.3). `pnpm-lock.yaml` is complete and should be committed.
Gotcha: Vitest 5's `--reporter=json` writes `.vitest/json/output.json` into the repo root, and `.vitest/` is not git-ignored. The worker created and deleted it once; delete it again after such a run, or add `.vitest/` to `.gitignore`.
