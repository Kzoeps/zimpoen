# Personal assistant — implementation plan

Status: approved direction. Milestones 1, 2 and 3 are implemented (see `progress-m1.md`, `progress-m2.md`,
`progress-m3.md`); this document was updated at the end of M3 to describe what was built. Owner: Dorje.

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
4. **File access is an allowlist.** Read: `/home/<user>/Documents`, `/home/<user>/Downloads`, `<data>/files` (and the
   workspace, so an agent can read back what it wrote). Write: `<data>/workspace`. Always denied, in any letter case,
   at any depth and after symlink resolution: `**/.ssh/**`, `**/.env*`, `**/auth.json`, `*.pem`, `*.key`, `.netrc`,
   `.npmrc`, `.aws/**`, `.git-credentials`, `.gnupg/**`, `id_*`, `<data>/secrets/**`. Paths are absolute in config;
   startup verifies each allowed path is readable, rejects one that would expose the databases, and fails loudly.
5. **No `bash` tool** for any agent.
6. **Inbox agent has no file tools** (it processes untrusted email text).
7. **Arithmetic is code, never the model** (splits, balances, totals, invoice numbers).
8. **Every app.sqlite write from a tool is idempotent** by the tool call ID (`source_call_id UNIQUE`,
   `ON CONFLICT DO NOTHING`), because Durable may rerun a replay-safe tool after a crash.
9. **Secrets** (OAuth credential store `credentials.json`, Jev key, VAPID keys `vapid.json`) live in `<data>/secrets/`
   (0700), files mode 0600, never readable through any agent environment.
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
                 data/secrets/         (credentials.json, vapid.json; 0700)
                 data/server.lock      (one server per data directory)
                 data/dev-push-outbox.jsonl  (only with ASSISTANT_PUSH_MODE=fake)
   Development uses ./data-dev, production ./data, so a dev database can never be opened by a production server.
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

const domain = createDomain({ db: appDb, timezone, now, notify }); // tasks, approvals, ... (§5.2)
migrate(appDb, [...coreMigrations, ...domain.migrations]);
const registry = createRegistry();
for (const ext of [profile, ...domain.extensions]) registry.install(ext);

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

### 5.2 Domain modules

```ts
// packages/extensions/src/module.ts
type DomainModule = {
	name: string; // "tasks", "approvals", "people", ... also the prefix of its migration ids and tables
	migrations: readonly Migration[]; // { id: "tasks/001_items", up(db) }
	extension: (deps: DomainDeps) => Extension; // Durable extension: tools, sections, hooks, tasks
	actions?: (deps: DomainDeps) => readonly ApprovalAction[]; // destructive operations it owns (§5.6)
};
type DomainDeps = {
	db: AppDb;
	timezone: string; // owner's IANA zone
	now: () => number; // the Harness clock: deadlines are stored on it
	harness: () => Harness; // late-bound: extensions exist before the Harness is opened
	post: EntryPoster; // zero-token write into a conversation (§5.3)
	notify: (payload: PushPayload) => Promise<void>; // Web Push to every device; never throws
	approvals: ApprovalService;
	schedule?: Partial<ScheduleSettings>; // when follow-ups and birthdays fire (ASSISTANT_AGENDA_LEAD_MINUTES, ...); defaults otherwise
};
```

The server (`apps/server/src/domain.ts`) lists the modules, concatenates their migrations after the core ones
(`migrate(db, [...coreMigrations, ...domain.migrations])`), installs every extension in the registry, and gives each agent
the ones it should have (`buildAgents`: the PA gets `tasks` and `approvals`; capability is tool presence). A module never
imports server code: everything it needs arrives in `DomainDeps`.

**Migrations.** An id is `<module>/<NNN>[_name]`. Ordering is a rule within one module only: its migrations must be
declared in ascending sequence, and what a database recorded for it must be a prefix of what it declares, so a migration
inserted before a shipped one is refused, while adding a whole module anywhere in the list is fine. A database that
recorded an id this build does not declare is still refused (older code against a newer schema).

Tool rules: TypeBox params; `output` short text for the model; `details` typed card payload for the UI
(types in `packages/shared`, `ToolCard`); `structuredOutput` for code callers. Rarely used tools `deferred: true` with the
`tool_search` extension. Write tools declare `replay: "safe"` only when idempotent per rule 8: a tool that creates a row
uses `source_call_id UNIQUE` (`add_task`, `propose_delete_task`); a tool that changes a row records its call id in the same
transaction in a ledger (`tasks_call`), so a replayed `snooze_reminder` does not move the reminder twice.

### 5.3 Zero-token posts

Reminders and system notices are posted with `conversation.submit({ type: "write", requestId, entry: { kind, data } })`
using custom entry kinds (`app.reminder`, `app.notice`). No model call, ever: the model is invoked only when the user replies.
The `requestId` makes a repeated post write once, which is what makes posting safe to rerun after a crash. A write of only
`kind`/`data` is display-only and is appended immediately even mid-run (README "Busy Conversations").

**A post never carries `model`.** Durable treats a write with model text as input for the next run, and for an idle
conversation that still has a queued message (a run that failed because the model was down) it starts that run: tokens
spent, and a failure, on a reminder. So `EntryPoster` has no model text. What the model needs to know comes from the database
through a prompt section instead: the `tasks` section lists the reminders that were sent for tasks that are still open, so
"snooze it" or "done" resolves (`renderTasksSection` in `packages/extensions/src/tasks/index.ts`: open count, next three due,
sent reminders; no clock, so it renders the same bytes until a task changes). An approved deletion is visible to the model
through `list_tasks`.

### 5.4 Durable tasks (state machines)

```ts
// Reminder (implemented): one Durable task per scheduled reminder, `app.reminder`, input { itemId, gen, at }.
wait --sleepUntil(at)--> fire --(posted memo, requestId reminder:<item>:<gen>)--> notify --> terminal
//  wait:   ends as superseded when the row no longer wants this reminder, else sleeps (no invocation held)
//  fire:   re-checks the row (open, same gen and remind_at; `reminded_at` is not asked, so a timer that a power cut set
//          back to before its card re-posts it), posts the app.reminder card (zero tokens), marks the row, checkpoints to notify
//  notify: pushes (at least once; one tag, so a duplicate replaces the banner), then completes
// Recurrence (birthdays yearly, briefing daily) = when a cycle ends, the next one goes into the ROW first (a new generation,
// no timer), then its timer is created; if that fails the periodic repair creates it (every person always wants one).

// FollowUp (implemented, `followups` module): one Durable task per meeting or commitment, `app.followup`, input { itemId, gen }.
agenda_wait --sleepUntil(event - lead)--> agenda_ping --(only with points, only before it began: app.agenda card + push)-->
  commitment: nudge_wait --sleepUntil(event)--> nudge --(card + push, only while before the question's time)-->
ask_wait --sleepUntil(end, or event + 30 min)--> ask --(app.followup question card, row -> asked, push)-->
reask_wait --sleepUntil(next morning 09:00 local)--> reask --(the same question once more, only if still unanswered; card + push)--> terminal
//  The answer is not a phase: the tool record_outcome resolves the row and, if something has to be followed up, creates the
//  next link (a commitment with its own timer, parent_id = this one), so the chain runs until one resolves with no follow-up.
//  update_followup moves or renames one (a new generation when the time changes; agenda points stay). A date given without a
//  time takes the default time (10:00, `ASSISTANT_FOLLOWUP_DEFAULT_TIME`) and the tool says so (`time_assumed`).
//  Asked twice at most: what is still unanswered after that is for the morning briefing (M4: list the follow-ups with
//  status `asked`, they are the open loops), not for a nagging timer.
// Birthday (implemented, `people` module): one Durable task per person and year, `app.birthday`, input { personId, gen }.
remind_wait --sleepUntil(09:00 local)--> remind (card + push) --> check_wait --sleepUntil(18:00 local)--> check
  (question card + push unless the owner said they wished or the birthday is more than 2 days ago; moves the row to next
  year's cycle, creates that timer) --> terminal
// Both: the row is the truth, exactly as for reminders (below); the cards are display-only; the phases tolerate a timer that
// is back from before its own card (design-notes.md: "Follow-ups, agendas and birthdays"). What no timer can repair is a
// birthday card that Durable's database lost AFTER the cycle ended (the row has moved on): the row keeps the latest morning
// card and evening question (`reminded_year/at`, `asked_year/at`), and the server posts them again at start (`recoverCards`).
MorningBriefing (daily 07:30 Asia/Thimphu): gather (code: tasks due, today's meetings and birthdays, open asked follow-ups,
                inbox digest) -> submit input to pa ("compose briefing", requestId per date)
EveningWrapUp  (daily 21:00): gather done-log facts (code) -> submit input to pa -> user replies -> pa_journal row
```

**The row is the truth, the Durable task is a timer.** `tasks_item` and `durable.sqlite` are two databases, so nothing can
be atomic across them. Instead the row says whether a reminder is wanted and which one (`remind_gen`), and a task carries
the generation it was created for and fires only while the row still has it (and is open, same `remind_at`; whether it was
already sent is not asked, because `reminded_at` can be ahead of a Durable database that a power cut set back).
Rescheduling, snoozing, completing or deleting only changes the row (and aborts the old task as housekeeping); a stale
task ends itself when it wakes. A generation is taken in app.sqlite right before the Durable task is created, so a rerun
of the creating tool call after a crash makes a newer generation and the orphan is stale. Reminders are conversation-owned
`background` tasks, so the user's Stop button does not abort them and they do not keep the conversation busy.
`reconcile()` runs at every start and every 10 minutes while the server is up: it re-creates a timer Durable lost (it syncs
less often than app.sqlite) or ended (a faulted task is never retried by Durable) and re-links one the row lost track of, row
by row, so one task that cannot be repaired is reported with the SQL that clears it and the others are still done. A
30-second tick calls `harness.resume()` so a reminder that came due during a suspend or a clock step fires within seconds of
the machine waking up. The two databases are self-healing (design-notes.md); keeping the machine awake is in `docs/OPS.md`.

Timezone: `Asia/Thimphu`, configurable. Due times stored as UTC epoch ms.

### 5.5 HTTP API (apps/server, all under /api, JSON)

```text
GET  /api/agents                          -> { agents: AgentSummary[], health: { parkedTasks, parked: ParkedTask[] } }
GET  /api/conversations/:id/stream        -> SSE: `events` frames (snapshot first, then Durable agent-event batches), `ping` every 15 s
POST /api/conversations/:id/messages      { content, requestId, whenBusy?: "steer"|"followUp" } -> 202 { submissionId }
                                          (a message that is exactly YES answers the one waiting approval request instead, §5.6)
POST /api/conversations/:id/abort
GET  /api/conversations/:id/messages?before=&limit=   history paging (root entries, system entries removed)
GET  /api/settings/agents                 -> { agents: AgentSettings[], models: ModelOption[] }
GET|PUT /api/settings/agents/:id          { model?, thinkingLevel? }, validated against the models this server serves
GET  /api/push/config                     -> { publicKey }  (VAPID public key)
POST /api/push/subscribe                  { endpoint, keys: { p256dh, auth } } -> 201 (public https host, 65-byte / 16-byte keys; 409 beyond 20 devices)
DELETE /api/push/subscribe                { endpoint } -> { removed }
POST /api/approvals/:id                   { decision: "approve"|"deny" } -> ApprovalState; 404 unknown, 409 expired/answered
POST /api/admin/tasks/:id/retry           runs a task Durable parked after repeated crashes; 404 if it is not parked
POST /api/uploads                         (M4)   GET /api/files/:id (M4)
```

Errors are `{ error: { code, message } }` (`unauthorized`, `forbidden`, `invalid_json`, `invalid_request`,
`payload_too_large`, `not_found`, `conflict`, `too_many_requests`, `unavailable`, `internal_error`).

SSE: `apps/server/src/stream.ts` is the only user of `watchEvents` (experimental). On connect it sends a `snapshot`
(newest 200 entries, system entries and opaque provider signatures removed, plus why recent messages were never answered);
then Durable's batches, partial commits every 100 ms. The keep-alive is a named `ping` event, not a comment, because
`EventSource` never shows comments; the browser reconnects after 40 s of silence and when the tab or network returns.
Reconnect = a fresh snapshot, no replay. At most 8 streams are open; bodies are limited to 256 KB.

Auth and request guards (all in both auth modes unless noted): the `Host` header must be a name the server answers to
(loopback names on its port plus `ASSISTANT_PUBLIC_HOST`; this stops DNS rebinding), a state-changing request the browser
marks `Sec-Fetch-Site: cross-site` is refused, and every POST/PUT/PATCH/DELETE must be `Content-Type: application/json`.
With `ASSISTANT_AUTH=on` (the default; `off` is refused in production) the peer must be loopback and
`Tailscale-User-Login` must equal `ASSISTANT_OWNER_LOGIN`. The reasoning is in `design-notes.md`.

### 5.6 Approvals

`pending_actions` (module `approvals`) holds one row per request: tool, a canonical `target` ("task:t_ab12"), args,
summary, status `pending → approved → executed | failed`, or `denied`, or `expired`, and 24 hours to live.

- A destructive tool is two-step. The model calls `propose_delete_task`, which creates the request (idempotent by tool call
  id; an identical waiting request is reused) and returns an `approval` card. Nothing is deleted.
- The owner answers with **Approve/Deny** (`POST /api/approvals/:id`) or a message that is **exactly "YES"** (trimmed, any
  case). The server decides both, deterministically: the YES is intercepted in `POST …/messages` before the model sees it
  and approves the request waiting in that conversation, but only when **exactly one** unexpired request waits and the owner
  **has sent nothing else since it was made** (a "yes" after another exchange may answer another question). Otherwise the
  message goes to the model like any other, and it ends the YES window of whatever waits; the buttons keep working.
  A resent YES (same `requestId`) returns the same outcome notice and never approves a second request.
- Approving runs the module's `ApprovalAction.run` in the server at once (idempotent; a failure becomes the outcome, status
  `failed`), then writes the outcome as an `app.notice` entry (zero tokens, display-only). The approval card is
  immutable, so the UI derives its state from those notices; with none, past `expiresAt` it shows as expired.
- **The hook is the enforcement**: `hook(ToolTask, { beforeTool })` (extension `approvals`) blocks any registered destructive
  tool (`delete_task`) unless an approved, not yet executed request exists for exactly that conversation, tool and target.
  The block message tells the model to call the propose tool. The destructive tool itself calls the same `runApproved`.
- Requests past their deadline are closed lazily, every 10 minutes, and at start; start also carries out an approved request
  a crash interrupted, posts outcome notices that were never written, and asks again for those of the last 24 hours in case
  a power cut took them from Durable's database (`ApprovalService.recover`, idempotent by request id). One it cannot post is
  logged with the SQL that stops the retrying; the server still starts.

## 6. Web (apps/web)

Next.js App Router, `@assistant-ui/react` with `useExternalStoreRuntime` (no Vercel AI SDK). Client store (zustand)
fed by `EventSource` → adapter (`applyEvent(state, event)`) → `convertMessage` → assistant-ui.

- Sidebar: agents with avatar, busy indicator (unread badge: not yet; it needs a read marker).
- Thread: one endless chat per agent; messages attributed; `app.reminder`/`app.notice` entries render as system cards,
  as `role: "system"` messages whose card travels in `metadata.custom.card`.
- Tool cards from `details` (typed in `packages/shared`, `toolCardOf`): approval card (Approve/Deny, state derived from
  notices), task list, single task; chart and invoice download later.
- Composer: text, attachments (upload), stop button.
- Settings: per-agent model + thinking level (curated list: models whose id starts with `gpt-6`, "Show all" toggle; the
  agent's current model is always listed; a server with no curated model lists everything) and the Enable
  notifications control (permission → register `/sw.js` → subscribe with the VAPID key → `POST /api/push/subscribe`).
- PWA (M2): `manifest.ts`, generated icons (`apps/web/scripts/make-icons.mjs`), `public/sw.js` (push, notificationclick and
  pushsubscriptionchange; no caching), Web Push with VAPID; `PushSync` re-registers the device's subscription whenever the
  app opens. Web Share Target (Android "Share → Assistant") is M4. iOS delivers pushes only to an installed (Home Screen)
  web app.
- A banner reports tasks Durable parked after repeated crashes, with a Retry button.

## 7. Data model (app.sqlite) — initial domains

```sql
-- core (packages/db; migration ids core/NNN)
_migrations(id TEXT PRIMARY KEY, applied_at INTEGER)
agents(id TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL UNIQUE, created_at INTEGER)  -- Durable ConversationId is an integer
push_subscriptions(endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, user_agent TEXT, created_at INTEGER)

-- approvals (module approvals)                                              -- §5.6
pending_actions(id TEXT PK, conversation_id, tool, target, args_json, summary,
                status CHECK(status IN ('pending','approved','denied','expired','executed','failed')),
                result_text, source_call_id UNIQUE, created_at, expires_at, decided_at, decided_via ('button'|'yes'),
                decided_request_id, executed_at, notified_at, notice_submission_id,
                yes_ok INTEGER DEFAULT 1)   -- approvals/002: 0 once the owner sent anything else, ending the YES window

-- tasks / reminders (module tasks, PA)
tasks_item(id TEXT PK /* t_xxxxxxxx */, title, notes, status CHECK(status IN ('open','done','dropped')),
           due_at INTEGER NULL, due_all_day INTEGER, remind_at INTEGER NULL, remind_gen INTEGER,
           durable_task_id INTEGER NULL, reminded_at INTEGER NULL, conversation_id INTEGER,
           source_call_id TEXT UNIQUE, created_at, updated_at, done_at)
tasks_call(source_call_id TEXT PK, tool, task_id, applied_at)   -- rule 8 for tools that change an existing row
-- followups (module followups, PA)
followups_item(id TEXT PK /* f_xxxxxxxx */, title, counterpart, context, kind CHECK(kind IN ('meeting','commitment')),
               event_at, ends_at NULL, ask_at /* ends_at, or event_at + 30 min */, agenda_lead_minutes /* default 15 */,
               status CHECK(status IN ('waiting','asked','resolved')), outcome NULL,
               parent_id NULL REFERENCES followups_item ON DELETE SET NULL, next_followup_id NULL,
               time_assumed INTEGER /* the owner gave a date and no time: event_at is the default time */,
               gen, durable_task_id NULL, agenda_pinged_at NULL, asked_at NULL, reasked_at NULL /* the one re-ask */, resolved_at NULL,
               conversation_id, source_call_id UNIQUE, created_at, updated_at)
followups_agenda(id INTEGER PK, followup_id REFERENCES followups_item ON DELETE CASCADE, text, source_call_id UNIQUE, created_at)
followups_call(source_call_id PK, tool, followup_id, applied_at)   -- rule 8 for record_outcome, resolve_followup, update_followup
-- people (module people, PA; shared profile-level data, only the PA has the tools for now)
people_person(id TEXT PK /* p_xxxxxxxx */, name, relation, birthday_md TEXT NOT NULL /* MM-DD */, birthday_year NULL, notes,
              cycle_year, remind_at NULL, check_at,   -- the yearly cycle waiting to run
              reminded_year NULL, reminded_at NULL, asked_year NULL, asked_at NULL,   -- the latest cards: outlive the cycle
              gen, durable_task_id NULL, conversation_id, source_call_id UNIQUE, created_at, updated_at)
people_wish(person_id REFERENCES people_person ON DELETE CASCADE, year, wished INTEGER, recorded_at, PRIMARY KEY(person_id, year))
people_call(source_call_id PK, tool, person_id, applied_at)   -- rule 8 for update_person, record_wish
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
| **M1 Foundation** (done)                                          | pnpm monorepo; server with Harness (durable.sqlite), app.sqlite + migration runner, config + allowlist validation, `ensureAgents` (all four agents created, only PA has tools beyond profile); HTTP API (agents, messages, stream, abort, history); web chat with sidebar + streaming via assistant-ui; faux-provider dev mode | `pnpm test`, `pnpm typecheck`, `pnpm build` pass; dev mode chat streams from faux model end to end; restart mid-run resumes |
| M2 Tasks & reminders (done)                                       | tasks extension + Reminder task + zero-token posts + Web Push + approvals for delete                                                                                                                                                                                                                                           | reminder fires after restart, posts card, push sent (mockable)                                                              |
| M3 Follow-ups, agendas, birthdays, people (done)                  | FollowUp task, agenda capture, yearly birthday                                                                                                                                                                                                                                                                                 | follow-up loop works with fake clock                                                                                        |
| M4 Briefing, wrap-up, journal, share target                       | daily tasks, done-log, PWA share target                                                                                                                                                                                                                                                                                        |                                                                                                                             |
| M5 Inbox                                                          | Gmail + Calendar read-only (multi-account), Jev triage, digest, handoff to PA                                                                                                                                                                                                                                                  |                                                                                                                             |
| M6 Health                                                         | weight/lift tables, chart cards                                                                                                                                                                                                                                                                                                |                                                                                                                             |
| M7 Accountant                                                     | expenses (CSV/photo/chat), code-mode analysis, splits, invoice PDF from template                                                                                                                                                                                                                                               |                                                                                                                             |
| M8 Memory/profile UI, activity log, usage dashboard, budget guard |                                                                                                                                                                                                                                                                                                                                |                                                                                                                             |
| Ops                                                               | systemd units, tailscale serve config, OAuth login CLI (`pnpm login:openai`), backup (deferred)                                                                                                                                                                                                                                |                                                                                                                             |

## 9. Open items (deferred decisions)

- Invoice PDF template source format (user has a PDF; may need to recreate as HTML/Typst template). M7.
- Backups (deferred by user).
- (Resolved in M1) Durable conversation-creation and event APIs were confirmed against the installed 1.4.0 package; where
  it differs from the repository checkout the code follows the package (progress-m1.md §2.1).
