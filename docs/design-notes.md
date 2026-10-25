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
   refused. Requests without the header (curl, older browsers) are not refused by this rule, except for uploads (below),
   where it is required.
3. **JSON-only writes** (`validation.ts`). Every POST/PUT/PATCH/DELETE must carry `Content-Type: application/json`. A page
   cannot send that cross-origin without a CORS preflight, and the server never answers preflights. This is what protects
   browsers that do not send `Sec-Fetch-Site`.

No cookies or CSRF tokens exist, so there is nothing to steal or forget.

### Uploads: `POST /api/uploads`, multipart

A multipart body cannot satisfy rule 3, so uploads are the one write that is not JSON, and they are built to make that
exception as small as possible (`apps/server/src/http/uploads.ts`, mounted in `http/app.ts`):

- **The exemption is the order of registration.** Hono runs middleware and handlers in the order they were registered, so
  the upload route is mounted after the `Host` guard and auth and *before* `requireJsonContentType`; every other route is
  behind that rule, and there is no list of exempt paths inside the middleware to extend by accident. A test proves both
  halves: the upload route refuses JSON (415), and every other write still refuses a form (415). Do not move the route and
  do not add another like it.
- **Rule 2 is required, not optional, on that route.** A request without `Sec-Fetch-Site`, or with anything but
  `same-origin` or `none`, is refused (403). Every browser the owner uses sends it and a page on another site cannot forge
  it; curl callers add `-H 'Sec-Fetch-Site: none'`. Rule 1 (`Host`) applies as everywhere.
- **One file per request, 20 MB** (`MAX_UPLOAD_BYTES`; a streamed body is counted, so it cannot be bigger than it
  announces): 413 with the size and the limit. `formData()` buffers, which is fine for one owner and 20 MB.
- **Judged by content, never by name or by the type the sender claimed** (`packages/extensions/src/files/sniff.ts`): PNG,
  JPEG, GIF, WebP and PDF by their signatures; otherwise UTF-8 text without a NUL byte, CSV when the name ends in `.csv`.
  Text that holds a private key is refused (415) so that a pasted key cannot end up in a file the PA will read. The stored
  extension follows the content (a PNG called `x.txt` is `x.png`).
- **Stored where the server decides**: `<data>/files/<yyyy-mm>/<id>-<safe name>.<ext>`, mode 0600, written to a temp
  file and renamed, then a `files_index` row. A failed insert removes the file; a crash between the rename and the insert
  leaves an orphan file (no sweep yet; it costs disk, nothing else).
- **Served back by `GET /api/files/:id`** only for uploads, only from inside the uploads folder (the path is resolved
  through links again), with `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, inline for images and as a
  download for everything else, so an uploaded HTML or SVG cannot run in the assistant's origin.
- **The message names the files**, not the request: the web app writes one `[Attached file: name · type · size · id fi_…]`
  line per file after the text (`withAttachments` / `splitAttachments` in `@assistant/shared`), and `POST …/messages` is
  unchanged. The model reads the lines and opens a file with `read_file`; the thread shows them as chips. A name that tries
  to carry a line break or a bracket cannot add a reference of its own.

**Behind the Next dev proxy.** Next buffers a proxied request body and, past `experimental.proxyClientMaxBodySize`
(10 MB by default, and it applies to the `/api/*` rewrite too), stops forwarding it: an 11 MB upload hangs and the browser
gets a 500. `apps/web/next.config.ts` sets the limit to the upload cap plus 1 MiB, so the server, which explains itself,
is what refuses a file that is too big. Production behind Tailscale Serve has no proxy; `next start` without Serve does.

**The Android share target** (`share_target` in the manifest → `app/share/route.ts` → `lib/share.ts`). The share sheet
POSTs multipart to `/share`; a page cannot read a POST body, so the route does, sends each file to the upload route and
redirects (303) to `/capture?…`, where the owner picks the agent and sends. The route does not vouch for the request
itself: it refuses unless `Sec-Fetch-Site` is `none` or `same-origin` (the API checks the same for a file, but a share with
no files never reaches it), and it passes `Tailscale-User-Login`, `Sec-Fetch-Site` and the page's host (as
`X-Forwarded-Host`) on to the API, so the API makes the same decisions it would for the browser itself. Text longer than
1500 characters would not fit an address and is stored as `shared-text.txt`; a refused file becomes a notice on the capture
page with the server's reason. The capture address is read defensively (ids must look like `fi_` and eight hex digits,
names lose line breaks and brackets). Untried on a device: Chrome is assumed to send `Sec-Fetch-Site: none` for the
share-sheet POST; if it does not, the share is refused with 403 and the fix is here. An installed web app (https) is
required for Android to offer it.

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
  keep working, and the card says so. So does every card a module posts by itself: a timer asks yes/no questions of its own
  ("did you wish Tashi a happy birthday?") at any moment of the 24 hours, and the owner's "yes" to it must not approve a
  deletion that was waiting before it. The poster the modules get (`closingYesWindow`) closes the window *before* it writes,
  so a card is never visible while a YES can still approve something; the approval service's own notices use the plain
  poster. A start-up repair that posts a card again closes the window too (a restart can cost a YES; the button never).
  A resent `requestId` returns the same notice and never approves a second request.

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

## Follow-ups, agendas and birthdays: the reminder design again

M3 adds two more things that wait for a time and then post a card: a meeting (`followups` module) and a person's birthday
(`people`). They use the design of [Reminders](#reminders-the-row-is-the-truth) unchanged: the row in `app.sqlite` is the
truth, the Durable task is a timer carrying `{ id, gen }`, a generation is taken before the task exists, `reconcile()` repairs
the pairing at start and every ten minutes, the cards are display-only writes, and the push is at least once. What they
share is code (`packages/extensions/src/timers.ts`: `createTimerScheduler`, one `TimerKind` per module); what differs is below.

- **A phase has to tolerate a timer that is back from before its own card.** A reminder has one phase that posts. A meeting
  has four (`agenda_wait → agenda_ping → ask_wait → ask`), so after a power cut Durable's database can bring the timer back to
  `agenda_wait` while `app.sqlite` already says the owner was asked. Treating that timer as superseded (the first version
  did, and a test with a rewound database caught it) would lose the question from the thread. So every phase accepts any row
  that is not resolved and has the timer's generation; the phases before the post fall through (an agenda that is too late is
  not posted, and the waits are already past) and `ask` posts again, idempotently. A birthday cannot do the same for the
  last phase of its cycle: finishing a cycle moves the row on with a new generation, so the rewound timer finds itself
  superseded and nothing posts the cards again. That one case is repaired by the row, not the timer: it keeps the latest
  morning card and evening question (`reminded_year/at`, `asked_year/at`, which outlive the cycle), and the server posts
  them again at start (`recoverCards`: the unanswered evening question of the last 24 hours, the morning card while its day
  is not over; same `requestId`, so a thread that has them keeps one, no push). Correcting a birthday forgets them.
- **The `requestId` of a card names what the card is about, not the timer.** `agenda:<followup>:<event time>`,
  `followup:<followup>:<ask time>[:reask]`, `followup:<followup>:<event time>:nudge`,
  `birthday:remind|check:<person>:<day>`. The *day*, not the year: a birthday corrected within the year must not have the
  new day's card swallowed by the old one's. A generation belongs to one timer, and the timer of a later generation (after a
  repair, say) must not post a second agenda or question for the same meeting; a meeting that moves gets a new time and so
  a new card.
- **The agenda is posted only when there are points, and only before the meeting began** (five minutes of grace). A timer that
  wakes late because the server was down all morning does not post "today's agenda" after the meeting; it goes on to the
  question, which is still worth asking whenever it is. A point added after the ping time is saved and shown by
  `list_followups`, and is not posted: there is no one to post it for.
- **The question is asked, and once more the next morning; the answer is a tool call.** After the question the timer waits
  for the morning after (09:00 local, `ASSISTANT_FOLLOWUP_REASK_TIME`; the next calendar day, so a question asked at 07:00 is
  not repeated at 09:00) and asks again if the row is still open, then stops: twice at most, the same card with a different
  stage. `record_outcome` (or `resolve_followup`) resolves the row and aborts the timer, and `record_outcome` with
  `needs_followup` creates the next link in the same transaction as the call ledger entry, so a replay makes no second
  link. A follow-up with no time is an error that tells the model to ask the owner when (the tool never guesses), and so is
  the contradiction "no follow-up, but here is when". What is still unanswered after the second question stays in the prompt
  section and in `list_followups`, and is an open loop for the morning briefing (M4), not for a nagging timer. A row that is
  `asked` and has not been asked again still wants a timer (`WANTS_TIMER`), and one made by the repair for such a row starts
  at the wait for the re-ask (`input.asked`), so a repair never asks the first question twice.
- **A commitment is due at its time.** A meeting is something the owner goes to; a commitment ("call the bank on Monday") is
  something they have to do, so its timer posts a nudge card and push at `event_at`, before the question at `ask_at`. A
  nudge that would arrive after the time of its question (the server was down) is left out: the question is enough. The
  nudge has its own push tag, so the question half an hour later does not replace it in the tray.
- **A date without a time of day takes a default time.** "On Monday" is accepted (`ASSISTANT_FOLLOWUP_DEFAULT_TIME`, 10:00
  local); the tool's result tells the model it chose the time, so that it tells the owner and can change it with
  `update_followup`. The choice is saved (`time_assumed`), so a call that Durable replays after a crash says the same, and
  `list_followups` shows it until the time is confirmed or changed. An end time (`ends_at`) is still required in full.
- **A meeting that moves keeps its agenda.** `update_followup` changes the title, who it is with and the time. A change of
  time bumps the generation in the same transaction as the ledger entry (the old timer is stale at once), puts an asked row
  back to waiting (the question was about a time that is no longer the time) and keeps the agenda points; a meeting that has
  an end keeps its length unless the new end is given.
- **A birthday is a yearly cycle kept in the row** (`cycle_year`, `remind_at`, `check_at`). When a cycle begins after its
  morning moment (a person added at noon on their birthday) the row has no `remind_at`, and the timer goes straight to the
  evening question. When it wakes late, the reminder is posted only within the day (a reminder to wish someone well tomorrow
  is no use), and neither card is posted for a birthday the owner said they wished. A recorded "not yet" does not silence
  the evening question; it is what it is for (and a "not yet" recorded earlier in the day does not count as the answer to
  the question that came after it). The evening question is also left out for a birthday more than two days ago: after a
  long stop "did you wish her?" about a birthday of months ago is noise. The cards say the date, so a late one is not
  mistaken for today's.
- **Finishing a cycle changes the row first.** The evening phase posts, then moves the row to the next cycle (a new
  generation, no timer), then creates the successor, then ends. If creating it fails the end of the cycle still happens and
  the periodic repair creates the timer, because every person always wants one. The next cycle is the first whose evening
  question is still to come, so a server that was off for two years does not post a card for every birthday it missed, only
  for the one it was waiting for.
- **Times of day are wall-clock times in the owner's zone** (`atLocalTime`, built on the same `zonedToUtc` as `parseWhen`), so
  09:00 is 09:00 on both sides of a change of the clock, and a time the clock skips moves to the later instant. 29 February
  falls on 28 February in a year without one (`occurrenceDate`).
- **People are shared data, the cards are not.** `people_person` is profile-level data (other agents may use it later), but
  for now only the PA has the tools, and a birthday card is posted into the conversation that created the person, like a
  reminder. Two things assume that the PA is the only one: the pushes link to `/chat/pa` whatever conversation the card
  went to, and `people_person.notes` is free text with no scope. Before another agent gets `add_person` or `list_people`
  (M5, M6): link the push to the card's conversation, and give `notes` a scope.
- **The `people` prompt section is the one that reads the date.** "Birthdays in the next 7 days" cannot be written without
  one, so it reads the Harness clock for the owner's local *calendar day* and prints absolute dates only: it renders the same
  bytes all day, and changes when a birthday enters or leaves the week (seven days, today included, like `list_people
  upcoming_days: 7`), when the evening question is asked or answered (it lists the open ones for three days) or when people
  change. The `followups` section needs no clock at all. A changed section does not re-render the prompt: Durable appends a
  system entry holding the section's whole new text, so the prefix stays cacheable and each change costs one such entry
  until the conversation is compacted (a handful per birthday and year), not a cache miss.

## Which tools the PA is offered

Every tool of the PA is in every request, so the PA carries only what it uses every day: `add_task`, `list_tasks`,
`complete_task`, `snooze_reminder`, `current_time`, `add_followup`, `add_agenda_point`, `record_outcome`, `add_person`,
`record_wish`. The rest (`update_task`, `list_followups`, `update_followup`, `resolve_followup`, `list_people`,
`update_person`, the three `propose_delete_*` and the three `delete_*`) are `deferred: true`: not offered until the model
loads them with `tool_search` (`@earendil-works/pi-durable/tool-search`, installed with the PA's extensions), which stays
loaded on that branch, also after a compaction. The PA's instructions name them, or the model would never look.

- **The approval hook does not depend on it.** A deferred `delete_*` tool can still be loaded (a search for "delete a task"
  finds it) and called, and the hook blocks it exactly as before: the guard is the hook, not the tool's absence.
- **A call to a tool that is not loaded fails before it runs** ("Tool X is not available"). That includes the dev model's
  `/tool`: it has to be preceded by `/tool tool_search {"query":"..."}` for these tools (README).
- **Tests that are about what a tool does** load every deferred tool up front (`openFixture`); the whole-server tests load
  them the way a model does.

## Changing a task that may be sleeping

A timer can sleep for a year (a birthday). Durable runs it again with whatever definition is installed *then*: a task whose
`version` does not match, with no `migrate` from the stored one, is **blocked** (`task_too_old`, `migration_failed`), and so
is one whose extension is gone (`missing_task`). A blocked timer never wakes, and the repair counts it as live, so the
reminder, meeting or birthday it stood for stops without a word. So: never rename or remove a phase of a task that has
shipped; add phases (the stored phases stay valid) or bump `version` and write `migrate`. The server logs blocked tasks at
every start (`[durable] N task(s) cannot run`), separately from the parked ones. The follow-up task grew its nudge and re-ask
phases before M3 shipped, so it is still version 1.

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

## The daily jobs: the row is the truth, once more

The morning briefing and the evening wrap-up (`packages/extensions/src/daily/`) follow the reminder design
([Reminders: the row is the truth](#reminders-the-row-is-the-truth)) with one row per job instead of one per item.

- **`schedule_daily`** holds the job, its local time, whether it is on, the run that is waiting (`due_date`, `due_at`), the
  latest day that ran (`last_run_date`), a generation and the Durable task that is its timer. A Durable task `app.daily`
  (phases `wait → run`, input `{ job, gen }`) sleeps until `due_at`; a timer acts only while it carries the row's
  generation, so editing a time, switching a job off or a run finishing leaves the old timer stale and it ends itself.
  `reconcile()` (`createTimerScheduler`, at start and in the 10-minute sweep) recreates the timer of a job that is on and has
  none. The rows are created at start by `ensureRows()`; that first timer is a set-up, which the log says apart from a
  repair (`DailyStart.created`).
- **Time arithmetic is calendar arithmetic** (`occurrence.ts`: `addDays` and `atLocalTime`, never "plus 24 hours"), so 07:30
  stays 07:30 across a clock change; tested for New York on 8 March and 1 November 2026. A wall time that does not exist
  moves to the later instant, one that happens twice takes the first (as `time.ts`).
- **The late window** is for a server that was down at the time: a briefing that wakes late still runs until 11:00 (210
  minutes after the default 07:30), a wrap-up for 180 minutes, both capped at the end of the local day; after that the day
  is skipped. It is deliberately **not** applied to a job's first row (a new data directory has no past: without this, a
  test run at 08:09 got a briefing nobody asked for) nor to an edit in Settings (setting 07:00 at 07:45, or switching a
  job on after its time, means tomorrow). A day that ran never runs again, however the time is edited.
- **The day's facts are a durable memo** (`TaskRuntime.memo`, first writer wins): if the process dies between gathering
  them and posting the request, the rerun uses the first attempt's plan, and the request id `briefing:<date>` /
  `wrapup:<date>` makes the post happen once. After a power cut, which can lose the request from Durable's database while
  `app.sqlite` remembers the run, start-up (`recoverRuns`) makes the request again for a job whose `last_run_date` is today:
  a thread that has it keeps one, a thread that lost it gets it. No second push for something old.
- **The request is a Durable input with a custom entry kind** (`app.daily`, `whenBusy: followUp`): the model reads the same
  text as a user message and starts a run; the thread shows a card (the facts folded) instead of a bubble and puts a chip on
  the first answer after it. The instructions for writing the briefing and for the wrap-up are in the PA's own rules
  (`PA_DAILY_RULES`), so the day's input is only facts. A briefing with nothing in it is a `write` with no model message: it
  never starts a run, so it costs no tokens, and the card says so. A wrap-up always asks (even with no facts) and creates its
  `pa_journal` row when asked.
- **Every question the jobs ask closes the YES window** (`closingYesWindowOnAsk`, like the timer cards): a "YES" typed to a
  wrap-up cannot approve a deletion that was proposed earlier.
- **Facts come from providers each module registers** (`DomainModule.facts` → `DomainDeps.facts()`): tasks (today with
  reminders, overdue), follow-ups (meetings today with agenda counts, open questions), people (birthdays today and in three
  days) and the journal (what the last answered day carried over, within three days). A provider that throws is left out and
  reported, the others still speak. Health and expenses add theirs later without touching the jobs; the wrap-up's "what the
  system knows happened today" comes the same way.
- **The journal** is `pa_journal` (one row per local day: the auto-summary the wrap-up was asked with, the owner's answer,
  the items carried over) plus `daily_call`, the call ledger of rule 8: `save_journal` replayed by Durable changes nothing,
  and a later call for the same day replaces the earlier answer (the model is told to merge). A date in the future is
  refused. The `journal` prompt section names the wrap-ups still waiting (last three days) so that "I paid the rent" typed
  the next morning finds its day.

## Files the PA can read

`read_file`, `describe_file` (offered), `search_files`, `list_dir` and `read_file_path` (loaded by `tool_search`;
`packages/extensions/src/files/`):

- **Their own reader** (`read.ts`), not Durable's nested `read` tool: it can be tested without a harness, bounded the way the
  PA needs (text and CSV: 200 lines or 32 KB per call, with `offset` and `limit` to go on), and holds the one answer for what
  cannot be read. Images go through Durable's image processor (`createNodePhotonImages()`, created in `server.ts`, so the model
  sees receipts at a size it accepts); PDFs and other binaries answer that the PA cannot read them yet. Text extraction from
  PDFs is a dependency decision for later.
- **The deny list holds through them, because they use the scoped file environment** (`api.env`: `canonicalPath` and
  `listDir` apply the path policy, links resolved, protected entries hidden). `list_dir` does not show `.env*`, `id_*`,
  keys, `auth.json`, `.ssh`, `.npmrc` or `<data>/secrets`; a direct read says why it refuses ("…is protected", "…is
  outside the folders the assistant may read (…)"). The whole-server test tries each, and links into them.
- **A file found in an allowed folder is registered in `files_index` when it is used** (`read_file_path`, idempotent by
  path), so the PA can `describe_file` it ("the March bank CSV") and `search_files` finds it again by name, description or
  tags (a `LIKE` over the three, every word must match; no ranking). Nothing is copied: a `path` file stays where it is.
- **Nothing here writes**: the only place the assistant may write remains `<data>/workspace`.
