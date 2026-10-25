# Handoff: M6 review fixes + finish
Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, `main`, M6 uncommitted (coordinator commits).
Read: `docs/handoff-m6.md` (scope; constraints from `docs/handoff-m2.md`), `docs/handoff-m6-2.md`, `docs/progress-m6.md`, `docs/review-m6.md`.

## Coordinator adjudication
- Fix B1–B3 per the review (exercise kind must be able to change/infer from loaded sets; added weight on bodyweight
  exercises tracked as progress; catalog weighted names loggable without load with a clear path).
- Tests T1–T4: add. Nits N1–N12 / U-items: fix where each < ~15 min, else defer with reason.
- Veto points progress-m6 §4: 1–6 and 8 ACCEPTED. #7 OVERRIDDEN: add `rename_exercise` (rename + add alias) and
  `merge_exercises(from, into)` (moves sets, keeps aliases; merge is destructive → approval via propose_ pattern).
- Finish the skipped work: browser check via agent-browser with dev `/tool` commands, screenshots `/tmp/assistant-shots/m6/`
  (weight chart, exercise progress, workout card, 390 px); production bundle smoke; final report in `docs/progress-m6.md`.
## Done when
Gates green; report (item → fixed/deferred + test); servers stopped; reply DONE-FIXES. ~55% context → handoff-m6-fixes-2.md, DONE-HANDOFF.
