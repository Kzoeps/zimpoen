# Review brief: Milestone 1 (read-only)

You are an independent reviewer. You advise the coordinator; you do not direct or edit.

## Inputs
- Repo `/home/kzoeps/Projects/personal/assistant`, branch `scaffold/pa-foundation`, **no commits: every file is untracked**.
  Review the whole tree (excluding node_modules, .next, dist, data).
- Scope and rules: `docs/PLAN.md` (esp. §2 hard rules, §5, §7), `docs/handoff-m1.md` (M1 scope),
  `docs/handoff-m1-web.md` and `docs/progress-m1.md` (worker's claims).
- Durable reference source: `/home/kzoeps/Projects/personal/pi/packages/durable` (README, docs/spec.md, examples).

## Rules
- Do NOT edit, create, format, install, or run git-mutating commands. No network calls besides none. No logins.
- You MAY run `pnpm typecheck`, `pnpm lint`, `pnpm test` and read files. Do not start long-lived dev servers.

## Review method
1. Security rules (PLAN §2): file allowlist/deny enforcement (path traversal, symlinks, `..`, absolute paths, case),
   no bash/shell, secrets perms (0700 dir, 0600 credential file, atomic writes), 127.0.0.1 binding, auth middleware
   (Tailscale-User-Login, `ASSISTANT_AUTH=off` cannot be enabled accidentally in production), error leakage.
2. Durable correctness: API usage matches source; requestId dedupe; restart/resume semantics; ensureAgents idempotency
   and that it never overwrites user-chosen model/thinking; stream.ts is the only watchEvents user; watch cleanup on
   disconnect (leaks); heartbeat; shutdown closes harness.
3. Data layer: migration runner atomicity/ordering, WAL, transactions.
4. API: input validation, error shape `{error:{code,message}}`, actionable messages, history paging correctness.
5. Web: applyEvent reducer correctness vs real events, EventSource reconnect/backoff, duplicate messages on reconnect,
   send idempotency (requestId reused on retry?), stop button, agent switching cleanup.
6. Tests: do they test behavior (not implementation)? Missing coverage of real risks?
7. Scope creep or violations of the handoff.

## Output
Write findings to `/tmp/assistant-review-m1.md` and reply with that path. For each finding: severity
(blocker / should-fix / nit), file:line, evidence, shortest mechanism or repro, suggested fix. Separate **confirmed bugs**
from **unverified risks**. Also list gate results you ran. Be concise; skip praise.
