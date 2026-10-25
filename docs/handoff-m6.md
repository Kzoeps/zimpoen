# Handoff: M6 — Health agent

Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, `main` (M1–M4 committed). Coordinator commits; you don't.
Read: `docs/PLAN.md` (§1 agents, §2 rules, §5.2, §7), `docs/design-notes.md`, `docs/progress-m4.md` (daily facts provider interface,
latest state), `docs/handoff-m2-2.md` §3 (Durable API facts). Constraints: as in `docs/handoff-m2.md`.

## User intent
Log weight every day and track the trend; log gym work (exercise, sets, reps, weight lifted) and see progress ("how much am I picking up").
Talk to a dedicated **Health** agent (already exists as a conversation with only the profile extension).

## Scope
1. **health module** (domain module, attached to the `health` agent only): tables `health_weight(id, measured_on date local, kg, note,
   source_call_id UNIQUE, created_at)` (allow one per day by default; a second same-day entry updates with an explicit flag),
   `health_exercise(id, name, aliases, kind)`, `health_session(id, date, note)`, `health_set(id, session_id, exercise_id, set_no, reps,
   kg, rpe?, source_call_id UNIQUE)`. Units: kg default; accept lb input and convert (store kg). Profile height optional for BMI (skip if absent).
2. Tools: `log_weight`, `log_workout` (one call with multiple exercises/sets; exercise name normalised to canonical + aliases, e.g.
   "bench" → "Bench press"; unknown → create with confirmation text in result), `weight_trend(range)` (7-day moving average, change over
   range, min/max — computed in code), `exercise_progress(exercise, range)` (top set, estimated 1RM by Epley, volume per session, PRs —
   code), `list_workouts(range)`, `propose_delete_*` (approval). Results carry `details` chart payloads (typed in packages/shared).
3. Prompt section (no clock, cache-friendly): latest weight + 7-day average, last workout date, current PRs top 5.
4. Daily facts provider (from M4) for the wrap-up: "weighed 72.4 kg, trained: squat 5x5 100 kg".
   Morning briefing: optional nudge line "no weight logged yesterday" (code-derived).
5. Health agent instructions: concise, encouraging but factual; never give medical advice beyond general; arithmetic only from tools.
6. Web: chart cards (weight line with moving average; exercise progress) — lightweight SVG component, no heavy chart lib unless tiny;
   workout summary card. 390 px friendly.
7. Fix the flaky M1 test reported last round: `agents.test` "a crashed start created…" compare as sorted sets (listAgentRows order ties).
8. Tests: unit conversions, alias normalisation, trend/1RM/PR math, idempotent replays, same-day weight rule, facts provider output,
   chart payload shapes, web chart renders.
9. Docs: README, design-notes, PLAN deviations, `docs/progress-m6.md`. Browser check (dev `/tool` commands) screenshots `/tmp/assistant-shots/m6/`.

## Done when
Gates green, report appended, servers stopped, reply DONE-M6. Context hygiene ~55% → `docs/handoff-m6-2.md`, DONE-HANDOFF.
