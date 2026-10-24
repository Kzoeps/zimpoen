# Personal assistant — implementation plan

Status: approved direction, Milestone 1 in progress. Owner: Dorje.

## 1. Goal

An always-on personal assistant running on an old Linux laptop, reached privately over Tailscale from a
ChatGPT-like web UI (Android PWA). Several themed agents, each a durable conversation:

| Agent        | Purpose                                                                                                                                  | Default model                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `pa`         | Front door. Tasks, reminders, follow-ups, meeting agendas, birthdays, morning briefing, evening wrap-up, done-log. Can ask other agents. | `openai/gpt-6.1-sol`, thinking `medium` |
| `inbox`      | Gmail (several accounts, read-only) + Google Calendar (read-only). Jev triage, digests, hands commitments to PA.                         | `gpt-6.1-sol`, `low`                    |
| `health`     | Weight, gym lifts, trends.                                                                                                               | `gpt-6.1-sol`, `low`                    |
| `accountant` | Expenses (mostly BTN), balance, bill splits, monthly invoice PDFs.                                                                       | `gpt-6.1-sol`, `low`                    |

Model and thinking level are per-agent settings editable at runtime (stored per conversation in Durable's
`pi.agent` document via `configure()`), never hard-coded in agent logic.

Model access: ChatGPT **Plus** subscription via pi-ai's "Sign in with ChatGPT" OAuth on the `openai` provider.
Allowed for personal, user-controlled runtimes. Tokens stored locally on the laptop only.
Anthropic subscription OAuth must NOT be used (violates Anthropic consumer terms).

## 2. Hard rules (security and behavior)

1. **No outbound actions.** No tool may send email, post messages, spend money, or contact people. These tools do
   not exist. Gmail and Calendar use read-only OAuth scopes only.
2. **Writes are local only:** `app.sqlite`, memory, generated files under the workspace.
3. **Deletes require explicit approval** in chat (Approve button or a literal "YES"), enforced by a `beforeTool` hook
   in code, not by prompt.
4. **File access is an allowlist.** Read: `/home/<user>/Documents`, `/home/<user>/Downloads`, `<data>/files`.
   Write: `<data>/workspace`. Always denied: `**/.ssh/**`, `**/.env*`, `**/auth.json`, `<data>/secrets/**`.
   Paths are absolute in config; startup verifies each allowed path is readable and fails loudly otherwise.
5. **No `bash` tool** for any agent.
6. **Inbox agent has no file tools** (it processes untrusted email text).
7. **Arithmetic is code, never the model** (splits, balances, totals, invoice numbers).
8. **Every app.sqlite write from a tool is idempotent** by the tool call ID (`source_call_id UNIQUE`,
   `ON CONFLICT DO NOTHING`), because Durable may rerun a replay-safe tool after a crash.
9. **Secrets** (OAuth credential store, Jev key, VAPID keys) live in `<data>/secrets/`, mode 0600, never readable
   through any agent environment.
10. Server and web bind to `127.0.0.1` only. Tailscale Serve is the only ingress.

## 3. Topology

```text
Phone / laptop (Tailscale on)
   │ HTTPS https://<machine>.<tailnet>.ts.net      (tailscale serve; Funnel OFF)
   ▼
Laptop
   tailscale serve ──► web    Next.js + assistant-ui     127.0.0.1:3000
                  └──► server API + SSE + Durable        127.0.0.1:3001  (path prefix /api)
   server owns:  data/durable.sqlite   (pi-durable storage, node:sqlite)
                 data/app.sqlite       (our domain tables, node:sqlite)
                 data/files/           (uploads: CSVs, bill photos)
                 data/workspace/       (generated: invoice PDFs, markdown notes)
                 data/secrets/         (credential store, keys)
```

Outbound only: OpenAI (model), Google APIs (Gmail/Calendar read), TypeSafe Jev (triage), Web Push service (FCM).
Push payloads are minimal ("1 reminder"), never sensitive content.

Machine naming: pick a non-identifying machine name before enabling Tailscale HTTPS (names appear in public
certificate transparency logs). Which Linux user runs the server is a deployment decision, not app code.

## 4. Repository layout (pnpm workspace)

```text
assistant/
  apps/
    server/          long-running Node 24 process: Harness, scheduler, HTTP API, SSE, sync jobs
    web/             Next.js (App Router) + @assistant-ui/react, PWA
  packages/
    shared/          API contracts: route types, SSE event types, UI card types (details payloads)
    db/              app.sqlite access: migration runner, typed query helpers
    extensions/      Durable extensions: profile, memory, tasks, followups, people, files, approvals, ...
  docs/PLAN.md
```

TypeScript strict everywhere, ESM, Node 24 type stripping is fine for server dev but ship a build.
Tests: vitest. Durable tests use the pi-ai **faux provider** (no network, no credentials).

Dependencies pinned exactly: `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord`
(all `1.4.0` at time of writing; API is experimental). Reference source: `~/Projects/personal/pi/packages/durable`
(README, docs/spec.md, test/examples). Verify every Durable API against that source; do not guess signatures.

## 5. Server architecture

```ts
// apps/server/src/main.ts (shape)
const config = loadConfig(); // data dir, allowlists, agent defaults; validated, fails loudly
const appDb = openAppDb(config.paths.appDb); // node:sqlite, WAL, runs migrations from all extensions
const models = createModels({
	credentials: fileCredentialStore(config.paths.secrets),
});
models.setProvider(openaiProvider());

const registry = createRegistry();
for (const ext of buildExtensions({ appDb, config, notifier }))
	registry.install(ext);

const harness = await Harness.open(
	await openNodeSqliteStorage(config.paths.durableDb),
	{
		models,
		registry,
		env: scopedEnvFor(config),
		settings: liveSettings(config),
	},
	ctx,
);
await ensureAgents(harness, appDb, AGENTS); // idempotent: one conversation per agent id
harness.resume();
startHttp({ harness, appDb, config }); // 127.0.0.1 only
```

### 5.1 Agents

```ts
type AgentId = "pa" | "inbox" | "health" | "accountant";
type AgentDef = {
	id: AgentId;
	name: string;
	avatar: string; // UI identity
	defaultModel: { provider: string; modelId: string };
	defaultThinking: ModelThinkingLevel;
	extensions: Extension[]; // capability boundary
	instructions: string;
};
```

Agent → conversation mapping is stored in `app.sqlite` table `agents (id PK, conversation_id, created_at)`.
`ensureAgents` creates missing conversations with `harness.createConversation({ ownership: { kind: "ownerless" }, agent: {...} }, context)` (ownership is required) and records them.
Only `pa` gets `ask_agent`; specialists cannot reach each other (capability by tool presence).

### 5.2 Domain extension contract

```ts
type DomainModule = {
	name: string; // "tasks", "people", "health", ...
	migrations: Migration[]; // tables prefixed by domain: tasks_*, people_*, ...
	extension: (deps: Deps) => Extension; // Durable extension: tools, sections, hooks, tasks
};
type Migration = { id: string; up: (db: AppDb) => void }; // applied once, recorded in _migrations
```

Tool rules: TypeBox params; `output` short text for the model; `details` typed card payload for the UI
(types in `packages/shared`); `structuredOutput` for code callers. Rarely used tools `deferred: true` with the
`tool_search` extension. Write tools declare `replay: "safe"` only when idempotent per rule 8.

### 5.3 Zero-token posts

Reminders and system notices are posted with `conversation.submit({ type: "write", entry: { kind, data } })`
using custom entry kinds (`app.reminder`, `app.notice`). No model call. The model is invoked only when the user replies.
A write of only `kind`/`data` is appended immediately even mid-run (README "Busy Conversations").

### 5.4 Durable tasks (state machines)

```ts
// Reminder: one per reminder. Phases rerun from top after crash; effects guarded by memo.
Reminder: wait --sleepUntil(dueAt)--> fire --(memo "posted") write app.reminder + push--> terminal
// Recurrence (birthdays yearly, briefing daily) = on terminal, create the next instance in the same commit.

FollowUp: wait(until event end) -> ask (write app.followup question, push)
          -> await_outcome (completed by tool record_outcome) -> maybe schedule next FollowUp
MorningBriefing (daily 07:30 Asia/Thimphu): gather (code) -> submit input to pa ("compose briefing", requestId per date)
EveningWrapUp  (daily 21:00): gather done-log facts (code) -> submit input to pa -> user replies -> pa_journal row
```

Timezone: `Asia/Thimphu`, configurable. Due times stored as UTC epoch ms.

### 5.5 HTTP API (apps/server, all under /api, JSON)

```text
GET  /api/agents                          -> AgentSummary[] (id, name, avatar, conversationId, busy, unread)
GET  /api/conversations/:id/stream        -> SSE: snapshot event, then Durable agent-event batches
POST /api/conversations/:id/messages      { content, requestId, whenBusy?: "steer"|"followUp" } -> { submissionId }
POST /api/conversations/:id/abort
GET  /api/conversations/:id/messages?before=  history paging (root.entries)
POST /api/approvals/:id                   { decision: "approve"|"deny" }
GET  /api/settings/agents  PUT /api/settings/agents/:id   { model, thinkingLevel }
POST /api/push/subscribe                  Web Push subscription
POST /api/uploads                         multipart -> data/files, returns file ref
GET  /api/files/:id                       download generated files (workspace) — allowlisted only
```

SSE: wrap `watchEvents` in ONE module (`apps/server/src/stream.ts`) because it is marked experimental. On connect
send `snapshot`; forward batches; heartbeat comment every 15s; stop the watch on disconnect. Reconnect = fresh
snapshot (no replay needed). Partial commits every 100 ms (Durable default `progress`).

Auth: requests must come from loopback (Tailscale Serve proxies locally) and carry a `Tailscale-User-Login` header
matching configured owner login. Configurable off for local dev.

### 5.6 Approvals

`pending_actions (id, conversation_id, tool, args_json, status, created_at, decided_at)`.
Destructive tools are two-step: `propose_*` creates a pending action and returns a `details` approval card;
`POST /api/approvals/:id` or user message "YES" (exact, case-insensitive, referring to the latest pending action)
marks it approved and runs it. A `beforeTool` hook blocks any tool tagged destructive without an approved row.

## 6. Web (apps/web)

Next.js App Router, `@assistant-ui/react` with `useExternalStoreRuntime` (no Vercel AI SDK). Client store (zustand)
fed by `EventSource` → adapter (`applyEvent(state, event)`) → `convertMessage` → assistant-ui.

- Sidebar: agents with avatar, busy indicator, unread badge.
- Thread: one endless chat per agent; messages attributed; `app.reminder`/`app.notice` entries render as system cards.
- Tool cards from `details` (typed in `packages/shared`): approval card, task list, chart (later), invoice download.
- Composer: text, attachments (upload), stop button.
- Settings: per-agent model + thinking level.
- PWA: manifest, service worker, Web Push (VAPID), Web Share Target (Android "Share → Assistant").

## 7. Data model (app.sqlite) — initial domains

```sql
-- core
_migrations(id TEXT PRIMARY KEY, applied_at INTEGER)
agents(id TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL UNIQUE, created_at INTEGER)  -- Durable ConversationId is an integer
pending_actions(...)                         -- §5.6
push_subscriptions(endpoint TEXT PRIMARY KEY, keys_json TEXT, created_at INTEGER)

-- tasks / reminders (PA)
tasks_item(id TEXT PK, title, notes, status CHECK(status IN ('open','done','dropped')),
           due_at INTEGER NULL, remind_at INTEGER NULL, durable_task_id TEXT NULL,
           source_call_id TEXT UNIQUE, created_at, updated_at, done_at)
followups_item(id PK, subject, context, event_at, ask_at, status('waiting','asked','resolved'),
               outcome TEXT, next_followup_id, source_call_id UNIQUE, ...)
agenda_item(id PK, followup_id/meeting ref, text, source_call_id UNIQUE, created_at)
people_person(id PK, name, relation, birthday_md TEXT /* MM-DD */, birthday_year NULL, notes, source_call_id UNIQUE)
people_wish(person_id, year, wished INTEGER, PRIMARY KEY(person_id, year))
pa_journal(date TEXT PK /* YYYY-MM-DD local */, user_log, auto_summary, carried_over_json)

-- memory / files
memory_fact(id PK, scope /* 'shared' | agent id */, kind /* 'preference' | 'fact' */, text,
            source_call_id UNIQUE, created_at, updated_at)   -- FTS5 virtual table for recall
files_index(id PK, path, description, tags, added_at)

-- later milestones: health_weight, health_lift, ledger_expense, ledger_balance, splits_bill,
-- splits_share, invoice_state, inbox_message(triage) ...
```

Preferences/personality memory is written only when the user explicitly asks. Factual updates come from domain
tools (e.g. `add_expense`), not free-form memory.

## 8. Milestones

| #                                                                 | Deliverable                                                                                                                                                                                                                                                                                                                    | Done when                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **M1 Foundation**                                                 | pnpm monorepo; server with Harness (durable.sqlite), app.sqlite + migration runner, config + allowlist validation, `ensureAgents` (all four agents created, only PA has tools beyond profile); HTTP API (agents, messages, stream, abort, history); web chat with sidebar + streaming via assistant-ui; faux-provider dev mode | `pnpm test`, `pnpm typecheck`, `pnpm build` pass; dev mode chat streams from faux model end to end; restart mid-run resumes |
| M2 Tasks & reminders                                              | tasks extension + Reminder task + zero-token posts + Web Push + approvals for delete                                                                                                                                                                                                                                           | reminder fires after restart, posts card, push sent (mockable)                                                              |
| M3 Follow-ups, agendas, birthdays, people                         | FollowUp task, agenda capture, yearly birthday                                                                                                                                                                                                                                                                                 | follow-up loop works with fake clock                                                                                        |
| M4 Briefing, wrap-up, journal, share target                       | daily tasks, done-log, PWA share target                                                                                                                                                                                                                                                                                        |                                                                                                                             |
| M5 Inbox                                                          | Gmail + Calendar read-only (multi-account), Jev triage, digest, handoff to PA                                                                                                                                                                                                                                                  |                                                                                                                             |
| M6 Health                                                         | weight/lift tables, chart cards                                                                                                                                                                                                                                                                                                |                                                                                                                             |
| M7 Accountant                                                     | expenses (CSV/photo/chat), code-mode analysis, splits, invoice PDF from template                                                                                                                                                                                                                                               |                                                                                                                             |
| M8 Memory/profile UI, activity log, usage dashboard, budget guard |                                                                                                                                                                                                                                                                                                                                |                                                                                                                             |
| Ops                                                               | systemd units, tailscale serve config, OAuth login CLI (`pnpm login:openai`), backup (deferred)                                                                                                                                                                                                                                |                                                                                                                             |

## 9. Open items (deferred decisions)

- Invoice PDF template source format (user has a PDF; may need to recreate as HTML/Typst template). M7.
- Backups (deferred by user).
- Exact Durable conversation-creation and event APIs to be confirmed against source during M1.
