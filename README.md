# Assistant

A personal assistant that runs on one always-on Linux machine and is reached privately, over Tailscale, from a
ChatGPT-style web chat. Several themed agents (`pa`, `inbox`, `health`, `accountant`) each keep one endless,
crash-safe conversation on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable): if the
process dies mid-answer, the next start picks the work up where it stopped.

Status: **Milestone 1 (foundation)**. You can open the web UI, pick an agent, chat, and watch the answer stream in. In dev
mode the model is a scripted stand-in, so nothing leaves the machine. Agents have no tools yet; tasks, reminders, mail,
health and accounting arrive in later milestones. The full design and milestone list is in [`docs/PLAN.md`](docs/PLAN.md).

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
  server/        Node process: Durable Harness, HTTP API, SSE. Entry: src/main.ts
  web/           Next.js (App Router) + assistant-ui over the server's API
packages/
  shared/        API contracts: DTOs, error shape, stream event types (types only, plus tiny constants)
  db/            app.sqlite: node:sqlite wrapper and the migration runner, core tables
  extensions/    Durable extensions the server installs (profile now; tasks, memory, files, ... later)
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

OpenAI mode reads credentials from `<data>/secrets/credentials.json` (mode 0600, pi-ai's `CredentialStore` format). The
sign-in command is not part of Milestone 1, and the server never logs in or calls OpenAI by itself.

## Data directory

```text
data/
  app.sqlite       domain tables (agents now; tasks, expenses, ... later), WAL
  durable.sqlite   Durable's storage: conversations, entries, tasks, WAL
  files/           uploads. Agents may read
  workspace/       generated files. The only place agents may write
  secrets/         credentials and keys, mode 0700. Never readable by an agent
```

Back both databases up together: `agents` in `app.sqlite` points at conversations in `durable.sqlite`, and the server
refuses to start if they disagree. (A crash between creating a conversation and recording it is repaired by itself at the
next start: every conversation is tagged with its agent inside the commit that creates it.) `app.sqlite` is written with
`synchronous=FULL` and Durable's database with `NORMAL`; see [`docs/design-notes.md`](docs/design-notes.md) for what that
means after a power cut.

One server per data directory: it holds `<data>/server.lock` while it runs, and a second start fails with the pid of the
first before it touches either database. A lock left behind by a crash is recognised as stale and taken over.

## Security rules

[`docs/PLAN.md` §2](docs/PLAN.md) is the source of truth. Where each rule lives in code:

- **No outbound actions, no bash:** no such tools exist. The file environment's `exec` always fails
  (`apps/server/src/env/scoped-env.ts`).
- **Files are an allowlist:** reads inside `ASSISTANT_READ_PATHS`, `<data>/files` and the workspace; writes only inside
  `<data>/workspace`. Always refused, in any letter case: `.ssh`, `.env*`, `auth.json`, `*.pem`, `*.key`, `.netrc`, `.npmrc`,
  `.aws`, `.git-credentials`, `.gnupg`, `id_*` and `<data>/secrets/**`. The data directory, the workspace and the secrets
  folder are resolved through symlinks at startup and every path is resolved before the check, so a link cannot smuggle a
  protected file in. A read path that would expose the databases is rejected at startup.
- **Secrets:** `<data>/secrets` is 0700 and `credentials.json` 0600, written atomically and fsynced. The credential store
  is locked (`credentials.json.lock`) against a second writer, such as a future login command running beside the server,
  and removes temp files a crashed write left behind. The data directory is set to 0700 at every start.
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
   ▲                                          │  └─► app.sqlite (agents, later domains)
   └──────── SSE: snapshot, then deltas ◄─────┘   stream.ts (the only user of watchEvents)
```

- `GET /api/agents` (agents plus `health.parkedTasks`), `GET|POST /api/conversations/:id/messages`, `POST …/abort`,
  `GET …/stream` (SSE), `GET /api/settings/agents`, `GET|PUT /api/settings/agents/:id` (model and thinking level, validated
  against the models this server serves). Errors are `{ "error": { "code", "message" } }`. Types are in `packages/shared`.
  Only conversations that belong to an agent are reachable.
- A message needs a client-generated `requestId`; resending it never sends the message twice. The web app keeps one id per
  message across retries.
- Every SSE connection starts with a `snapshot` event (system entries removed, newest 200 entries, and why recent messages
  were never answered), followed by Durable's agent events as they are committed, every 100 ms while an answer streams.
  A named `ping` event arrives every 15 s; the browser reconnects after 40 s of silence, and when the tab or the network
  comes back. Reconnecting just gets a fresh snapshot. Older history comes from `GET …/messages?before=`.
- The port is bound before Durable is opened and answers 503 "starting" meanwhile.
- **Parked tasks:** a task cut off by crashes (not by a normal stop) five times in a row is parked by Durable and does
  nothing until retried. The server logs it as an error at every start and the web app shows a banner. Nothing retries it
  automatically; there is no retry command yet.
- **A restart mid-answer** keeps what had been written as an interrupted message and answers again from the same
  question, once. Nothing is sent twice. The browser shows "Reconnecting…" meanwhile.

## Tests

`pnpm test` runs everything against the faux model with no network: the migration runner, config validation, the file
environment, credential store and file locks, agents, the HTTP API, the stream module, the full server over real HTTP and
SSE including a restart in the middle of an answer and a child process killed with SIGKILL, and the web reducer and store.

The web reducer is tested against event streams recorded from the real server (`apps/web/test/fixtures/*.json`). Durable's
event protocol is experimental: after upgrading it, run `node apps/server/scripts/record-fixtures.ts`, review the diff,
and run the tests.
