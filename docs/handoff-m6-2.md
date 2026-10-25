# Handoff 2: M6 — browser check, final gates, final report

Second worker. Coordinator is tech lead. Repo `/home/kzoeps/Projects/personal/assistant`, branch **`main`**, nothing committed (the coordinator
commits; **do not commit or push**). Worker 1 stopped at the context limit with **all code, tests and docs done and the gates green**; what is left
is the browser check, a last review, the final gates and the report. Read `docs/handoff-m6.md` (the scope) and `docs/progress-m6.md` ("M6 (partial)")
first; the reasoning behind the design is in `docs/design-notes.md` ("Health: weight and lifts").

Rules that still apply (`docs/handoff-m2.md`): no calls to OpenAI/Google/TypeSafe/real push services, no logins, stop every server you start, use
pnpm, do not touch `railway`. **Never run `git checkout`/`git restore` on this tree** (everything is uncommitted). The model here has a 1M window:
"~55 %" is about 550k tokens. Context hygiene: at ~55 % finish the current item, write `docs/handoff-m6-3.md`, reply DONE-HANDOFF.

## 1. State (last runs, after the last code change)

| Check | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm lint` | clean (216 files; Biome ignores `*.md`) |
| `pnpm test` (serial) | 47 files, 892 passed; one test was added after (health.test.ts: 42): expect **893** |
| `pnpm build` | ok (server bundle 403.8 kB; `next build` ok) |
| Browser check, bundle smoke | not done |

The module map: `packages/extensions/src/health/` (`catalog` names, `units`, `stats` pure math, `range`, `migrations`, `store` SQL, `reports` text + cards,
`tools`, `facts` daily provider, `index` module + prompt section); cards `packages/shared/src/health.ts`; web `apps/web/src/lib/chart.ts` (layout) and
`components/health-charts.tsx` (the five cards), wired in `components/cards.tsx`; server wiring `apps/server/src/{domain,agents,config,server}.ts`.

## 2. Remaining items, in order

1. **Browser check** (agent-browser; dev servers; dev model) with screenshots in `/tmp/assistant-shots/m6/`. Recipe in §3. Look for and fix what the
   real browser shows (worker 1 never saw these cards): the chart drawing (dots, the average line, axis labels not clipped, record rings), the cards
   at **390 px** (`set viewport 390 844`: no horizontal scroll, the stats grid wraps, `.msg--card` has `padding-left: 40px` and `.card--chart` is
   `width: min(100%, 520px)`, so check the chart is not squeezed), dark mode (the headless browser prefers dark; also try light with
   `agent-browser`'s color-scheme option if it has one, else say light mode was not seen), the workout card (PR badge, "new exercise" badge), the
   approval card of `propose_delete_workout` in the Health thread and the YES reply, and the Health agent's sidebar entry. Record findings in the
   report as a table (B1, B2, ... like `progress-m4.md` §2) with the fix.
2. **A last look at the new functions** (global AGENTS.md "Function design"). Worker 1 already split `exerciseProgress` (`reports.ts`) into `progressOf` (the
   numbers), `progressLines` / `recordsLine` / `dayLine` (the text) and `progressCard` (the card), with byte-identical output. `weightTrend` (about 70 lines,
   numbers + text + card in one) could get the same treatment if it reads better; `createHealthTools` is one long factory by the pattern of
   `createTaskTools` / `createPeopleTools`: leave it. Keep every output identical (the tests in `health.test.ts` pin the texts and cards).
3. **Final gates**, serial: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Then the bundle smoke as in M4:
   `ASSISTANT_DATA_DIR=/tmp/m6-smoke ASSISTANT_READ_PATHS=/usr/share/doc ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux ASSISTANT_PORT=3005 node apps/server/dist/main.js`
   (starts, applies the health migrations, `/tool log_weight` in the health conversation works, clean SIGTERM; remove `/tmp/m6-smoke`).
4. **Append the final report** to `docs/progress-m6.md` in the M4 style: changed files (this session), what the browser check found (table), decisions
   and deviations with ★ veto points (copy §4 of the partial section and add yours), commands run and results, break-and-restore checks (optional but
   valuable: break one rule, see exactly its tests fail, restore byte for byte with `cmp`; good candidates: drop `UNIQUE (measured_on)`'s check by
   making `log_weight` ignore `replace`, make `personalRecords` use `>=`, remove the `health_call` ledger lookup in `log_weight`, drop the `earlier`
   cut at the workout's date in `insertWorkout`, remove the approval guard from the Health agent's extension list in `domain.ts`), could-not-verify,
   known risks, and suggested scoped commits for the coordinator (`shared:`, `extensions:`, `server:`, `web:`, `docs:`, `vitest:`; `docs/handoff-m6.md`
   stays untracked as handed over).
5. Stop every server and browser session; confirm nothing listens on 3000–3009; remove scratch dirs under `/tmp` except `/tmp/assistant-shots/m6/`.
6. Reply **DONE-M6**.

## 3. Browser check recipe

- `pnpm dev` (server 127.0.0.1:3001 with `./data-dev`, web 127.0.0.1:3000; dev model, push fake). If `./data-dev` holds an older database, that is fine:
  `ensureAgents` re-applies the code-owned instructions and extensions to the Health conversation at start (it logs "updated instructions/extensions: health").
  Use a throwaway data dir instead if you prefer: `ASSISTANT_DATA_DIR=/tmp/m6-dev ASSISTANT_READ_PATHS=<a narrow dir, not containing the data dir>`.
  Set `ASSISTANT_OWNER_HEIGHT_CM=176` to see the BMI.
- agent-browser 0.34: `--args "--no-sandbox"` is needed here; `set viewport W H`; use a named session (`AGENT_BROWSER_SESSION=m6`); `eval "<js>"` runs in
  the page. Open `http://127.0.0.1:3000/chat/health`.
- **Seed through the API** instead of typing each command (the dev model turns `/tool <name> {json}` into a tool call; the Health agent's everyday
  tools need no `tool_search`; `propose_delete_*` and `delete_*` do). Find the conversation id with `curl -s 127.0.0.1:3001/api/agents` (the `health`
  entry), then per command
  `curl -s -X POST 127.0.0.1:3001/api/conversations/<id>/messages -H 'content-type: application/json' -d '{"content":"/tool log_weight {\"weight\":72.4,\"date\":\"2026-10-20\"}","requestId":"seed-1"}'`
  (a new `requestId` each time; wait about a second between commands, or poll the stream; each run answers with the dev model's echo of the result).
  The real date of this laptop is 2026-10-25 (`date +%F`); dates in the future are refused, so seed relative to today.
- What to seed: 14 to 20 weights over 3 weeks with a mild downward trend (`/tool log_weight {"weight":..,"date":".."}`; one in pounds:
  `"unit":"lb"`), squat sessions on 3 to 4 days with rising weight (`/tool log_workout {"date":"..","exercises":[{"name":"squat","sets":[{"reps":5,"weight":100,"count":5}]},{"name":"bench","sets":[{"reps":8,"weight":60,"count":3}]},{"name":"pull ups","sets":[{"reps":8,"count":3}]}]}`),
  one unknown exercise (`cable crossover`, to see the "new exercise" badge and the confirmation text), then `/tool weight_trend {"range":"30d"}`,
  `/tool exercise_progress {"exercise":"squat"}`, `/tool exercise_progress {"exercise":"pull ups"}`, `/tool list_workouts`, `/tool log_weight {"weight":72.4}` twice
  (the second answer is the refusal text, no card). Deletion: `/tool tool_search {"query":"delete a workout"}`, `/tool propose_delete_workout {"session_id":"w_…"}`,
  then type `YES` in the composer (no message in between: another message closes the YES window).
- Screenshots to keep (names are suggestions): `01-empty-health-thread`, `02-weight-logged`, `03-weight-chart`, `04-exercise-chart`, `05-bodyweight-chart`,
  `06-workout-logged` (PR + new exercise badges), `07-workout-list`, `08-approval-and-yes`, `09-mobile-390-weight-chart`, `10-mobile-390-workout`, plus one
  of the PA's evening wrap-up card with the "Health today" section if you can trigger it (Settings → Daily schedule → set the wrap-up a minute ahead; the
  card folds the sections: open it) and the briefing nudge (log a weight dated 2 days ago and none yesterday, set the briefing a minute ahead).

## 4. Verified facts (Durable 1.4.0 and the tools as installed)

- Durable composes an agent's tools **by name, last extension wins** (`resolveAgent`); the registry only refuses a duplicate *task* name or a duplicate tool
  *within one extension*. That is why `current_time` may exist in two extensions that never share an agent. In the test fixture all modules share one
  conversation; it works, the later extension's tool answers.
- `tool_search` (`createToolSearchExtension`) is one extension object that two agents list; deferred tools are loaded per conversation.
- `AppDb.transaction` nests as savepoints; `db.get` of `SELECT MAX(...)` over no rows returns `{ col: null }`; SQLite window functions work in `ORDER BY`
  (`MIN(id) OVER (PARTITION BY ...)` is used by `setsOfSessions`).
- A YES is answered per conversation and only when nothing else was said since the request (design-notes "Approvals"): a test or a browser run that sends any
  message between the proposal and the YES sees the YES go to the model instead.
- Vitest 5 / Vite 8 transform with oxc: JSX in a `.tsx` imported by a test needs `oxc.jsx` in `vitest.config.ts` (added); test files must end `.test.ts`.
  `react-dom/server`'s `renderToStaticMarkup` works in the node environment.
- Numbers: `round()` is half away from zero with a `toPrecision(15)` guard; `e1rmOf` is Epley rounded to 0.1 (one rep = the weight); a personal record is
  judged on the rounded value, so equal after rounding is not a record.
- The dev model has no judgement: it never calls `log_workout` by itself, which is why the check uses `/tool`.

## 5. Known risks and gaps (for the report)

- A real model has not run `HEALTH_RULES`: whether it passes `count`, `today`/`yesterday`, finds the deletion tools with `tool_search`, and quotes the numbers
  as returned is unverified (the tests prove the plumbing and the texts only).
- Estimated 1RM above about ten reps is a poor estimate (stated in the tool text and the docs); there is no cap.
- `list_workouts` does not mark records (only `log_workout` does at log time, and `exercise_progress` over time).
- No rename or merge of an exercise: a wrong new name is fixed by deleting that workout and logging it again; a misspelling that is not caught by the
  key/plural matching creates a second exercise.
- One weighing a day (no morning/evening pair); a weight with a time of day is not kept.
- The Health agent knows nothing the PA knows (and vice versa) except through the daily facts: it cannot be asked by the PA yet (`ask_agent` is later).
- `exerciseProgress`'s "best ever" is "up to the end of the range" when `to` is in the past.
- The existing test `daily.test.ts` ("power cut" case) leaves a `/tmp/assistant-ext-*-backup` directory per run (`${f.dir}-backup` is never removed; 29 had
  piled up by the end of worker 1's runs, all from the suite, none from M6 code). Deleting them needs the owner's OK (the rule is to ask before deleting
  files); a test fix (remove the backup in the test) is the real cure and is outside M6's scope: mention it in the report.
- Unchanged from earlier milestones: the `file-lock` flake under CPU starvation (run suites serially when judging gates), `experimental.proxyClientMaxBodySize`,
  Tailscale-related behaviour unverified, the Android share target untried.
