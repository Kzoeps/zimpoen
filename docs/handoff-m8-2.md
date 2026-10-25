# Handoff 2: M8 + Ops — what worker 1 built, what is left

Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, `main` (M1–M7 committed; **M8 is in the working tree, uncommitted**: the coordinator
commits, you don't). Scope and constraints: `docs/handoff-m8.md` (read it first, then this file). Same rules as every milestone: no OpenAI/Google/TypeSafe
calls, no logins, no sudo, no system services installed, stop every server you start. Context hygiene: at ~55% write `docs/handoff-m8-3.md` and reply DONE-HANDOFF.

## 1. State of the scope items

| # | Item | State |
|---|---|---|
| 1 | Memory (`memory_fact` + FTS5, tools, prompt section, instruction lines) | **done and tested** |
| 2 | Profile page (web) + memory editor | **API and page written and tested (unit/markup); NOT yet seen in a browser** |
| 3 | Activity log | **API and page written and tested; NOT yet seen in a browser** |
| 4 | Usage dashboard + budget guard | **sampler, limits, report API, guard in the daily jobs, the page with its limit editor, the banner and the degraded daily card: written and tested; NOT yet seen in a browser** |
| 5 | `ops/systemd/*.service`, `ops/assistant.env.example` | **done and tested** (`systemd-analyze verify` is silent) |
| 6 | `ops/tailscale-serve.sh`, `ops/check.sh` | **done and tested** (bash -n, dry runs, real temp data dirs; shellcheck is not installed here, its test is `skipIf`) |
| 7 | `pnpm login:openai` / `logout:openai` | **done and tested against a fake provider** (never the real one) |
| 8 | `docs/SETUP.md` final checklist, README pointers | **`SETUP.md` rewritten (14 ordered steps, `ops/check.sh` at the end); README: the `login:openai` sentence and two command-table rows fixed; the rest of README (status line, memory/usage paragraph, layout, data dir) still to do** |
| 9 | Tests | server, extension and web-markup tests done; **the browser check is open** |
| 10 | `docs/progress-m8.md`, PLAN "all milestones built" + known-unverified list, design-notes, OPS.md | **NOT done** |

Gates on the final tree of worker 1: `pnpm typecheck` green (5 packages), `pnpm lint` (`biome check .`) clean (341 files), `pnpm test` **72 files, 1,603 tests pass, 2 skipped** (the shellcheck tests: shellcheck is not
installed here), `pnpm build` green (the web build lists `/profile`, `/activity`, `/usage`; `apps/server/dist/main.js` 938 KB). Before M8 it was 66 files / 1,489 tests.

## 2. What exists (new files first)

```text
packages/shared/src/{memory,usage,activity}.ts     wire types: MemoryFactView/Card/ListCard/Response, ProfileResponse, UsageResponse, BudgetAlert/BudgetHealth, ActivityItem/Response
packages/extensions/src/memory/                    migrations (memory/001_facts: memory_fact + memory_fact_fts + triggers), store, section (renderMemory), tools (remember, recall, forget, delete_memory), index (memoryModule + readOnlyExtension)
packages/extensions/src/usage/                     migrations (usage/001_ledger: usage_baseline, usage_day, usage_seed, usage_budget), store, service (sample, check, alerts, report, setLimit), index (usageModule)
apps/server/src/activity.ts                        createActivityReader: the log, derived from the threads (no table)
apps/server/src/http/owner.ts                      GET/PUT /api/profile…, GET/PATCH/DELETE /api/memory…, GET /api/activity, GET /api/usage, PUT /api/settings/budget/:agent
apps/server/src/login/openai.ts, login-openai.ts, logout-openai.ts     the CLIs (logic is testable; the entries wire readline)
apps/web/src/components/memory-cards.tsx           cards of remember / recall in the thread
ops/{assistant.env.example,check.sh,tailscale-serve.sh,systemd/assistant-server.service,systemd/assistant-web.service}
tests: packages/extensions/test/{memory,usage}.test.ts, apps/server/test/{m8,ops,login-openai}.test.ts
```
Changed: `packages/extensions/src/{module,index}.ts` (`DomainDeps.budget`, `BudgetGate`, exports), `daily/{run,task,index}.ts` (the guard), `packages/shared/src/{api,cards,daily,index}.ts`
(`AgentsResponse.budget`, the two memory cards in `ToolCard`, `DailyEntryData.degraded`), `apps/server/src/{domain,agents,server}.ts`, `http/{app,validation}.ts`, the web
`cards.tsx`, `card-text.ts`, `ui-messages.ts` (memory cards and the degraded daily card), `package.json` ×2 (scripts), five old server tests brought up to date (extension and tool lists:
the PA, Health and Accountant gained `memory` and the tools `recall` and `remember`; the Inbox gained `memory-read` and `recall`), `apps/server/test/support.ts`
(`appDepsFor` gives a real usage service and a profile), `packages/extensions/test/support.ts` (memory and usage modules, `budget` option).

## 3. Decisions of worker 1 (★ = for the coordinator to veto; each is cheap to reverse)

1. ★ **The Inbox agent may read memory and never write it** (`memory-read` extension: the prompt section and `recall`; no `remember`, `forget`). The handoff said "tools for
   every agent"; the Inbox processes untrusted email (PLAN rule 6) and a line it wrote would sit in a prompt for good (shared scope: in every agent's). Reverse: `inboxExtensions: [inbox, memory]` in `domain.ts` (it would also need the approval hook and `tool_search` for `forget`).
2. **`forget(id)` is the proposing tool and `delete_memory(id)` the guarded one** (the `propose_delete_*` pattern with the handoff's name). Both are `deferred`, so `tool_search` loads them
   (PA, Health, Accountant have it); `MEMORY_RULES` in `agents.ts` names them. The server deletes on Approve (`createForgetAction`); the owner's page deletes without asking.
3. ★ **Preferences "only on explicit request" is a prompt rule** (`remember`'s description and `MEMORY_RULES`), not code: code cannot tell. What code does: a line is one plain line (≤400
   chars, `<>` removed, refused when longer rather than cut), ≤400 lines per scope, an identical line in a scope+kind is "already remembered", and every write is a card in the thread and visible on the profile page.
4. **The prompt section** `memory` (key `memory`): intro line, "Preferences for every agent", "Preferences for you", "Facts" (pinned first, then newest), each line cut to 240 chars, total ≤2,400 chars
   (~600 tokens), the rest counted in a last line; no ids (recall gives them), no clock, absent when nothing is stored. The two profile preferences are shared preference rows with a `slot` (`tone`, `explanations`) shown under their labels.
5. ★ **Budget unit = the provider's `totalTokens` (cache reads included)**, because it is what the provider reports and a stable number; the dashboard shows input/output/cache so the owner can judge.
   **The week is Monday–Sunday in the owner's zone**; "reached" is `used >= limit`; the money shown is API-price dollars (a ChatGPT subscription is not billed by it), stored as micro-dollars.
6. **Usage is sampled, not hooked** (`pi.usage` has no timestamps): `usageModule.service(deps).sample()` copies Durable's per-conversation totals into `usage_baseline`, and what is new since the
   last reading goes to `usage_day` under the local day of the reading. Readings: at start (last step of `domain.repair()`, before `harness.resume()`), every 10 minutes (`sweep`), at shutdown, fresh in
   `check()` and `report()`, and throttled to 30 s for the banner (`alerts()`). The **first reading of an agent only seeds** the baseline (what was spent before has no day: never today's). A ledger that went
   down (restored database) counts nothing and the baseline follows it down. Readings run one at a time (a mutex), else an older snapshot could be applied over a newer baseline and count growth twice.
7. **The guard is in the daily engine, once per run** (`withBudget` in `daily/run.ts`, called in `task.ts` before the plan is memoized and in `recoverRuns`): over the limit → `plan.degraded`, kept in the durable
   memo (so a rerun after a crash cannot ask the model for a day whose first attempt posted the plain card: the two have different request ids); `deliver` posts the `app.daily` card with `degraded: { usedTokens, limitTokens }`
   and `requestId <job>:<date>:empty`, no model call; a **wrap-up still opens its journal day** (`recordWrapupAsked`) so an unasked answer has a day; the push still goes (unless the run is quiet and the job keeps quiet); a plan with nothing to say stays the old
   "nothing today" card. A gate that throws leaves the run as it was (fail open, reported). Owner-typed messages are never checked.
8. **Activity = derived from the transcripts**: a tool result is an item (tool name, first line of its text, `isError`), plus five kinds of timer cards (`app.reminder|agenda|followup|birthday|daily`, time = `firedAt`);
   `current_time` and `tool_search` are left out; chat messages and notices are not items. Paging: the cursor is base64url JSON `{agent: oldest entry id shown}`, each thread is read newest-first and the four are merged by time; at most 5,000
   entries per thread per request (then `truncated: true`). Day filters are the owner's calendar days (`from`/`to` inclusive).
9. The profile page's name/timezone/currency/height are **display-only** (they are `ASSISTANT_*` settings the prompt is built from at start); only tone and explanations are editable there.

## 4. Verified facts and quirks (do not rediscover)

- **`harness.snapshot(UsageDoc, conversationId, ctx)`** returns `{ models: Record<"provider/model", Usage>, tools: Record<name, Usage> }`; in a test, `harness.commit(async (tx) => { const doc = await tx.doc(UsageDoc, id); doc.models[key] = …}, ctx)` writes it (`setLedger` in `usage.test.ts`). The faux model reports estimated tokens (non-zero) and zero cost.
- **Tool-result timestamps come from the Harness clock** (`now`), so a test that moves the fake clock also dates the activity; moving it past 21:00 also runs that day's wrap-up (an extra `system` item in the log).
- A week starts on Monday: a test that spends on Sunday and checks the limit on Monday sees a new week (usage 0). Spend after moving the clock.
- `vitest`'s default reporter swallows `console.log` in a test: write to a file to debug.
- A section's `render(input)` gets `input.conversationId`; the memory section maps it to the agent through `agents` (`agentOfConversation`).
- `systemd` units: `ProtectHome=read-only` (not `true`) keeps `~/Documents` readable; no `MemoryDenyWriteExecute` (V8); `ReadWritePaths` must equal `ASSISTANT_DATA_DIR`. `next start` is run through Node directly (`node_modules/next/dist/bin/next`), so the unit does not need pnpm on its PATH.
- `tailscale funnel --https=443 off` and the `serve` flags are from knowledge of Tailscale ≥1.52 and could not be run: they are in the "known unverified" list. The script verifies Funnel is off afterwards.
- The real `models.login("openai","oauth", …)` (pi-ai) starts a loopback server on **127.0.0.1:1455** (`/auth/callback`) and prompts `manual_code` for a pasted redirect URL when the browser is elsewhere; the CLI prints both instructions. `Models.login` persists through `FileCredentialStore.modify`. The installation id (`getDeviceId`) is kept in `<data>/secrets/device-id` (0600).

## 5. Remaining work, in order

### 5.1 Web: written, needs eyes

Written by worker 1 (all typecheck, lint and build clean; **never opened in a browser**): `apps/web/src/lib/owner-pages.ts` (pure helpers: query strings, `parseTokenLimit` "500k", number formats), the API client functions in `lib/api.ts`
(`fetchProfile`, `updatePreferences`, `fetchMemory`, `updateMemory`, `deleteMemory`, `fetchActivity`, `fetchUsage`, `updateBudget`), `components/{profile-view,activity-view,usage-view}.tsx` with their thin `app/(app)/{profile,activity,usage}/page.tsx`,
the sidebar links (`agent-sidebar.tsx`: Profile, Activity, Usage above Settings), the banner (`chat-shell.tsx` `BudgetBanner`, fed by `useAgents().budget`), the memory cards (`memory-cards.tsx`), the degraded daily card (`cards.tsx`, `data-testid="degraded-note"`),
CSS at the end of `globals.css` (`owner-*`, `usage-*`), and `apps/web/test/owner-pages.test.ts` (26 tests: limit parsing, formats, query strings, the cards, the banner).

What to look at in the browser (it is the point of the browser check): the memory editor (tabs with counts, search, Edit/Pin/Delete with the in-page confirmation, empty states), the preference fields, the people list; activity filters and "Load more"; the usage cards (bar, red when over, limit editor, Days/Weeks bars, per-model list); the banner on every page; 390 px with no sideways scroll;
light and dark. Things I suspect and did not check: the Settings link no longer sits alone at the bottom of the sidebar on desktop (`.agent--settings { margin-top: auto }` still pushes it down, the three new links sit under the agents); `.usage-history__row` on a phone; the date inputs' look in dark mode; whether `useChat().agents` is already loaded when the activity page mounts (the agent select fills when it arrives).
Missing, if you want it: a web test for the pages themselves (they fetch on mount; the pure parts and cards are tested).

### 5.2 Docs
- `docs/SETUP.md`: **done by worker 1** (read it, and check each command against what you saw: the unit-file `CHANGE` lines, step numbers that README/PLAN refer to). It was meant to be: rewrite as THE ordered checklist the handoff lists: laptop prep (no-suspend: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`, lid switch), Node 24 + pnpm 10, clone, `pnpm install && pnpm build`, the env file (`ops/assistant.env.example` → `/etc/assistant/assistant.env`, mode 0600), **`pnpm login:openai`** (replaces the hand copy of pi's `auth.json`; keep the old command as a fallback paragraph), VAPID/`ASSISTANT_PUSH_SUBJECT`, Tailscale (`sudo tailscale set --hostname=…`, HTTPS certificates in the admin console, `ops/tailscale-serve.sh`, `ASSISTANT_PUBLIC_HOST`), systemd install commands (`sudo install …`, `daemon-reload`, `enable --now`), Google (`docs/setup-google.md`), Jev (`docs/setup-jev.md`), the invoice template (`docs/setup-invoice.md`), the phone: install the PWA, enable notifications, test the share target; each with the exact command and how to verify (`ops/check.sh` is the one verification at the end). Keep its "to verify" notes.
- `README.md`: the status line ("Milestones 1 to 8"), a paragraph on memory/profile, activity, usage and the weekly limit, the `/tool remember|recall` examples, the commands table (`pnpm login:openai`, `pnpm logout:openai`; `ops/`), the data dir (`device-id`), Layout (`ops/`), the new routes, point to `docs/SETUP.md`.
- `docs/PLAN.md`: header "all milestones built"; §5.5 routes; §7 `memory_fact` as built (seq, id, scope, kind, text, pinned, slot, source, source_call_id) and the `usage_*` tables; §8 rows M8/Ops "done"; §9 a **known-unverified list** (below); remove "`pnpm login:openai` still does not exist" from §9.
- `docs/design-notes.md`: a section each for Memory, Usage and the budget guard (decisions 1–7 above), Activity (8); `docs/OPS.md`: the systemd units (install, logs, what each hardening line is for), `ops/check.sh` output, Tailscale Serve, "what to do when…" (over the limit, a parked task, an account that needs reconnecting).
- `docs/progress-m8.md`: the report (state table, commands and results, changed files, decisions with ★, could-not-verify, known gaps, suggested scoped commits, break-and-restore if you do it). Suggested commits: `shared:` types, `extensions:` memory + usage + the daily guard, `server:` owner API/activity/login CLIs, `web:` pages, `ops:` systemd/tailscale/check, `docs:`.

**Known-unverified list for PLAN §9 / the report** (nothing here could be run offline): the `tailscale serve`/`funnel` flags and that Serve works on the free plan; the systemd units on a real machine (hardening vs a real Node/Next start, `ReadWritePaths` with a data dir under `/home`); `pnpm login:openai` against the real ChatGPT sign-in (the callback on 1455, the SSH paste path, that OpenAI accepts the saved refresh token for the server); push delivery through FCM/Apple; Google's REST behaviour, the 7-day Testing-mode expiry, Jev's request shape (all from M5); a real model driving the memory rules (preferences only on request, no remembering of file/email text), the Inbox/ask_agent/digest instructions; that `totalTokens` from the real provider includes what the owner expects (cache reads) and that ChatGPT-sign-in responses carry usage at all (if they report zeros the limit never trips: the dashboard would show it); the Android share target on a device.

### 5.3 Browser check and gates
Start with this one (it is the biggest unknown): `pnpm dev` (faux model, fake Google, throwaway `ASSISTANT_DATA_DIR`, `agent-browser --args "--no-sandbox"`, skill `browser-check-assistant-ui` has the recipe): screenshots in `/tmp/assistant-shots/m8/` at 1100 and 390 px: profile (preferences saved, memory edit/pin/delete/search, people), a `/tool remember` card and a `/tool recall` card in the PA thread, activity with filters and "Load more", usage with a limit set and the banner on every page, a degraded briefing card (limit 1 token; move the briefing two minutes ahead via `PUT /api/settings/schedule/briefing`, spend something first so the week has usage, add a task due today so the card has facts). Measure `scrollWidth` at 390 px. Then `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, a bundle smoke (`ASSISTANT_DATA_DIR=/tmp/m8-smoke ASSISTANT_READ_PATHS=/usr/share/doc ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux ASSISTANT_PORT=3005 node apps/server/dist/main.js`: the new migrations `memory/001_facts` and `usage/001_ledger` apply), stop every server, remove throwaway dirs, reply DONE-M8.

Anything in `/tmp/assistant-ext-*-backup` is the pre-existing power-cut test's leftover (project memory): not yours.
