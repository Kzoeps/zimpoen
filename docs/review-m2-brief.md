# Review brief: M2 (read-only)
Independent reviewer; you advise the coordinator. Repo `/home/kzoeps/Projects/personal/assistant` on `main`.
Base = `HEAD` (M1 commits). Review `git diff HEAD` AND all untracked files (`git status --short`), excluding node_modules/.next/dist/data*.
Scope/rules: `docs/handoff-m2.md`, `docs/PLAN.md` §2 hard rules, `docs/design-notes.md`; claims in `docs/progress-m2.md`, `docs/handoff-m2-2.md`.
Durable source: `/home/kzoeps/Projects/personal/pi/packages/durable` (installed 1.4.0 in node_modules is authoritative).
Rules: no edits, installs, formatting, git mutation, network, logins, or long-lived servers. You may run pnpm typecheck/lint/test.
Focus: reminder correctness (fires once per occurrence across crash/restart, snooze/complete/delete cancellation, reconcile()
between app.sqlite and Durable, clock/timezone handling), zero-token write path, tool idempotency (rule 8), approvals (hook truly
blocks destructive tools; YES handling cannot be triggered by model or by other text; expiry; executes once), Web Push (VAPID key
perms, minimal payload, 404/410 cleanup, no sensitive text), service worker scope/security, new endpoints' auth/Host/CSRF guards,
parked-task retry endpoint, migration namespacing, web rendering of cards, test quality.
Output: `/tmp/assistant-review-m2.md`; each finding severity (blocker/should-fix/nit), file:line, evidence, mechanism/repro, fix.
Separate confirmed bugs from unverified risks. Concise. Reply with the path when done.
