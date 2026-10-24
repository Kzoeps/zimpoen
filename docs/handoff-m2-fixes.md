# Handoff: M2 review fixes
Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, branch `main`, M2 uncommitted in the tree (coordinator commits).
Read: `docs/handoff-m2.md` (scope + constraints apply), `docs/handoff-m2-2.md` (verified API facts), `docs/review-m2.md` (findings;
repro scripts in `/tmp/m2-review-scratch/`).

## Coordinator adjudication — fix all:
- C1: drop `remindedAt === undefined` from `isCurrentReminder`; add the durable-rewind test; fix the design-notes paragraph. Same check for approvals `notified_at`.
- C2: option (a): reminder/approval cards are display-only writes (no `model`); expose sent reminders to the model via the `tasks` prompt section derived from DB (no clock). Update the pinned test.
- C3: idempotency lookup by call id before any validation in add_task/update_task/snooze_reminder; replay test with past remind_at.
- C4: `setInterval(resume, 30s).unref()`; run `reconcile()` in the 10-min sweep; treat a row pointing at a terminal/faulted durable task as rescheduleable; ops note on disabling suspend (docs/design-notes or a docs/OPS.md stub).
- C5, C6: service worker origin check via `new URL`, null payload guard; tests with the bypass inputs.
- C7: per-row catch in reconcile/recover, log remedy, continue.
- U1, U2 and nits: fix per the review's suggested fixes where each is < ~15 min; defer others with reason in the report.
Optional cheap item: move credentials.ts onto writeFileAtomic.

## Done when
Gates green (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`); report appended to `docs/progress-m2.md` (item → fixed/deferred, test name);
nothing listening on 3000–3009; reply DONE-FIXES. Context hygiene: at ~55% write `docs/handoff-m2-fixes-2.md`, reply DONE-HANDOFF, stop.
Constraints as in handoff-m2.md (no commits, no network to OpenAI/Google/TypeSafe/push services, no logins).
