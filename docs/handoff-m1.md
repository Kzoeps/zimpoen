# Handoff: Milestone 1 — Foundation

You are the implementation worker. The coordinator (another agent) is the technical lead; the user is AFK.

## Read first

1. `docs/PLAN.md` in this repo — the approved architecture. Sections 2 (hard rules), 4, 5, 6, 7 and the M1 row in §8.
2. Durable reference source (read-only, do not modify): `/home/kzoeps/Projects/personal/pi/packages/durable`
   — `README.md`, `docs/spec.md` (normative), `test/examples/*.ts` (13, 16, 18, 19, 20, 22, 25, 26 are most relevant).
   Also `/home/kzoeps/Projects/personal/pi/packages/ai/README.md` (providers, faux provider, OAuth, CredentialStore).
   Verify every Durable/pi-ai API you use against this source or the installed package types. Do not guess signatures.

## Checkout

- Repo: `/home/kzoeps/Projects/personal/assistant`, branch `scaffold/pa-foundation` (already created; no commits yet).
- `docs/PLAN.md` and this file exist untracked. Do not edit PLAN.md except to fix factual API details you verified
  (note any such edits in your report).

## Objective (M1)

Build the foundation so that, in **dev mode with the pi-ai faux provider**, a user can open the web UI, pick an agent
in the sidebar, chat, and see the answer stream in; the server survives restart mid-run and resumes.

### In scope

1. pnpm workspace: `apps/server`, `apps/web`, `packages/shared`, `packages/db`, `packages/extensions`.
   Root scripts: `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint` (pick a light linter, e.g. Biome).
   Pin `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord` to exactly `1.4.0` from npm.
   TypeScript strict, ESM. Node 24 (installed: v24.22.0). pnpm 10.
2. `packages/db`: open `app.sqlite` with `node:sqlite` (WAL), migration runner (`_migrations` table, ordered,
   idempotent, each in a transaction), tiny typed helpers. Core migration: `agents` table (PLAN §7).
3. `apps/server` config: data dir (default `./data`, env `ASSISTANT_DATA_DIR`), allowlisted read paths (absolute,
   default `/home/kzoeps/Documents`, `/home/kzoeps/Downloads`, plus `<data>/files`), write path `<data>/workspace`,
   owner Tailscale login (env), timezone (default `Asia/Thimphu`), model mode `faux | openai` (env, default faux in dev).
   Validate at startup; fail with a clear actionable message (which path, why, what to do). Create data subdirs.
   `<data>/secrets` created with mode 0700.
4. Harness: `openNodeSqliteStorage(<data>/durable.sqlite)`, registry, `models` (faux in dev with a scripted streaming
   reply that echoes so streaming is visible; `openai` provider wired with a file-backed `CredentialStore` in
   `<data>/secrets/credentials.json` mode 0600 — implement the store per pi-ai README contract; do NOT perform any
   login or network call). `harness.resume()` on start. Graceful shutdown on SIGINT/SIGTERM (`harness.close`).
5. Agents: `AGENTS` definitions for `pa`, `inbox`, `health`, `accountant` (PLAN §1, §5.1) with names, avatars
   (emoji ok), default model + thinking, instructions (short, sensible). `ensureAgents` idempotently creates one
   conversation per agent and records it in `agents`. In M1 agents only get a `profile` extension (a system prompt
   section with timezone/currency/owner name placeholder from config). No other tools yet.
6. Scoped execution environment factory implementing PLAN rule 4 (allowlist read, workspace write, deny globs),
   unit-tested, even though no file tools are installed yet in M1. No bash tool anywhere.
7. HTTP API (PLAN §5.5) for M1: `GET /api/agents`, `GET /api/conversations/:id/messages`,
   `POST /api/conversations/:id/messages` (requestId required, client-generated; dedupe via Durable requestId),
   `POST /api/conversations/:id/abort`, `GET /api/conversations/:id/stream` (SSE). Bind 127.0.0.1, port 3001.
   Use a small framework (Hono with @hono/node-server recommended) or node:http. Auth middleware per PLAN §5.5
   (Tailscale-User-Login must equal configured owner; disabled when `ASSISTANT_AUTH=off` for dev). Validate inputs;
   errors are JSON `{ error: { code, message } }` with actionable messages.
8. `apps/server/src/stream.ts`: the ONLY module touching `watchEvents` (experimental). Snapshot first, forward event
   batches, 15s heartbeat, stop watch on client disconnect. Event + snapshot types re-exported/defined in
   `packages/shared` so web is type-checked against them.
9. `apps/web`: Next.js App Router + `@assistant-ui/react` with `useExternalStoreRuntime` (NO Vercel AI SDK).
   zustand store fed by `EventSource`; adapter `applyEvent(state, event)` (pure, unit-tested) → messages →
   `convertMessage`. Sidebar of agents (avatar, name, busy dot), one thread per agent, composer with send + stop.
   Next dev server proxies `/api/*` to `127.0.0.1:3001` (rewrites) so the browser uses one origin. Clean, readable
   UI; no need for polish beyond a solid ChatGPT-like layout. Mobile-friendly layout (Android is primary).
10. Tests (vitest): migration runner; config validation; scoped env allowlist/deny; ensureAgents idempotency;
    an integration test that opens a Harness on a temp sqlite with faux provider, submits via the API layer, and
    observes the answer through the stream module; a restart test (close mid-run, reopen, run completes or settles —
    follow Durable semantics, document what you observe); web adapter `applyEvent` tests from recorded event fixtures.
11. `README.md` at repo root: what it is, layout, dev quickstart (`pnpm i`, `pnpm dev`), env vars, data dir layout,
    security rules summary linking PLAN.md. `.gitignore` must exclude `data/`, `node_modules`, `.next`, `dist`, env files.

### Out of scope for M1 (do not build)

Tasks/reminders, push notifications, approvals, memory, files tools, Gmail/Calendar/Jev, health/accountant tools,
PWA/service worker, systemd/tailscale config, OAuth login flow execution, backups.

## Constraints

- Treat the coordinator's explicit handoff as the approved scope. Make routine implementation or review decisions
  within that scope without pausing to reconfirm them with the user. If information is missing or a decision exceeds
  scope, ask the coordinator. Still stop for required approval before destructive, external, irreversible, or
  otherwise restricted actions. Do not interpret this handoff as approval for a commit, push, deployment, migration,
  or external API call.
- Allowed: `pnpm install`/`pnpm add` from the npm registry, running local builds/tests/dev servers on 127.0.0.1.
- Not allowed: git commit/push, any call to OpenAI/Google/TypeSafe or any login, editing files outside this repo,
  deleting files you did not create, `railway` CLI.
- Follow the repo-agnostic norms: focused functions, comments only for non-obvious decisions, actionable errors.
- If a Durable API differs from PLAN.md assumptions, follow the real API and record the difference in your report.
- If something in the plan is genuinely wrong or blocked, stop and explain to the coordinator instead of inventing a
  large workaround.

## First milestone (report back when done, then continue)

Workspace skeleton + `packages/db` with migrations + config validation + tests passing. Write a 5-line status to
`docs/progress-m1.md` (append) at each milestone, then continue without waiting.

## Final report (append to `docs/progress-m1.md` and print in chat)

Changed files/dirs, technical decisions and deviations from PLAN (with reasons), exact commands run and results
(`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, a manual dev-mode smoke test via curl of the API + SSE),
what you could not verify, known risks.
