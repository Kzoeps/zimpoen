# Assistant

A personal assistant that runs on one always-on Linux machine and is reached privately, over Tailscale, from a
ChatGPT-style web chat. Several themed agents (`pa`, `inbox`, `health`, `accountant`) each keep one endless,
crash-safe conversation on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable): if the
process dies mid-answer, the next start picks the work up where it stopped.

Status: **Milestone 4 (daily briefing and wrap-up, files)**. You can open the web UI, pick an agent, chat, and watch
the answer stream in. The `pa` agent keeps a task list and reminds you at the right time; it also follows your meetings:
after one it asks how it went and, if something has to be followed up, when, and then asks about that follow-up in turn;
through the day you add agenda points, and shortly before the meeting it posts them; and it keeps your friends' and
family's birthdays, reminding you in the morning to wish them well and asking in the evening whether you did. All of it
survives a restart, costs no model tokens until you answer, and also sends a Web Push notification to your phone. Deleting
anything needs your explicit approval. Every morning (07:30) it writes you a briefing from what the system knows (today's
tasks, overdue ones, meetings and follow-ups, birthdays, what you carried over from yesterday), and every evening (21:00)
it asks what you got done and keeps your answer in a journal; both times are settings. You can attach images, PDFs, CSV
and text files to a message (or share them from your phone's share sheet), and the PA can read them, remember what each
one is, and read files in the folders you allow. In dev mode the model is a scripted stand-in and pushes go to a file, so
nothing leaves the machine. The other agents have no tools yet; mail, health and accounting arrive in later milestones.
The full design and milestone list is in [`docs/PLAN.md`](docs/PLAN.md).

## Quickstart

Needs Node 24 and pnpm 10.

```bash
pnpm install
pnpm dev          # server on 127.0.0.1:3001, web on 127.0.0.1:3000
```

Open <http://127.0.0.1:3000>. Dev mode uses the scripted `faux` model (it echoes your message and streams it back in
small chunks, with a "Thinking" block) and turns authentication off unless you export `ASSISTANT_AUTH` yourself. Data goes
to `./data-dev`; production uses `./data` (both ignored by git), so a dev database full of scripted-model agents can never
be opened by a production server.

The scripted model has no judgement, so it never decides to use a tool itself. To try the `pa` agent's tools without a real
model, tell it what to call: `/tool <name> {json}`. For example `/tool add_task {"title":"Stretch","remind_in_minutes":1}`
saves a task with a reminder one minute from now, and a minute later the reminder card appears in the thread. The tools
are `current_time`, `add_task`, `list_tasks`, `update_task`, `complete_task`, `snooze_reminder` and `propose_delete_task`
(arguments: `packages/extensions/src/tasks/tools.ts`).

The same works for the M3 tools (arguments in `packages/extensions/src/followups/tools.ts` and `people/tools.ts`):
`add_followup`, `add_agenda_point`, `list_followups`, `update_followup`, `record_outcome`, `resolve_followup`,
`propose_delete_followup`, `add_person`, `update_person`, `list_people`, `record_wish` and `propose_delete_person`.

**Rarely used tools are not offered until loaded.** The PA is offered `current_time`, `add_task`, `list_tasks`,
`complete_task`, `snooze_reminder`, `add_followup`, `add_agenda_point`, `record_outcome`, `add_person`, `record_wish` and
`tool_search`; `update_task`, `list_followups`, `update_followup`, `resolve_followup`, `list_people`, `update_person`, the
`propose_delete_*` tools and the `delete_*` tools load when the model calls `tool_search` (the real model does; its
instructions name them). The dev model's `/tool` is refused with "Tool X is not available" until you load the tool the
same way: `/tool tool_search {"query":"propose delete task"}` first, then `/tool propose_delete_task {...}`. To watch a meeting go through its
whole life in a few minutes, start the server with `ASSISTANT_FOLLOWUP_ASK_DELAY_MINUTES=1` and say
`/tool add_followup {"title":"Meeting about the house","counterpart":"Dabtonog Realty","event_in_minutes":3,"agenda_lead_minutes":1}`,
then `/tool add_agenda_point {"text":"Ask about the price","meeting":"Dabtonog"}`: the agenda card arrives two minutes
later and the question at minute four; answer it with `/tool record_outcome {"followup_id":"f_…","outcome":"They
agreed","needs_followup":true,"next_in_minutes":2}` and the chained follow-up (a commitment: a "due now" card at its time, the
question half a delay later) is asked about two minutes after that. A question nobody answers is asked once more the next
morning (`ASSISTANT_FOLLOWUP_REASK_TIME`).
Birthdays fire at the configured times of day (`ASSISTANT_BIRTHDAY_REMIND_TIME`, `ASSISTANT_BIRTHDAY_CHECK_TIME`): save one
for today with `/tool add_person {"name":"Pema","birthday":"1990-10-25"}` (use today's month and day) and set the check time
a minute or two ahead.

**The daily briefing and wrap-up** are two jobs whose times are settings, not environment variables: **Settings → Daily
schedule** (or `PUT /api/settings/schedule/briefing` with `{"localTime":"08:15","enabled":true}`). To see one without
waiting, set it two minutes ahead, add something to report (`/tool add_task {"title":"Pay rent","due":"2026-10-25T23:00"}`,
today's date) and watch the thread: a briefing card (what the assistant looked at, folded) and the PA's answer under a
"Morning briefing" chip, plus a push. With nothing to report the briefing is a one-line card and costs no model tokens. A
job that is edited or switched on after its time means tomorrow; a server that was down at the time still sends the briefing
when it starts before 11:00 (a wrap-up before midnight), and a day that ran never runs twice. Answer the wrap-up, or play
the PA's part: `/tool save_journal {"date":"2026-10-25","user_log":"Paid rent.","carried_over":["Renew the licence"]}`
(`get_journal` is loaded with `tool_search` first); tomorrow's briefing lists what you carried over.

**Files.** The paperclip in the composer uploads as you pick (one request per file, up to 20 MB: PNG, JPEG, GIF, WebP,
PDF, CSV or text; the server judges by content, not by name) and the message names the files for the PA. To try it from a
shell: `curl -F file=@receipt.png -H 'Sec-Fetch-Site: none' http://127.0.0.1:3001/api/uploads` (the header stands in for
the browser; a request without it is refused). Then `/tool read_file {"file_id":"fi_…"}` (images come back as images, text
and CSV as lines, at most 200 lines or 32 KB per call) and `/tool describe_file {"file_id":"fi_…","description":"The
March bank CSV","tags":["bank"]}`. `search_files`, `list_dir` and `read_file_path` (files in the folders of
`ASSISTANT_READ_PATHS`, indexed when used) are loaded with `tool_search` first. PDFs are stored and shown but not yet
readable by the PA. The Android share sheet (installed app, https) posts to `/share`, which stores the files and opens
`/capture`, where you choose the agent and send; on a laptop try it with `curl -i -X POST -H 'Sec-Fetch-Site: none' -F
text=hello -F files=@pic.png http://127.0.0.1:3000/share`. Dev mode also keeps pushes on the machine
(`ASSISTANT_PUSH_MODE=fake`): after you press **Enable notifications** in Settings, each reminder appends one line per
subscribed device to `./data-dev/dev-push-outbox.jsonl`, which is what your phone would have been sent.

On first start the server must be able to read `~/Documents` and `~/Downloads`, which agents may read once file tools
exist. If you do not have them, point it elsewhere and it will tell you what is wrong in any case:

```bash
ASSISTANT_READ_PATHS=/some/folder:/another/folder pnpm dev
```

| Command | What it does |
|---|---|
| `pnpm dev` | Server (restarts on file changes, resuming interrupted work) and web dev server |
| `pnpm build` | Bundles the server to `apps/server/dist/main.js` and builds the web app |
| `pnpm start` | Runs the built server in production mode (`NODE_ENV=production`: auth on and cannot be turned off, OpenAI model, `./data`). Run the built web app with `pnpm --filter @assistant/web start` |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | Vitest for the whole workspace |
| `pnpm lint` | Biome (lint and format check) |
| `node apps/server/scripts/record-fixtures.ts` | Re-records the event streams the web tests replay (see below) |

## Layout

```text
apps/
  server/        Node process: Durable Harness, HTTP API, SSE, Web Push. Entry: src/main.ts
  web/           Next.js (App Router) + assistant-ui over the server's API; PWA manifest and service worker for pushes
packages/
  shared/        API contracts: DTOs, error shape, stream event types, card types (types, plus tiny constants and guards)
  db/            app.sqlite: node:sqlite wrapper and the migration runner (ids per module), core tables
  extensions/    Durable extensions the server installs: domain modules `tasks`, `followups`, `people`, `approvals`, `daily` (briefing, wrap-up, journal) and `files`, and `profile`; more later
docs/            PLAN.md (architecture), design-notes.md (security and durability reasoning), handoff and progress notes
```

Workspace packages export TypeScript source. Node 24 runs it directly in dev, Next compiles `@assistant/shared`
(`transpilePackages`), and `pnpm build` bundles the server with esbuild.

## Configuration

All settings are environment variables, read and checked at startup. A bad value stops the server with one message that
names every problem, the setting, why it is wrong and what to do. A `.env` file is not loaded: export the variables, or
use a systemd unit.

| Variable | Default | Meaning |
|---|---|---|
| `ASSISTANT_DATA_DIR` | `./data-dev`, or `./data` when `NODE_ENV=production` (relative to the working directory; the scripts run from the repo root) | Where all state lives |
| `ASSISTANT_READ_PATHS` | `~/Documents:~/Downloads` | Folders agents may read, absolute, separated by `:`. `<data>/files` is always added. Set but empty is an error, not "the defaults" |
| `ASSISTANT_AUTH` | `on` (`pnpm dev` uses `off` unless you export it) | `off` accepts every identity: local development only, and refused when `NODE_ENV=production` |
| `ASSISTANT_OWNER_LOGIN` | none | Your Tailscale login. Required while auth is on |
| `ASSISTANT_PUBLIC_HOST` | none | The name you open the assistant by through Tailscale Serve, for example `my-laptop.tail1234.ts.net` (comma-separate several; add `:port` if it is not the default HTTPS port). The API answers only to `127.0.0.1`, `localhost`, `[::1]` on its own port, and these names |
| `ASSISTANT_MODEL_MODE` | `faux`, or `openai` when `NODE_ENV=production` | `faux` is the scripted dev model; `openai` is gpt via ChatGPT sign-in |
| `ASSISTANT_PUSH_MODE` | `fake`, or `web-push` when `NODE_ENV=production` | `web-push` sends reminders through the browser vendors' push services (FCM, Apple), the only outbound call a reminder makes. `fake` sends nothing: it appends what it would have sent to `<data>/dev-push-outbox.jsonl` |
| `ASSISTANT_PUSH_SUBJECT` | `mailto:assistant@localhost` in `fake` mode; **required** in `web-push` mode | How a push service can contact the operator (the VAPID `sub` claim): a `mailto:` or `https:` URL you control, sent with every push. Some push services may refuse a placeholder, so the server will not start in `web-push` mode without one |
| `ASSISTANT_TIMEZONE` | `Asia/Thimphu` | IANA time zone told to every agent, and the one the times below are in (also across a change of the clock) |
| `ASSISTANT_AGENDA_LEAD_MINUTES` | `15` | A meeting's agenda is posted this long before it starts, when it has points (1 to 1440). A tool call can set it for one meeting |
| `ASSISTANT_FOLLOWUP_ASK_DELAY_MINUTES` | `30` | The owner is asked how a meeting went this long after it started, unless it has an end time (1 to 1440) |
| `ASSISTANT_FOLLOWUP_REASK_TIME` | `09:00` | Local time of day of the one re-ask of a follow-up question nobody answered: the morning after it was asked |
| `ASSISTANT_FOLLOWUP_DEFAULT_TIME` | `10:00` | Local time of day a follow-up starts when the owner gave a date and no time ("on Monday"); the PA is told it chose it |
| `ASSISTANT_BIRTHDAY_REMIND_TIME` | `09:00` | Local time of day (24-hour `HH:MM`) of the birthday reminder |
| `ASSISTANT_BIRTHDAY_CHECK_TIME` | `18:00` | Local time of day of the evening question whether the owner wished them well; later than the reminder |
| `ASSISTANT_CURRENCY` | `BTN` | ISO 4217 default currency told to every agent |
| `ASSISTANT_OWNER_NAME` | `the owner` | Your name, as agents address you |
| `ASSISTANT_PORT` | `3001` | API port. It always binds to `127.0.0.1` |
| `ASSISTANT_API_ORIGIN` | `http://127.0.0.1:3001` | Where the web app proxies `/api/*` (web only). It is baked into `apps/web/.next` by `next build`: changing it, or `ASSISTANT_PORT`, needs a rebuild of the web app |

Changing `ASSISTANT_MODEL_MODE` on an existing data directory leaves agents pointing at the old mode's model. The server
warns at start-up when that happens, and **Settings** in the web app (or `PUT /api/settings/agents/:id`) points each
agent at a model the server can serve.

To try the production build on your own machine, where the browser cannot send a Tailscale identity, run it outside
production mode: `ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux node apps/server/dist/main.js` and
`pnpm --filter @assistant/web start`. `pnpm start` itself refuses `ASSISTANT_AUTH=off`.

OpenAI mode reads credentials from `<data>/secrets/credentials.json` (mode 0600, pi-ai's `CredentialStore` format). There is
no sign-in command yet (PLAN.md lists `pnpm login:openai` under Ops), and the server never logs in or calls OpenAI by itself.

Real push notifications need two things the server cannot provide. The page must be served over https (Tailscale Serve),
because browsers allow service workers and push subscriptions only on secure origins; `http://127.0.0.1` counts as one,
which is why development works. And on an iPhone the web app must first be added to the Home Screen. Then press
**Enable notifications** in Settings on each device. M2 was built and tested against the fake sender: a delivery through
FCM or Apple's push service has not been tried yet.

## Data directory

```text
data/
  app.sqlite       domain tables (agents, tasks, follow-ups, people, approvals, push subscriptions, daily schedule, journal, file index; expenses, ... later), WAL
  durable.sqlite   Durable's storage: conversations, entries, tasks (reminder timers included), WAL
  files/           uploads, `<yyyy-mm>/<id>-<name>`, mode 0600. Agents may read; the browser gets them back through `GET /api/files/:id`
  workspace/       generated files. The only place agents may write
  secrets/         credentials and keys, mode 0700. Never readable by an agent
    credentials.json   the OpenAI sign-in, mode 0600
    vapid.json         the Web Push key pair, mode 0600, created at the first start
  server.lock      held while a server runs on this directory (see below)
  dev-push-outbox.jsonl   what the fake push sender would have sent; only with ASSISTANT_PUSH_MODE=fake
```

Back both databases up together: `agents` in `app.sqlite` points at conversations in `durable.sqlite`, and the server
refuses to start if they disagree. (A crash between creating a conversation and recording it is repaired by itself at the
next start: every conversation is tagged with its agent inside the commit that creates it.) A task's reminder is also
split across the two: the `tasks_item` row says whether it is wanted and a Durable task is the timer, so at every start
the server recreates a timer the row wants and Durable lost. `app.sqlite` is written with `synchronous=FULL` and Durable's
database with `NORMAL`; see [`docs/design-notes.md`](docs/design-notes.md) for what that means after a power cut. Back up
`secrets/vapid.json` too: with a new key pair every device must enable notifications again.

One server per data directory: it holds `<data>/server.lock` while it runs, and a second start fails with the pid of the
first before it touches either database. A lock left behind by a crash is recognised as stale and taken over.

## Security rules

[`docs/PLAN.md` §2](docs/PLAN.md) is the source of truth. Where each rule lives in code:

- **No outbound actions, no bash:** no such tools exist. The file environment's `exec` always fails
  (`apps/server/src/env/scoped-env.ts`).
- **Deletes need your approval (rule 3):** the model can only ask. `delete_task`, `delete_followup` and `delete_person` are
  blocked by a `beforeTool` hook in code unless an approved request exists for exactly that task, follow-up or person in that
  conversation, whatever the model says
  (`packages/extensions/src/approvals`). You answer with the **Approve/Deny** buttons (`POST /api/approvals/:id`) or by
  replying exactly `YES`, which the server handles itself before the model sees it (only when one request is waiting and
  you have sent nothing else since it was made; otherwise use the buttons); the server then carries out the deletion. A
  request expires after 24 hours.
- **Files are an allowlist:** reads inside `ASSISTANT_READ_PATHS`, `<data>/files` and the workspace; writes only inside
  `<data>/workspace`. Always refused, in any letter case: `.ssh`, `.env*`, `auth.json`, `*.pem`, `*.key`, `.netrc`, `.npmrc`,
  `.aws`, `.git-credentials`, `.gnupg`, `id_*` and `<data>/secrets/**`. The data directory, the workspace and the secrets
  folder are resolved through symlinks at startup and every path is resolved before the check, so a link cannot smuggle a
  protected file in. A read path that would expose the databases is rejected at startup. The PA's file tools
  (`read_file`, `list_dir`, `read_file_path`, `search_files`) go through the same environment, so the list holds for them
  too: `list_dir` does not show a protected file, and a read of one or of a path outside the folders is refused with the
  reason. An upload cannot be a way around it: it is stored under `<data>/files` by an id the server chooses, judged by
  its content (an image, a PDF, CSV or UTF-8 text; text holding a private key is refused), served back with `nosniff`, a
  sandboxing CSP, and as a download unless it is an image.
- **Secrets:** `<data>/secrets` is 0700; `credentials.json` and `vapid.json` (the Web Push private key, created at the first
  start) are 0600, written atomically and fsynced. The private key never leaves that folder: browsers get only the public
  key. The credential store is locked (`credentials.json.lock`) against a second writer, such as a future login command
  running beside the server, and removes temp files a crashed write left behind. The data directory is set to 0700 at
  every start.
- **Pushes carry no content:** a push travels through Google's or Apple's servers, so it says only "Reminder" and
  "1 reminder", "1 meeting is about to start", "1 question: how did it go?" or "1 birthday today" and links to the chat
  (`reminder.ts`, `followups/task.ts`, `people/task.ts`). Task titles, meeting names, agenda points and people's names stay
  on this machine and in the chat. Only `apps/server/src/push/sender.ts` talks to a push service; a subscription it reports gone (404/410) is
  deleted.
- **Network:** the server binds `127.0.0.1` only. For every API request, in both auth modes: the `Host` header must be one
  the server is meant to answer to (the loopback names on its port, plus `ASSISTANT_PUBLIC_HOST`), which defeats DNS
  rebinding; state-changing requests that the browser marks `Sec-Fetch-Site: cross-site` are refused; every POST/PUT must be
  `application/json`, which makes a cross-site form post impossible. The one exception is `POST /api/uploads`, which takes
  one `multipart/form-data` file per request and so cannot be protected by that rule: it **requires**
  `Sec-Fetch-Site: same-origin` or `none` (every browser sends it; a script or a form on another site cannot forge it),
  on top of the `Host` rule and the auth below, and nothing else is exempt. Tailscale identifies the owner by device, not by
  cookie, so without these another website could act as the owner from the owner's browser. With auth on, the peer must
  also be loopback and `Tailscale-User-Login` must equal `ASSISTANT_OWNER_LOGIN`. JSON bodies are limited to 256 KB, an
  upload to 20 MB, and at most 8 event streams stay open. The reasoning is in [`docs/design-notes.md`](docs/design-notes.md).
- **The browser never sees** the system prompt (the agent's `instructions`), server paths or opaque provider signatures
  (`apps/server/src/wire.ts`). It does see the agent's model name and thinking level.

## How it fits together

```text
browser ──/api/*──► Next (dev proxy)  ──►  Hono API ──► Durable Harness ──► durable.sqlite
   ▲                                          │  └─► app.sqlite (agents, tasks, approvals, push)
   └──────── SSE: snapshot, then deltas ◄─────┘   stream.ts (the only user of watchEvents)
```

- `GET /api/agents` (agents plus `health`: how many tasks are parked, and which), `GET|POST /api/conversations/:id/messages`,
  `POST …/abort`, `GET …/stream` (SSE), `GET /api/settings/agents`, `GET|PUT /api/settings/agents/:id` (model and thinking
  level, validated against the models this server serves), `GET /api/push/config` (the public VAPID key),
  `POST|DELETE /api/push/subscribe` (one device's subscription), `POST /api/approvals/:id`
  (`{ "decision": "approve" | "deny" }`), `POST /api/admin/tasks/:id/retry`, `GET /api/settings/schedule` and
  `PUT /api/settings/schedule/:job` (`{ "localTime"?, "enabled"? }`, job `briefing` or `wrapup`), `POST /api/uploads`
  (multipart, one `file` field) and `GET /api/files/:id` (an upload, back). Errors are
  `{ "error": { "code", "message" } }`. Types are in `packages/shared`. Only conversations that belong to an agent are
  reachable.
- A message needs a client-generated `requestId`; resending it never sends the message twice. The web app keeps one id per
  message across retries.
- Every SSE connection starts with a `snapshot` event (system entries removed, newest 200 entries, and why recent messages
  were never answered), followed by Durable's agent events as they are committed, every 100 ms while an answer streams.
  A named `ping` event arrives every 15 s; the browser reconnects after 40 s of silence, and when the tab or the network
  comes back. Reconnecting just gets a fresh snapshot. Older history comes from `GET …/messages?before=`.
- The port is bound before Durable is opened and answers 503 "starting" meanwhile.
- **Reminders cost no model tokens.** `add_task` with a reminder time (or `snooze_reminder`) starts a Durable task that
  sleeps until then. When it wakes it writes an `app.reminder` entry into the `pa` conversation (shown as a card; display-only,
  the model is never called for it, even if an earlier run failed and left a message queued) and sends the push. "Snooze
  it" still works because the `tasks` prompt section lists the reminders that were sent for tasks that are still open. The
  `tasks_item` row is the truth and the Durable task only a timer: rescheduling, snoozing, completing or deleting change
  the row, and an outdated timer ends itself. A reminder that came due while the server was down fires when it starts again,
  and the server checks for due reminders every 30 seconds and repairs lost or failed timers every 10 minutes, so a machine
  that wakes from suspend catches up (it does not wake itself: [`docs/OPS.md`](docs/OPS.md)). The model learns what time it
  is from the `current_time` tool, works in `ASSISTANT_TIMEZONE`, and times are stored as UTC.
  Reasoning: [`docs/design-notes.md`](docs/design-notes.md).
- **Follow-ups and birthdays work the same way as reminders** (the `followups` and `people` modules): a row in `app.sqlite`
  is the truth and a Durable task is its timer, with the repair at start and every ten minutes shared with reminders
  (`packages/extensions/src/timers.ts`). A meeting's timer sleeps until the agenda is due, posts it only if there are
  points, sleeps until the end of the meeting and posts the question (a commitment is also nudged when it is due), and asks
  once more the next morning if nobody answered; the answer comes through the `record_outcome` tool, which resolves it and,
  when something has to be followed up, creates the next link of the chain. A person's timer wakes in the morning of their
  birthday and in the evening, then starts next year's; the birthday cards that a power cut took from Durable's database
  after the cycle had ended are posted again at start. A card that a timer posts is display-only
  and costs no model call; the `followups` and `people` prompt sections (from the database, no clock beyond the local date)
  tell the model which questions are open, so "they agreed to a viewing on Friday" and "yes, I did" find what they answer.
  Reasoning: [`docs/design-notes.md`](docs/design-notes.md).
- **The daily jobs work the same way again** (the `daily` module): `schedule_daily` has one row per job (local time, on or off,
  the run that is waiting) and a Durable task `app.daily` is its timer. At the time the server gathers facts from every
  module that registered a provider (today's tasks and reminders, overdue tasks, meetings and follow-ups with their agenda
  counts, open questions, birthdays today and in three days, yesterday's carried-over items) and puts them to the PA as one
  request, an `app.daily` entry that the thread shows as a card, with a generic push; the instructions for writing the
  briefing live in the PA's rules, not in the day's text. With nothing to report the briefing is a card and no model call. The
  wrap-up always asks what you got done, with what the system recorded, and `save_journal` keeps the answer in `pa_journal`
  (one row per day, replaced by a later answer; replaying a call changes nothing). The briefing is run late, once, when the
  server starts or wakes after its time and before 11:00 (a wrap-up before midnight); a job's first start, an edit in
  Settings and a day that already ran are never "late". Times are local to `ASSISTANT_TIMEZONE` and follow its clock changes.
  Reasoning: [`docs/design-notes.md`](docs/design-notes.md).
- **Files.** `POST /api/uploads` stores a file under `<data>/files/<yyyy-mm>/` and indexes it in `files_index` (name,
  type found by looking at the content, size, a description and tags the PA can add). A message names its files with one
  `[Attached file: …]` line each, which the web app writes and shows back as chips; the PA reads them with `read_file` (its
  own bounded reader: text and CSV by lines, images through the image processor so that the model sees them, PDFs not
  yet). Behind the Next dev proxy (`next dev`, or `next start` without Tailscale Serve) uploads work up to the cap because
  `apps/web/next.config.ts` lifts Next's 10 MB limit on proxied bodies; in production Tailscale Serve sends `/api/*` to
  the server directly.
- **Parked tasks:** a task cut off by crashes (not by a normal stop) five times in a row is parked by Durable and does
  nothing until retried. The server logs it as an error at every start and the web app shows a banner with a **Retry**
  button (`POST /api/admin/tasks/:id/retry`; from a shell it needs `Content-Type: application/json` even without a body, see
  [`docs/OPS.md`](docs/OPS.md)). Nothing retries it automatically: find out why the process kept dying first.
- **A restart mid-answer** keeps what had been written as an interrupted message and answers again from the same
  question, once. Nothing is sent twice. The browser shows "Reconnecting…" meanwhile.

## Tests

`pnpm test` runs everything against the faux model with no network and no push service: the migration runner (ids per
module), config validation, the file environment, credential store and file locks, agents, the HTTP API, the stream module,
the full server over real HTTP and SSE including a restart in the middle of an answer and a child process killed with
SIGKILL, and the web reducer and store. M2 added, all with a fake clock and a fake push sender:

- the task tools, driven by scripted tool calls: the same call id twice makes one row (also when the replay runs after the
  reminder time has passed), and a replayed snooze does not move the reminder twice;
- reminders: fire once, including across a crash between posting the card and recording it, and again when Durable's
  database comes back older than app.sqlite (a simulated power cut); snoozing, completing, clearing or deleting cancels;
  close and reopen; a timer Durable lost or faulted is recreated (at start, and by the periodic repair); the card never
  starts a model run, even with a failed run's message queued; the server wakes a due reminder by itself;
- approvals: the hook blocks and permits, a reply of YES (only the exact word, only when it is the one request waiting and
  nothing else was said since, resends, other conversations), the 24 hour expiry, notices lost in a power cut come back,
  rows of a conversation that is gone are reported and do not stop the server;
- push: the sender gets the minimal payload, a 404/410 removes the subscription, the key file is created 0600, endpoints
  that are not public hosts are refused, the subscription follows the server's key and the push service's changes;
- the web: reminder, notice, task and approval cards rendered from a recording of the real server, the agenda, question and
  birthday cards, the service worker
  (including addresses that leave the site only after URL parsing), the notification setup, and the API client's approval
  and retry calls.

M4 added: the daily engine with a fake clock (the next run across the clock changes of New York in 2026 and across midnight,
the late window, once per day, a first start and an edit are not late, a crash between the plan and the request, a power
cut), the facts providers and an empty day that costs no model call, the journal tools (a replayed call, a later answer, a
future date), the uploads (the `Sec-Fetch-Site` rule, `Host`, size, type by content, a private key, every other write still
refusing a form), the file tools and the deny list through them (`.env*`, `id_*`, keys, links into them, the databases,
anything outside the roots), the share target route with a fake `fetch`, and the web pieces that need no browser (cards,
chips, attachments, the capture address, the upload client over a fake request).

M3 added, again with a fake clock and a fake push sender: the follow-up life cycle (the agenda only when there are points and
only before the meeting began, the question after the end time, the chain of follow-ups until one resolves, repair, a
restart, a crash between posting and recording, Durable's database coming back older than app.sqlite), agenda points matched
to meetings by words (and the list of candidates when it is ambiguous), the birthday cycle (local morning and evening, skipped
when wished, 29 February, years missed during a long stop, across a change of the clock), the prompt sections, the
configuration of the times, and the whole server over HTTP for both. The review fixes added: a YES typed to a question a timer
asked, birthday cards lost to a power cut (also over the whole server), a birthday corrected within the year, the re-ask, the
nudge of a commitment, a date without a time, `update_followup`, and which tools the PA is offered.

The web reducer is tested against event streams recorded from the real server (`apps/web/test/fixtures/*.json`; M2 added
`reminders-approvals.json`: a reminder firing and a deletion approved with the button). Durable's event protocol is
experimental: after upgrading it, run `node apps/server/scripts/record-fixtures.ts` (it re-records all five), review the
diff, and run the tests.
