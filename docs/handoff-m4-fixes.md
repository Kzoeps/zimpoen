# Handoff: M4 review fixes
Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, `main`, M4 uncommitted (coordinator commits).
Read: `docs/handoff-m4.md` (scope; constraints from `docs/handoff-m2.md`), `docs/handoff-m4-2.md`, `docs/progress-m4.md`, `docs/review-m4.md`.

## Coordinator adjudication
- Fix B1–B7 per the review's suggested fixes (B7: rule line in PA_FILE_RULES + read_file description; section shows only id/name/mime).
- B3: strip image bytes from snapshot/history wire (send a placeholder with file id; UI can fetch via /api/files/:id), keep model context intact.
- Nits N1–N14 and U-items: fix where each < ~15 min; else defer with reason. U1: add a minimal `fetch` listener to sw.js (pass-through)
  for installability, and document the Sec-Fetch-Site/Serve assumptions in SETUP-to-verify list in docs/OPS.md.
- Worker veto points: all ACCEPTED as-is (proxy limit, capture page, chip, log line).
- Also add the missing M3 CSS (.task__body, .card--task).
## Done when
Gates green; report appended to docs/progress-m4.md (item → fixed/deferred + test); servers stopped; reply DONE-FIXES.
Context hygiene ~55% → docs/handoff-m4-fixes-2.md, DONE-HANDOFF.
