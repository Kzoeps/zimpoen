# Design notes

Decisions that are not obvious from the code, and the reasoning to check before changing them.

## CSRF and cross-origin rules

Tailscale Serve tells the API who is calling with the `Tailscale-User-Login` header. That identifies a **device**, not a
page: a script on any website open in the owner's browser can make that browser send a request to the assistant, and
the request arrives with the owner's identity. The API therefore does not rely on identity alone. Three rules apply to
every `/api/*` request, with auth on or off:

1. **`Host` allowlist** (`apps/server/src/http/guard.ts`). `Host` must be `127.0.0.1:<port>`, `localhost:<port>`,
   `[::1]:<port>` or a name in `ASSISTANT_PUBLIC_HOST`. This stops DNS rebinding, where an attacker's domain is re-pointed
   at 127.0.0.1 so that the browser treats the API as same-origin with the attacker's page. Behind the Next dev proxy
   (which rewrites `Host`), `X-Forwarded-Host` must also be one of those names.
2. **`Sec-Fetch-Site`**. A POST/PUT/PATCH/DELETE that the browser marks as anything other than `same-origin` or `none` is
   refused. Requests without the header (curl, older browsers) are not refused by this rule.
3. **JSON-only writes** (`validation.ts`). Every POST/PUT/PATCH/DELETE must carry `Content-Type: application/json`. A page
   cannot send that cross-origin without a CORS preflight, and the server never answers preflights. This is what protects
   browsers that do not send `Sec-Fetch-Site`.

No cookies or CSRF tokens exist, so there is nothing to steal or forget.

### Uploads (planned, M4): `POST /api/uploads`, multipart

A multipart body cannot satisfy rule 3. The plan, to be done when uploads are built (no upload code exists yet):

- Exempt **only** that route from the JSON rule, by an explicit route-level allowance, never by loosening the middleware.
- Rely on rules 1 and 2 for it, and make rule 2 **required** on that route: a request without `Sec-Fetch-Site`, or with a
  value other than `same-origin`/`none`, is refused. Every browser the owner uses sends it; curl callers add
  `-H 'Sec-Fetch-Site: none'`.
- Apply its own body limit (the global one is 256 KB), a file-type allowlist, and store files under `<data>/files` with
  server-generated names.
- Add a test per rule: wrong `Host` → 403, `cross-site` → 403, missing `Sec-Fetch-Site` → 403, and a JSON POST to the same
  path still → 415.

## Two databases, two durability levels

`app.sqlite` is opened with `synchronous=FULL` (every commit is flushed), Durable's `durable.sqlite` with
`synchronous=NORMAL` (Chord's SQLite adapter; the last commits can be lost after a **power cut**, not after a crash of the
process). After a power cut `app.sqlite` can therefore be ahead of Durable: an `agents` row pointing at a conversation
Durable no longer has, which the server refuses at start with an explanation. It cannot happen on a process crash or a
normal shutdown. The laptop is on mains power but has no UPS. Accepted for M1 (the only cross-database reference was the
agent's conversation id, created once).

**Resolved in M2 by making the reference self-healing, not by raising Durable to `FULL`.** M2 added the second
reference: a `tasks_item` row points at the Durable task that fires its reminder, and after a power cut the row can
survive while Durable loses the task. Raising Durable's database to `FULL` would mean reaching into Chord's SQLite
adapter before `SqliteStorage.open`, which ties us to its internals, and it would not be enough anyway: even with `FULL`
on both, a crash between the two commits leaves the databases apart, so the repair would be needed regardless. Making the
row the truth needs neither; see [Reminders: the row is the truth](#reminders-the-row-is-the-truth). The `agents`
reference is unchanged: a row pointing at a conversation Durable lost is still refused at start, with an explanation.

The repair has to work in both directions, because a flag in `app.sqlite` is **not proof that Durable has the thing it
talks about**: `tasks_item.reminded_at` and `pending_actions.notified_at` are written with `FULL`, the card and the notice
they describe with `NORMAL`. After a power cut the flag can survive while the card or notice is gone. So a reminder timer
that comes back from before its card was written does not treat "the row says sent" as "done" (it posts the card again, which is
idempotent), and at start the approval service asks again for the outcome notices of the last 24 hours (same request id,
so a notice that is there is found, one that is not is written). A duplicate beats a reminder that never reaches the thread.

## One server per data directory

`<data>/server.lock` (apps/server/src/file-lock.ts) is taken before anything else is opened, and the port is bound before
Durable is opened. Durable has no fence between processes: `Harness.open()` marks every running task as restarted, so a
second process on the same data would steal the first one's work and count crashes that never happened. The lock records
the pid and, on Linux, the process start time, so a lock left by a crash, or by a boot before which the pid was reused,
is recognised as stale. Two processes taking over the same stale lock at the very same instant is narrowed, not
eliminated; that is accepted for one person's laptop.

## What is not retried

A task that Durable parked (`restart_limit`) stays parked: the server reports it (error log at every start, the count and
the parked tasks in `GET /api/agents`, a banner in the web app) but never calls `retryTask()` itself, because the usual
cause is something that keeps killing the process (out of memory, a bad input) and retrying would loop. The owner can
retry: the banner's Retry button calls `POST /api/admin/tasks/:id/retry`, which retries a task that is parked right now
(404 for any other id) and only on that request. Look at why the process died before pressing it.

## Reminders: the row is the truth

A reminder lives in two databases: a `tasks_item` row in `app.sqlite`, and a Durable task (`app.reminder`) in
`durable.sqlite` that sleeps until the due time. No transaction spans the two, so the design does not pretend there is one.

- **The row decides; the Durable task is a timer.** The row says whether a reminder is wanted and which one
  (`remind_gen`). The timer carries `{ itemId, gen, at }` and fires only while the row is open and still has that `gen`
  and `remind_at`. Rescheduling, snoozing, completing and deleting change only the row (and abort the old timer as
  housekeeping); a timer that was not aborted ends itself, without posting, when it wakes. Whether the reminder was
  already sent (`reminded_at`) is deliberately not part of that question: a generation belongs to exactly one timer, and
  after a power cut the timer can be back from before its card was written while the row says "sent" (see
  [Two databases](#two-databases-two-durability-levels)). Such a timer posts the card again and pushes again.
- **The generation is taken before the task exists.** `ensureScheduled` bumps `remind_gen` in `app.sqlite` (only for a row
  with no timer linked), then creates the Durable task, then links it. If the process dies in between, the rerun of the
  same tool call takes a newer generation, and the first attempt's task, if it was created, is stale. Nothing has to go
  looking for the orphan.
- **`reconcile()` runs at every start and then every 10 minutes** (`packages/extensions/src/tasks/scheduler.ts`). A row that
  wants a reminder but has no live timer of its generation gets one: a power cut took the timer from Durable's database, the
  process died before it was created, or Durable ended it after an error (a faulted task is never retried by Durable, and the
  row would otherwise point at it for ever). A live timer the row does not point at is linked, instead of making a second
  one that would fire twice. It works row by row: a task whose conversation is not in Durable (what `DELETE FROM agents`
  leaves behind) is reported once, with the SQL that drops its reminder, and does not keep the server from starting.
- **A tick wakes sleepers that came due.** `harness.resume()` runs every 30 seconds. Durable arms one timer for the
  earliest sleeper; on Linux Node's timers use a clock that does not run while the machine is suspended (standard behaviour,
  not measured on this laptop), and a step of the wall clock does not move it either, so a reminder can come due with
  nothing noticing. `resume()` runs every sleeper whose time has passed and does nothing otherwise. It cannot wake a machine
  that is asleep: see [`OPS.md`](OPS.md).
- **Firing posts once.** `fire` writes the card with `requestId = reminder:<item>:<gen>`, and a second write with the same
  id returns the first entry, so a rerun after a crash cannot duplicate the card. A `posted` memo lets the rerun skip even
  the call.
- **The card is display-only; the model learns about it from the prompt.** A write that carries model text is input for
  Durable's next run, and for an idle conversation that still has a queued message (a run failed because the model was
  down: `afterFailedRun: keep`) it starts that run. A reminder would then cost tokens and fail like the run before it, and
  the title of a task would reach the model as a message of the owner. So reminder cards and approval notices never carry
  model text (`createEntryPoster` has no way to). What "snooze it" needs comes from the database: the `tasks` prompt section
  lists the reminders that were sent for tasks that are still open.
- **The push is at least once after a crash, best effort otherwise.** A crash between sending the push and ending the task
  sends it again (one `tag`, so the phone replaces the banner instead of stacking another). A push service that is down or
  refusing is logged and not retried, and never faults the task: the card is in the thread, and the push is only the nudge.
- **Reminders are `background` tasks of the conversation.** The Stop button aborts a conversation's tasks, and a task
  waiting for a due date in two days would otherwise keep the conversation "busy" the whole time. Background tasks do
  neither.
- **Late beats never.** A reminder that came due while the server was down fires at the next start. Its card shows the
  time it was due, not the time it fired.

## Approvals

Rule 3 of the plan (deletes need explicit approval) is enforced in code, in three places that do not rely on each other.

- **The hook is the enforcement** (`packages/extensions/src/approvals/index.ts`). `hook(ToolTask, { beforeTool })` blocks
  any tool registered as destructive (`delete_task`) unless an approved, not yet executed request exists for exactly that
  conversation, tool and target (a canonical name such as `task:t_ab12cd34`). Arguments the module cannot name a target
  for are refused too. The model sees the block as a tool error that says to call `propose_delete_task` and wait. Nothing
  in the prompt is what protects the data.
- **The model asks; the server executes.** `propose_delete_task` creates the request (idempotent by tool call id; an
  identical waiting request is reused) and returns an approval card. When the owner approves, the server runs the action
  at once (`ApprovalAction.run`, safe to run twice) and writes the outcome as an `app.notice` entry. It does not wait for
  the model to call the tool: a model that never comes back would leave an approved but undone request. `delete_task`
  stays visible to the model only so that the hook guards something real (hiding it would leave a rule nothing could
  exercise); it passes the hook in the narrow window between approval and execution (a crash), and
  `ApprovalService.recover()` at start finishes those and posts notices that never made it. A model that calls
  `delete_task` directly wastes one turn.
- **YES is handled by the server, not by the model, and only when it is plainly the answer.** In
  `POST /api/conversations/:id/messages`, a message that is exactly "YES" (trimmed, any case) approves the request waiting
  in that conversation when **exactly one** request waits and the owner **has said nothing else since it was made**. The
  model never sees it and no user bubble is made; the outcome notice says "You replied YES. ...". Everything else is an
  ordinary message that goes to the model: "yes please", "y", "yes, but later" (a sentence is not an answer to a question
  about destroying data); a YES with nothing waiting; a YES with two requests waiting (which one?); and a YES after any
  other message of the owner, because a "yes" typed after "shall I list tomorrow's tasks?" answers that question, not the
  card. Every message that is not taken as an answer closes the YES window of the requests that were waiting
  (`pending_actions.yes_ok`, set by `ApprovalService.tryYes`, the one place every message of the owner passes); the buttons
  keep working, and the card says so. A resent `requestId` returns the same notice and never approves a second request.

The outcome notice is display-only (no model text, see [Reminders](#reminders-the-row-is-the-truth)): the model finds out
whether an approved deletion went through by looking at the list (`list_tasks`), and the tool result of `propose_delete_task`
says so.

State and expiry. Entries are immutable, so the approval card never changes: the UI derives approved, denied, executed or
expired from the later `app.notice` entries that name the request, and shows "expired" once `expiresAt` has passed with no
notice. The server is authoritative: a button pressed too late gets 409 `conflict`. A request expires after 24 hours (closed
when touched, every 10 minutes, and at start). An action that fails ends as `failed`; nothing retries it, the owner asks
again.

## Web Push subscriptions

A push goes browser vendor → phone, so a subscription has a life of its own that the server can only guess at.

- **A subscription is bound to the server's VAPID key.** If `<data>/secrets/vapid.json` is lost and made again, every
  existing subscription keeps "working" in the browser while the push service refuses each send, and subscribing again with
  the new key throws `InvalidStateError` until the old subscription is gone. So `enable()` compares the key a subscription
  was made with against the server's current one and replaces a stale subscription (unsubscribe in the browser, delete its
  endpoint on the server, subscribe again).
- **Subscriptions rotate and expire** without anyone being asked. Two things notice: every time the app opens, `PushSync`
  (`apps/web/src/components/push-sync.tsx`) re-registers the device's subscription with the server (idempotent upsert, which
  also heals a `POST` that failed while offline or a row the server pruned after a 410); and `sw.js` handles
  `pushsubscriptionchange` by registering the new subscription and deleting the old. Neither asks for permission or makes a
  first subscription: "Turn off" stays off. Neither could be tried with a real push service here, only with fakes.
- **One tag, `renotify`.** Every reminder push has the tag `reminder`, so a second one replaces the first in the tray (and a
  duplicate sent after a crash does not stack). By the Notification spec a replacement is silent unless `renotify` is set,
  so `sw.js` sets it.
- **The VAPID `sub` claim must be a real contact.** `ASSISTANT_PUSH_SUBJECT` has no default in `web-push` mode: some push
  services are reputed to refuse a placeholder such as `mailto:assistant@localhost` (not verified), and the result would be
  reminders that never reach the phone. `fake` mode keeps the placeholder.
- **The server posts to every endpoint it stores**, so it refuses an endpoint that is not a public host name (an address, a
  one-word host, `*.local`, `*.ts.net`, ...), and stores at most 20 devices. This is not an allowlist of vendors: those
  would refuse a vendor that is not on the list, and only the owner can send an endpoint (identity, `Host`,
  `Sec-Fetch-Site` and JSON-only rules). A subscription whose `p256dh` is not a valid curve point is still only found out
  when a send fails; nothing prunes it.

## Time in prompts

No prompt section contains the time. A section is rebuilt before every request and costs something only when its text
changed, since a prompt that did not change can be served from the provider's prompt cache. A clock in a section would
change it on every request and defeat that each time. So the `tasks` section (the number of open tasks, the next three
due, and the last few reminders that were sent for tasks that are still open) renders the same bytes however much time
passes, which a test pins, and it never says "overdue". It changes only when a task, a due date or a reminder does.

The model gets what it needs another way:

- the `current_time` tool returns the date, weekday and zone from the Harness clock. It is called only when the model has
  to turn "tomorrow" or "next Friday" into a date;
- `remind_in_minutes` (on `add_task` and `update_task`; `snooze_reminder` takes `minutes`) means "in ten minutes" needs no
  clock at all;
- `remind_at` is ISO 8601 in the owner's zone. The tool validates it, refuses a time in the past and says what time it is
  now, and stores UTC milliseconds. A call that Durable replays after a crash is answered from what its first run saved
  *before* any of that is checked, because the check reads the clock and the replay runs later than the first run did.
- a wall-clock time that does not exist (the clock jumped forward) moves to the later instant, one that happens twice takes
  the first (`time.ts`); it only matters if `ASSISTANT_TIMEZONE` is a zone with daylight saving time.

Rejected: a timestamp on every user message. It changes every message, spends tokens on every turn for a need that arises
rarely, and would change what the dev model echoes for every agent.
