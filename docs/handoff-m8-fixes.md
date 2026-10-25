# Handoff: M8 review fixes (final)
Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, `main`, M8 uncommitted (coordinator commits).
Read: `docs/handoff-m8.md` (scope; constraints from `docs/handoff-m2.md`), `docs/progress-m8.md`, `docs/review-m8.md`.
## Coordinator adjudication
- S1: agents may NOT write shared preferences. `remember` with kind=preference from a model creates a pending approval card (owner
  confirms) and records provenance (agent, conversation, time); owner UI edits stay direct. Facts stay per-agent scope unless owner moves them.
- S2–S6, T1, T2: fix per the review. For SETUP.md walk every step again after fixing; each command must be runnable as written.
- Report why 2 tests are skipped in the suite; unskip if they can run, otherwise document the reason in the test.
- Nits/U-items: fix where < ~15 min; else defer with reason.
## Done when
Gates green; report appended to progress-m8.md; servers stopped; reply DONE-FIXES. ~55% → handoff-m8-fixes-2.md, DONE-HANDOFF.
