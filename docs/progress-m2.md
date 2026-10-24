# M2 progress log (worker → coordinator)

## M2 (partial) — code, tests and browser check done; docs and final report remain

Branch `main`, nothing committed. Worker 1 stopped at the context limit by instruction. Details, remaining steps and verified
API facts: `docs/handoff-m2-2.md`.

**State**
- All eleven scope items of `docs/handoff-m2.md` are implemented and tested, including the PLAN.md fold-in. Not yet done:
  README and `docs/design-notes.md` updates, and the final report (this file, below) in the M1 style.
- Gates at the last code change: `pnpm typecheck` (5 packages) · `pnpm lint` (132 files) · `pnpm test` **29 files, 423 tests**
  (was 20 / 272; three runs, two of them concurrent, stable) · `pnpm build` (server bundle 149.7 kB, `next build` with the manifest
  and icon routes). The built bundle was started once as a smoke test: VAPID file created 0600, migrations applied, clean SIGTERM.
- Browser check (headless Chromium via agent-browser against `pnpm dev` with the dev model): task card, reminder card appearing live at
  its due second with the fake push sender writing `{"title":"Reminder","body":"1 reminder","url":"/chat/pa","tag":"reminder"}`,
  approval Approve button, a reply of YES, settings (notifications card, service-worker registration, curated model list and
  "Show all"), parked-task banner with Retry (mocked `/api/agents`, real retry endpoint), 390 px layout. 13 screenshots in
  `/tmp/assistant-shots/m2/`. All servers and the browser session stopped; scratch directories removed.

**Shape of the work** (modules, not a file list; the final report will list files)
- `packages/db`: per-module migration policy (`<module>/<NNN>`, ordering within a module only, prefix check), `core/002_push_subscriptions`.
- `packages/shared`: card and entry types, push/approval/parked-task DTOs, error code `conflict`.
- `packages/extensions`: `module.ts`, `post.ts`, `time.ts`; `tasks/` (tables, tools, reminder task, scheduler with start-up repair, prompt
  section); `approvals/` (table, service, hook).
- `apps/server`: `domain.ts` composition root, `push/` (VAPID, sender interface, web-push and fake senders, notifier), new routes,
  YES interception, start-up repair and approval sweep, dev-model `/tool` commands.
- `apps/web`: system cards in the thread, approval buttons, Retry on the parked banner, notifications card, curated models, PWA
  manifest/icons/service worker.

**Decisions worth a look** (full list with reasons in `docs/handoff-m2-2.md` §4)
- Reminder consistency is "the row is the truth, the Durable task is a timer" plus start-up `reconcile()`; this resolves the M1
  design-note "revisit in M2" by self-healing rather than `synchronous=FULL`.
- Reminder and approval-outcome entries carry a model-visible user message (about 40 tokens, no model call) so "snooze it" resolves.
  Easy to switch off if you prefer UI-only.
- No clock in prompt sections; the model uses the new `current_time` tool, and `remind_in_minutes` avoids needing it.
- `delete_task` is model-visible but hook-guarded; the server executes an approved action itself; YES is intercepted by the server.

**Not verified:** real Web Push delivery (FCM/Apple), a real browser subscription (headless has no push service), iOS Home Screen
behavior, the success path of Retry in a browser (covered at API level).

*(The final report follows.)*

---

# FINAL REPORT — Milestone 2

Branch `main` (as the handoff instructs). Nothing committed or pushed. No OpenAI, Google or TypeSafe call, no real push service, no
login, no `railway`; nothing written outside this repository except the screenshots in `/tmp/assistant-shots/m2/` (kept on purpose).
Two worker stints: the first built and browser-checked everything and updated PLAN.md; the second wrote README and
`design-notes.md`, skimmed the PLAN.md diff, re-ran every gate and opened three of the screenshots to confirm what is reported
below. Scope: `docs/handoff-m2.md`. State and verified API facts: `docs/handoff-m2-2.md`.

## 1. Changed files and directories

```text
packages/db/           migrate.ts (ids are <module>/<NNN>; ordering per module), core.ts (core/002_push_subscriptions + helpers), index.ts
                       tests: migrate (policy), core (push subscriptions)
packages/shared/       cards.ts (new: entry and card types), api.ts (push, approval and parked-task DTOs, error code `conflict`), index.ts
packages/extensions/   module.ts post.ts time.ts · tasks/{index,migrations,store,tools,reminder,scheduler}.ts ·
                       approvals/{index,migrations,store,service}.ts · index.ts · package.json (now depends on db, shared, chord, pi-ai)
                       tests: time, tasks-tools, reminders, approvals (+ support.ts)
apps/server/           new: domain.ts (composition root), push/{vapid,sender,notifier,dev-sender}.ts, atomic-file.ts
                       edited: agents.ts config.ts dev-model.ts runtime.ts server.ts http/{app,validation}.ts package.json,
                       scripts/record-fixtures.ts (records reminders-approvals.json as well)
                       tests: m2, push (new); agents, api, config, crash, dev-model, support (edited)
apps/web/              new: src/app/{manifest.ts,icon.png}, public/{sw.js,icons/*.png}, scripts/make-icons.mjs,
                       components/{cards,notifications-card}.tsx, lib/{push,card-text}.ts
                       edited: app/{layout.tsx,globals.css}, components/{chat-shell,settings-view,thread-view}.tsx,
                       lib/{api,convert-message,settings-form,ui-messages}.ts
                       tests: cards, push, sw (new); api, settings-form, fixtures.ts (edited); fixtures/reminders-approvals.json
docs/                  PLAN.md (M1 deviations and M2 folded in), README.md, design-notes.md, handoff-m2.md, handoff-m2-2.md, progress-m2.md
pnpm-lock.yaml         web-push 3.6.7, @types/web-push 3.6.4 (apps/server) and the new workspace links
```

40 tracked files modified (+1,786 / −145 lines, docs included) and 46 new files (about 5,400 lines of code, tests and scripts;
about 7,400 with the docs and the recorded fixture). Icons are generated by `apps/web/scripts/make-icons.mjs`; their outputs are committed.

## 2. Decisions and deviations

### 2.1 Where M2 differs from the handoff (PLAN.md already says so)
- **More tools than listed:** `current_time` and a guarded `delete_task` exist beside the six tools of the scope; `add_task` and
  `update_task` also take `remind_in_minutes`, and `snooze_reminder` takes `minutes` or `until`.
- **Browser check:** the scripted model was told `remind_in_minutes: 1` where the handoff says `remind_at = now+1min`. Both
  resolve to the same stored time; `remind_at` parsing is covered by `time.test.ts` and the tool tests.
- **Routes (PLAN §5.5):** `GET /api/push/config` returns the public VAPID key; `DELETE /api/push/subscribe` carries a JSON body
  (every write must be JSON); `POST /api/approvals/:id` answers 404 for an unknown request and 409 `conflict` for one that
  expired or was answered the other way; `GET /api/agents` gained `health.parked`.
- **New helper** `apps/server/src/atomic-file.ts` (the VAPID file needs the same atomic write as the credential store).
  `credentials.ts` was left alone: change boundaries.

### 2.2 Decisions to review (reasoning in `docs/design-notes.md`; each is cheap to reverse)
1. **Reminder consistency.** `tasks_item` is the truth; the Durable `app.reminder` task is a timer carrying `{ itemId, gen, at }`
   that fires only while the row still wants exactly that. A generation is taken in app.sqlite right before the task is created,
   and `reconcile()` at start repairs lost or unlinked timers. This closes M1's "revisit in M2" **by self-healing, not by
   `synchronous=FULL`**: no dependence on adapter internals, and `FULL` would not close the gap between two commits anyway.
2. **Firing.** A `write` submission with `requestId = reminder:<item>:<gen>` plus a `posted` memo, then the row is marked and the
   task checkpoints to `notify`, which pushes. The push is at least once after a crash; a failing push is logged, not retried, and
   never faults the task.
3. **Model-visible cards (please confirm).** Reminder entries and approval-outcome notices also carry `model: [user message]`
   (about 40 tokens, no model call) so "snooze it" and "did that go through?" resolve. To make them UI-only, drop `modelText` in
   `tasks/reminder.ts` and in `approvals/service.ts` (`noticeFor`).
4. **Time in prompts.** No clock in any prompt section (the `tasks` section renders identical bytes however much time passes;
   tested). The model gets "now" from `current_time`, and `remind_in_minutes` needs no clock. No timestamp prefix on user messages.
5. **Destructive tools.** `delete_task` is visible to the model and guarded by the `beforeTool` hook; `propose_delete_task` is the
   way in; on approval the **server** runs the action itself and writes the outcome; `recover()` finishes anything a crash
   interrupted. Rejected: hiding `delete_task`, which would leave the hook guarding a tool nobody can call.
6. **YES.** Exactly the word (trimmed, any case), only while an unexpired request waits in that conversation. Handled in
   `POST …/messages`: the model never sees it, no user bubble is made, and a resend returns the same notice.
7. **Approval card state is derived** from later `app.notice` entries (entries are immutable). With none, past `expiresAt`, the UI
   shows "expired". The server is authoritative: a late answer gets 409.
8. **Push setup.** Subscriptions are validated the way a sender needs them (https URL, 65-byte `p256dh`, 16-byte `auth`).
   `ASSISTANT_PUSH_MODE` defaults to `fake` outside production; `ASSISTANT_PUSH_SUBJECT` defaults to `mailto:assistant@localhost`.
   Real sends use TTL 6 h and urgency high; one `tag`, so a duplicate replaces the banner.
9. **Dev model `/tool <name> {json}`** (dev and faux only). Call ids hash the message and the user-turn count, so an answer
   regenerated after a crash reuses the id (rule 8).
10. **Tests changed on purpose** because they encoded the old shape: one `migrate` test used two migrations with the same sequence
    number and an out-of-order declaration in one module (forbidden by the new policy); `api.test` health is now
    `{ parkedTasks, parked }`; the `config.test` path table gained `vapid` and `pushOutbox`.
11. **Small ones.** The PA's instructions are code-owned and changed (it has tools now; the other agents keep "no tools yet"). A due
    date without a time is stored as the end of that day with `due_all_day`. Task ids are `t_` + 8 hex. Migration ids:
    `core/002_push_subscriptions`, `tasks/001_items`, `tasks/002_call_ledger`, `approvals/001_pending_actions`.
12. **C12 (M1's deferred migration-order check)** is now policy: ordering is enforced within one module only (ascending declaration;
    what a database recorded for a module must be a prefix of what it declares); an id this build does not declare is still refused.

### 2.3 Durable 1.4.0 facts learned in M2 (for M3 and later)
- `ToolExecutionApi` has no `abortTask`; a tool that must abort a task needs the late-bound `harness()`.
- A task created with `background: true` stays out of the user's Stop (a conversation abort) and out of "busy".
- `submit({ type: "write", requestId, entry })`: the same `requestId` returns the same submission, which is what makes a rerun post
  once. A write never starts a run; with `model` it is placed at the next boundary when the conversation is busy.
- When a prompt section changes mid-run, Durable inserts a `pi.system` message after the tool result. Code that looks for "the last
  message" must skip `system` (the dev model once looped forever on it).
- `beforeTool`'s `call.arguments` is pi-ai's `JsonObject`, not assignable to pi-durable's: type it `Readonly<Record<string, unknown>>`.
- A phase that throws while `harness.close()` runs counts as cut off, not faulted: reopening reruns it.
- After `Harness.open`, `resume()` is required; sleepers wake on `resume()` once the injected `now` is past their `until`.
- `web-push` always talks https, so tests spy on `sendNotification` instead of running a local server.

## 3. Commands run and results

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm lint` | `Checked 132 files … No fixes applied` |
| `pnpm test` | **29 files, 423 tests passed** in 12 s (M1 after fixes: 20 / 272). The first worker ran it three times, two of them concurrently: stable |
| `pnpm build` | server bundle `dist/main.js` 149.7 kB; `next build` ok, routes `/`, `/chat/[agentId]`, `/settings`, `/icon.png`, `/manifest.webmanifest` |
| Built bundle (first worker): `ASSISTANT_DATA_DIR=… ASSISTANT_READ_PATHS=/usr/share/doc ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux node apps/server/dist/main.js` | starts, creates `secrets/vapid.json` (0600, directory 0700), applies every migration, exits cleanly on SIGTERM |
| PLAN.md format check | `git diff --check` clean, 16 code fences (even), every table row has the same column count, no trailing spaces |
| Cleanup check | nothing listening on 3000–3009; no scratch directories left (see §6 for two log files) |

Browser check (first worker: headless Chromium through agent-browser against `pnpm dev` and the dev model; 13 screenshots in
`/tmp/assistant-shots/m2/`; I opened `03`, `05` and `09` and they show what is written here):
- `02`, `03`: `/tool add_task {…"remind_in_minutes":1}` gives a task card; a minute later the reminder card appears live at the due
  second, and `<data>/dev-push-outbox.jsonl` holds `{"title":"Reminder","body":"1 reminder","url":"/chat/pa","tag":"reminder"}` for
  the fake subscription that was POSTed by hand.
- `04`, `05`, `06`: `propose_delete_task` gives an approval card; Approve deletes the task (row `executed`); a reply of YES does the same
  with no `pi.user` entry containing YES and the notice "You replied YES. Deleted task …".
- `07`, `08`: Settings shows the Notifications card; Enable in headless ends in permission denied and the "blocked" text; `/sw.js`
  registers with root scope and `pushManager`; the manifest and icons are served.
- `09`, `10`: the parked-task banner with Retry (`/api/agents` mocked with `network route`; the real retry endpoint answered 404
  and the banner showed its message).
- `11`, `12`: curated model list (4 options, server in `openai` mode without credentials) and "Show all models (42)".
- `13`: the cards at 390 px.

## 4. Could not verify
- **Real Web Push delivery** (FCM, Apple's service). `web-push` is spied on in tests and the dev fake was used in the browser. A
  real `pushManager.subscribe` cannot run headless (only the permission-denied path was seen). iPhone behavior (Home Screen app
  required) is untried.
- **A real model using these tools.** Every test and the browser check drive the tools with scripted calls. No GPT model has chosen
  them or turned "tomorrow at 9" into an ISO time with them, so the tool descriptions and the `tasks` prompt section are untested
  against real model behavior.
- **Retry's success path in a browser.** It is covered by `crash.test.ts` (a really parked task: a child process killed with SIGKILL)
  and the web API-client test; in the browser only the mocked banner and the real endpoint's 404 were seen.
- Unchanged from M1: Tailscale Serve itself (`ASSISTANT_PUBLIC_HOST`, the `Host` and `X-Forwarded-Host` it really sends). A real
  push also needs that https address.

## 5. Known risks
- A push that the push service refuses for a reason other than 404/410 is logged and not retried: that reminder reaches the thread
  but not the phone. Nothing queues it.
- A model that calls `delete_task` directly wastes one turn (it is blocked and told to propose).
- A reminder that came due while the server was down fires late, on start; its card shows the original time.
- Reminder and notice entries are model context (decision 3); compaction will eventually summarise them.
- `atomic-file.ts` repeats the atomic-write steps of `credentials.ts`.
- The server's log lines for a parked task (`reportDurable`, `warnAboutParkedTasks` in `server.ts`) say that nothing retries it
  automatically but do not mention the Retry button or the endpoint.
- Unchanged from M1: two processes taking one stale lock at the same instant; `node --watch` restarts interrupt answers in dev.

## 6. For the coordinator
- **Veto points:** decision 3 (model-visible cards) and decision 5 (`delete_task` visible to the model).
- **Optional items not done** (outside the scope): refactoring `credentials.ts` onto `writeFileAtomic`; a browser check of a
  successful Retry on a really parked task.
- **Leftovers:** `/tmp/m2-dev.log` and `/tmp/m2-dev-openai.log` are the first worker's dev-server logs. I left them because deleting
  files needs your yes: `rm /tmp/m2-dev.log /tmp/m2-dev-openai.log`. `/tmp/assistant-shots/` (M1 and M2) is kept on purpose.
- **README:** besides the M2 updates, "The sign-in command is not part of Milestone 1" now reads "There is no sign-in command yet
  (PLAN.md lists `pnpm login:openai` under Ops)", because the old sentence read as if M2 might add it.
- **PLAN §3** names only FCM as the push service; on an iPhone it is Apple's. Cosmetic, not edited.
- **Suggested scoped commits**, in this order (the DTOs in `packages/shared` change together with server and web, so the middle
  commits will not typecheck alone; use one commit if every commit must be green; keep `pnpm-lock.yaml` with the `package.json` files):
  `db: namespace migration ids per module and add push_subscriptions` ·
  `shared, extensions: add tasks and approvals modules, reminder task and card types` ·
  `server: wire domain modules, Web Push, approval and retry routes` ·
  `web: render reminder, task and approval cards, add push notification setup` ·
  `docs: describe M2 in plan, readme and design notes, add M2 handoffs and report`.

---

# M2 REVIEW FIXES — report

Scope: `docs/handoff-m2-fixes.md` (the coordinator's adjudication of `docs/review-m2.md`). Branch `main`, nothing committed or
pushed, no `git checkout`/`restore`. No call to OpenAI, Google, TypeSafe or a real push service, no login, no `railway`, no
new dependency. Every server I started (a browser check, below) is stopped; nothing listens on 3000–3009. One worker, no
handoff needed.

## 1. Item by item

"Guard" = I made the change's behaviour undone on purpose (a scratch edit, reverted) and the test failed, so it is not vacuous.

| Item | Status | What changed | Test (file › name) |
|---|---|---|---|
| **C1** reminder lost after a durable rewind | fixed | `isCurrentReminder` no longer asks `reminded_at` (`tasks/store.ts`); design-notes, PLAN §5.4 and the "Two databases" section corrected | `reminders.test.ts` › *is posted again when Durable's database comes back older than app.sqlite, which remembers it was sent (power cut)* (guard) |
| **C1** approvals `notified_at` | fixed | `recover()` asks again (same `requestId`) for the notices of the last 24 h; `markNotified` keeps the latest submission id | `approvals.test.ts` › *posts a notice again when Durable's database came back from before it, though app.sqlite says it was posted (power cut)* (guard) |
| **C2** zero tokens with a queued follow-up | fixed (option a) | Cards and notices are display-only: `PostedEntry.modelText`, `reminderModelText` and the `now` parameter of `createEntryPoster` are gone; the `tasks` prompt section lists up to 5 sent reminders of open tasks (from the DB, no clock). Docs: PLAN §5.3, README, design-notes | `reminders.test.ts` › *starts no run even when a failed one left a follow-up queued…* (guard: +1 model call without the fix); *is told to the model by the tasks prompt section, from the database…*; the pinned test *sleeps until its time…* now asserts `entry.model` is undefined |
| **C3** replay re-validates the clock | fixed | `add_task`, `update_task`, `snooze_reminder` (and `complete_task`, for uniformity) look the call id up first (`findByCallId`, `findChangedByCall`) and answer from what the first run saved | `tasks-tools.test.ts` › *add_task › answers a replay with what its first run saved even when the reminder time has passed by then (rule 8)*; *answers replays of update_task and snooze_reminder with their first result, whatever the clock says by then* (both guard) |
| **C4** no periodic safety net | fixed | `server.ts`: `harness.resume()` every 30 s and the sweep every 10 min (`unref`, cleared by `close()`, no overlapping sweeps); the sweep runs `reconcile()` plus approval expiry (`Domain.sweep()`); `reconcile()` already treats a row that points at an ended task as reschedulable (its test is new); `StartServerOptions.intervals` lets tests shorten both; **`docs/OPS.md`** (keep the machine awake, clearing what cannot be repaired, calling the admin endpoint) | `m2.test.ts` › *wakes a reminder whose time passed while the timers were not looking (suspend, clock step) without any request*; *makes the timer again, while running, for a reminder whose timer Durable lost or ended* (both guard); `reminders.test.ts` › *replaces a timer that Durable faulted, without a restart…* |
| **C5** SW origin check | fixed | `appPath` resolves with `new URL(value, origin)` and keeps same-origin results only (`public/sw.js`) | `sw.test.ts` › *never takes the user to another site: %j becomes the app's own page* (11 inputs, incl. `/\evil.example`, tab, newline); *opens the app, not %j, even if the notification carries it*; *keeps a page of the app, also written as an absolute address* (guard) |
| **C6** `null` push payload | fixed | `?? {}` | `sw.test.ts` › *shows a notification for a body that is JSON null…* (guard) |
| **C7** one orphan row stops the start | fixed | `reconcile()` returns `{ rescheduled, failures }`, `recover()` returns `failures`; per-row catch; the server logs each once per process with the SQL that clears it (`createRepairLogger` in `server.ts`); the M1 message in `agents.ts` points at it | `reminders.test.ts` › *reports a task whose conversation Durable does not have, and still repairs the others*; `approvals.test.ts` › *reports a request whose conversation is gone and still finishes the others*; `m2.test.ts` › *start-up repair › starts although a task and an approval belong to a conversation that is gone, and says how to clear them* |
| **U1** bare YES | fixed | A YES approves only when exactly one request waits and nothing else was said since it was made. New column `pending_actions.yes_ok` (migration **`approvals/002_yes_window`**), closed by `tryYes` for every message that is not taken as an answer; card text says when YES works | `approvals.test.ts` › *a reply of "YES"* (5 tests: one waiting; two waiting; after another message; a later request; resend); `m2.test.ts` › *a YES after another message is an ordinary message…* (also in the browser, below) |
| **U2** push subscription lifecycle | fixed | `lib/push.ts`: `enable()` replaces a subscription bound to another key (unsubscribe in the browser and on the server first); new `sync()`, run by `PushSync` in the layout every time the app opens (upsert; never asks permission, never creates a first subscription); `sw.js` handles `pushsubscriptionchange` | `push.test.ts` › *keeps a subscription made with the server's current key*; *replaces a subscription made with another key…*; *sync, when the app opens* (5); `sw.test.ts` › *the subscription was replaced by the push service* (2) |
| **U3** `renotify` | fixed | `renotify: true` (the tag is always set) | `sw.test.ts` › first push test |
| **U4** push subject placeholder | fixed | `ASSISTANT_PUSH_SUBJECT` is required when the push mode is `web-push` (the default in production). **Operator action: set it before the next production start.** README row updated | `config.test.ts` › *asks for a real contact address before it sends real pushes, and accepts the placeholder while nothing is sent* (three older tests got the variable) |
| **U5** subscribe accepts any https URL | fixed in part | Endpoints must be public host names (no IP literals, one-word hosts, `*.local`, `*.localhost`, `*.internal`, `*.lan`, `*.home.arpa`, `*.ts.net`); at most 20 devices (409). **Deferred:** a vendor allowlist (would refuse an unlisted vendor; only the owner can send an endpoint) and curve-point validation of `p256dh` (tests and the browser check use random bytes; a bad key shows up at send time) | `m2.test.ts` › *stores a subscription, refuses malformed ones…* (7 new refusals); *accepts the endpoints of the real push services*; *stops at 20 devices, but lets a registered one register again* |
| **U6** titles reach the model as a user message | fixed by C2 | | |
| **N1** `delete_task` replay says "not approved" | **deferred** | The fix has to let the hook pass a call whose request is already `executed`, which reverses the pinned behaviour "used up: a second call is blocked again"; data is safe either way, and the server executes approved deletions itself, so the model-initiated path is rare | |
| **N2** idempotency key = provider call id | **deferred** | Only pi-ai's Google path invents ids (`name_ts_counter`); this server serves OpenAI, whose ids are unique. Switching to `api.taskId` touches the ledger keys, the fixtures and the dev model | |
| **N3** DST gap / 24 h day | fixed | `zonedToUtc` takes the later instant for a time that does not exist and the earlier for one that happens twice; `parseWhen` returns `dayStartMs` for a date without a time, so `due_after` no longer assumes 24 h | `time.test.ts` › *when the clock changes (New York, 2026)* (3) |
| **N4** sweep interval not cleared by `close()` | fixed | with C4 | none (a cleared, `unref`ed interval has no observable effect); the server tests that close servers stay green |
| **N5** string-built `status = '…'` | fixed | parameterised | covered by the existing `list_tasks` tests |
| **N6** Retry stops at the first failure; heading after the answer | fixed | Retry tries every parked task and reports the first message plus a count; the card heading is "Approval" once answered | no unit test (the web has no component tests); heading seen in the browser check, the retry loop not exercised |
| **N7** `remind_at: null` ignores `remind_in_minutes` | fixed | error "Send only one of them"; `update_task` split into `changeFrom` + apply | `tasks-tools.test.ts` › *refuses to clear the reminder and set a new one in the same call* |
| **N8** docs | fixed | README, PLAN, design-notes, `docs/OPS.md` (admin `curl` needs `Content-Type: application/json`) | |
| optional: `credentials.ts` on `writeFileAtomic` | done | `#write` is one call; `syncDirectory` and four imports removed | `credentials.test.ts` unchanged, green |
| (review §E) Stop keeps reminders | test added | | `reminders.test.ts` › *survives the Stop button…* |

Also changed to follow: `apps/server/test/support.ts` `appDepsFor` migrates the approvals table (the service reads it for every
message); `apps/web/test/fixtures/reminders-approvals.json` re-recorded and run through Biome (the four M1 recordings restored
from a backup, untouched); `packages/shared/src/cards.ts` comments.

## 2. Decisions and deviations (veto points marked)

1. **Decision 3 of the M2 report is reversed (C2a):** cards and notices never carry model text, and the code cannot do it any more.
   The model learns of sent reminders from the `tasks` prompt section, and of an approved deletion through `list_tasks` (the
   `propose_delete_task` result says so). *Veto point:* a pending-approvals line in the same section would tell the model that a
   YES is not accepted; not done.
2. **U1 is a flag, not a timestamp:** the reviewer suggested `last_user_message_at` per conversation; `yes_ok` on the request does
   the same with no clock comparison and no new table. The rule is the reviewer's: one waiting request, no message since.
   *Veto point:* a "yes" typed right after a proposal *in the same turn as a different yes/no question from the model* is still
   taken as the approval (nothing in the data tells the two apart).
3. **`ASSISTANT_PUSH_SUBJECT` is now mandatory in production** (U4). `pnpm start` without it refuses to start, with the message
   that says what to set.
4. **New migration instead of editing `approvals/001`:** a dev data directory that already ran M2 would otherwise miss the column.
5. **Shapes that changed:** `reconcile()` → `{ rescheduled, failures }`; `recover()` gained `failures`; `Domain.repair()` →
   `{ reminders, approvals }`, new `Domain.sweep()`; `ParsedWhen` is a union with `dayStartMs` for a date without a time.
6. **Recheck window of 24 h for outcome notices** (`NOTICE_RECHECK_MS`): a guess at how much a power cut can take from a
   database written this rarely; beyond it the card shows "expired" anyway.

## 3. Commands run and results

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm lint` | `Checked 134 files … No fixes applied` |
| `pnpm test` | **29 files, 472 tests passed** (was 423), 12 s; run four times serially, all green |
| `pnpm build` | `next build` ok (same routes), server bundle `dist/main.js` 156.3 kB (was 149.7) |
| browser check (agent-browser against the built server and `next start`, faux model, fake push; **6 screenshots in `/tmp/assistant-shots/m2-fixes/`**) | task card; approval card with the new text; a message and then `YES`: the task stays, `yes_ok` = 0, the Approve button still works; answered card is headed "Approval"; the reminder card appeared by itself and the fake outbox got the minimal payload; Settings shows the Notifications card; no console errors |
| listening ports | none on 3000–3009; the server was stopped with SIGTERM (clean shutdown line in its log) |

## 4. Could not verify

- Real push delivery, a real `pushsubscriptionchange`, `renotify` on iOS: only fakes and a headless browser. Same for the new key
  check in `enable()`/`sync()` (`PushSubscription.options` in real browsers).
- That a suspended laptop's timers really stop (standard Linux behaviour, not measured here): `docs/OPS.md` says so.
- The Retry loop of N6 in a browser.
- A real model choosing the tools (as before).

## 5. Remaining risks and one unrelated flake

- **Flaky, pre-existing, not touched:** `apps/server/test/file-lock.test.ts` › *serializes critical sections of many contenders…*
  fails under CPU starvation (3 of 8 full-suite runs that overlapped another suite; 5 of 12 runs of that file alone beside 24
  busy loops; 0 of 4 serial full-suite runs and 0 of 8 concurrent runs of that file alone). `LockHeldError` is thrown by `removeStale` (`file-lock.ts:159`): a live replacement lock is moved by
  the stale-removal `rename`, `link` fails with `EEXIST`, and the error leaves `acquireFileLock` although `waitMs` (10 s) has not
  run out. Suggested fix, outside this scope: in `acquireFileLock`, catch that error while `Date.now() < deadline` and go on
  polling. The credential store waits on the same lock (`waitMs` 30 s), so two processes could hit it too, rarely.
- A reminder can still be late by the length of a suspend; nothing wakes the machine (OPS.md).
- The YES rule cannot see what the model asked after the proposal (decision 2).
- An orphan the server cannot repair is logged once per process, not every ten minutes, and stays until its SQL is run.

## 6. For the coordinator

- **Before the next production start:** export `ASSISTANT_PUSH_SUBJECT` (decision 3).
- **Commit grouping:** the fixes sit in the same uncommitted tree; the five scoped commits suggested in the M2 report still fit
  (`db` has no change; `docs/OPS.md` goes with the docs commit; `approvals/002_yes_window` belongs to `shared, extensions`).
- **Leftovers:** `/tmp/assistant-shots/m2-fixes/` (kept on purpose, like the M1 and M2 shots) and `/tmp/m2-review-scratch/`
  (the reviewer's). My scratch files and logs are removed.
