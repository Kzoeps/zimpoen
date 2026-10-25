# Handoff: M3 review fixes + product adjustments
Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, `main`, M3 uncommitted in the tree (coordinator commits).
Read: `docs/handoff-m3.md` (scope; constraints section of `docs/handoff-m2.md` applies), `docs/progress-m3.md`, `docs/review-m3.md`
(repros in `/tmp/m3-review-scratch/`), `docs/design-notes.md`.

## Coordinator adjudication — do all:
- B1: recover unanswered birthday evening questions (asked in last 24h) at start, idempotently, card built from `asked_year`;
  add `reminded_year` so the morning card can be recovered too; rewind test; fix PLAN/design-notes sentence.
- B2: birthday requestIds include the occurrence date; test for same-year date correction.
- B3: any non-approval post from a module closes the YES window; test.
- D1: (a) re-ask an unanswered follow-up question once, next morning 09:00 local (card + push), then stop;
  (b) commitments get a nudge card + push at `eventAt`; (c) date-only follow-up times default to 10:00 local (configurable),
  told to the model in the tool result. Add "open asked follow-ups" to the M4 briefing note in PLAN.
- D2: `update_followup` tool (title/time/counterpart; gen bump; agenda points kept).
- Birthday: an explicit "not yet" (`record_wish wished=false`) does NOT suppress the evening check; only wished=true does.
- PA tool load: mark rarely used tools `deferred: true` and install Durable's `tool_search` extension (`@earendil-works/pi-durable/tool-search`,
  README "Who may call a tool"). Keep always-on: add_task, list_tasks, complete_task, snooze_reminder, add_followup, add_agenda_point,
  record_outcome, add_person, record_wish. Verify the faux dev model `/tool` path still works for deferred tools (document if it needs tool_search first).
- Nits N1–N13 and U1–U7: fix where each is < ~15 min, else defer with reason.

## Done when
Gates green; report appended to `docs/progress-m3.md` (item → fixed/deferred + test); servers stopped; reply DONE-FIXES.
Context hygiene at ~55% → `docs/handoff-m3-fixes-2.md`, reply DONE-HANDOFF.
