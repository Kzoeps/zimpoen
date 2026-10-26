# Zimpoen

A self-hosted personal assistant. It runs on one always-on Linux machine and you reach it privately over Tailscale,
from a chat UI in the browser or as an installed PWA.

Each agent keeps one long-running, crash-safe conversation on
[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable). If the process dies mid-answer, the next
start picks up from where it stopped.

## Agents

| Agent | What it does |
|---|---|
| `pa` | Tasks and reminders, meeting follow-ups and agendas, birthdays, the morning briefing and evening wrap-up, file attachments |
| `inbox` | Reads Gmail and Google Calendar (read-only), sorts the mail and sends a digest twice a day, suggests follow-ups |
| `health` | Weight and gym logs, trends, estimated 1RM, personal records, charts |
| `accountant` | Expenses and income (from chat, receipts or bank CSVs), balances, bill splitting, monthly invoice PDFs |

Shared across agents:

- **Memory and profile:** facts and preferences you can edit on the Profile page.
- **Activity log**
- **Usage page:** token usage, with a weekly limit per agent.

Reminders and scheduled cards cost no model tokens. They are also sent as Web Push notifications, and the push carries no
content.

## Requirements

- Node 24+
- pnpm 10

## Quickstart

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:3000>. Dev mode uses a scripted model, a fake mailbox and a fake push sender, so nothing leaves
the machine. Data goes to `./data-dev`.

Agents may read `~/Documents` and `~/Downloads` by default. If you don't have those folders, point the setting
elsewhere:

```bash
ASSISTANT_READ_PATHS=/some/folder pnpm dev
```

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Server (with reload) and web dev server |
| `pnpm build` | Bundle the server and build the web app |
| `pnpm start` | Run the built server in production mode |
| `pnpm test` | Vitest across the workspace |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` | Biome lint and format check |
| `pnpm login:openai` / `logout:openai` | Sign in to OpenAI with a ChatGPT subscription |
| `pnpm connect:google` | Connect a Gmail account (read-only) |

## Layout

```text
apps/
  server/       Durable harness, HTTP API (Hono), SSE, Web Push
  web/          Next.js + assistant-ui, PWA
packages/
  shared/       API contracts and event types
  db/           SQLite wrapper and migrations
  extensions/   Domain modules: tasks, followups, people, daily, files, health, ledger, splits, invoices, inbox, memory, usage, ...
ops/            systemd units, Tailscale Serve and health-check scripts, env example
docs/           Design, setup and operations guides
```

## Configuration

Settings are environment variables, validated at startup. A `.env` file is not loaded: export the variables or use the
systemd env file (`ops/assistant.env.example`).

| Variable | Default | Description |
|---|---|---|
| `ASSISTANT_DATA_DIR` | `./data-dev` (dev), `./data` (prod) | State directory |
| `ASSISTANT_READ_PATHS` | `~/Documents:~/Downloads` | Folders agents may read, separated by `:` |
| `ASSISTANT_AUTH` | `on` (`off` in `pnpm dev`) | Tailscale identity check. Can't be turned off in production |
| `ASSISTANT_OWNER_LOGIN` | — | Your Tailscale login. Required when auth is on |
| `ASSISTANT_PUBLIC_HOST` | — | Your Tailscale Serve hostname(s) |
| `ASSISTANT_MODEL_MODE` | `faux` / `openai` | Scripted dev model, or OpenAI |
| `ASSISTANT_PUSH_MODE` | `fake` / `web-push` | `fake` writes to `<data>/dev-push-outbox.jsonl` |
| `ASSISTANT_PUSH_SUBJECT` | — | VAPID contact (`mailto:` or `https:`). Required for `web-push` |
| `ASSISTANT_GOOGLE_MODE` | `fake` / `real` | Demo mailbox, or real Gmail and Calendar |
| `ASSISTANT_TIMEZONE` | `Asia/Thimphu` | IANA time zone for every scheduled job |
| `ASSISTANT_CURRENCY` | `BTN` | Default currency (ISO 4217) |
| `ASSISTANT_OWNER_NAME` | `the owner` | How agents address you |
| `ASSISTANT_OWNER_HEIGHT_CM` | unset | Enables BMI in the Health agent |
| `ASSISTANT_PORT` | `3001` | API port. Always binds `127.0.0.1` |
| `ASSISTANT_API_ORIGIN` | `http://127.0.0.1:3001` | Where the web app proxies `/api`. Changing it needs a web rebuild |

| `ASSISTANT_AGENDA_LEAD_MINUTES` | `15` | Post a meeting's agenda this long before it starts |
| `ASSISTANT_FOLLOWUP_ASK_DELAY_MINUTES` | `30` | Ask how a meeting went this long after it starts |
| `ASSISTANT_FOLLOWUP_REASK_TIME` | `09:00` | Time of the one re-ask, the next morning |
| `ASSISTANT_FOLLOWUP_DEFAULT_TIME` | `10:00` | Time used when a follow-up has a date but no time |
| `ASSISTANT_BIRTHDAY_REMIND_TIME` | `09:00` | Birthday reminder |
| `ASSISTANT_BIRTHDAY_CHECK_TIME` | `18:00` | Evening "did you wish them?" check |
| `ASSISTANT_INBOX_SYNC_MINUTES` | `10` | Gmail sync interval |

The times of the briefing, wrap-up and digests are set in the app under **Settings → Daily schedule**.

## Data

```text
data/
  app.sqlite       domain tables
  durable.sqlite   conversations and durable tasks
  files/           uploads
  workspace/       generated files (invoices); the only place agents can write
  templates/       your invoice template; agents can't read it
  secrets/         credentials and keys (0700); agents can't read it
```

Back up `app.sqlite`, `durable.sqlite` and `secrets/vapid.json` together. Only one server can run on a data directory
at a time; `server.lock` enforces this.

## Security

- No outbound actions and no shell. There are no tools to send mail, invoices or anything else.
- Deletes need your approval, which code enforces through an approval hook.
- Gmail and Calendar access is read-only by scope. Email content is treated as untrusted data.
- File access is an allowlist. Secrets, keys, `.env*` and the databases are always refused, and symlinks are resolved
  before the check.
- The API binds `127.0.0.1` only and checks `Host`, `Sec-Fetch-Site` and the Tailscale identity.
- Pushes carry no content.

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2 and [`docs/design-notes.md`](docs/design-notes.md).

## Deployment

- [`docs/SETUP.md`](docs/SETUP.md): install checklist (systemd, Tailscale Serve, OpenAI sign-in)
- [`docs/OPS.md`](docs/OPS.md): running and troubleshooting
- [`docs/setup-google.md`](docs/setup-google.md), [`docs/setup-jev.md`](docs/setup-jev.md),
  [`docs/setup-invoice.md`](docs/setup-invoice.md): optional integrations

After deploying, run `ops/check.sh` to verify the setup.

## Development

Tests run offline against the scripted model, fake Google and fake push. The web tests replay event streams recorded
from the real server (`apps/web/test/fixtures/`). After upgrading Durable, re-record them:

```bash
node apps/server/scripts/record-fixtures.ts
```
