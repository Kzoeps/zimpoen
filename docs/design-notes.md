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

## Health: weight and lifts

The `health` module (`packages/extensions/src/health/`) belongs to the Health agent alone: its extension (tools and the
`health` prompt section), the approval hook that guards its deletions, and `tool_search` are in that agent's list, and the
PA has none of them (capability by tool presence; a whole-server test shows the PA's `/tool log_weight` refused).

- **Kilograms in the database, always.** Pounds are converted once, where they come in (`unit: "lb"` on `log_weight` and
  `log_workout`, `0.45359237` exactly, rounded to 10 g), and every number after that is kilograms. Cards and tool text share one
  wording (`formatKg`, `signed`, `formatVolume`, `describeSetGroup` live in `@assistant/shared`), so the thread and the model say
  `62.5` and `5x5 100 kg` the same way. A body weight outside 20 to 500 kg, or a set above 1000 kg, is refused with a hint about
  the unit rather than saved.
- **One weighing a day, by the schema.** `health_weight.measured_on` is `UNIQUE` (the owner's local day). A second `log_weight` for
  a day is refused with the existing value and what to do; `replace: true` overwrites. The insert is idempotent by `source_call_id`;
  a replacement is recorded in the ledger `health_call` in the same transaction, so a replay of an *older* call after a later
  correction changes nothing (the same pattern as `tasks_call`). The tools that write (`log_weight`, `log_workout`,
  `rename_exercise`) look for their own earlier result before they read the clock, so a call replayed after midnight lands on
  the day it was made for; the `propose_*` tools resolve `today` and `yesterday` first, so a proposal replayed after midnight may
  meet another day, which at worst says there is no weight there (the approval service hands back the request the call id made, so
  nothing is proposed twice and nothing else is deleted). A weight 4 kg or more from the previous entry within two weeks is
  saved, and the result tells the model to check the unit with the owner (`replace: true` fixes it).
- **A workout is written whole.** One `log_workout` call is one `health_session`, written with its sets (and any exercise it
  needs) in one transaction under the call's id: a rerun finds the session and returns it, or finds nothing and writes it all.
  Each set also carries `<call id>:<n>` in its own `UNIQUE` column. `count` expands to identical sets (5x5 at 100 kg is one entry
  with `count: 5`). Two calls on one day are two sessions, and every chart and the wrap-up group by *day*, so they are one point.
  What a workout did (a record, an exercise it named for the first time) is read back from the database, not remembered: the
  sets before a workout are those of the sessions written before it (by row order) and dated no later than it, and an exercise
  is new when nothing came before it and it was made with the session, so a rerun after a crash tells the model exactly what the
  first run did.
- **Exercise names.** A name is compared by its key (lower case, letters and digits of any script, accents dropped, so
  `Bench-Press`, `bench press`, `benchpress` and `Тяга блока` agree with themselves) and with a trailing plural dropped on either
  side (`squats`, `lunges`, `presses`, `flies` for `fly`; the exact spelling wins). It is looked up in the owner's exercises (name and
  aliases), then in a built-in list of about 40 (`catalog.ts`: `bench`, `ohp`, `rdl`, `pull ups`, ...), which creates the exercise
  with the list's name, aliases and kind on first use and says nothing (a built-in name the owner renamed is found under its new
  name, not made again), and otherwise a new exercise is created under the name as typed, its kind taken from the sets (no weight
  anywhere: bodyweight). The result tells the model the kind it got and what follows from it, and how to fix a slip: merge it into
  the exercise it should be, or rename it. An exercise left with no set by a deletion is removed, so a wrong name does not
  stay in the list. The prompt lists the owner's exercise names so that the model reuses them.
- **Renaming and merging** (the coordinator overrode the first design, which had neither). `rename_exercise` gives an exercise
  another name and keeps the old one, with its built-in aliases, as aliases; it is not destructive, so it asks nothing, and it is
  idempotent by the call ledger (a replay after a later rename does not undo it). A name another exercise already answers to is
  refused with the way out (merge). `propose_merge_exercises(from, into)` asks the owner first like a deletion (`merge_exercises` is
  the guarded tool, `deferred` with the deletion tools): on Approve every set of `from` moves to `into`, numbered after the
  sets `into` already has in the same workout, `from` is removed and stays an alias of `into` together with its own. The pair is
  checked before the owner is asked: an exercise cannot be merged into itself, and sets with no weight cannot join a *weighted*
  exercise (they would be zeros in its line); the other way round is fine. Both exercises' arguments are stored as ids, so a
  rename between the proposal and the answer cannot change what is merged.
- **Kind and metric.** The *kind* says what a set needs: `weighted` (squat, bench) needs a load on every set, which is refused
  otherwise, because a forgotten weight is the likelier mistake; `bodyweight` (pull-up, dip, push-up) needs none. A weighted
  movement really done with no weight is logged under its bodyweight twin, `Bodyweight lunge` (the refusal names it; the built-in list
  has the common ones). What the progress is *measured in* is derived from the sets and never stored, so it cannot be wrong for
  good: a weighted exercise by estimated one-rep max, Epley `kg x (1 + reps / 30)` (one rep is the weight itself; it drifts above
  about ten reps, which is why every text says "estimated"); a bodyweight exercise by repetitions in a set **until a set of it
  carries added weight** (a belt, a vest), from then on by the estimated 1RM of that added weight, unloaded days counting 0. So
  loaded dips (8, then 8 with 20 kg, then 5 with 30 kg) show progress, and a new exercise first logged without a weight (`bodyweight`)
  follows its load as soon as one is logged, with no rename, no delete and no change of kind. Unloaded days of a loaded exercise are
  ordered by reps and are never records (the load comes first). The **top set** of a day is the set with the highest metric, the
  heavier of equals, then the one with more reps; **volume** is the sum of reps x kg; a **personal record** is a day whose metric is
  *strictly* better than every earlier day's (an equal day is not one, the first day is the baseline), judged against the whole
  history even when the range is shorter, and `exercise_progress` reports the best ever separately when it is older than the range.
  The heaviest weight is taken from every set (110 x 3 can be heavier than the top set 105 x 5). Records are counted per **day** by
  `exercise_progress` and the wrap-up, and per **session** when a workout is logged: it is judged against every set logged before it,
  dated that day or earlier (a late entry is not judged against later days), so a second session on a day that beats the first announces
  its own record ("was 122.5", not "was 116.7") while the day counts once.
- **The moving average is over calendar days.** The 7-day average at a weighing is the mean of the weighings of the 7 days up to and
  including it; days without one are not zeros. Weights are kept to 10 g, so every sum, mean, difference and total is worked out in
  whole hundredths of a kilogram and rounded once, where it is shown (half away from zero): rounding a rounded mean, or subtracting
  two floats, was 0.1 kg off in a few percent of cases (72.44 and 72.45 average 72.445, which is 72.4; 71.35 after 71.2 is +0.2). A
  test holds the numbers to an integer oracle over 300 random histories. A range fetches six days before its start, so the average at its first point is
  what it would be had the range begun earlier. The trend is the average at the latest weighing minus the average at the first;
  the weekly rate is given only when the entries span two weeks or more. BMI needs `ASSISTANT_OWNER_HEIGHT_CM` and is a number, with
  no category: a label such as "overweight" is a medical judgement the agent is told not to make.
- **Ranges** are `7d`, `12w`, `6m`, `1y` or `all` counted back from today (today included), or explicit `from`/`to` days; never both.
  A count reaches back 100 years at most (`5000y` is refused, not read as another century). A chart card carries at most 90 points
  (`MAX_CHART_POINTS`) because it is stored in the thread for good: the first day, the latest five (the days the card lists), the
  newest records (at most half of the room) and the rest spread evenly; the summary always covers every entry, and a card of any
  history is under 10 KB (measured: 9.7 KB with a record on every day; the review's 300-day card was 31 KB before the cap).
- **The prompt section has no clock.** It lists the latest weight with the average *at that weighing*, the day of the last workout
  and the current record of the five exercises trained most recently (by logged day), all as absolute dates, so it renders the
  same bytes until something is logged (a test pins it). The records are the best day ever, not "this month's".
- **The daily jobs.** The wrap-up gets a "Health today" section (what was weighed, what was trained, the records the day set); the
  morning briefing gets a "Health" nudge, written by code, only when yesterday has no weighing, today has none yet, and the owner
  logged at least once in the 14 days before (`NUDGE_WINDOW_DAYS`): someone who stopped logging is not nagged every morning, someone
  who never logged is not nagged at all. The push payload stays generic; the PA is told to word the line kindly.
- **Deleting and merging** follow the approvals design unchanged: `propose_delete_weight` (by day), `propose_delete_workout` (by id)
  and `propose_merge_exercises` (by name, stored as ids) create the request, the server executes on Approve or YES, and the guarded
  `delete_weight` / `delete_workout` / `merge_exercises` exist so the hook has something to guard. All six are `deferred`, as the
  PA's deletion tools are, and the instructions name them. The YES window is per
  conversation, so a YES in the Health thread approves only the Health thread's request.
- **`current_time` is defined twice** (tasks, for the PA, and health): the Health agent has no other way to know today's date for "last
  Friday" and the prompt may not carry one. The two never share an agent, and Durable composes tools by name per agent.
- **Height is not in the profile section.** `ASSISTANT_OWNER_HEIGHT_CM` goes to the Health module only (`Config.health`, then
  `DomainDeps.health`), so the other agents' prompts and cache are untouched; it is deliberately not a field of `ProfileConfig`, which
  is handed whole to the extension every agent has. The BMI shows in weight results and in the Health prompt section only when it is
  set. A server test reads what each agent was *told* (its system messages) and finds the height in the Health agent's and nowhere else.
- **What the provider sees, and the prompt cache.** Weight, BMI, workouts and notes are chat content like any other and go to the model
  provider; the PA receives a few lines of them as daily facts. Every logged weight or workout changes the `health` section, so the
  next request appends a system-prompt delta and misses the provider's cache once (as the tasks section does); the render is
  otherwise byte-stable. Tool call ids are assumed unique per conversation, across a change of model, as in M2 to M4: a repeated id
  would be answered as a replay and write nothing.
- **Charts are SVG without a library** (`apps/web/src/lib/chart.ts` lays out ticks, scales and paths; `components/health-charts.tsx`
  draws them). The layout is a pure function, tested without a browser; the card components are plain functions of their card, tested
  by rendering to markup. The drawing scales through its `viewBox` (360 x 176), colours are CSS variables, so a 390 px phone and dark
  mode need no special case. Vitest turns JSX into calls through `oxc.jsx` in `vitest.config.ts` (the web app's `tsconfig` says
  `preserve` because Next compiles it).

## Accountant: ledger, splits, invoices

Three modules (`packages/extensions/src/ledger/`, `splits/`, `invoices/`) belong to the Accountant agent alone. Its extension list
is `ledger`, `splits`, `invoices`, `files` (receipts and statements are read with `read_file`), the approval hook, `tool_search`
and code mode; the PA and the other agents have none of the three modules' tools (a whole-server test shows the PA's
`/tool add_expense` refused). Rule 7 is the point of all three: **every number is computed in code**, and the instructions
(`ACCOUNTANT_RULES` in `apps/server/src/agents.ts`) tell the model to pass amounts exactly as stated and never to add, convert or
split anything itself.

- **Money is integers, and text becomes an integer by its digits.** Storage is `INTEGER` minor units in `STRICT` tables (chhertum,
  cents, paise; `currencyExponent` knows the few currencies that are not hundredths), signed from the account's side. A tool call
  carries an amount as a JSON number of major units; `toMinor` reads the *digits* of its shortest decimal form (`19.99` is 1999, never
  `19.99 * 100`) and refuses more decimals than the currency has instead of rounding: `12.345` for BTN, or a `1004.9999999999999` the
  model computed, is an error that says so. Sums, shares and conversions are BigInt, rounded half away from zero once.
  Nothing is fetched: an exchange rate is a number the owner gave (`ledger_fx`, insert-only, six decimals).
- **A balance is the latest stated balance plus what was written after it.** `set_balance` stores a snapshot (the amount, the day and
  the highest entry `seq` it saw). Entries dated after the day count, entries dated before are inside the stated balance, and entries
  of that same day count only if they were written after it. That makes "I spent 450 on lunch, my balance is 12,000" and the same two
  sentences the other way round both right, and a backdated snapshot never replaces a newer one. `set_balance` reports the difference
  against what the entries explained and writes no adjustment entry: the owner's statement is the truth, and the difference is told, not hidden.
- **Spending is outflow that is not a transfer.** A transfer is two entries sharing a `transfer_id`; it is neither spending nor income.
  Income (a refund too) is reported next to spending and never netted against it. Shares of a summary are tenths of a percent from the
  same largest-remainder `allocate` as everything else, so they add up to exactly 100.0 %. Other currencies are listed apart unless
  `convert_to` is given, and then each entry converts at the owner's latest rate on or before its day.
- **A CSV is imported in two steps, and what was shown is what is written.** `import_csv` reads the file through `api.env` (the path
  policy holds), detects the encoding (UTF-8 with or without a BOM, UTF-16, else Windows-1252), the separator, the header (it may sit
  below title lines), the columns and the date order (day-first when every date is ambiguous, and the preview says so), and keeps the
  parsed rows in `ledger_import` with the preview. `confirm_import` writes those rows, not a second reading of the file. Entries are
  deduplicated by a fingerprint (account, day, amount, description, and a counter for identical rows within one file) in
  `ledger_txn.import_hash UNIQUE`, so the same statement twice, or two that overlap, adds nothing. Confirming is idempotent by status
  and by its call id. A preview nobody confirms stays in the table until it is.
- **A statement is text from outside, and a wrong reading costs the owner's numbers.** Four rules come from that.
  *Reading is linear*: the clock time at the end of a date cell is found by one pass over its colons (the regular expression it
  replaced was quadratic, and one cell of 40,000 spaces held the server's only thread for six seconds), and a cell longer than any
  date is not a date. *Which way the money went* is read from a column of DR/CR or Debit/Credit words (`mapping.direction`) next to
  one unsigned amount, from `Amount (Dr/Cr)` with the word in each cell, or from separate debit and credit columns; a header that says
  Debit over cells that say DR or CR is one signed column, and the narration beats a reference number as the description. The
  preview *warns* when ten or more rows all go one way and says what to check. *A row that repeats an entry already there* is
  found by account, amount and a date within two days of an entry typed in chat or read from a receipt (each entry answers for one
  row, the nearest day first, never an entry another import wrote): such rows are listed with the entry they look like and are left out
  unless `confirm_import` is given their line (`include_lines`) or `include_matches`, so that the owner's lunch is not counted once
  from chat and once from the bank. Rows dated after today are left out, as the chat refuses such a day. *A wrong import can be taken
  back as a unit*: `propose_undo_import` asks for approval and then deletes the entries whose `source_ref` is the import
  (`ledger/004_undo` marks the import `undone_at`; confirming it again is refused and the file can be read again).
- **A bulk recategorization can be seen first and taken back.** `recategorize` matches a merchant by its key (case, accents,
  punctuation and order numbers aside): the whole name by default, whole words with `match: "words"`, never a piece of a word ("tea"
  no longer takes "Steak House"). More than 20 entries change only on a second call with `confirm: true`, after the first showed the
  merchants, the categories they come from and a sample. Each change is a batch that keeps every entry's earlier category
  (`ledger_recategorization`), and `undo_recategorize` puts back what is still in the category the batch gave it.
- **Every tool is idempotent by its call id (rule 8).** Entry-creating tools use `source_call_id UNIQUE` (a transfer's second leg is
  `<call>:in`, an import's rows `<call>:<n>`); tools that change a row that exists (`recategorize`, `archive_account`,
  `set_invoice_profile`) record their call in a ledger table in the same transaction, so a replay after a crash is recognised and a
  later change is not undone; each looks for its own earlier result before it reads the clock, so a call replayed days later says the
  same words. Deleting an entry or a bill is `propose_delete_*` and the owner's approval, like everywhere else.
- **Code mode, without the paid calls, and with a time limit that is really applied.** The accountant can write a script; it is
  given `ledger_query` and `ledger_accounts` (`callers: ["tools"]`: not offered to the model, callable from a script) and may call every
  other tool the Accountant has, the writes included, each under the same approval hook (a script calling `delete_txn` is blocked); it
  has no network, no files and no model. The sandbox is QuickJS in a worker (256 MiB), created with `models: false`:
  `models.classify()` and `models.generateImages()` are calls to a provider that cost money and send data out (PLAN rule 1), so a
  script sees none. A script's nested calls have their own call ids (`<call>/c<n>`), so rule 8 holds inside a script and a replayed
  script writes nothing twice. `ledger_query` pages are at most 1000 rows, because Durable journals a script's results.
  **The time limit is written into the script.** Durable starts a script with the `timeout_ms` of the script's own `// @options`
  line and nothing else (the sandbox's configured `timeoutMs` is not read on that path): a script that names none ran until the
  owner pressed Stop and again after every restart, and one that named a day was allowed a day. `createBoundedCodemodeExtension`
  (`packages/extensions/src/codemode.ts`) wraps the tool so the line is always there: 30 seconds by default, a request above two
  minutes cut to two minutes. Durable then also stores the script's deadline, so a script that a restart interrupted past its
  deadline ends with "its deadline passed while it was interrupted" instead of starting again.
- **Splits are written whole and add up exactly.** `split_bill` writes the bill, its items and every share in one transaction
  (`splits/compute.ts` is pure). Each item is shared equally by those who had it; a person's claim on the items is the sum of their
  parts as an exact fraction (a common denominator, BigInt), and rounding happens once per person by largest remainder, not once per
  item, so three items of 1.00 shared by three people give each exactly 1.00. Tax, service and tip are shared in proportion to what each
  person's items came to, the same way; a percentage is of the items alone, never compounded with the other extras. A `total` the model
  read from the bill is a check: when it differs from what the items and extras come to, the call fails and names the difference, which
  is how a misread line is caught. The payer need not be among the people (they paid for others), and the result says so when they are
  not, because "I paid for lunch with Pema and Tashi" with the payer left out of `people` would otherwise split between two.
  People are matched by the key of their whole name (accents, case and punctuation dropped); `me`, `I`, `you`, the configured owner
  name are the owner, shown as "You". A new name that shares words with a known one ("Pema" after "Pema Dorji") is flagged in
  the result of a bill, which is how a friend joins; in `record_settlement` it is **refused**: nothing is recorded and the tool
  asks which person was meant (`new_person: true` says it really is somebody else), because a payment from "Pema" would otherwise
  become a debt of a second person and leave the real one open.
- **Who owes whom is netted per pair of people and currency.** Every share of someone other than the payer is a debt to the payer,
  every settlement a payment against it; opposite debts cancel, and nothing is converted between currencies. "Unsettled splits" in the
  prompt is therefore the number of open pair balances, listed with the owner's first. **Splits do not write ledger entries**
  (decision for the coordinator to veto): the owner's own share is recorded with `add_expense` if they want it there, and a friend's
  payment back reaches an account when the owner next states its balance. The result of each tool says so.
- **Invoices: a profile, a template, and a number taken with the row.** `invoice_profile` holds what stays the same (client, usual
  amount, the line, terms, payment details, the numbering pattern and the running number). `generate_invoice` runs one call at a time
  in the process (Durable may run two calls of a round at once, and there is one server per data directory): replay by call id,
  defaults (this month, today, due after the terms), a second invoice for a month refused unless `again`, the number from the pattern
  (`INV-{YYYY}-{seq:03}`) checked as unused, **the PDF rendered first** (a template that fails uses no number and leaves no file),
  the file written through a temporary name and renamed, indexed in `files_index` (`source: generated`), and then one transaction
  that bumps the running number *from the value that was read* and inserts the invoice row (`UNIQUE number`), failing with "the
  profile changed meanwhile" if the number moved. A crash between the file and the row leaves a file the replay overwrites with the
  same name. `preview_invoice` renders the same PDF with PREVIEW drawn across every page (over the template, which cannot remove it)
  and takes nothing: no number, no row, no file among the real invoices (previews are `workspace/invoices/previews/`, one per call).
  It also previews a month that already has an invoice, and says so, which is what trying a changed template needs.
- **The template is Mustache over a documented set of fields, rendered by a small HTML layout over pdfkit.** `mustache` fills
  `<data>/templates/invoice.html` (read fresh at every invoice, so an edit takes effect at once); `{{field}}` is HTML-escaped, the
  `*_html` fields are escaped by this program for `{{{field}}}`, and a name that is not a field is an error that lists the fields
  (Mustache would print nothing for a typo, which on an invoice is the worst failure). The result is read by `invoices/html.ts`, a
  tolerant parser of the subset an invoice needs (scripts and styles dropped with their text, unknown tags transparent), and laid out by
  `invoices/pdf.ts` with **pdfkit**: pure JavaScript, the standard Helvetica fonts, no browser and no file at run time. Chromium was
  not chosen: it is not reliably present on the machine, and a browser is a large thing to run for a page of text. The layout paints in
  one pass and measures in a dry run (a table row's height, a box with a background); text is wrapped by this code, because pdfkit's
  own continued text aligns each fragment of a right-aligned line separately. Text outside Latin-1 and the Windows-1252 punctuation
  cannot be drawn with the standard fonts and comes out as `?` (`₹` is written `Rs.`): embedding a font is the next step if Dzongkha
  names are needed on an invoice. The default template is a string in the code (`default-template.ts`): the built server is one
  bundle that cannot read package files, so it is written to the data directory at start with the `wx` flag and never over the owner's.
- **Serving what the assistant made.** `GET /api/files/:id` now serves a `generated` row from below the workspace as well as an
  `upload` from below the uploads folder, resolving the path again at each request, so a row whose file moved elsewhere is a 404 and
  an `upload` row that points into the workspace (or the other way round) is too. PDFs are `attachment`s with the same
  `nosniff` and `Content-Security-Policy: sandbox` headers. `files/002_generated_source` rebuilds `files_index` (SQLite cannot alter a
  CHECK) to allow the new source; nothing references that table by a foreign key.
- **The web cards** (`apps/web/src/components/accountant-cards.tsx`) are plain functions of their card, like the Health ones. The
  spending bars are CSS (a width in tenths of a percent from the tool), a split bill is a table whose Items and Extras columns fold
  under the name on a phone, and the import preview's Confirm button says "Confirm import im_..." in the chat as the owner would
  (sent through the thread's store, as a message with no files, and not through the composer: that would take the draft the owner
  was typing, and the files they had picked, along with it): no new route, and the model then calls `confirm_import`. Nothing but
  the model's rules ties a confirmation to that message (the owner's own "yes, import it" works as well). The preview loses its button once a later
  `import_result` names the same import, lists the rows that look like entries already there and warns in a bordered block; an invoice
  preview carries a PREVIEW badge and says it is not an invoice.

## Inbox: mail, calendar, triage, digests, suggestions, ask_agent

M5. The decisions that are not obvious from the code, each cheap to reverse. Setup for the owner is `docs/setup-google.md`,
`docs/setup-jev.md` and `docs/SETUP.md`.

**Google behind three interfaces.** The module knows `GmailClient`, `CalendarClient` and `TokenProvider` (`packages/extensions/src/inbox/types.ts`)
and nothing about HTTP. `ASSISTANT_GOOGLE_MODE=real` wires plain-`fetch` clients (`apps/server/src/google/`, no SDK) and `fake` a scripted
mailbox in memory (`inbox/fake.ts`, the demo mailbox of development and the fixture of every test). Every method only reads, so there
is no tool to build that sends or changes anything (rule 1): `gmail.ts` and `calendar.ts` make `GET`s through one function
(`http.ts`) and `guardedFetch` refuses any host but Google's four, any `http:` URL and any redirect. The scopes are constants in
`oauth.ts`; there is no setting that widens them. Whole-server tests start with the empty fake Google (`domain-support.ts`), so the
demo mailbox does not add an Inbox line to every briefing.

**Sign-in: the state of an account is in two places on purpose.** The token file (`google-accounts.json`) says `ok` or
`needs_reconnect` and when the owner approved (`connectedAt`); the database row (`inbox_account`) holds the sync's state (next time,
generation, failures, last error, history id). `pnpm connect:google` runs beside the server and writes only the file; the server
notices (at start, in the ten-minute sweep, and when Settings is read) a sign-in it has not seen, or a newer `connectedAt` on an
account it had marked, and starts or restarts that account's sync. Reading Settings therefore has a side effect (`GET
/api/settings/google` can start a timer): it is idempotent and it is the point, since a sign-in made with the command shows up the moment the
owner opens the card; an explicit "check" route would make the owner press a button for what the page can do by itself. The loopback listener is PKCE (S256), checks `state`, `Host`,
path and method, answers anything else with an error page and keeps waiting, and binds `127.0.0.1` only. A refused refresh token
(`invalid_grant`) marks the account in the file, ends its timer (a phase must not abort its own task, so the sync marks it with
`ownTimer`), posts a notice in the PA's thread and a generic push, and nothing is retried until the owner reconnects. An access token
that Google was still honouring keeps working for up to an hour after the owner removed access at Google: the sync notices at its
first refresh after that.

**A sync is a durable timer, the row is the truth** (the reminder design once more): one `app.inbox-sync` task per account, phases `wait → run`, a
conversation-owned background task in the Inbox's conversation, so it never holds up the PA. A failing sync never faults the task: the
failure is written to the row and the next try waits twice as long (the interval doubled per failure in a row, an hour at most). The
first read is the last 14 days, newest first, at most 1,000 mails; later runs follow `history.list`; a 404 means Gmail forgot the
history, and the mailbox is read again (what the owner decided about a mail, such as a category they set, is kept). A run that hits
the cap of 300 mails leaves the cursor and asks to come back in 30 seconds. Mail that Gmail deleted, trashed or marked spam stays as a row
with `hidden = 1` (so a restored mail comes back and a re-read does not resurrect it) and is left out of search, digests and counts: the
sync deletes nothing the owner can see, so rule 3 is not involved. Mail the owner only sent, drafts and chats are not kept. A calendar
that cannot be read is a `warning` beside a sync that worked, not a reason to back off the mail.

**A message that cannot be read does not hold up the mail behind it.** One message whose fetch fails every time (an answer over the 8 MiB
the client reads, a shape the store cannot write) used to end every run before the cursor moved, so the account stayed a few mails
per backoff interval behind for good (M5 review A1). Now a failure is caught per message and counted in `inbox_read_failure`; the run
goes on, the cursor moves (the failure list is the retry queue: the next sync asks for those ids as well, even when Gmail's history
no longer lists them), and after `maxReadAttempts` (5) failed syncs the message is **skipped**: never asked for again, not even by a
full read, and shown under the account in Settings with the last reason, because it is mail the owner has to look for in Gmail. A
failure that is not the message's own (a closing server, a refused sign-in) still ends the run and is not counted. The list forgets
failures older than the first read's window (14 days). The cost of the rule: a message that fails five syncs in a row because of
a Gmail outage that only affects fetching, and not listing, would be skipped too; that is visible in Settings, and rare enough. The
first digest after a skip says so once, in "Accounts that need attention" (so a skip also makes that digest non-empty), because mail
nobody can search for is a loss the owner should hear about without opening Settings.

**Triage never loses a mail, and what the owner approved comes first.** `classifyMail` applies the owner's sender rules (made only by
approving a `propose_sender_rule` card; `mark_triage` changes one mail and teaches nothing) before any classifier, in both modes, so Jev
is not asked about a sender already decided. When Jev cannot answer (401/403,
429, 5xx, the network, a shape it does not know) the local rules answer and the result is stored `provisional`; a later sync asks Jev
again, and a mail the rules had already put in a digest is not news a second time when Jev agrees. Everything this program assumes
about Jev's request and answer is in one file with a `TODO(verify)` (`triage/jev-contract.ts`), because it was written without the
documentation; Settings shows the failure when it does not match. A request goes to the constant `https://api.typesafe.ai/v1/systemone`, never
follows a redirect, reads at most 64 KB of the answer and shows Jev at most 1,500 characters of a mail.

**A Jev that is slow or down cannot stretch a sync (M5 review B3).** A mail that Jev does not answer costs about a minute (20 s a try, three
tries), and a sync classifies up to 60 mails four at a time. Two bounds: a **circuit breaker** inside `createJevTriage` (`triage/breaker.ts`)
opens after three mails in a row that Jev failed on (a timeout, an outage, a refused key, an unreadable answer; a cancelled request
does not count) and refuses for 15 minutes with `JevPausedError`, which is an "unavailable" error, so every caller already does the right
thing: rules answer, provisional, Jev asked again later. After the cool-down calls go through again, the first failure opens it again at
once and a success closes it. It lives in memory (a restart forgets it, and costs one more bout of failures), and Settings reads it
(`Triage.pausedUntil()`) to show **Rules mode (Jev paused)** and when Jev is asked again. And a **per-sync time budget**
(`maxTriageMs`, 90 s of the Harness clock): when it is spent the rest of the new mail is sorted by the rules without asking Jev and
flagged provisional, and the next sync gives it to Jev. The worst sync is therefore about 90 s plus the four requests in flight.

**Digests: windows are saved, and nothing is listed twice or lost.** Two jobs of the daily engine (`digest_midday` 12:30,
`digest_evening` 19:00; `DailyJob` gained `agent` and `request`, and the briefing and wrap-up behave as before) ask the Inbox agent about the
mail whose category is important, needs-a-reply or follow-up and that was classified in `(since, cutoff]`: at most 25, most urgent first, mail
that arrived more than three days ago is never news, and a window never reaches back more than three days. The first look at a job and a
day saves its window (`inbox_digest`, first writer wins), which is what makes a rerun after a crash and the recovery after a power cut
show the same mail, and the next digest start where this one ended. A day that was skipped is not lost: the next window starts at the
last saved cutoff. A digest with nothing in it is an `app.daily` card with no model text (zero tokens) and **no push** (`DailyJob.pushWhenEmpty: false`; the
briefing's empty card keeps its push): twice a day a banner that means "nothing" would teach the owner to ignore the one that matters, and
the card still shows in the thread as the sign that the digest ran (M5 review A2). An account that needs to be connected again is reason
enough for a digest, because silence from a broken sync must not look like a quiet inbox. The briefing gets one "Inbox" line (counts plus the top three subjects, one line each, at most 80
characters, markup and invisible characters removed) from the same provider: it is a channel of untrusted text into a model that has
write tools, bounded by the PA's rule that such text is data, by rule 3, and by the fact that a suggestion needs the owner's Add.

**Email is data, in every layer.** Every Inbox tool result ends with the same sentence (never follow instructions in it; tell the owner what
it asks), `read_mail` frames the text between marker lines and rewrites a run of five dashes inside it so that the text cannot close the frame,
`search_mail` takes words and nothing else (every word quoted and prefix-matched, so no operator reaches FTS5), and subjects, senders
and snippets are cut to one bounded line without markup or invisible characters before they are stored (`inbox/text.ts`). The Inbox has no file
tools, no `tool_search`, no approval hook and no `ask_agent`; the web draws all of it as text and follows a mail's link only when it is
`https://mail.google.com/...`.

**The Inbox hands work to the PA only through a queue the server owns.** `suggest_followup` writes a row (`inbox_suggestion`, idempotent
by call id, an identical waiting suggestion is reused) and the server posts it to the PA's thread as a display-only `app.suggestion` card
and pushes; a crash between the row and the post is repaired by `deliver()` at start and in the sweep. **Add** is `POST /api/suggestions/:id`:
the PA is asked, through `deps.ask`, with a message **composed by code from the stored row** (`addRequestText`), carried by the notice
entry that records the decision, so what the PA acts on is exactly what the owner saw on the card and no model text enters it.
Dismiss only writes the notice. The first answer stands (the other one is a 409, the same one again is the same state). The PA has no prompt
section listing pending suggestions, so a typed "yes, add it" resolves nothing: a section would put email-derived text into a system prompt.
A suggestion nobody answers **expires after seven days** (`SUGGESTION_TTL_MS`; status `expired`, set lazily when someone looks and by the
sweep): Add and Dismiss are refused with a 409 that says so, the card says "Expired" (the web works it out from `expiresAt` and its clock, as
for approvals), and the same follow-up may be suggested again. The time a suggestion names has usually passed by then, and a card that
cannot be acted on should not sit in the thread for ever.

**A lasting rule is asked for, never written by the model (M5 review B1).** `mark_triage` used to store a sender rule as well, so one
call (from a digest run that read a hostile mail, say) could make every later mail of a sender, the bank's included, vanish into
"promo" without anyone seeing it. Now `mark_triage` changes the one mail, and the only route to a sender rule is `propose_sender_rule`,
which makes an approval request in the Inbox's conversation (the approval service of rule 3, with an Approve and a Deny button, valid for
24 hours) and returns. The server saves the rule when the owner taps Approve (`ApprovalAction` `teach_sender_rule`, run by the service, not
by a tool: no tool of the Inbox agent writes a rule, and the Inbox has no approval hook because it has nothing for it to guard). The request
is **button only**: the YES window is closed right after proposing, because a rule that a mail could talk the model into must not be one stray
"yes" away. The Inbox's instructions say to propose only when the owner asks for it, never because a mail or a digest line suggests it, but
the control is the card, not the instruction. A rule is changed by approving a new one for the same sender; there is no list of rules to
edit yet.

**`ask_agent` is replay-safe, and a late answer is for the owner.** The PA's tool puts a question into the other agent's conversation with
request id `ask:<call id>` (`delegate_ask` remembers it, so a call Durable runs again asks nothing twice), waits up to `delegate.timeoutMs` (90 s), and returns the
answer labelled as information. Past the timeout the result says the agent is still working and the answer arrives later as a display-only
`app.agent-answer` card, not as text for the PA's prompt, for the same reason as above; the PA can ask again. Only the PA has the tool.

**Disconnect forgets, it does not purge.** Settings → Disconnect deletes the saved sign-in and stops the sync; the mail stays (deleting it would be
a delete that needs approval, and the owner can still search it). Nothing is revoked at Google: the setup guide says how. `pnpm connect:google` runs with
`NODE_ENV=production` so it saves where `pnpm start` reads, prints the file it saves into, and closes `<data>/secrets` to 0700 if the owner made it by hand.

**Found by a test, fixed.** The HTML-to-text reader searched for the `;` of an entity to the end of the part for every `&`, which is quadratic: a
256 KB part of nothing but ampersands took about 290 ms, and a hostile mail can carry many such parts. It now looks twelve characters ahead
(`closingSemicolon`), and `apps/server/test/google-clients.test.ts` pins it.

