# Personal assistant — implementation plan

Status: approved direction. Milestones 1 to 7 are implemented (see `progress-m1.md` … `progress-m7.md`; M5, the inbox, was built last);
this document was updated at the end of M5 to describe what was built. M8 and Ops remain. Owner: Dorje. What the owner has to do is
`SETUP.md`.

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
6. **Inbox agent has no file tools** (it processes untrusted email text). As built: its extension list is `[profile, inbox]` and its only tools are
   `search_mail`, `read_mail`, `list_events`, `mark_triage` (one mail), `propose_sender_rule` (asks; the owner's Approve writes the rule), `suggest_followup` and
   `current_time`: no file tools, no `tool_search`, no approval hook, no `ask_agent`. Email text is data in every layer (`design-notes.md`: "Inbox").
7. **Arithmetic is code, never the model** (splits, balances, totals, invoice numbers).
8. **Every app.sqlite write from a tool is idempotent** by the tool call ID (`source_call_id UNIQUE`,
   `ON CONFLICT DO NOTHING`), because Durable may rerun a replay-safe tool after a crash.
9. **Secrets** (OAuth credential store `credentials.json`, Jev key, VAPID keys `vapid.json`) live in `<data>/secrets/` As built: `credentials.json`, `vapid.json`, `google-accounts.json` (refresh tokens, written by `pnpm connect:google`), and the two files the owner places, `google-oauth.json` (the OAuth client) and `jev.json`.
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
Only `pa` gets `ask_agent` (M5, `packages/extensions/src/delegate/`): `ask_agent(agent: inbox|health|accountant, question)` puts the question into that agent's conversation
with request id `ask:<call id>` (table `delegate_ask`, so a replayed call asks nothing twice), waits 90 s, and returns the answer as information; past that the result says the agent is still working and
the answer later arrives as a display-only `app.agent-answer` card. Specialists cannot reach each other (capability by tool presence); the Inbox hands work to the PA only through the
suggestion queue (§5.2).

### 5.2 Domain modules

```ts
// packages/extensions/src/module.ts
type DomainModule = {
	name: string; // "tasks", "approvals", "people", ... also the prefix of its migration ids and tables
	migrations: readonly Migration[]; // { id: "tasks/001_items", up(db) }
	extension: (deps: DomainDeps) => Extension; // Durable extension: tools, sections, hooks, tasks
	actions?: (deps: DomainDeps) => readonly ApprovalAction[]; // destructive operations it owns (§5.6)
	facts?: (deps: DomainDeps) => readonly DailyFactsProvider[]; // what it can tell the daily jobs (§5.4): "Tasks due today", ...
};
type DomainDeps = {
	db: AppDb;
	timezone: string; // owner's IANA zone
	now: () => number; // the Harness clock: deadlines are stored on it
	harness: () => Harness; // late-bound: extensions exist before the Harness is opened
	post: EntryPoster; // zero-token write into a conversation (§5.3)
	notify: (payload: PushPayload) => Promise<void>; // Web Push to every device; never throws
	approvals: ApprovalService;
	ask: InputSubmitter; // a message to the model that starts a run (the briefing, the wrap-up), once per requestId; unlike `post` it costs tokens
	facts: () => readonly DailyFactsProvider[]; // every module's providers, read when a daily job runs; one that throws is left out and reported
	files?: FilesDeps; // { readPaths, images? }: the folders the PA is told it may read, and the image processor for read_file
	schedule?: Partial<ScheduleSettings>; // when follow-ups and birthdays fire (ASSISTANT_AGENDA_LEAD_MINUTES, ...); defaults otherwise
	health?: HealthDeps; // { heightCm? }: the owner's height for BMI (ASSISTANT_OWNER_HEIGHT_CM); only the Health module reads it
	accountant?: AccountantDeps; // { currency, ownerName?, invoices?: { outDir, templatesDir } }: ASSISTANT_CURRENCY (BTN), the configured owner name, where invoice PDFs and the template live (M7)
	inbox?: InboxDeps; // { google: GoogleGateway (gmail, calendar, tokens: read-only interfaces), triage: Triage (Jev or the rules), sync?: SyncSettings } (M5)
	delegate?: DelegateDeps; // { timeoutMs? }: how long ask_agent waits (M5)
};
```

The server (`apps/server/src/domain.ts`) lists the modules, concatenates their migrations after the core ones
(`migrate(db, [...coreMigrations, ...domain.migrations])`), installs every extension in the registry, and gives each agent
the ones it should have (`buildAgents`: the PA gets `tasks`, `followups`, `people`, `approvals`, `daily`, `files` and `delegate` (`ask_agent`); the Inbox agent gets `inbox` alone (`inboxExtensions`: no files, no `tool_search`, no approvals); the Health agent gets `health`, `approvals` and `tool_search`; the Accountant gets `ledger`, `splits`, `invoices`, `files`, `approvals`, `tool_search` and Durable's code mode (`@earendil-works/pi-durable/codemode` over a QuickJS sandbox with `models: false`, so a script has no paid model calls, and a time limit written into every script: `createBoundedCodemodeExtension`, 30 s by default and 2 minutes at most); capability is tool presence). A module never
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
//  Asked twice at most: what is still unanswered after that is for the morning briefing (it lists the follow-ups with
//  status `asked`: they are the open loops), not for a nagging timer.
// Birthday (implemented, `people` module): one Durable task per person and year, `app.birthday`, input { personId, gen }.
remind_wait --sleepUntil(09:00 local)--> remind (card + push) --> check_wait --sleepUntil(18:00 local)--> check
  (question card + push unless the owner said they wished or the birthday is more than 2 days ago; moves the row to next
  year's cycle, creates that timer) --> terminal
// Both: the row is the truth, exactly as for reminders (below); the cards are display-only; the phases tolerate a timer that
// is back from before its own card (design-notes.md: "Follow-ups, agendas and birthdays"). What no timer can repair is a
// birthday card that Durable's database lost AFTER the cycle ended (the row has moved on): the row keeps the latest morning
// card and evening question (`reminded_year/at`, `asked_year/at`), and the server posts them again at start (`recoverCards`).
// Daily jobs (implemented, `daily` module): one Durable task per job, `app.daily`, input { job, gen }; `schedule_daily` is the truth
// (local time, enabled, the run that is waiting, last_run_date). Settings: GET|PUT /api/settings/schedule.
wait --sleepUntil(due_at)--> run
//  wait: ends as superseded when the row no longer wants this timer (time edited, job off, a run done), else sleeps
//  run:  re-checks the row; the day's facts are gathered by CODE from every module's facts provider and kept in a durable memo
//        (the first attempt's plan stands after a crash); then, once per local day (last_run_date):
MorningBriefing (07:30 Asia/Thimphu; late window to 11:00): facts = tasks and reminders today, overdue tasks, meetings and
                follow-ups today (agenda counts), open asked follow-ups, birthdays today and in 3 days, items carried over by the
                last answered journal day (within 3 days). Facts -> deps.ask(pa, input with entry kind app.daily, requestId
                briefing:<date>, whenBusy followUp) + push "Your morning briefing". NOTHING to report -> an app.daily write with
                no model message (a card, zero tokens, requestId briefing:<date>:empty). The instructions live in the PA's rules.
EveningWrapUp  (21:00; late window to midnight): what the system recorded today (tasks completed, follow-ups resolved, birthdays
                wished, reminders fired; later modules register providers) -> input to pa, requestId wrapup:<date> (always asks),
                a pa_journal row is created (asked_at, auto_summary) -> the owner answers -> the PA calls save_journal(date, user_log,
                carried_over[]) -> tomorrow's briefing carries the items over. Tools: save_journal (replay-safe by call id; a later
                call for the day replaces), get_journal(date | from,to).
//  A first row is never "late", nor is an edit in Settings; a day that ran never runs again. At start, a job that ran today
//  is delivered again with the same request id and no push (a power cut can lose it from Durable's database). Every question
//  the jobs ask closes the YES window (an approval cannot be answered by a "yes" typed to a wrap-up).
// Inbox digests (M5, the same engine, `agent: "inbox"`): `digest_midday` 12:30 and `digest_evening` 19:00, late window 2 h. Facts = the mail whose category is important, needs_reply
//  or follow_up and that was classified in `(since, cutoff]` (at most 25, most urgent first; not older than 3 days; the window starts at the last saved cutoff, never more than 3 days
//  back; saved in `inbox_digest` so a rerun and the power-cut recovery show the same mail) plus any account that needs to be connected again -> deps.ask(inbox, request id
//  digest_<midday|evening>:<date>) + push "Your inbox digest" (/chat/inbox). NOTHING -> an app.daily card, zero tokens, NO push (requestId ...:empty; DailyJob.pushWhenEmpty false). The morning briefing gets an
//  "Inbox" line (counts, the top three subjects).
// Inbox sync (M5): one Durable task per connected Gmail account, `app.inbox-sync`, input { account, gen }; `inbox_account` is the truth (next_sync_at, gen, failures, last error).
wait --sleepUntil(next_sync_at)--> run
//  wait: ends as superseded when the row no longer wants this timer, else sleeps
//  run:  first read (last 14 days, newest first, <= 1000) or history.list (a 404 reads the mailbox again) -> classify what is new (Jev, or the rules; provisional when Jev fails)
//        -> calendar (yesterday to +14 days) -> the next run goes into the row first, then its timer; a failure waits twice as long each time (<= 1 h), a refused token
//        ends the timer and marks the account needs_reconnect (a card in the PA's thread and a push). A conversation-owned background task: it never holds up the PA.
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
GET  /api/settings/schedule               -> { timezone, jobs: [{ job, label, localTime, enabled, defaultTime, nextRunAt?, nextRunText?, lastRunDate? }] }   (jobs: briefing, wrapup, digest_midday, digest_evening)
PUT  /api/settings/schedule/:job          { localTime?: "HH:MM", enabled? } -> the same body; takes effect at once (404 unknown job, 400 bad time)
GET  /api/settings/google                 -> { mode: "real"|"fake", clientConfigured, triage: { mode: "jev"|"rules", lastError?, lastErrorText? }, syncMinutes, accounts: [{ email, status: "connected"|"needs_reconnect"|"disconnected", lastSyncText?, lastError?, messages }] }
DELETE /api/settings/google/accounts      { email } -> the same body (local only: the sign-in is forgotten, the sync stops, the mail stays; 404 unknown, 400 bad address)
POST /api/suggestions/:id                 { decision: "add"|"dismiss" } -> { id, status }; Add asks the PA to add the follow-up (message written by code from the stored suggestion); 404 unknown, 409 answered the other way
POST /api/uploads                         multipart, ONE `file` field, <= 20 MB -> 201 { file: FileSummary }; the only non-JSON write
GET  /api/files/:id                       an upload's bytes (nosniff, sandbox CSP; inline for images, download for the rest)
```
The web app also has two routes of its own that are not under `/api`: `POST /share` (the Android share target: it stores the
files through `/api/uploads` and redirects with 303 to `/capture`) and the page `/capture`.

Errors are `{ error: { code, message } }` (`unauthorized`, `forbidden`, `invalid_json`, `invalid_request`,
`payload_too_large`, `not_found`, `conflict`, `too_many_requests`, `unavailable`, `internal_error`).

SSE: `apps/server/src/stream.ts` is the only user of `watchEvents` (experimental). On connect it sends a `snapshot`
(newest 200 entries, system entries and opaque provider signatures removed, plus why recent messages were never answered);
then Durable's batches, partial commits every 100 ms. The keep-alive is a named `ping` event, not a comment, because
`EventSource` never shows comments; the browser reconnects after 40 s of silence and when the tab or network returns.
Reconnect = a fresh snapshot, no replay. At most 8 streams are open; JSON bodies are limited to 256 KB, an upload to 20 MB.

Auth and request guards (all in both auth modes unless noted): the `Host` header must be a name the server answers to
(loopback names on its port plus `ASSISTANT_PUBLIC_HOST`; this stops DNS rebinding), a state-changing request the browser
marks `Sec-Fetch-Site: cross-site` is refused, and every POST/PUT/PATCH/DELETE must be `Content-Type: application/json`. The
one exception is `POST /api/uploads`: it is registered before that rule (order of registration, not a path list) and instead
**requires** `Sec-Fetch-Site` to be `same-origin` or `none`.
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
  notices), task list, single task; the Health agent's cards (M6: a logged weight, the weight chart with its 7-day average, the
  exercise chart with records ringed, a logged workout, a list of workouts; small SVGs, no chart library); invoice download later.
- Composer: text, attachments (a paperclip; each file uploads as it is picked, with its own progress and a way to remove it,
  and a message may carry up to 10), stop button. Sent files are shown as chips (a thumbnail for an image) above the text;
  a message of files only has no bubble.
- Daily cards: the briefing or wrap-up request is a card (the facts folded, "sent late" when it was) and the PA's first answer
  after it carries a "Morning briefing" / "Evening wrap-up" chip until the owner speaks again; a briefing with nothing in it
  is one line. `save_journal` / `get_journal` and the file tools (`describe_file`, `search_files`, `read_file_path`) have cards.
- Inbox cards (M5): `search_mail` and a digest list mail as rows (subject as a link to the conversation in Gmail, category chip, sender, date, account; text only, and a link is
  followed only when it is `https://mail.google.com/...`), `read_mail` folds the text, `list_events` lists the calendar; in the PA's thread a suggestion from the Inbox is a card with
  **Add** and **Dismiss** (disabled once pressed; its state comes from the notices that follow), `ask_agent` shows the question and the answer (or "still working"), and a late answer is a
  card; in a specialist's thread the question the PA asked is a card. The digest is the daily card with its mail open; the Inbox agent's answer under it carries an "Inbox digest" chip.
- Capture page `/capture` (the Android share target lands here): the shared files as chips, the shared text editable, an
  agent picker (default `pa`), "Send to X".
- Settings: **Google accounts** (each account's address, status, last sync and how much mail is kept, Disconnect with a confirmation, the commands that connect or reconnect one, the
  **Jev / Rules mode** badge with why Jev fell back, "client file missing", and a note in fake mode); the daily schedule (a time and an on/off switch for each job, the two digests included) and per-agent model + thinking level (curated list: models whose id starts with `gpt-6`, "Show all" toggle; the
  agent's current model is always listed; a server with no curated model lists everything) and the Enable
  notifications control (permission → register `/sw.js` → subscribe with the VAPID key → `POST /api/push/subscribe`).
- PWA (M2): `manifest.ts`, generated icons (`apps/web/scripts/make-icons.mjs`), `public/sw.js` (push, notificationclick and
  pushsubscriptionchange; no caching), Web Push with VAPID; `PushSync` re-registers the device's subscription whenever the
  app opens. Web Share Target (M4: Android "Share → Assistant" posts to `/share`, which stores the files and opens `/capture`;
  needs the installed app over https; untried on a device). iOS delivers pushes only to an installed (Home Screen) web app.
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
-- daily (module daily, PA; the tables keep the plan's names, so they do not start with the module's)
schedule_daily(job TEXT PK /* 'briefing' | 'wrapup' */, local_time CHECK 'HH:MM', enabled INTEGER,
               due_date TEXT, due_at INTEGER,   -- the run that is waiting (the row is the truth; the Durable task is its timer)
               last_run_date TEXT NULL, last_run_at NULL,   -- a day runs at most once
               gen INTEGER, durable_task_id INTEGER NULL, updated_at)
pa_journal(date TEXT PK /* YYYY-MM-DD local */, user_log NULL /* NULL while the wrap-up waits for an answer */,
           auto_summary TEXT /* what the system recorded, as the wrap-up was asked */, carried_over_json,
           asked_at NULL, saved_at NULL, updated_at)
daily_call(source_call_id PK, tool, subject, applied_at)   -- rule 8 for save_journal

-- files (module files)
files_index(id TEXT PK /* fi_xxxxxxxx */, path UNIQUE /* absolute, links resolved */, name, mime, kind CHECK(kind IN
            ('image','pdf','csv','text','other')), size, source CHECK(source IN ('upload','path','generated')),
            description, tags, added_at, updated_at)   -- an upload, a file the PA found in an allowed folder, or one the assistant made (M7: files/002 rebuilds the table to allow 'generated')
files_call(source_call_id PK, tool, file_id, applied_at)   -- rule 8 for describe_file and read_file_path

-- memory (M8)
memory_fact(id PK, scope /* 'shared' | agent id */, kind /* 'preference' | 'fact' */, text,
            source_call_id UNIQUE, created_at, updated_at)   -- FTS5 virtual table for recall

-- health (module health, the Health agent; M6). Deviations from the first sketch: weight is UNIQUE per local day (the schema, not
-- a check in code, keeps one weighing a day; `replace: true` overwrites); sessions carry source_call_id too (one log_workout call is
-- one session written in one transaction); the ledger health_call (rule 8) is what keeps a replayed replacement from undoing a
-- later correction; exercise.kind is 'weighted' | 'bodyweight'; exercise.key is the normalised name used for matching (letters and
-- digits of any script). kind says what a set needs (weighted: a load on every set; bodyweight: none, an added load is allowed); what
-- progress is measured in (estimated 1RM, or reps) is derived from the sets, never stored: a bodyweight exercise follows its added weight
-- once a set has one. Exercises can be renamed (the old name stays an alias) and merged (approval; sets move, the name stays an alias).
health_weight(id INTEGER PK, measured_on TEXT UNIQUE /* YYYY-MM-DD local */, kg REAL, note, source_call_id UNIQUE, created_at, updated_at)
health_exercise(id INTEGER PK, name, key UNIQUE, aliases /* JSON array */, kind CHECK(kind IN ('weighted','bodyweight')), created_at)
health_session(id TEXT PK /* w_xxxxxxxx */, date TEXT /* local day */, note, source_call_id UNIQUE, created_at)
health_set(id INTEGER PK, session_id REFERENCES health_session ON DELETE CASCADE, exercise_id REFERENCES health_exercise, set_no, reps, kg /* 0: no load (or none added) */,
           rpe NULL, source_call_id UNIQUE /* "<call id>:<n>" */, UNIQUE(session_id, exercise_id, set_no))
health_call(source_call_id PK, tool, subject, applied_at)   -- rule 8 for log_weight's replace and rename_exercise

-- ledger (module ledger, the Accountant; M7). Money is INTEGER minor units, signed from the account's side (out is negative), in STRICT
-- tables; never a float. Deviations from the first sketch: ledger_txn.seq (AUTOINCREMENT) numbers the writes, and a snapshot remembers
-- the highest seq it saw, which is how a balance, an entry of the same day written before it and one written after it are told apart;
-- ledger_category has a kind (expense | income) and 18 seeded names; ledger_import keeps the parsed rows of a CSV between the preview
-- and the confirm; ledger_call is rule 8 for recategorize and archive_account; ledger_fx is insert-only (rate_micro, six decimals).
ledger_account(id PK, name, key UNIQUE /* nameKey(name) */, kind CHECK(kind IN ('cash','bank','wallet','card')), currency, archived, source_call_id UNIQUE, created_at)
ledger_category(id PK, name, key UNIQUE, parent_id NULL, kind CHECK(kind IN ('expense','income')), source_call_id UNIQUE)
ledger_txn(seq INTEGER PK AUTOINCREMENT, id TEXT UNIQUE /* x_xxxxxxxx */, account_id, occurred_on /* local day */, amount_minor CHECK(!= 0), currency,
           category_id NULL, merchant, merchant_key, note, source CHECK(source IN ('chat','csv','receipt')), source_ref NULL /* fi_ id, or im_ id */,
           transfer_id NULL /* the two legs of a transfer */, source_call_id UNIQUE, import_hash UNIQUE NULL, created_at)
ledger_balance_snapshot(id PK, account_id, as_of, amount_minor, txn_watermark, note, source_call_id UNIQUE, created_at)
ledger_fx(id PK, date, from_currency, to_currency, rate_micro, source_call_id UNIQUE, created_at)
ledger_import(id TEXT PK /* im_xxxxxxxx */, file_id, file_name, account_id, status CHECK(status IN ('preview','imported')), summary_json, rows_json,
              inserted, duplicates, skipped_matches NULL /* rows left out: they look like entries already there */, source_call_id UNIQUE,
              confirmed_call_id, created_at, imported_at, undone_at NULL /* the owner had the import's entries removed */)
ledger_call(source_call_id PK, tool, subject, applied_at)
-- ledger/004_undo: a bulk recategorize keeps each entry's earlier category so that it can be taken back
ledger_recategorization(id TEXT PK /* rc_xxxxxxxx */, source_call_id UNIQUE, category_id, what, changed, created_at, undone_at NULL)
ledger_recategorization_row(batch_id REFERENCES ledger_recategorization ON DELETE CASCADE, txn_id, previous_category_id NULL, PK(batch_id, txn_id))

-- splits (module splits, the Accountant; M7). People are matched by the key of their whole name; 'me' is the owner. Splits write no ledger entries.
splits_bill(id TEXT PK /* b_xxxxxxxx */, title, occurred_on, payer_key, payer_name, total_minor, currency, equal, extras_json, source_ref NULL /* fi_ */,
            note, source_call_id UNIQUE, created_at)
splits_item(id PK, bill_id REFERENCES splits_bill ON DELETE CASCADE, description, amount_minor, shared_by_json)
splits_share(bill_id, person_key, person_name, person_id NULL REFERENCES people_person ON DELETE SET NULL, items_minor, extras_minor, owed_minor, PK(bill_id, person_key))
splits_settlement(id TEXT PK /* s_xxxxxxxx */, occurred_on, from_key, from_name /* paid */, to_key, to_name /* received */, amount_minor, currency, note,
                  source_call_id UNIQUE, created_at)

-- invoices (module invoices, the Accountant; M7). One profile row; a number is taken in the same transaction as the invoice row.
invoice_profile(id INTEGER PK CHECK(id = 1), sender_name, sender_details, client_name, client_address, description /* {period} {month} {year} */,
                amount_minor NULL, currency, payment_terms_days, payment_details, notes, number_pattern DEFAULT 'INV-{YYYY}-{seq:03}', next_seq, updated_at)
invoice_issued(id PK, number UNIQUE, seq, period /* YYYY-MM */, issue_date, due_date, amount_minor, currency, client_name, description,
               file_id /* fi_ */, file_path, source_call_id UNIQUE, created_at)
invoices_call(source_call_id PK, tool, subject, applied_at)   -- rule 8 for set_invoice_profile

-- inbox (module inbox, the Inbox agent; M5). Mail is a local copy, never attachments. Subjects, senders and snippets are one bounded line; text <= 8000 characters.
inbox_account(email PK, status CHECK(status IN ('connected','needs_reconnect','disconnected')), history_id NULL, connected_at, next_sync_at, last_sync_at NULL, last_ok_at NULL, last_error NULL,
              failures, needs_reconnect_at NULL, calendar_synced_at NULL, gen, durable_task_id NULL, created_at, updated_at)   -- the row is the truth; the token file says ok / needs_reconnect and when the owner approved
inbox_message(id INTEGER PK, account, gmail_id, thread_id, from_name, from_addr, to_addrs, subject, date, labels /* JSON */, bulk, snippet, body_text_trunc, hidden /* deleted, trashed, spam */,
              deleted_at NULL, triage_json NULL, category NULL, urgency NULL, needs_human NULL, triage_source NULL /* jev | rules | owner */, provisional /* rules stood in for Jev */,
              triaged_at NULL /* digests select by it */, created_at, UNIQUE(account, gmail_id))   -- + FTS5 inbox_message_fts over subject, sender, snippet, text, kept by triggers
inbox_event(id PK, account, event_id, title, start_at, end_at, all_day, attendees /* JSON */, location, updated, UNIQUE(account, event_id))
inbox_rule(id INTEGER PK, kind CHECK(kind IN ('sender','domain')), value, category, created_at, UNIQUE(kind, value))   -- what the owner approved (propose_sender_rule -> Approve)
inbox_suggestion(id TEXT PK /* sg_xxxxxxxx */, kind CHECK(kind IN ('meeting','commitment')), title, counterpart, context, at, ends_at NULL, source_type, source_id, source_label, source_url NULL,
                 status CHECK(status IN ('pending','added','dismissed','expired')), posted_at NULL, decided_at NULL, source_call_id UNIQUE, created_at)   -- the queue from the Inbox to the PA; a pending one expires after 7 days
inbox_call(source_call_id PK, tool, subject, applied_at)   -- rule 8 for mark_triage
inbox_digest(job, date, since_at, cutoff_at, PRIMARY KEY(job, date))   -- the window a digest first looked at: first writer wins
inbox_state(key PK, value, updated_at)   -- small facts: why Jev last fell back
inbox_read_failure(account, gmail_id, attempts, last_error, last_failed_at, skipped_at NULL, PRIMARY KEY(account, gmail_id))   -- a message Gmail would not hand over: retried at each sync until 5 syncs failed, then skipped and shown in Settings
delegate_ask(id TEXT PK /* q_xxxxxxxx */, source_call_id UNIQUE, conversation_id /* the asker's */, agent CHECK(agent IN ('inbox','health','accountant')), question, request_id,
             status CHECK(status IN ('waiting','answered','failed')), answer NULL, late, posted_at NULL, created_at, settled_at NULL)   -- ask_agent (module delegate)
```

Preferences/personality memory is written only when the user explicitly asks. Factual updates come from domain
tools (e.g. `add_expense`), not free-form memory.

## 8. Milestones

| #                                                                 | Deliverable                                                                                                                                                                                                                                                                                                                    | Done when                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **M1 Foundation** (done)                                          | pnpm monorepo; server with Harness (durable.sqlite), app.sqlite + migration runner, config + allowlist validation, `ensureAgents` (all four agents created, only PA has tools beyond profile); HTTP API (agents, messages, stream, abort, history); web chat with sidebar + streaming via assistant-ui; faux-provider dev mode | `pnpm test`, `pnpm typecheck`, `pnpm build` pass; dev mode chat streams from faux model end to end; restart mid-run resumes |
| M2 Tasks & reminders (done)                                       | tasks extension + Reminder task + zero-token posts + Web Push + approvals for delete                                                                                                                                                                                                                                           | reminder fires after restart, posts card, push sent (mockable)                                                              |
| M3 Follow-ups, agendas, birthdays, people (done)                  | FollowUp task, agenda capture, yearly birthday                                                                                                                                                                                                                                                                                 | follow-up loop works with fake clock                                                                                        |
| M4 Briefing, wrap-up, journal, files, share target (done)                       | daily tasks, done-log, uploads + file tools, PWA share target |                                                                                                                             |
| M5 Inbox (done)                                                   | Gmail + Calendar read-only (multi-account), Jev triage (rules without a key), digests at 12:30 and 19:00, suggestions to the PA, `ask_agent` | fakes for Google and Jev throughout; whole-server tests; browser check; the real services are the owner's first run (`SETUP.md`) |
| M6 Health (done)                                                  | weight/lift tables, tools, trends, chart cards, facts for the wrap-up and briefing                                                                                                                                                                                                                                              | tools tested with replays; whole-server test; browser check                                                                 |
| M7 Accountant (done)                                              | expenses (CSV/photo/chat), code-mode analysis, splits, invoice PDF from template                                                                                                                                                                                                                                               |                                                                                                                             |
| M8 Memory/profile UI, activity log, usage dashboard, budget guard |                                                                                                                                                                                                                                                                                                                                |                                                                                                                             |
| Ops                                                               | systemd units, tailscale serve config, OAuth login CLI (`pnpm login:openai`), backup (deferred)                                                                                                                                                                                                                                |                                                                                                                             |

## 9. Open items (deferred decisions)

- (Decided in M7) Invoice template: an HTML file with Mustache fields, `<data>/templates/invoice.html`, laid out to PDF by a small
  renderer over pdfkit (pure JavaScript, no browser; Latin-1 text only for now: an embedded font is the next step for Dzongkha).
  The owner recreates their PDF as that HTML once (`docs/setup-invoice.md`); Chromium and Typst were not chosen (not reliably
  present on the machine). Open: a font for non-Latin names, and a way to turn the owner's existing PDF into the template.
- (Decided in M7, cheap to reverse) Splits write no ledger entries; "unsettled splits" is the number of open pair balances; a CSV is
  previewed and then confirmed; a balance is the latest stated balance plus what was written after it (`docs/design-notes.md`).
- (Decided in the M7 review fixes) A script's time is bounded (30 s, 2 minutes at most); a settlement that names only part of a known
  friend's name is refused instead of starting a second person; rows of a statement that repeat an entry typed in chat or read from
  a receipt (same account and amount, within two days) are left out unless the owner includes them; a wrong import is taken back as
  a unit with approval; a bulk recategorization shows what it would do above 20 entries and can be undone; `preview_invoice` shows
  an invoice without taking a number. Open: should `record_settlement` also write the owner's side as a ledger entry (an optional
  account and category), so that "I paid Pema 250 from mBoB" reaches spending and the balance? The review recommended it; it
  couples the splits module to the ledger and was not in the coordinator's adjudication. And: an issued invoice keeps no snapshot of
  its address, payment details or notes, so a lost PDF cannot be made again under its own number (`docs/OPS.md` says to back it up).
- (Decided in M5, cheap to reverse) Digest windows are saved per job and day (`inbox_digest`) rather than derived from the last run; Disconnect forgets the sign-in but keeps the mail; a
  suggestion acts only through the owner's Add, on a message written by code and expires after 7 days; late `ask_agent` answers are cards, not prompt text; the briefing quotes the top three subjects; an empty
  digest is a card and no push. After the M5 review (`review-m5.md`): one unreadable message cannot stall an account's sync (it is skipped after 5 tries and shown in Settings); `mark_triage` changes one mail and a
  lasting sender rule needs the owner's Approve; a Jev that fails three mails in a row is paused for 15 minutes (Settings says so) and one sync gives Jev at most 90 s; `setup-google.md` recommends publishing the Google app
  "In production" so that sign-ins do not expire weekly. Open, cannot be checked offline: Google's REST behaviour (the history 404, label records, a Desktop client's loopback redirect) and the 7-day expiry of a Testing-mode refresh
  token are written from knowledge; Jev's request and answer shape were written without its documentation (`triage/jev-contract.ts`, `TODO(verify)`); no real model has driven the Inbox
  instructions, the digests or `ask_agent`; `pnpm login:openai` still does not exist (`SETUP.md` says how to make the credential file by hand).
- Backups (deferred by user).
- PDFs are stored and shown but the PA cannot read them yet: text extraction is a dependency decision (M7 needs it for
  statements; bank CSVs and receipt photos already work).
- An upload whose row insert is cut off by a crash between the rename and the insert leaves an orphan file; there is no sweep.
- The Android share target is untried on a device (Chrome is assumed to send `Sec-Fetch-Site: none` for the share POST).
- `experimental.proxyClientMaxBodySize` is how Next lets a proxied upload through; it can be renamed by a Next upgrade
  (`docs/OPS.md`).
- `search_files` is a plain word match over name, description and tags; add ranking (or FTS5, with `memory_fact`) if it is not enough.
- (Resolved in M1) Durable conversation-creation and event APIs were confirmed against the installed 1.4.0 package; where
  it differs from the repository checkout the code follows the package (progress-m1.md §2.1).
