# M6 progress log (worker → coordinator)

# M6 (partial) — worker 1, stopped at the context limit

Branch `main`, nothing committed or pushed (the coordinator commits). No OpenAI, Google or TypeSafe call, no real push service, no login, no
`railway`; **no server of mine is running** (nothing was started: the tests start in-process servers on port 0). Scope: `docs/handoff-m6.md`.
What is left, in order, with the verified facts and the decisions: `docs/handoff-m6-2.md`. The final report (worker 3: the review's fixes, the browser check, the bundle smoke) is at the end of this file.

## 1. State at the handoff

| Scope item | State |
|---|---|
| 1 health module (tables, units, kg, lb conversion, BMI only with a height) | **done, tested** (`packages/extensions/src/health/`, migrations `health/001_weight`, `002_workouts`, `003_call_ledger`) |
| 2 tools: `log_weight`, `log_workout`, `weight_trend`, `exercise_progress`, `list_workouts`, `propose_delete_weight|workout` (+ the guarded `delete_*`), `current_time` | **done, tested**; results carry typed `details` cards (`packages/shared/src/health.ts`) |
| 3 prompt section (no clock) | **done, tested** (`renderHealthSection`, section key `health`) |
| 4 daily facts: wrap-up "Health today", briefing nudge | **done, tested**, also through the whole server with the fake clock |
| 5 Health agent instructions; the PA's briefing rule mentions the health line | **done** (`apps/server/src/agents.ts: HEALTH_RULES`), tested for content |
| 6 web: weight chart, exercise chart, workout summary, logged-weight card, workout list; 390 px | **written, typechecked, rendered to markup in tests; NOT yet seen in a browser** |
| 7 flaky M1 test (`agents.test` "a crashed start created…") | **fixed** (compared as sets by id; the cause was `created_at` ties) |
| 8 tests | done: see §3 |
| 9 docs: README, design-notes ("Health: weight and lifts"), PLAN (status, `DomainDeps.health`, §6, §7 tables and their deviations, §8) | **done**; `progress-m6.md` final report **not yet** |
| 9 browser check, screenshots `/tmp/assistant-shots/m6/` | **not done** |

## 2. Changed files

```text
packages/shared/       NEW health.ts (card types, MAX_CHART_POINTS, and the wording both sides share: round, formatKg, signed, formatVolume,
                       describeSetGroup); edited cards.ts (ToolCard union, CARD_TYPES), index.ts
packages/extensions/   NEW health/{catalog,units,stats,range,migrations,store,reports,tools,facts,index}.ts
                       edited module.ts (DomainDeps.health, HealthDeps), index.ts (exports); tests: NEW health.test.ts (42), health-math.test.ts (29);
                       edited support.ts (the fixture installs healthModule; option `health`)
apps/server/           edited config.ts (ASSISTANT_OWNER_HEIGHT_CM -> profile.heightCm), domain.ts (healthModule, healthExtensions, option `health`),
                       agents.ts (HEALTH_RULES, buildAgents gives the Health agent its extensions, PA briefing rule), server.ts (wiring)
                       tests: NEW m6.test.ts (7); edited agents.test.ts (flaky fix, buildAgents, Health rules), config.test.ts (height), m3.test.ts (Health's extension list)
apps/web/              NEW lib/chart.ts (layout of the SVG charts), components/health-charts.tsx (the five cards + LineChart)
                       edited components/cards.tsx (CardView cases), lib/ui-messages.ts (UiCard), lib/card-text.ts (summaries), app/globals.css (health styles)
                       tests: NEW chart.test.ts (14), health-cards.test.ts (12)
vitest.config.ts       `oxc: { jsx: { runtime: "automatic" } }` so a test can import a .tsx component (the web tsconfig says jsx: preserve)
docs/                  README, design-notes, PLAN, handoff-m6-2.md, progress-m6.md (this file)
```

No new dependency. One new environment variable: `ASSISTANT_OWNER_HEIGHT_CM` (optional).

## 3. Commands run and results

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm lint` | clean (216 files) |
| `pnpm test` (serial) | **47 files, 892 tests pass** (M4 end: 42 / 783 at my start; +109 tests), plus 1 added afterwards (health.test 42): run again for the final count |
| `pnpm build` | ok: server bundle `dist/main.js` 403.8 kB, `next build` ok |
| browser check, bundle smoke | **not run** |

## 4. Decisions so far (★ = for the coordinator to veto; the reasoning is in `design-notes.md` "Health: weight and lifts")

1. ★ The Health agent's deletion tools (`propose_delete_*`, `delete_*`) are `deferred` and found with `tool_search`, exactly as the PA's; the agent
   therefore also has the `tool-search` extension. Cost: one extra model turn for a deletion. The approval hook is in its extension list.
2. ★ One `log_workout` call is one session; two calls on one day are two sessions. Every chart, record and fact groups by *day* [worker 3: except that a workout being logged is judged per session, so a second session on a day can announce its own record; see the final report, §1 N4].
3. ★ A personal record is a day whose metric (estimated 1RM to 0.1 kg, or reps for a bodyweight exercise) is **strictly** better than every earlier
   day; the first day is the baseline; judged against the whole history, not the range.
4. ★ The briefing nudge needs a weighing in the 14 days before yesterday (`NUDGE_WINDOW_DAYS`), none yesterday and none today.
5. ★ The height is `ASSISTANT_OWNER_HEIGHT_CM`, passed to the Health module only (`DomainDeps.health`), not in the shared profile section.
6. ★ `current_time` exists in the health extension too (same text as the tasks one): the Health agent has no other way to learn today's date.
7. ★ A built-in list of about 35 exercises seeds names and aliases; an unknown name is created and the result says so; there is no rename/merge tool
   (delete the workout and log it again) [overridden by the coordinator: `rename_exercise` and `propose_merge_exercises` exist now; see the final report].
8. Plausibility limits (20 to 500 kg body weight, 1000 kg a set) and a warning for a 4 kg jump within 14 days (saved, the model is told to check).
9. The schema enforces one weighing a day (`measured_on UNIQUE`); sessions have `source_call_id` and weights `updated_at` (the sketch had neither);
   `health_call` is the ledger for `log_weight replace`.
10. The wording helpers are in `@assistant/shared` and re-exported by `health/units.ts`, so the thread and the model's text agree.
11. Test-only: `oxc.jsx` in `vitest.config.ts`; component tests are `.test.ts` files that use `createElement` (the include glob is `*.test.ts`).

## 5. Could not verify

- Everything in the browser (layout at 390 px, the SVG drawing, dark mode, the cards in a real thread).
- A real model with `HEALTH_RULES` (does it pass `count`, use `today`/`yesterday`, find the deletion tools with `tool_search`, quote tool numbers).
- Real push (unchanged: the new nudge uses the briefing's generic push).

## 6. Known risks

See `docs/handoff-m6-2.md` §5.


---

# M6 review fixes and finish — worker 3

Branch `main`, nothing committed or pushed (the coordinator commits). No OpenAI, Google or TypeSafe call, no real push service, no login, no `railway`,
no `git checkout`/`restore`. Scope: `docs/handoff-m6-fixes.md` (the adjudication of `docs/review-m6.md`) plus the work `docs/handoff-m6-2.md` left
(browser check, bundle smoke, this report). Every server and browser session I started is stopped; nothing listens on 3000–3099.
Gates after the last change: `pnpm typecheck` 0 errors, `pnpm lint` clean (216 files), `pnpm test` **47 files / 951 tests** (893 at my start: +58), `pnpm build` ok.

## 1. Every item of the review: fixed or deferred, and the test that holds it

| Item | State | What was done | Held by |
|---|---|---|---|
| **B1** a new exercise first logged with no weight stayed `bodyweight` for good; later loads were judged by reps | **fixed** | What an exercise is *measured in* is derived from its sets, never stored (`metricFor`): a bodyweight exercise is measured by reps until a set of it carries added weight, from then on by the estimated 1RM of that weight (unloaded days count 0). So no change of kind, rename or delete is needed. The new-exercise note now says the kind it got and what follows (`newExerciseNote`) | health.test › "an exercise's kind and what its progress is measured in" (tracks a new exercise first logged with no weight by its load…; tells the model which kind a new exercise got…); health-math › "what an exercise is measured in" |
| **B2** added weight on a bodyweight exercise (loaded pull-ups, dips) was invisible to progress, and the rules told the model to give none | **fixed** | Same mechanism. Texts say "estimated 1RM of the added weight"; `+20 kg` sets; "Heaviest added weight … Total reps"; the PR line, the wrap-up fact, the prompt section and the cards (`ExerciseMetric`, `WorkoutExercise.metric`) follow it. `HEALTH_RULES` and the `weight` description now say to pass the added weight | health.test › "follows added weight on a bodyweight exercise: loaded dips…", "announces a record for added weight…", "does not count unloaded reps as a record once…", "reads an unloaded day of a loaded exercise as 0 kg…", "puts the load in the prompt's records and in the evening's facts…"; health-cards › "…bodyweight exercise with added weight" (3) |
| **B3** a built-in weighted name (lunges, calf raises, squats, hip thrusts) could not be logged without a load, and the error had no way out | **fixed** | The refusal names the way out: `log it as 'Bodyweight lunge' instead` (`bodyweightNameOf`). The four common twins are in the built-in list (`Bodyweight squat|lunge|calf raise|hip thrust`, so the retry makes no "new exercise" noise); any other weighted exercise gets the same sentence, and an unknown twin is created like any new name. `weight: 0` gets the same answer (no hidden meaning) | health.test › "a weighted exercise done with no weight (its bodyweight version)" (3); health-math › "has a bodyweight twin…", "writes the bodyweight name…" |
| **T1** replay of a `log_weight replace` two days later with no date | **added** | the guard at the top of `log_weight` was load-bearing and untested | health.test › log_weight › "writes no phantom weighing when a replaced weighing's call is replayed on another day…". Break B16 kills exactly it |
| **T2** "today logged, yesterday missing" for the briefing nudge | **added** | | health.test › daily jobs › "does not nudge when today's weight is in even though yesterday's is missing…". Break B17 |
| **T3** exercise chart thinning, "every record kept", the 4 kg boundary | **added** | | health.test › "exercise_progress of a long history" (2), log_weight › "doubts a jump of exactly 4 kg…" (also 14 vs 15 days); health-math › "thinning an exercise chart" (4). Breaks B05, B06, B18 |
| **T4** the height test was vacuous (`JSON.stringify` drops the section functions) | **fixed** | the test reads what each agent was *told* (`conversation.context().messages`, the system sections) and starts with a positive control: the Health agent's prompt says `BMI 23.4 (height 176 cm)`; the PA, inbox and accountant prompts contain no `176`, `height` or `BMI` | m6 › "tells the Health agent the owner's height, and no other agent". Breaks B21, B22 |
| **N1** averages, trends and changes 0.1 kg off in 2–7 % of cases (rounding twice, float subtraction) | **fixed** | every sum, mean, difference and total is worked out in whole hundredths of a kilogram (`hundredths`, `diffKg`, `avg7Hundredths`) and rounded once, where it is shown; `avg7` is the exact mean (the chart payload rounds it to 2 decimals). The total volume of a range is summed over the sets, not over the rounded days | health-math › "weight arithmetic that is exact" (5, among them an integer oracle over 300 random histories for the average, change, trend and weekly rate); health.test › log_weight (3: 72.44 and 72.45 average 72.4; 72.57 after 72.42 is +0.2) and "adds the volume of a range from its sets…". Breaks B02, B03, B04, B20 |
| **N2** running-sum drift over thousands of weighings | **fixed** | each window is summed afresh, in integers | health-math › "sums every window afresh… a history of years" (4,000 days checked against the exact sum) |
| **N3** the 90-point cap was not kept for exercise charts | **fixed** | `thinDays`: the first day, the latest five, the newest records (at most 45) and the rest spread evenly; at most 90, and 9.7 KB with a record on every day (was 31 KB for 300 days) | the T3 tests; the size is asserted (< 12 KB) |
| **N4** two sessions on one day announce two records | **kept, documented** | announcing per session at log time is the better message for the owner (the evening session that beats the morning one says "was 122.5"); the day is still counted once by `exercise_progress` and the wrap-up. The claims in design-notes and `progress-m6` §4 were corrected | health.test › "announces a record per session: a second session on a day beats the first, while the day counts one record" |
| **N5** a replayed `log_workout` lost its record and new-exercise lines | **fixed** | what a workout did is read back from the database (`writtenOfSession`: sessions written before it by row order, dated no later than it; an exercise is new when nothing came before it and it was made with the session), on the first run and on a rerun alike | health.test › "answers a replayed call with the same text and card as the first run…" (a heavier late entry logged in between does not change it), "…with the pounds note too". Break B08 |
| **N6** `propose_delete_weight` reads the clock before it looks for its own request | **claim fixed, code deferred** | the doc and the header comment now say which tools look first (`log_weight`, `log_workout`, `rename_exercise`) and that the `propose_*` tools do not; the approval service still returns the original request by call id, so nothing is proposed twice or deleted wrongly. Closing it means a lookup by call id in the approvals service (M2 code the review confirmed and this milestone does not otherwise touch), for a replay after midnight of a call that runs in milliseconds | – |
| **N7** `5000y` answered for the wrong century | **fixed** | counts reach back 100 years (5,200 weeks, 1,200 months; days stop at what four digits say) | health-math › "refuses a count that reaches back further than a log can…". Break B15 |
| **N8** `flies` is not `fly`; a name in another script was "no letters or digits" | **fixed** | `-ies` plurals; the key keeps letters and digits of any script and drops accents | health-math › "matches a plural that ends in -ies…", "keeps the letters of any script…"; health.test › "finds a plural that ends in -ies, and names with letters of any script", "says 'no letters or digits' only of a name that has none". Breaks B13, B14 |
| **N9** `vitest.config.ts` named a test file that does not exist | **fixed** | comment | – |
| **N10** the height rode in `config.profile` | **fixed** | `Config.health.heightCm`; `ProfileConfig` has the three fields the profile section reads | config.test › "reads every setting…" and the defaults (`profile` is compared whole). Break B21 |
| **N11** a replaced weighing keeps no history; no aggregate such as "total volume this month" | **deferred** | product features, not defects: nobody has asked for them, and the rules forbid the model to add numbers itself, so the first aggregate wanted is one new tool. Nothing in the data model prevents either | – |
| **N12** the card's "latest days" came from the thinned points | **fixed** | the thinning always keeps the latest five days, which the card lists | health.test long history (the last five dates), health-cards › "a thinned exercise card" |
| **U1** nothing seen in a browser | **done** | §3 | 20 screenshots in `/tmp/assistant-shots/m6/` |
| **U2** no real model has run `HEALTH_RULES` | **open** | cannot be done offline. The rules were rewritten for the new tools and the refusals say what to do; whether a model passes `count`, finds the merge tool with `tool_search` and quotes numbers as returned is still unverified | – |
| **U3** every log changes the `health` section, so the provider's cache misses once | **documented** | design-notes "What the provider sees, and the prompt cache"; same as the tasks section | – |
| **U4** tool-call ids are assumed unique per conversation | **documented** | same note (M2 to M4 assumption) | – |
| **U5** build, bundle smoke | **done** | §5 | – |
| **U6** card size in a snapshot | **fixed by N3** | 9.7 KB worst case | the size assertion |
| **U7** privacy: body data goes to the provider, the PA gets a summary | **documented** | README "What the model provider sees" (Security rules), design-notes | – |
| **U8** `tool_search` for the deletion tools | **accepted** | coordinator: veto point 1 accepted | – |
| **Veto #7 overridden** rename and merge | **built** | `rename_exercise` (everyday tool; the old name stays an alias; idempotent by the call ledger) and `propose_merge_exercises` / guarded `merge_exercises` (deferred with the deletion tools; approval by Approve or YES; moves every set, numbers them after the others in a shared workout, keeps the removed name and its aliases as aliases; refuses merging an exercise into itself and sets with no weight into a weighted exercise, before the owner is asked) | health.test › "rename_exercise" (5), "merging two exercises asks the owner first" (5); m6 › "renaming and merging exercises through the whole server" (2: the tool lists, a rename and a merge by YES). Breaks B09–B12, B19 |

## 2. Changed files (this session; nothing new, 26 edited)

```text
packages/shared/       health.ts (ExerciseMetric, WorkoutExercise.metric, LATEST_DAYS_LISTED, comments), index.ts
packages/extensions/   health/catalog.ts (keys in any script, -ies, bodyweight twins, bodyweightNameOf), range.ts (counts), units.ts (hundredths, diffKg),
                       stats.ts (metricFor/hasLoad, metric in place of kind, exact moving average and stats, thinDays), store.ts (loadedExerciseIds,
                       writtenOfSession, insertWorkout without `written`, resolveExercise, rename, merge), reports.ts (metric everywhere, estimateName,
                       thinning, volume, weightTrend split into trendSummary / trendLines / trendCard), tools.ts (checkLoads, new-exercise note, rename_exercise,
                       propose_merge_exercises, merge_exercises, requireExercise, approval actions), facts.ts, index.ts (metric)
                       tests: health.test.ts (now 76 tests), health-math.test.ts (now 47)
apps/server/           config.ts (Config.health), server.ts, agents.ts (HEALTH_RULES); tests: m6.test.ts (now 9), config.test.ts, agents.test.ts
apps/web/              components/health-charts.tsx (kind and metric apart, the plus, "no added weight", latest five), app/globals.css (record colour,
                       axis font on a phone, legend); test: health-cards.test.ts (now 17)
vitest.config.ts       comment (N9)
docs/                  README, design-notes, PLAN, progress-m6 (this section)
```

No new dependency, no new environment variable, no new migration (the call ledger and the tables already existed).

## 3. What the browser check found (dev servers, dev model, `agent-browser`, a throwaway data directory; each is fixed unless marked)

| # | Finding | Fix / test |
|---|---|---|
| BC1 | **A record was drawn in the line's blue**, not amber like its legend key: `.chart__series--points .chart__dot` (two classes) beat `.chart__dot--pr` (one). Computed fill was `rgb(109,151,255)` on all points | `.chart__series .chart__dot--pr`; computed fill now `rgb(217,164,65)`; seen on the squat and the 90-point deadlift charts. A CSS rule: no automated test |
| BC2 | **At 390 px the axis text was 7.9 px** (10 units of a 360-unit drawing scaled to a 285 px SVG; the card is 318 px because of the thread's 40 px indent), hard to read | `@media (max-width: 480px) { .chart__axis text { font-size: 12.5px } }`: 9.9 px; the stats grid wraps to two columns and nothing scrolls sideways (`scrollWidth` 390) |
| BC3 | A loaded exercise's unloaded day read **"est. +0 kg"** | "no added weight" (health-cards › the bodyweight card with added weight) |
| BC4 | The **"· ● record" legend** broke across lines key and word apart | `.chart__note { white-space: nowrap }` |
| BC5 | A reps chart's Best note repeated its own number (`11 reps` over `11 reps · 25 Oct`) | the note is only the day when nothing was added (health-cards › "measures a bodyweight exercise in reps…") |
| BC6 | The model's text after `propose_merge_exercises` said "Nothing is **deleted** yet" | `approvalResult(…, "merged")` (health.test › merging › asks first…) |
| BC7 | tooling, not product: `agent-browser find text "Approve" click` did not press the button (the match was another node); `eval` with `button.click()` did. `kill`/`pkill -f` with a pattern also matches the shell that runs it | – |

Seen working (dark, 1100 px unless said): the Health entry in the sidebar and the empty thread; 18 weight cards (delta since the last entry, 7-day average, BMI 23.4, the pounds
entry with its note); the second `log_weight` of a day refused with the reason; the weight chart (dots, average line, axes, legend, stats grid with trend per week and
BMI); the squat chart (records ringed, five latest days with PR badges); a pull-up chart in reps; **loaded dips** (0 → 12.7 → 24 kg of added weight, "6 reps +20 kg",
PR badges); the workout card with PR, "new exercise" and the note; the workout list with ids; the deletion approval card, then **`YES` typed in the composer**: the card
turns to "Approved" and "You replied YES. Deleted the workout of Mon 12 Oct 2026."; a typo exercise (`Cable crosover`) flagged "new exercise", then
`tool_search` → `propose_merge_exercises` → the **Approve button**: "Merged Cable crosover into Cable crossover: 3 sets moved." and one exercise left with the alias; the
**evening wrap-up** card with "Health today" (weighed, trained, three records) and the **morning briefing** card with the Health nudge (after the two last weighings were
deleted through approvals); a 130-day deadlift history: 90 dots, 33 rings, the latest five days, "The chart shows a selection of the days."; **390 px** (weight chart,
loaded dips, workout card; no horizontal scroll); **light mode** (`set media light`) at 390 px. No console errors. Not seen: a push to a device (the fake outbox only).

## 4. Decisions and deviations of this session (each cheap to reverse; veto points marked ★)

1. ★ **The metric is derived from the sets and never stored**, instead of promoting a kind when a load shows up. Promotion would make a ring dip or an ab wheel
   that is sometimes loaded refuse its unloaded sessions ("a weighted exercise needs a weight"). Cost: the stored kind of an exercise first logged without
   a weight stays `bodyweight`, so a cable machine that later gets 15 kg is written `3x12 +15 kg`.
2. ★ **Load first, then reps.** Once a bodyweight exercise has a loaded set, 5 reps at +10 kg beats 20 unloaded reps, and unloaded days are 0 on the line (ordered by reps, never
   records). The alternative (a score mixing both) has no number the owner can read.
3. ★ **The way out of a refused weighted exercise is its bodyweight twin by name**, in the error and in the built-in list (`Bodyweight lunge`), instead of reading `weight: 0`
   as a request. A magic zero would be a silent branch; a name is visible in the log, charts and prompt list, and progress of the loaded and the unloaded version stay apart.
4. ★ `rename_exercise` is an **everyday tool** (it destroys nothing); merging is deferred behind `tool_search` and an approval with the deletions. The Health agent's everyday list is now
   `current_time exercise_progress list_workouts log_weight log_workout rename_exercise tool_search weight_trend`.
5. ★ **A merge cannot put sets with no weight into a weighted exercise** (they would be zeros on its line); the other way is allowed. The pair is checked before the owner is asked.
6. ★ **Records are announced per session when logged and counted per day afterwards** (N4), see §1.
7. ★ `Config.health` (N10) changes the public `Config` type: anything that built a `Config` by hand needs the field (typecheck found none).
8. Small: `createDeleteActions` is now `createApprovalActions` (it also holds the merge); the Health prompt's records header names the bodyweight rule; new-exercise and refusal
   texts changed (tests updated: the old assertions of the same behaviour, not removed).

## 5. Commands run and results

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, 0 errors |
| `pnpm lint` | clean (216 files) |
| `pnpm test` (`vitest run`, serial) | **47 files, 951 tests pass** (893 at the start of the session, +58; now health 76, health-math 47, m6 9, health-cards 17) |
| `pnpm build` | ok: server bundle 418.3 kB (403.8 kB before), `next build` ok |
| Bundle smoke: `ASSISTANT_DATA_DIR=/tmp/m6-smoke ASSISTANT_READ_PATHS=/usr/share/doc ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux ASSISTANT_PORT=3005 ASSISTANT_OWNER_HEIGHT_CM=176 node apps/server/dist/main.js` | starts; applies all 18 migrations (`health/001_weight`, `002_workouts`, `003_call_ledger`); `/tool log_weight` in the Health thread: "Logged 72.4 kg … BMI 23.4 (height 176 cm)"; `lunges` without weight refused naming `Bodyweight lunge`; `cable flies` and `bodyweight lunges` logged; `rename_exercise`; `tool_search` loads `propose_merge_exercises`; a Cyrillic exercise name works (the `\p{L}` regex survives the esbuild bundle); `5000y` refused; clean SIGTERM; `/tmp/m6-smoke` removed |
| Browser check | §3; 20 screenshots in `/tmp/assistant-shots/m6/` |

## 6. Break-and-restore checks (one rule broken at a time, the five targeted test files run, the file restored and `cmp`-checked every time; harness `/tmp/m6-breaks/run.py`, since removed)

| Break | Failed (and only these kinds of tests) |
|---|---|
| B01 `metricFor` ignores added weight | 8: the whole "measured in" group (B1, B2) |
| B02 `diffKg` is a float difference | 3: the +0.2 pair, the oracle, the tool text |
| B03 `avg7` rounded to 2 decimals again | 4: 72.44/72.45, the fresh sums, the oracle, the tool text |
| B04 the trend from the rounded means | 1 (after I added the test it needed: 71.35 against 71.2); 0 before |
| B05 `thinDays` keeps every record | 3 |
| B06 `thinDays` forgets the latest days | 3 |
| B07 the refusal does not name the bodyweight version | 2 |
| B08 a replay judges against later sessions (and itself) | 9 (the replay test and every record test) |
| B09 `renameExercise` ignores its own ledger | **0**: redundant with the tool's own lookup (B10); kept as a defence |
| B10 `rename_exercise` replay lookup removed | 1 |
| B11 a merge does not renumber the moved sets | 1 (UNIQUE set number) |
| B12 a merge accepts unloaded sets into a weighted exercise | 1 |
| B13 `exerciseKey` Latin only | 3 |
| B14 no `-ies` plural | 2 |
| B15 range counts unbounded | 1 |
| B16 `log_weight` replay ledger lookup removed (T1) | 1 |
| B17 the nudge ignores today's weight (T2) | 1 |
| B18 the 4 kg warning needs more than 4 (T3) | 1 |
| B19 a renamed built-in exercise is made again from the list | 1 |
| B20 total volume from the rounded days | 1 |
| B21 the height rides in the profile again (N10) | 4 (config and the server test) |
| B22 every agent is told a height (T4) | 1 (the positive control would also catch an empty prompt) |
| B23 an unloaded day written "est. +0 kg" | 1 |
| B24 the added-weight PR badge loses its plus | 1 |
| B25 the card lists the first thinned points, not the latest days | 1 |

## 7. Could not verify

- **A real model** with the new `HEALTH_RULES`: whether it gives the added weight of a belt, asks for a forgotten weight instead of inventing one, names `Bodyweight lunge`
  after the refusal, finds `propose_merge_exercises` with `tool_search`, and quotes tool numbers as returned.
- **A push to a device** (nothing in the Health jobs sends content; only the fake outbox exists here), **the Android installed app**, **a clock change in a real zone** for
  the health dates (New York is tested with a fake clock; Thimphu has none).
- **`next start` in a browser**: the production web build compiles, but the browser check ran on `next dev`.

## 8. Known risks and gaps

- Everything of "U2" above; the rules are longer now (about 900 tokens in every Health request).
- A replayed `propose_merge_exercises` or `propose_delete_*` after the thing was already done (a crash between approval and the end of the call) answers "No exercise/workout …"
  instead of returning the request (N6's family; nothing is done twice).
- A machine exercise first logged unloaded, then loaded, is written with a plus (`+15 kg`); its progress is right.
- The estimated 1RM is still a poor estimate above about ten reps, and has no cap.
- `list_workouts` does not mark records. Weighings keep no history of their corrections. There is no aggregate over a month (N11).
- **The suite leaks a directory per run**: `daily.test.ts` ("power cut") leaves `/tmp/assistant-ext-*-backup`; 34 are there now (30 at the review; my full runs added the rest). I did not delete
  them (not mine). The cure is a test fix (remove `${f.dir}-backup` in that test), outside M6.
- Cards saved by the first M6 code (no `metric` on a workout's exercises) would draw a PR badge as reps: no such card exists outside throwaway data directories, since M6 was never run before.

## 9. Suggested scoped commits (the coordinator commits)

1. `shared: add health card types and wording` (`packages/shared/src/health.ts`, `cards.ts`, `index.ts`)
2. `extensions: add the health module: weight, workouts, trends, rename and merge` (`packages/extensions/src/health/`, `module.ts`, `index.ts`, `test/support.ts`, `test/health*.test.ts`)
3. `server: give the Health agent its tools, rules and the owner's height` (`apps/server/src/{agents,config,domain,server}.ts`, `test/{agents,config,m3,m6}.test.ts`)
4. `web: add weight, exercise and workout cards with SVG charts` (`apps/web/src/{app,components,lib}`, `apps/web/test/{chart,health-cards}.test.ts`)
5. `vitest: transform JSX for component tests` (`vitest.config.ts`)
6. `docs: add M6 handoffs, review and progress log` (`README.md`, `docs/{PLAN,design-notes}.md`, `docs/handoff-m6*.md`, `docs/review-m6*.md`, `docs/progress-m6.md`)
