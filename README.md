# Assistant

A personal assistant that runs on one always-on Linux machine and is reached privately, over Tailscale, from a
ChatGPT-style web chat. Several themed agents (`pa`, `inbox`, `health`, `accountant`) each keep one endless,
crash-safe conversation on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable): if the
process dies mid-answer, the next start picks the work up where it stopped.

Status: **Milestone 2 (tasks, reminders, approvals)**. You can open the web UI, pick an agent, chat, and watch the answer
stream in. The `pa` agent now keeps a task list: it captures tasks and reminders from chat, reminds you at the right time
(also after a restart, and without calling the model) and sends a Web Push notification to your phone. Deleting a task
needs your explicit approval. In dev mode the model is a scripted stand-in and pushes go to a file, so nothing leaves the
machine. The other agents have no tools yet; follow-ups, briefings, mail, health and accounting arrive in later
milestones. The full design and milestone list is in [`docs/PLAN.md`](docs/PLAN.md).

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
(arguments: `packages/extensions/src/tasks/tools.ts`). Dev mode also keeps pushes on the machine
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
  extensions/    Durable extensions the server installs: domain modules `tasks` and `approvals`, and `profile`; more later
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
| `ASSISTANT_TIMEZONE` | `Asia/Thimphu` | IANA time zone told to every agent |
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
  app.sqlite       domain tables (agents, tasks, approvals, push subscriptions now; expenses, ... later), WAL
  durable.sqlite   Durable's storage: conversations, entries, tasks (reminder timers included), WAL
  files/           uploads. Agents may read
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
- **Deletes need your approval (rule 3):** the model can only ask. `delete_task` is blocked by a `beforeTool` hook in code
  unless an approved request exists for exactly that task in that conversation, whatever the model says
  (`packages/extensions/src/approvals`). You answer with the **Approve/Deny** buttons (`POST /api/approvals/:id`) or by
  replying exactly `YES`, which the server handles itself before the model sees it (only when one request is waiting and
  you have sent nothing else since it was made; otherwise use the buttons); the server then carries out the deletion. A
  request expires after 24 hours.
- **Files are an allowlist:** reads inside `ASSISTANT_READ_PATHS`, `<data>/files` and the workspace; writes only inside
  `<data>/workspace`. Always refused, in any letter case: `.ssh`, `.env*`, `auth.json`, `*.pem`, `*.key`, `.netrc`, `.npmrc`,
  `.aws`, `.git-credentials`, `.gnupg`, `id_*` and `<data>/secrets/**`. The data directory, the workspace and the secrets
  folder are resolved through symlinks at startup and every path is resolved before the check, so a link cannot smuggle a
  protected file in. A read path that would expose the databases is rejected at startup.
- **Secrets:** `<data>/secrets` is 0700; `credentials.json` and `vapid.json` (the Web Push private key, created at the first
  start) are 0600, written atomically and fsynced. The private key never leaves that folder: browsers get only the public
  key. The credential store is locked (`credentials.json.lock`) against a second writer, such as a future login command
  running beside the server, and removes temp files a crashed write left behind. The data directory is set to 0700 at
  every start.
- **Pushes carry no content:** a push travels through Google's or Apple's servers, so it says only "Reminder" and
  "1 reminder" and links to the chat (`packages/extensions/src/tasks/reminder.ts`). Task titles stay on this machine and in
  the chat. Only `apps/server/src/push/sender.ts` talks to a push service; a subscription it reports gone (404/410) is
  deleted.
- **Network:** the server binds `127.0.0.1` only. For every API request, in both auth modes: the `Host` header must be one
  the server is meant to answer to (the loopback names on its port, plus `ASSISTANT_PUBLIC_HOST`), which defeats DNS
  rebinding; state-changing requests that the browser marks `Sec-Fetch-Site: cross-site` are refused; every POST/PUT must be
  `application/json`, which makes a cross-site form post impossible. Tailscale identifies the owner by device, not by
  cookie, so without these another website could act as the owner from the owner's browser. With auth on, the peer must
  also be loopback and `Tailscale-User-Login` must equal `ASSISTANT_OWNER_LOGIN`. Request bodies are limited to 256 KB
  and at most 8 event streams stay open. The reasoning and the plan for uploads are in
  [`docs/design-notes.md`](docs/design-notes.md).
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
  (`{ "decision": "approve" | "deny" }`) and `POST /api/admin/tasks/:id/retry`. Errors are
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
- the web: reminder, notice, task and approval cards rendered from a recording of the real server, the service worker
  (including addresses that leave the site only after URL parsing), the notification setup, and the API client's approval
  and retry calls.

The web reducer is tested against event streams recorded from the real server (`apps/web/test/fixtures/*.json`; M2 added
`reminders-approvals.json`: a reminder firing and a deletion approved with the button). Durable's event protocol is
experimental: after upgrading it, run `node apps/server/scripts/record-fixtures.ts` (it re-records all five), review the
diff, and run the tests.
