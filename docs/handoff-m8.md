# Handoff: M8 + Ops — memory/profile, activity log, usage & budget guard, deployment

Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, `main` (M1–M7 committed). Coordinator commits; you don't. This is the last
milestone. Read: `docs/PLAN.md` (§2, §3, §7 memory_fact, §8 M8 + Ops rows), `docs/design-notes.md`, `docs/OPS.md`, `docs/SETUP.md`,
`docs/progress-m5.md` (latest patterns). Constraints: as in `docs/handoff-m2.md` (no OpenAI/Google/TypeSafe calls, no logins, no sudo,
do not install system services — only write the files).

## Scope
### M8
1. **Memory** (PLAN §7 `memory_fact` + FTS5): scopes `shared` and per agent; kinds `preference` (only when the owner explicitly asks —
   "remember that I like…") and `fact`. Tools for every agent (own scope + shared read): `remember(text, kind, scope?)`,
   `recall(query)`, `forget(id)` (approval). Prompt section per agent: shared preferences + that agent's pinned/recent facts, bounded
   (~600 tokens), cache-friendly. Instruction lines: preferences only on explicit request; facts that belong in domain tables (money,
   weight, tasks…) go through the domain tools, not memory.
2. **Profile page** (web): owner name, timezone, currency, height, preferred tone/explanations (stored as shared preferences), people list
   link; edit memory facts per scope (list, search, edit text, delete — owner UI edits need no approval).
3. **Activity log**: page listing what agents did (from Durable task records / tool calls + app tables): time, agent, tool, short
   summary, link to the conversation; filters by agent/date. Read-only; derive from existing data (no new write paths except an index
   table if needed).
4. **Usage dashboard + budget guard**: per agent and model tokens/cost from Durable `pi.usage` (README "Usage and Cost"); per-day and
   per-week view. Budget guard: owner sets a weekly soft limit (tokens) per agent; when exceeded, background/scheduled model work (digests,
   briefing model run, wrap-up model run) degrades to the zero-token card variant and the UI shows a banner; owner-typed messages still
   go through. Implemented as a check in the schedule engine/daily jobs, not a hook on every request.
### Ops (files only)
5. `ops/systemd/assistant-server.service`, `assistant-web.service` (User= placeholder with comment, WorkingDirectory, Environment
   file `ops/assistant.env.example`, Restart=on-failure, hardening options that don't break file reads of allowlisted dirs, NODE_ENV=production).
6. `ops/tailscale-serve.sh`: idempotent `tailscale serve` config for web at / and api at /api (or per README routing), prints the URL,
   reminds to set ASSISTANT_PUBLIC_HOST; turns Funnel off for those ports. `ops/check.sh`: health check script (ports, lock, data dir perms,
   secrets perms, credentials present, VAPID present, Google accounts status, Jev mode) → clear pass/fail lines.
7. `pnpm login:openai`: CLI using pi-ai's OAuth login for the `openai` provider (Sign in with ChatGPT), writing to the server's file
   credential store; prints instructions; must not run in tests (test with a fake provider auth). Also `pnpm logout:openai`.
8. Finalise `docs/SETUP.md` as THE ordered checklist (laptop prep incl. no-suspend, Node/pnpm, clone, build, env file, OpenAI login,
   VAPID/push subject, Tailscale serve + public host, systemd install commands, Google, Jev, invoice template, phone PWA install + push
   enable + share target), each with exact command and how to verify. README points to it.
9. Tests: memory scopes/approval/FTS, budget guard degrade path, activity log derivation, login CLI with fake auth, check.sh shellcheck-clean
   (if shellcheck available) and a dry-run mode.
10. Docs/report: `docs/progress-m8.md`; PLAN updated to "all milestones built" with a known-unverified list.

## Done when
Gates green; browser check screenshots `/tmp/assistant-shots/m8/`; report; servers stopped; reply DONE-M8. ~55% → `docs/handoff-m8-2.md`, DONE-HANDOFF.
