# Design notes

Decisions that aren't obvious from the code, and what to check before changing them. The overall structure is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Request security

Tailscale's `Tailscale-User-Login` header identifies a **device**, not a page. Any website open in your browser can make
that browser send a request to the assistant, and the request arrives with your identity. So identity alone isn't
enough. Three rules apply to every `/api/*` request (`apps/server/src/http/guard.ts`, `validation.ts`):

1. **`Host` allowlist:** loopback names on the server's port, or `ASSISTANT_PUBLIC_HOST`. This blocks DNS rebinding.
   Behind the Next dev proxy, `X-Forwarded-Host` must match too.
2. **`Sec-Fetch-Site`:** writes marked anything other than `same-origin` or `none` are refused.
3. **JSON-only writes:** a page can't send `Content-Type: application/json` cross-origin without a CORS preflight, and
   the server never answers preflights. This covers browsers that don't send `Sec-Fetch-Site`.

There are no cookies or CSRF tokens, so there's nothing to steal.

### Uploads

`POST /api/uploads` is multipart, so it can't satisfy rule 3. The exception is kept small:

- **It's exempt only because of registration order.** The route is mounted after the `Host` guard and auth, but before
  the JSON rule. There is no list of exempt paths to extend by accident. Tests check both directions. Don't add another
  route like it.
- **`Sec-Fetch-Site` is required** on this route (`same-origin` or `none`). From curl, add `-H 'Sec-Fetch-Site: none'`.
- **One file, 20 MB max.** The streamed body is counted, so it can't exceed what it claims.
- **The type comes from the content, not the name** (`files/sniff.ts`): PNG, JPEG, GIF, WebP and PDF by signature,
  otherwise UTF-8 text with no NUL bytes. Text containing a private key is refused.
- **The server picks where the file is stored:** `<data>/files/<yyyy-mm>/<id>-<name>.<ext>`, mode 0600, written via
  temp file and rename.
- **Served back with `nosniff` and `CSP: sandbox`.** Images are inline; everything else is a download, so uploaded HTML or
  SVG can't run in the app's origin.
- **The message names the files.** The web app appends `[Attached file: … id fi_…]` lines, which render as chips.

**Next dev proxy limit.** Next stops forwarding proxied bodies over 10 MB, which shows up as a hang and then a 500.
`next.config.ts` raises `experimental.proxyClientMaxBodySize` to the upload cap plus 1 MiB. Production behind Tailscale
Serve skips the proxy.

### The Android share target

The share sheet POSTs multipart to `/share` (`app/share/route.ts`). The route forwards each file to the upload API and
redirects to `/capture`, where you pick the agent. It requires `Sec-Fetch-Site: none` or `same-origin` and passes your
identity headers through, so the API makes the same decisions it would for the browser. Not yet tried on a device:
Chrome is assumed to send `Sec-Fetch-Site: none`. If it doesn't, shares fail with 403 and this route is where to fix it.

## Two databases, two durability levels

`app.sqlite` uses `synchronous=FULL`. Durable's `durable.sqlite` uses `NORMAL`, which can lose its last commits on a
**power cut** (not on a process crash). After a power cut, `app.sqlite` can be ahead of Durable.

Rather than forcing Durable to `FULL` (which means reaching into Chord's internals, and still doesn't cover a crash
between two commits), every cross-database reference **repairs itself**: the `app.sqlite` row is authoritative and
Durable is brought back in line (see [Timers](#timers-the-row-is-authoritative)).

The repair runs in both directions. A "sent" flag in `app.sqlite` doesn't prove Durable still has the card. So a timer
that comes back from before its card was written posts it again (same request id, so this is idempotent), and at start
the approval service re-posts outcome notices from the last 24 hours. A duplicate is better than a reminder that never
shows up.

The one exception is `agents`: a row pointing at a conversation Durable lost makes startup fail with an explanation.

## One server per data directory

`<data>/server.lock` is taken before anything opens. Durable has no lock between processes: a second process would mark
the first one's running tasks as restarted and steal them. The lock records the pid and process start time, so a lock
left behind by a crash is recognised as stale.

## Parked tasks are not retried automatically

When Durable parks a task after repeated crashes, the server reports it (log, `GET /api/agents`, a banner) but never
retries on its own. The usual cause is something that keeps killing the process, and retrying would loop. The banner's
Retry button retries only on request.

## Timers: the row is authoritative

A reminder lives in two databases: a `tasks_item` row and a Durable `app.reminder` task that sleeps until the due time.
No transaction spans both.

- **The row decides; the Durable task is just a timer.** The timer carries `{ id, gen }` and fires only if the row is
  open and has the same `gen` and `remind_at`. Rescheduling, snoozing, completing or deleting changes only the row. The
  row's "already sent" flag is deliberately ignored, because after a power cut the timer can be older than its card.
- **The generation is taken before the task exists.** If the process dies in between, the rerun takes a newer
  generation, so the orphan is already stale.
- **`reconcile()` runs at start and every 10 minutes.** It recreates timers that were lost or faulted, and links live
  timers it finds instead of creating duplicates. It works row by row: a row it can't repair is logged with the SQL to
  clear it, and startup continues.
- **A 30 s tick wakes overdue timers.** Node's timers don't count time spent in suspend, so `harness.resume()` runs
  every 30 s. It can't wake a sleeping machine ([OPS.md](OPS.md#keep-the-machine-awake)).
- **Cards are posted once.** The request id is `reminder:<item>:<gen>`; a second write with the same id returns the
  first.
- **Cards are display-only.** A write with model text would start a model run in an idle conversation that has a queued
  message. The model learns about fired reminders from the `tasks` prompt section instead.
- **Push is at-least-once after a crash, best-effort otherwise.** A duplicate push replaces the earlier one (same
  `tag`). A push failure is logged and never faults the task.
- **Timers are background tasks,** so Stop doesn't kill them and they don't mark the conversation busy.
- **Late beats never.** A reminder that came due while the server was down fires on start and shows its due time.

### Follow-ups and birthdays

Same design, shared code (`packages/extensions/src/timers.ts`). The differences:

- **Every phase accepts any unresolved row with the same generation.** A meeting has several phases, and after a power
  cut Durable can bring the timer back to an earlier one. Phases whose moment has passed fall through, and `ask` posts
  again, idempotently.
- **Birthday cards are re-posted from the row.** Finishing a birthday cycle moves the row to next year, so a rewound timer
  is stale. The row keeps the latest card times, and at start `recoverCards` re-posts them (same request id, no push).
- **A card's request id names what it's about, not the timer**: `agenda:<id>:<event time>`, `birthday:remind:<person>:<day>`.
  A repaired timer can't post a second agenda, and a moved meeting gets a new card.
- **An agenda is posted only if it has points and only before the meeting starts.**
- **A question is asked at most twice:** after the meeting, then once more the next morning. Anything still open after
  that goes to the morning briefing. `record_outcome` resolves the row and can create the next follow-up in the same
  transaction.
- **A commitment gets a nudge at its due time.** If the server was down, the nudge is skipped once the question's time
  has passed.
- **A date without a time** gets `ASSISTANT_FOLLOWUP_DEFAULT_TIME`, and the tool tells the model it chose one.
- **Birthdays don't nag.** A late morning reminder is posted only within the day. The evening question is skipped if
  you already said you wished them, or if the birthday is more than 2 days old. After a long outage, only the cycle that
  was due posts.
- **Times are wall-clock times in your zone,** so 09:00 stays 09:00 across DST changes. 29 February falls on 28 February
  in non-leap years.
- **People are PA-only for now.** Before another agent gets `add_person`: link pushes to the right conversation, and give
  `notes` a scope.

### The daily jobs

Briefing, wrap-up and inbox digests (`packages/extensions/src/daily/`) use one `schedule_daily` row per job.

- **Use calendar arithmetic, never "plus 24 hours",** so 07:30 survives DST changes.
- **There's a late window for a server that was down:** the briefing still runs until 11:00, the wrap-up until midnight.
  It isn't applied to a job's first run or to an edit in Settings ("switch on at 07:45" means tomorrow). A day never runs
  twice.
- **Facts are stored in a Durable memo,** so a rerun after a crash uses the first attempt's plan. The request id
  `briefing:<date>` makes the post happen once. After a power cut, start re-sends today's request with the same id.
- **The request is a Durable input with a custom entry kind** (`app.daily`). The model reads it as a user message; the
  thread shows a card. Instructions for writing the briefing live in the PA's rules, so the input is only facts.
- **If there's nothing to report, the job posts a card and makes no model call.** Empty digests also send no push.
- **Modules contribute facts** through `DomainModule.facts`. If one provider throws, it's left out and the others still
  report.
- **The journal** (`pa_journal`) has one row per day. A later `save_journal` for a day replaces the earlier one.

### Changing a task that may be sleeping

A timer can sleep for a year (birthdays). Durable runs it with whatever definition is installed *then*. If the `version`
doesn't match and there's no `migrate`, or the extension is gone, the task is **blocked**: it never wakes, and the repair
still counts it as live. **Never rename or remove a phase that has shipped.** Add phases, or bump `version` and write
`migrate`. The server logs blocked tasks at start (`[durable] N task(s) cannot run`).

## Approvals

Deletes need approval (rule 3). The enforcement doesn't depend on the prompt:

- **A hook enforces it.** `beforeTool` blocks any destructive tool unless an approved, not-yet-executed request exists
  for exactly that conversation, tool and target. A blocked model is told to call the matching `propose_*` tool.
- **The model asks; the server executes.** On approval the server runs the action itself and posts the outcome. It
  doesn't wait for the model to call the tool. `delete_*` tools still exist so the hook has something real to guard.
- **YES is handled by the server, and only when it's clearly the answer:** the message is exactly "YES", exactly one
  request is waiting, and you've said nothing else since it was made. Anything else goes to the model and closes the YES
  window, but the buttons keep working. Cards that ask their own yes/no questions ("did you wish Tashi?") also close the
  window *before* they're posted, so a "yes" to them can't approve a pending delete.
- **The approval card never changes.** The UI works out the card's state from the notices posted after it. A request
  expires after 24 h, and a late button press gets 409.

## Web Push

- **A subscription is tied to the VAPID key.** If `vapid.json` is regenerated, old subscriptions fail silently. The app
  compares keys and resubscribes when they differ.
- **Subscriptions rotate.** `PushSync` re-registers on every app open, and `sw.js` handles `pushsubscriptionchange`.
  Neither creates a first subscription.
- **One `tag` with `renotify`,** so a duplicate replaces the banner instead of stacking.
- **`ASSISTANT_PUSH_SUBJECT` has no default in production,** because push services may reject a placeholder.
- **Endpoints must be public hostnames, with at most 20 devices.**

## Prompts and tools

**Prompt sections never contain the clock.** A section only costs something when its text changes. A clock would
change it on every request and defeat the provider's prompt cache. The model gets the time from the `current_time`
tool, and `remind_in_minutes` handles "in ten minutes" without a clock. Rejected alternative: a timestamp on every
message.

**Replayed tools answer from their first run.** A tool that validates against the clock checks for its own earlier
result first. Otherwise a replay after midnight could land on a different day.

**The PA is offered only the tools it uses daily.** The rest are `deferred` and loaded through `tool_search`. The PA's
instructions name them. The approval hook still guards deferred `delete_*` tools if the model loads them.

## Files

The PA's file tools (`packages/extensions/src/files/`) use their own bounded reader: text and CSV come in pages of 200
lines or 32 KB, images go through Durable's image processor, and PDFs aren't readable yet. They go through the scoped file
environment, so the deny list applies. `list_dir` hides protected files, and a refused read says why. A file read from an
allowed folder is indexed in `files_index` so it can be described and found again. Nothing is copied.

## Health

The `health` module belongs to the Health agent only.

- **Weights are stored in kg.** Pounds are converted once, on input. Out-of-range values (body weight outside 20–500 kg,
  sets over 1000 kg) are refused with a hint about units.
- **One weighing per day, enforced by the schema.** `replace: true` overwrites. A change of 4 kg or more within two weeks
  is saved, and the model is told to check the unit.
- **A workout is written whole,** in one transaction under the call id. A rerun finds it or writes all of it.
- **Exercise names are matched by a normalised key** (case, accents, punctuation and trailing plurals ignored) against
  your exercises, then a built-in list of about 40. Rename keeps the old name as an alias. Merge needs approval.
- **Weighted vs bodyweight.** Weighted exercises need a load on every set, because a missing weight is the likelier
  mistake. Bodyweight exercises are measured in reps until a set carries added weight, then by estimated 1RM of that
  weight. Estimated 1RM uses Epley.
- **Personal records** are strictly better than every earlier day, judged against the whole history.
- **All maths uses integer hundredths of a kg, rounded once when displayed.** Rounding along the way was 0.1 kg off in a
  few percent of cases. A property test checks it against 300 random histories.
- **The 7-day average covers calendar days;** missing days aren't zeros. BMI needs `ASSISTANT_OWNER_HEIGHT_CM` and has
  no category label.
- **Charts are capped at 90 points** because cards are stored in the thread forever.
- **Height goes to the Health agent only,** not the shared profile. A test confirms no other agent is told.

## Accountant

The `ledger`, `splits` and `invoices` modules belong to the Accountant only. Rule 7 is the point: **every number comes
from code.**

- **Money is integer minor units.** `toMinor` reads the digits of the number (`19.99` → 1999, never `19.99 * 100`) and
  refuses extra decimals instead of rounding. Sums, shares and conversions use BigInt, rounded once. Exchange rates are
  only ones you gave.
- **A balance is the latest stated balance plus anything recorded after it.** A snapshot records the highest entry seq it
  saw, so "spent 450, balance is 12,000" works in either order. Differences are reported, not hidden in an adjustment
  entry.
- **Transfers are neither spending nor income.** Summary shares use largest-remainder allocation, so they add up to
  exactly 100.0 %.
- **CSV import has two steps.** `import_csv` parses the file (encoding, separator, header row, date order, DR/CR columns)
  and stores a preview. `confirm_import` writes exactly what was previewed. A fingerprint per row means re-importing the
  same statement adds nothing.
- **Statements are untrusted input:**
  - Parsing is linear. A quadratic regex once stalled the server for 6 s on one cell.
  - The preview warns when every row goes the same way, which usually means a misread DR/CR column.
  - Rows that match an entry you typed or photographed (same account and amount, within 2 days) are left out unless you
    include them.
  - A wrong import can be undone as a whole, with approval.
- **Bulk recategorize** matches whole merchant names. Above 20 entries it shows what would change first, and it can be
  undone.
- **Code mode** gives scripts `ledger_query` plus the Accountant's other tools, all behind the same approval hook. No
  network, files or model (`models: false`). Nested calls get their own call ids, so rule 8 holds inside scripts. **The
  time limit is written into the script** (`createBoundedCodemodeExtension`), because Durable only reads the script's own
  `// @options` line. Without it, a script could run until Stop or restart.
- **Splits add up exactly.** Each person's share is an exact fraction, rounded once per person by largest remainder.
  Tax, service and tip are shared in proportion to items. A `total` the model read off the bill is checked, which catches
  misread lines. A settlement naming only part of a known friend's name ("Pema" for "Pema Dorji") is refused and asks
  which person you mean.
- **Debts are netted per pair and currency. Splits don't write ledger entries.**
- **Invoice numbers are taken with the row.** The PDF is rendered first, so a failing template uses no number. Then one
  transaction bumps the counter (checking it hasn't moved) and inserts the invoice. `preview_invoice` renders with a
  PREVIEW watermark and takes no number.
- **Templates are Mustache plus a small HTML layout engine over pdfkit.** Unknown fields are errors, not blanks.
  Chromium wasn't used because it isn't reliably installed and is heavy for one page. The standard fonts can't draw
  non-Latin scripts. The default template is written at start with `wx`, so it never overwrites yours.
- **Generated files are served only from the workspace and uploads only from the files folder.** The path is re-resolved
  on every request.

## Inbox

- **Google sits behind three read-only interfaces** (`GmailClient`, `CalendarClient`, `TokenProvider`). Real mode uses
  plain `fetch`, `GET` only, to Google's hosts only, with no redirects. Scopes are constants. Fake mode is an in-memory
  demo mailbox.
- **Sign-in state lives in two places on purpose.** `google-accounts.json` holds the token and when you approved;
  `inbox_account` holds sync state. `pnpm connect:google` writes only the file. The server notices new sign-ins at start,
  every 10 minutes, and whenever Settings is opened. A refused token marks the account, stops its sync and posts a
  notice.
- **Sync follows the timer design.** Failures back off up to 1 h. Mail Gmail deleted or marked as spam is hidden, not
  removed.
- **One unreadable message doesn't block the rest.** Failures are counted per message, and after 5 syncs the message is
  skipped and shown in Settings.
- **Triage never loses mail.** Your approved sender rules apply first. If Jev fails, local rules answer and the result is
  marked provisional, to be retried later. After 3 Jev failures in a row it's paused for 15 minutes. One sync spends at
  most 90 s waiting on Jev. Everything assumed about Jev's API is in `triage/jev-contract.ts` (`TODO(verify)`).
- **Digests save their time window,** so a rerun shows the same mail and the next digest starts where this one ended.
  The window covers at most 3 days. An empty digest is a card with no push; an account that needs reconnecting is always
  worth one.
- **Email is data in every layer.** Tool results say so, `read_mail` frames the text, search terms are quoted so they
  can't become FTS operators, and stored subjects and snippets are stripped of markup. Links open only if they point to
  `https://mail.google.com/`.
- **The Inbox hands work to the PA only through a server-owned queue.** `suggest_followup` writes a row and the server
  posts a card. **Add** sends the PA a message the code builds from the stored row, so no model text passes through.
  Suggestions expire after 7 days.
- **Sender rules need a button press.** `mark_triage` changes one mail. `propose_sender_rule` creates an approval that
  only the button can accept, not a typed YES, because a hostile mail could otherwise make a bank's mail disappear.
- **`ask_agent` is replay-safe.** Late answers arrive as display-only cards, not prompt text.
- **Disconnect forgets the sign-in; it doesn't delete mail** or revoke access at Google.

## Memory

The PA, Health and Accountant have `remember`, `recall` and `forget`; the Inbox can only `recall`.

- **One plain line, two kinds:** at most 400 chars, no `<` or `>`, and too-long lines are refused rather than cut. A
  *preference* is how you want things done; a *fact* is a detail no other tool stores.
- **Agents can't write preferences; they ask.** A preference reaches every prompt as your instruction. A line written by
  an agent that just read a CSV or a file could carry an injected instruction into every agent. So `remember` with
  `kind: "preference"` only creates an approval card. The line records which agent asked.
- **A fact stays with the agent that noted it.** You can share it from the Profile page.
- **The Inbox never writes memory,** not even by asking, because it reads untrusted email.
- **The prompt section is capped at 2,400 chars** and contains no ids or clock, so it changes only when a line does.
- **Your edits on the Profile page need no approval.** Approval protects you from the model, not from yourself.
- **Search** uses FTS5, with every term quoted.

## Usage and weekly limits

- **Usage is sampled.** Durable's per-conversation totals have no dates. The module copies them and adds the growth since
  the last reading to today: at start, every 10 minutes, at shutdown and on demand. An agent's first reading only sets
  the baseline.
- **The unit is the provider's `totalTokens`,** including cache reads. Weeks run Monday to Sunday in your timezone.
- **Only daily jobs check the limit.** Over the limit, they post plain cards with no model call. **What you type is
  never blocked.** If the check itself fails, the job runs normally: a broken meter shouldn't silence the briefing.

## Activity

The Activity page is built from the transcripts, not a separate log. It reads tool results and timer cards, newest first,
up to 5,000 entries per conversation. This means it can't drift from the conversation and needs no table.

## Deployment files

`ops/` holds files only; nothing installs itself.

- **Units** run the built server and `next start` through Node directly, so they need no pnpm. Hardening uses
  `ProtectHome=read-only` (not `true`) so the read paths stay readable, and `ReadWritePaths=` set to the data directory
  only. There is no `MemoryDenyWriteExecute`, because V8 needs writable, executable memory.
- **`install-units.sh`** fills in the machine-specific lines when installing, so the tracked files are never edited.
- **`tailscale-serve.sh`.** Two facts from Tailscale's source shape it:
  - `--set-path` strips the mount path before proxying, so the API target ends in `/api`.
  - `tailscale funnel --https=443 off` deletes every handler on the port, so the script never runs it. Each `serve` run
    already turns Funnel off.
- **`pnpm login:openai`** wraps pi-ai's OAuth login with a loopback callback on `127.0.0.1:1455` and a paste fallback for
  SSH.
