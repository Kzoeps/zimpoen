# M2 review (read-only), advisory for the coordinator

Reviewed: `HEAD 321d480` plus the working tree (40 modified, 46 new files plus this brief; node_modules/.next/dist/data* excluded).
Read: `handoff-m2.md`, `handoff-m2-2.md`, `progress-m2.md`, PLAN §2/§5, `design-notes.md`, all new/changed source and tests.
Durable behaviour was checked in the installed 1.4.0 `dist` (`packages/extensions/node_modules/@earendil-works/pi-durable/dist`), not the checkout.

**Verdict: 0 blockers, 7 should-fix (C1-C5, U1, U2), 14 nits.** The core holds: row-is-truth with a generation counter, `requestId` de-duplication,
hook plus tool-level approval check, single-winner approval, guards on every new route, migration policy. Act first on C2, C4 and U1
(the likeliest to bite); C1, C3, C5 are small fixes. The fixes for C1, C2(a), C3, C5 and C6 were verified in scratch copies (nothing in the repo was touched).

Gates re-run by me: `pnpm typecheck` (5 packages) ok, `pnpm lint` (132 files) ok, `pnpm test` 29 files / 423 tests ok (3 runs, 2 concurrent, stable).
`pnpm build` not run (writes dist/.next). The repo is untouched: sha256 manifest of every non-ignored file is identical before and after
(`/tmp/review-m2-baseline.sha`, `/tmp/review-m2-after.sha`).

Claims in the docs that do **not** fully hold: design-notes "Resolved in M2 by self-healing" (C1: only lost timers are healed, not lost cards),
"reminders cost no model tokens" (C2), sw.test "never takes the user to another site" (C5), "tools are idempotent by call id" for absolute times (C3).

---

## A. Confirmed defects C1-C7 (reproduced against the code as submitted)

Repro scripts: `/tmp/m2-review-scratch/*.ts|mjs`, run with `node <file>` (Node 24 strips types; they import the repo, write only to temp dirs).

### C1 [should-fix, low likelihood] After a power cut a reminder is never re-posted when durable.sqlite comes back older than app.sqlite
- Where: `packages/extensions/src/tasks/store.ts:326-333` (`isCurrentReminder` needs `remindedAt === undefined`), used at `tasks/reminder.ts:59` and `:70`; `markReminded` at `reminder.ts:89`.
- Evidence: `repro2-power-cut.ts`. Reminder fires (card 1, push 1, row `reminded_at` set). Close, restore the earlier copy of `durable.sqlite*` (what a lost WAL suffix looks like), keep `app.sqlite`, reopen, advance: **no card, no new push**, timer ends `{fired:false, reason:"superseded"}`. (Simulated rewind, not a real power cut.)
- Impact, precisely: the push of the first firing has usually gone out already, so the owner got a nudge but the thread has no card (only `list_tasks` says "already sent"). If the cut lands between `markReminded` (fsynced at once) and the push a short moment later, nothing ever reaches the owner. Design-notes prefer a duplicate to a lost reminder; this path loses it.
- Mechanism: `app.sqlite` is `synchronous=FULL` (`packages/db/src/app-db.ts:132`), Durable is `NORMAL` (chord `sqlite/node.js:160`). `markReminded` writes the "fired" flag into the stronger store; if Durable loses its tail (card write, memo, checkpoint, terminal state) the timer wakes in `fire`, sees `reminded_at`, and declares itself superseded. `reconcile()` cannot help: the row no longer wants a reminder. The same shape exists for approvals (`notified_at` FULL vs the notice in Durable): card stays "pending" until it flips to "expired" though the task is gone (not reproduced).
- Fix (verified in a copy): delete `&& row.remindedAt === undefined` from `isCurrentReminder`. A generation belongs to exactly one timer and `requestId = reminder:<item>:<gen>` makes the re-post idempotent, so a rewound timer re-posts (or finds the surviving card) and pushes again (at-least-once, already accepted). With it: the 70 extension tests stay green and repro2 gives cards 1 / pushes 1. Add the rewind simulation as a test; correct the design-notes paragraph.

### C2 [should-fix] "Zero model tokens" is false while a failed run has left a follow-up queued
- Where: `packages/extensions/src/post.ts:22-33` (write with `model: [...]`), `tasks/reminder.ts:81-86` (`modelText`), `approvals/service.ts:124-135, 284-298` (notices and the YES path go through the same `post`).
- Evidence: `repro6b-e2e.ts`. Run A fails (`model_error`); message B typed while A was busy stays `queued`. Real reminder task fires: **model calls 1 -> 2, B becomes `unanswered`** (a run started). Same state with a display-only write (no `modelText`): +0 calls. `repro6-write-starts-run.ts` shows it with a hand-built post.
- Mechanism: a write that carries `model` is not display-only (`inbox.js isDisplayOnly`). For an idle conversation with queued items, `admitSubmission` queues the write and runs a final boundary (`submissions.js`, doc at line 143), which starts a run for the queued inputs; `afterFailedRun: keep` (default, `types.d.ts:513`) is exactly what leaves them queued "until the next input or queued write". Reachable in any model outage (expired ChatGPT sign-in) after the owner typed twice. Side costs of `modelText`: ~40 tokens per reminder stay in context, and task titles enter context as a *user-role* message (U6).
- Fix: (a) recommended: post cards display-only, and give the model what "snooze it" needs through the `tasks` prompt section from DB state (e.g. "Reminders sent: t_ab12 “Pay rent”", derived from `reminded_at`, no clock, so the no-clock rule still holds). Verified in a copy: +0 calls; exactly one existing test changes (`packages/extensions/test/reminders.test.ts:65-66` pins the model text). (b) alternative, not tested: `afterFailedRun: "withdraw"` in `openRuntime`, which changes M1 behaviour (queued messages become `unanswered` at once).

### C3 [should-fix, low likelihood] Rule 8: a replayed tool call re-validates time-dependent arguments before it looks for its own earlier result
- Where: `tasks/tools.ts:129` (`add_task`: `resolveReminder` before `insertTask` at `:132`), `:223`/`:237` (`update_task`), `:279`/`:284` (`snooze_reminder` with `until`).
- Evidence: `repro1-replay-past-remind-at.ts`. First run saved the row (remind 14:10) and died; process back 20 min later; Durable replays the same call id and arguments: tool throws `remind_at ... is in the past`, row exists with no timer (until the next start's `reconcile()`).
- Mechanism: replay-safe should mean same call id gives same result; the clock check runs first. The model sees an error for work that was done and may call `add_task` again (new id, duplicate task). `remind_in_minutes` is safe (the stored row wins); absolute times are not.
- Fix (verified for `add_task` in the copy): look up `source_call_id` (`tasks_call` for the other two) first and return the stored result; validate only when there is none. Add a test that replays with `remind_at` after the clock passed it.

### C4 [should-fix] No periodic safety net: a late timer, or a faulted one, leaves a reminder dead until the next restart
- Where: `apps/server/src/server.ts:120-131` (repair and `resume()` once at start; the only interval is the approvals sweep), `tasks/scheduler.ts:31-33` with `tasks/store.ts:282-295` (`takeGeneration` needs `durable_task_id IS NULL`, so `ensureScheduled` does nothing for a row that still points at a dead task).
- Evidence: (a) `repro8-clock-jump.ts`: wall clock jumps 55 min past the deadline after the timer was armed: **no card after 2 s; one `harness.resume()` fires it**. (b) `repro3-fault.ts`: one throw in `fire` (post failure) makes Durable end the task `faulted` (`scheduler.js:1691`, rule 4, no retry); the row keeps the dead `durable_task_id`; an hour later with the server up: cards 0, pushes 0; `reconcile()` at the next start recreates it and it fires.
- Mechanism: Durable arms one `setTimeout` for the earliest sleeper (`scheduler.js:1216-1228`). On Linux/libuv timers use a monotonic clock that does not run during suspend (standard behaviour, **unverified on this laptop**), and most desktop distros suspend a laptop on lid close by default. (b) needs a real throw; none is known today, so it is hardening.
- Fix: `setInterval(() => harness.resume(), 30_000).unref()` next to the sweep; run `reconcile()` inside the existing 10-minute sweep (it only touches rows that want a reminder); put "disable suspend" (`HandleLidSwitch*=ignore`, mask `sleep.target`) in the ops notes.

### C5 [should-fix, low exploitability] The service worker's "never leaves the origin" guard is bypassable
- Where: `apps/web/public/sw.js:20-22`; test `apps/web/test/sw.test.ts:101-108` claims the opposite.
- Evidence: `sw-redirect.mjs` runs the real file. `url: "/\\evil.example"`, `"/\t/evil.example"`, `"/\n/evil.example"` pass `appPath`; the click ends in `clients.openWindow("https://evil.example/")`. `//evil.example` and absolute URLs are refused.
- Mechanism/impact: WHATWG URL reads `\` as `/` and strips tab/newline, so a "starts with / but not //" check is not an origin check. Needs a payload the server did not send (VAPID private key or server compromise; payloads are end-to-end encrypted), so it is defence in depth, but it makes a stolen key into phishing links on a trusted notification.
- Fix (verified in `sw-patched.js`): `const url = new URL(value, self.location.origin); return url.origin === self.location.origin ? url.pathname + url.search + url.hash : FALLBACK_URL` (in a try/catch). Add the three inputs to the test.

### C6 [nit] A push whose JSON is `null` shows no notification
- `sw.js:25-31`: `payload = event.data.json()` can be `null`, then `payload.title` throws (`sw-null-payload.mjs`: handler threw, 0 shown). The server never sends it; browsers penalise a `userVisibleOnly` push that shows nothing. Fix: `(...) ?? {}` (verified in the patched copy).

### C7 [nit] One orphan row stops the whole server from starting, and the message gives no remedy
- `tasks/scheduler.ts:37,90`, `server.ts:120`: `repro7-reconcile-poison.ts`: a task row whose conversation Durable lacks makes `reconcile()` reject, which fails `startServer`. M1's own advice for a mismatch ("DELETE FROM agents to start fresh", `agents.ts` message) creates exactly this state. `approvals.recover()` has the same path. Fix: catch per row, log with the SQL that clears it, continue; or at least put the remedy in the message.

---

## B. Unverified risks and design decisions U1-U6 (mechanism read from code/spec; not reproduced)

### U1 [should-fix] A bare "YES" approves the newest pending request whatever the owner is answering
- Where: `approvals/service.ts:209-223`, `approvals/store.ts:142-152`, intercept `http/app.ts:243`; tests pin "newest wins" (`approvals.test.ts:233-252`).
- Verified safe: only `POST /messages` reaches `tryYes` (grep), the model/tool output cannot; exact word only; one winner under concurrency (`repro4`: button + YES at once -> one execution, one notice, the YES then goes to the model).
- Risk: with any request pending (24 h), a "yes" typed to an unrelated question ("Shall I list tomorrow's tasks?") deletes a task; with two pending requests the card on screen may not be the newest. The model cannot trigger it but can create the situation (propose, then ask a yes/no). PLAN rule 3 says *explicit* approval.
- Fix: accept YES only if it is the single pending request and no other user message came after it was created (the route already sees every message: keep `last_user_message_at` per conversation and require `created_at >= last_user_message_at`); otherwise forward to the model and let the card say "use the button".

### U2 [should-fix] Push subscription lifecycle (no real browser or push service was available)
- Where: `apps/web/src/lib/push.ts:106-137`, `public/sw.js` (no `pushsubscriptionchange`), `apps/web/test/push.test.ts:95-103` (pins reuse).
- Stale key: `enable()` reuses `getSubscription()` without comparing `applicationServerKey`. `vapid.ts`/README say "enable notifications again" after a key loss; the old subscription stays bound to the old key, sends fail with a non-404/410 status that `notifier.ts:34-39` only logs, and Settings says "on". Per the Push API `subscribe()` with another key throws `InvalidStateError`, so the fix must unsubscribe first.
- Rotation: nothing re-registers a subscription except the Enable click. Push services rotate/expire subscriptions; the server then gets 410, deletes the row, and the phone stops being nudged without anyone noticing.
- `status()` never asks the server: a failed `POST /subscribe` (offline) leaves "on" with no server row.
- Fix: when the app loads with permission granted, compare keys (re-subscribe if different) and POST the current subscription (idempotent upsert); add a `pushsubscriptionchange` handler that does the same.

### U3 [nit] One constant `tag`, no `renotify`
- `sw.js:36`, `reminder.ts:15`. By the Notification spec a same-tag replacement is silent unless `renotify: true`, so a second reminder is silent while the first is still in the tray. Fix: `renotify: true`, or tag `reminder:<itemId>` (not sensitive).

### U4 [nit] `ASSISTANT_PUSH_SUBJECT` default is a placeholder
- `config.ts:340,355`. Real pushes in `web-push` mode go out with `mailto:assistant@localhost`; some push services (Apple is reputed to be strict about VAPID claims; not verified) may reject such a `sub`. Not testable here. Fix: require the variable when mode is `web-push`.

### U5 [nit] Subscribe accepts any https URL
- `http/validation.ts:128-147`: owner-only blind POST target (SSRF-style), no cap on rows, and a malformed `p256dh` point only fails at send time and is never pruned. Fix: allowlist the vendor hosts (fcm.googleapis.com, updates.push.services.mozilla.com, *.push.apple.com, *.notify.windows.com) or at least refuse private ranges.

### U6 [nit] Task titles reach the model as a user-role message
- `reminder.ts:111-116`, `approvals/service.ts:284-298`. Today titles come from the owner's own chat. In M5 the inbox agent hands commitments (untrusted email text) to the PA, so a title becomes a user-level instruction at reminder time. Display-only cards (C2 fix) remove it; otherwise quote and label as data.

---

## C. Other nits N1-N8

- N1 `tasks/tools.ts:331-339` `delete_task` is `replay:"safe"` but the replay throws "was not approved" because the first run consumed the approval (`service.ts:225-231`): data is safe, the result is wrong. Return "already deleted" when an executed request for the target exists.
- N2 Idempotency keys are the provider's `api.callId`. pi-ai's Google path synthesises ids (`name_ts_counter`) when Gemini returns none. A collision across turns makes `add_task` return an old row and `snooze`/`update` report success without applying. `api.taskId` (unique per tool call, stable across the rerun) is a safer key.
- N3 `time.ts:61`: comment says a DST gap picks "the later instant"; `parseWhen("2026-03-08T02:30","America/New_York")` gives 01:30 EST (one hour early). `tools.ts:192`: `due_after` assumes a 24 h day (25 h day starts at 01:00). Asia/Thimphu has no DST; matters only if `ASSISTANT_TIMEZONE` changes (`time-dst.ts`).
- N4 `server.ts:124-131,229-250`: the approvals sweep interval is cleared only on a failed start, not by `close()`; harmless in production, one leaked timer per test server.
- N5 `tasks/store.ts:133` builds `status = '${filter.status}'` by interpolation. Safe today (typed union, schema-validated), but parameterise it.
- N6 `chat-shell.tsx:43`: Retry loops over parked tasks and stops at the first failure (a 404 from another tab skips the rest). Approval card keeps the heading "Needs your approval" after the answer (`cards.tsx:135`).
- N7 `update_task` with `remind_at: null` silently ignores `remind_in_minutes` (`tools.ts:221`). Return an error for the contradictory pair.
- N8 Docs: PLAN §5.3 and README promise "no model call" without C2's caveat; `POST /api/admin/tasks/:id/retry` needs `Content-Type: application/json` even with no body (not documented for curl users).

---

## D. Checked and holding (no need to re-check)

- **Hook blocks destructive tools**: `beforeTool` block or throw both block (`tool.js:64-79`); target mismatch (other task/tool/conversation) blocks; `delete_task.execute` independently refuses without an approved row (`service.ts:225-231`), so a missing `approvals` extension does not open the tool. Tests drive the real Harness with a scripted model (`approvals.test.ts:81-130`).
- **Approvals execute once**: conditional `UPDATE ... status='pending' AND expires_at > now` is the single winner (`approvals/store.ts:192-`); `markExecuted ... WHERE status='approved'`; notice `requestId = approval:<id>`; `recover()` finishes crash leftovers. `repro4` confirms under concurrency. Expiry: refused at decision time, lazily, every 10 min, at start.
- **Fires once across crash/restart**: generation taken before the Durable task exists, `requestId reminder:<item>:<gen>` + `posted` memo, stale timers end themselves, `reconcile()` re-links instead of duplicating. Snooze/complete/clear/delete cancel (tests + code). **Stop does not cancel reminders**: `repro5` passes (background tasks), but no test in the repo pins it.
- **Web Push**: payload is the constant `REMINDER_PUSH` (`reminder.ts:15`); logs carry only the endpoint host; `privateKey` is used only in `push/sender.ts:38`; `/api/push/config` returns the public key only; `vapid.json` 0600 via atomic write, `secrets/` forced 0700 (`config.ts:160-167`), a damaged file is an error, never regenerated; 404/410 prune; web-push `timeout` is honoured (idle-socket destroy).
- **New routes' guards** (`probe-guards.ts`, auth ON, real server): for `GET /api/push/config`, `POST|DELETE /api/push/subscribe`, `POST /api/approvals/:id`, `POST /api/admin/tasks/:id/retry`: no/wrong owner header 401, foreign `Host` or `X-Forwarded-Host` 403, `Sec-Fetch-Site: cross-site` 403, non-JSON 415, correct request normal (201/200/404). They sit under the global `/api/*` middleware (`http/app.ts:94-96`).
- **Retry endpoint**: 404 for anything not parked, `retryTask` only after a request; covered with a SIGKILL'd child (`crash.test.ts`).
- **Migrations**: M1 database (only `core/001_agents` + an agent row) upgrades to M2 with the four new ids, data kept, second run applies 0 (`probe-m1-upgrade.ts`); per-module prefix rule and unknown-id refusal tested.
- **Zero-token when nothing is queued**: idle write appends and settles `done`; busy write queues and is placed at the next boundary (tests: `callCount` unchanged).
- **Cards**: React text rendering (no `dangerouslySetInnerHTML`), approval state derived from notices and `expiresAt`, recorded-fixture test; screenshots 06 and 13 match the claims.

## E. Test-quality notes

- Strong: real SQLite + Durable, fake clock, crash windows simulated (hung `post` + close + reopen), real HTTP for the server, recordings of the real server for the web.
- Missing, each guards a finding above: durable rewind with a fired row (C1); replay of absolute `remind_at` after the clock passed it (C3); Stop keeps reminders (passes today); a faulted/late timer is repaired without restart (C4); SW `/\`, tab/newline, `null` payload (C5/C6); web push with a subscription bound to another key (U2; the current test pins reuse); `reconcile()` with an orphan row (C7); DST gap/ambiguity (N3).
- `reminders.test.ts:262-275` ("creates the timer a power cut took") simulates the lost-timer half only, by aborting the task; it does not cover the lost-card half (C1).
- The "settle" sleeps (150 ms) prove absence by waiting; they were stable in 3 runs but are the first place to look if CI flakes.

## F. What I did and did not do
- Ran: `pnpm typecheck|lint|test` (and 2 concurrent `pnpm test`), the repro/probe scripts above (temp dirs only; one in-process server on an ephemeral port for ~2 s), `node -e` URL checks.
- Patched **copies only**: `/tmp/m2-review-scratch/ext-copy` (extensions package: C1+C3 fixes, 70/70 tests; C2 variant: 69/70, the one test that pins model text) and `sw-patched.js`. The server suite was not re-run against these patches.
- Not done: build, browser, real push service, network, installs, any repo write, git mutation.
- Left in `/tmp` (deleting needs your yes): `/tmp/m2-review-scratch/`, `/tmp/m2-review-{typecheck,lint,test,test-a,test-b}.log`, `/tmp/review-m2-{baseline,after}.sha`. Worker leftovers noted in progress-m2 (`/tmp/m2-dev*.log`) are unchanged.
