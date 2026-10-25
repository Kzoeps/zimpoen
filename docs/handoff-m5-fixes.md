# Handoff: M5 review fixes
Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, `main`, M5 uncommitted (coordinator commits).
Read: `docs/handoff-m5.md` (scope; constraints from `docs/handoff-m2.md`; no Google/TypeSafe/OpenAI calls), `docs/progress-m5.md`, `docs/review-m5.md`.
## Coordinator adjudication
- A1: a persistently failing message must not wedge sync: per-message attempt count, skip + record after N tries, surface in UI; test with probe s01.
- A2: an empty digest posts the zero-token card and sends NO push.
- B1: `mark_triage` from the model affects only that message; turning it into a lasting sender/domain rule needs owner confirmation
  (approval card) — or is only possible from the Settings UI. Pick the approval-card route.
- B2: setup-google.md: explain Testing-mode 7-day refresh-token expiry; recommend switching the consent screen to "In production"
  (unverified, personal use, owner is the only user) to avoid weekly re-auth; mark as "verify on first setup". Reconnect flow documented.
- B3: circuit breaker for Jev (after N consecutive failures/timeouts → rules mode for a cool-down, UI badge shows it), bounded total time per sync.
- B4, B5: accepted as built. Add: pending suggestions expire after 7 days.
- Doc-claims table in the review: make each claim true or fix the doc.
- Nits: fix where < ~15 min.
## Done when
Gates green; report appended to progress-m5.md; servers stopped; reply DONE-FIXES. ~55% → handoff-m5-fixes-2.md, DONE-HANDOFF.
