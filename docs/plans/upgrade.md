# Upgrade plan

Where zimpoen goes past "four fixed agents, web only, no shell". Karma (Dorje) agreed the direction; this file turns it
into phases, rule changes and designs. Phase 1 is built on branch `zimpoen/upgrade-phase1`; later phases are design only.

Sources: `/tmp/zimpoen-vs-durable-bots.md`, `/tmp/zimpoen-cred-vault.md`, `/tmp/zimpoen-dotenvx.md`,
`/tmp/zimpoen-vs-gfteam.md`, and pi-durable-bots `0e03a80` (`telegram.ts`, `voice.ts`, `routines.ts`, `manager.ts`).

## 1. Phases and order

| Phase | What | Status |
|---|---|---|
| 1a | PA creates and deletes specialist bots | built, behind approvals |
| 1b | Telegram bridge for the PA, voice notes via local whisper.cpp | built, off until configured |
| 1c | Agent-created recurring routines (slot-keyed, at most once) | built |
| 1d | Credential broker + per-project trust levels | built, `ZIMPOEN_CRED_BROKER=off` by default |
| 1e | Web UI: Bots page (list/create/delete) and Settings → Trust levels | built |
| 2b | Broker split: separate `zimpoen-broker` process | built, then dropped: the broker stays in the server (decision below) |
| 2 | Dedicated coding VM running herdr-lead; PA hands coding work to it | design (§6); provisioning scripts in `ops/coding-vm/`, not run |
| 3 | CTO bot that drives herdr-lead; push/merge/deploy follow the project's trust level | built (§7), `ZIMPOEN_CTO=off` by default; board create command unverified |
| 4 | Sandboxed shell (gVisor container per agent, egress rules) | built, `ZIMPOEN_SHELL=off` by default (§8) |
| 5 | Computer-use VMs | design (§8); image and run script in `ops/computer-use/`, not built |

Bots (1a) and routines (1c) have no feature flag: their tools are always installed, and each creation needs the owner's approval (bots: per the PA's trust level, set in Settings or by `ZIMPOEN_PA_TRUST`).

Why this order: 1b and 1c add reach with no new attack surface beyond one chat channel. 1a needs the trust model that
1d defines, but only for its own approval step, so both ship in phase 1. 2 and 3 depend on 1d (secrets never enter the
VM) and on the trust levels. Shell and computer use carry the most risk and come last.

## 2. Hard-rule changes (docs/ARCHITECTURE.md §2)

| Rule | Today | After |
|---|---|---|
| 1 No outbound actions | No tool contacts anyone | Unchanged for agents. Two named exceptions, both to the owner only: (a) the Telegram bridge replies in the **one bound private chat**; (b) phase 2+: work handed to the owner's own herdr-lead. Outbound actions on third-party systems (push, merge, deploy) happen only through the broker, gated by trust level (§3). |
| 2 Writes are local only | app.sqlite, memory, workspace | Unchanged in phase 1. Phase 3 adds broker-run actions, which are not agent writes. |
| 3 Deletes need approval | Approve / YES, `beforeTool` hook | Generalised: **sensitive actions** need approval *as the trust level says* (§3). Deletes of owner data still always ask (they are `ask` at every level except Open, where bot deletion may run without asking but is logged). |
| 5 No shell tool | Absolute | Phase 4 (built, off by default): "no shell on the host; shell only inside a per-agent disposable sandbox". |
| 6 Inbox has no file tools | | Unchanged. A spawned bot can never get inbox tools (§4). |
| 9 Secrets never readable by an agent | | Strengthened: secrets used by actions live with the broker (separate process, phase 2 separate user), are never returned to an agent, a model, the database or the coding VM. Telegram bot token joins `<data>/secrets/`. |
| new 12 | | **Hub and spoke.** Only the PA talks to other agents (`ask_agent`). Spawned bots never talk to each other or to built-in specialists. |
| new 13 | | **Nothing self-propagating during scheduled runs.** A routine or other scheduled run can't create/delete bots, create/change routines, or start broker actions. |

## 3. Trust levels (replaces per-use approval)

```ts
type TrustLevel = "open" | "normal" | "strict";     // default "normal"; only the owner changes it (settings/API, never a tool)
type Sensitivity = "routine" | "bot_lifecycle" | "merge_main" | "deploy_prod" | "prod_data_write" | "destructive";

// one place decides; tools never decide for themselves
function decide(level: TrustLevel, s: Sensitivity): "allow" | "ask" | "deny" {
  if (level === "open")   return "allow";                 // logged, never asks
  if (level === "normal") return s === "routine" ? "allow" : "ask";
  /* strict */            return s === "routine" ? "allow" : "ask"; // plus: policy entries can mark an action "deny" under strict
}
```

- **Open:** broad, no approvals, every use logged.
- **Normal (default):** automatic within scope; asks for merge to main, production deploy, production data writes,
  bot creation/deletion (ask once per bot).
- **Strict:** set explicitly by Karma; asks for everything sensitive and allows per-action `deny`.
- Levels are per project (the broker policy names a project) and one for the PA itself (bot lifecycle).
- Asking reuses the existing approvals flow (`pending_actions`, card, YES, 24 h TTL). Even at Open the broker uses a
  credential and returns redacted output; it never returns the secret.

## 4. Phase 1a: specialist bots

- `agents` table gains bot rows; `AgentId` stays a typed union for built-ins plus `bot:<slug>` ids for spawned bots.
- PA tools: `create_bot({ slug, name, avatar, soul, tools[] })`, `delete_bot({ slug })`, `list_bots()`.
  - `soul` is written by the PA, capped (6 000 chars), stored in `bots_bot`.
  - `tools` come from a fixed allowlist: `tasks-read` (list_tasks, current_time), `documents`, `web`, `memory`,
    `codemode`. Never `inbox`, `files`, `approvals` admin, `delegate`, `bots`, `routines`, and for now no domain write
    preset (`tasks`, `health`, `ledger`, `splits`). Accepted risk: a bot with `web` reads untrusted text, but what it can
    write is only its own memory scope and the PDFs and document numbers `documents` makes.
  - Cap: 8 bots.
  - Approval follows the PA's trust level (default Normal: ask once on create and once on delete).
  - Refused during scheduled runs (rule 13).
- Hub and spoke: `ask_agent` accepts bot ids; bots get no `ask_agent`.
- Deleting a bot aborts its run and tasks, archives its conversation (kept in durable.sqlite), removes its rows, and
  clears its memory scope and weekly limit, so a later bot with the same slug starts clean.
- Built: the trust level is the owner's choice in Settings → Trust levels, else `ZIMPOEN_PA_TRUST` (open / normal / strict, default normal; strict equals normal for bots
  until a policy can deny). Durable gives a tool no request id, so rule 13 reads the conversation's placed inputs and
  parses their request ids with the one parser in `packages/extensions/src/scheduled-run.ts` (`routine:<id>:<slot>`, or
  `<daily job id>:<date>` with job ids taken from `DAILY_JOBS`). Bots and routines share it. An approval the owner gives
  while a routine runs is carried out: the owner, not the run, decided it.

## 5. Phase 1b–1d

**Telegram (1b).** Long-poll Bot API client (injectable fetch). `/start <code>` with a one-time code from the server
binds exactly one private chat; every other chat is ignored. Text goes to the PA as an owner message (request id
`tg:<update_id>`); the reply is sent back when the run ends. Voice notes: download, convert with `ffmpeg` to 16 kHz WAV,
run `whisper-cli` (whisper.cpp) with fixed argv, put only the labelled transcript in the thread. No external STT key.
Config: `ZIMPOEN_TELEGRAM=on`, token in `<data>/secrets/telegram.json`, `ZIMPOEN_WHISPER_BIN`, `ZIMPOEN_WHISPER_MODEL`.
Off by default.

**Routines (1c).** Tools `propose_routine` (approval; the server then creates it), `list_routines`, `cancel_routine` (PA, and bots that have the preset).
Schedule: daily at HH:MM, weekly on days at HH:MM, or every N hours (≥ 1 h). A run sends the routine's message as an
`ask` with request id `routine:<id>:<slot>` so one slot runs at most once across restarts. After downtime only the newest
due slot runs; a slot more than 6 h late is skipped. Same DB-authoritative timer pattern as §5.4 (gen + reconcile).
During a routine run, routine/bot/broker tools refuse (rule 13). Cap 20 active routines.
Creation goes through approval (`propose_routine`, Approve/YES), and a slot whose agent is over its weekly token limit is skipped.

**Credential broker (1d).** `ZIMPOEN_CRED_BROKER=off|inprocess` (`on` = `inprocess`), default off: no tool
registered. The broker runs inside the server (§9: the separate process was dropped). Tokens are long-lived, one per
project; no short-lived minting. It implements:

```ts
interface CredBroker {
  run(req: { project: string; credId: string; action: string; params: Record<string,string>; approvalId?: string }):
    Promise<{ exitCode: number; output: string; redacted: boolean }>;
}
```

- Policy file (owner-written, read-only to agents): projects with trust level, credentials, actions = fixed argv with
  validated `{placeholders}`, a `sensitivity` per action, output cap.
- `cred_run` tool → trust-level decision → approval if `ask` → broker executes with secret in env/stdin → output scrubbed
  (exact value, base64, URL-encoded, known token patterns) → capped.
- Audit log: append-only JSONL, no secret values.
- No `get_secret` anywhere.

## 6. Phase 2: coding VM with herdr-lead (design)

- One Linux VM (or a separate small box) on the tailnet, running herdr-lead, `hc`, pi and git. It holds **test values
  only**; egress blocks the zimpoen host's loopback, LAN and tailnet except one allowed
  endpoint (the board relay).
- zimpoen's PA gets `delegate_coding({ repo, goal, doneWhen, outOfScope })`: the server calls a fixed binary
  (`hc-board` over an authenticated relay) with argv only; idempotent by tool call id stored on the card. Reports come
  back by polling the board and post as display-only cards.
- Git push from the VM uses the project's long-lived, repo-scoped token (the broker injects it, no minting) handed to a
  host-side push step on files copied out, never into the VM.
- Built (scripts only, never run; [docs/coding-vm.md](../coding-vm.md)): `ops/coding-vm/provision.sh` (Node and pi
  pinned and checksummed; herdr, hc, hc-board and herdr-lead copied from the host by `copy-tools.sh`, because the VM
  cannot reach the host; refuses credential-shaped values), `egress.sh` (nftables: relay and DNS allowed, then the host's
  addresses, private, tailnet and link-local ranges dropped, on output and forward), a `herdr-lead` unit whose
  `ExecStartPre` refuses to start without those rules, and `host-push.sh` (bundle copied out over ssh, verified, pushed
  from a throwaway clone with the project's token on stdin; never main, never force).

## 7. Phase 3: CTO bot (design)

- A built-in specialist (not spawned) with `delegate_coding`, `board_status`, `cred_run` for the projects it is allowed.
- It plans work, opens cards on herdr-lead, reads reports, and asks the PA (hub and spoke) to tell Karma.
- Push, merge and deploy are broker actions with sensitivity `merge_main` / `deploy_prod`; the project trust level
  decides allow/ask. Branch pushes are `routine`.
- Never from a scheduled run without the trust level being Open.

**Built (phase 3, branch `zimpoen/p2-cto`):**

- `ZIMPOEN_CTO=off|on` (default off: no agent, no tool). On needs `ZIMPOEN_CTO_REPOS` (comma list, `name` or
  `owner/name`); optional `ZIMPOEN_CTO_TRUST` (default normal), `ZIMPOEN_CTO_BOARD_BIN` (default `hc-board`),
  `ZIMPOEN_CTO_HC_BIN` (default `hc`).
- Agent `cto` (`CTO_AGENT` in `apps/server/src/agents.ts`), added by `buildAgents` only when on. Extensions: `cto`
  (`delegate_coding`, `board_status`), `broker` when `ZIMPOEN_CRED_BROKER` is on (limited to the projects of its repos), `approvals`, `tool_search`. No `ask_agent`,
  memory, files or web. The PA reaches it with `ask_agent cto` (refused while off).
- The board sits behind `CodingLead { createCard, notifyLead, readCard }` (`packages/extensions/src/cto/lead.ts`); the
  server implements it in `apps/server/src/cto.ts` with `execFile` (no shell, env = `PATH`, `HOME`, `LANG`,
  `HC_BOARD_LIVE=1`). Argv: `hc-board create --key <call id> --repo --goal --done-when --out-of-scope` (card id on the last
  line), `hc send lead "New coding card <id> …"`, `hc-board show <id>`. **`hc-board create` does not exist yet** in
  herdr-lead (cards are made by the lead's extension); the contract above must be added there or the adapter changed.
- `delegate_coding` validates: repo in the allowlist, goal ≤ 2000, doneWhen/outOfScope ≤ 1000 chars, no leading `-`, no
  control characters. Rule 8: `cto_card` keyed by call id; a replay resumes (same key → same card; the lead is told at
  most once after success). Sensitivity `routine` through `decide()`.
- Rule 13: refused in a scheduled run unless `ZIMPOEN_CTO_TRUST=open`. `isScheduledRequest` now also treats an
  `ask:<call id>` input (the question in the asked agent's thread) as scheduled when the PA asked from a scheduled run,
  or when its `delegate_ask` row is missing. This also applies to bots.
- Hub and spoke for owner input: `POST /conversations/:id/messages` refuses (403) a message to the CTO's thread; a bare
  YES there still answers its approval requests. The CTO stays visible in the sidebar so its cards and approvals can be read.
- Depends on herdr-lead adding `hc-board create --key …` before `ZIMPOEN_CTO=on` is usable on a real host.
- `board_status` reads only cards the CTO opened; board text is clipped and labelled as information.
- Push/merge/deploy stay `cred_run` broker actions (unchanged): `merge_main`/`deploy_prod` ask under Normal. The approval
  card lands in the CTO's thread and stays there (not mirrored); the PA is told to relay it.

## 8. Phases 4–5 (sketch)

- **Shell (built):** `ZIMPOEN_SHELL=off|on`, default off. `shell_run` for the PA and for bots with the `shell` preset
  (default no); never the Inbox (checked per call against the agent row). Rootless Podman (default) or Docker, `--runtime=runsc`, one fresh
  container per call, the agent's named volume as the only mount, read-only root, `--cap-drop=ALL`,
  `no-new-privileges`, cpu/memory/pids limits, 60 s default (300 s max) timeout, 64 KB output cap. Refused during
  scheduled runs (rule 13). No network by default; a dedicated network needs `ops/shell-egress.sh` (blocks private,
  link-local, loopback, ULA and tailnet ranges and the host). Startup refuses without the `runsc` runtime, or, with a
  network, without the root-owned egress marker. Runner behind `ContainerRunner`, tested with a fake engine. Details:
  ARCHITECTURE §5.9. Egress stays a blocklist (no destination allowlist). Deleting a bot deletes its volume; the `shell` preset is refused while the shell is off. The egress network is for a rootful engine: with rootless Podman use `ZIMPOEN_SHELL_NETWORK=none`. Not yet run against real podman/docker, gVisor or nftables.
  `ops/shell-egress.sh` and `ZIMPOEN_SHELL_IMAGE` belong to this shell-sandbox feature; anything else that uses them
  (the coding VM, computer use) depends on it.
- **Computer use:** builds on the shell sandbox plus a desktop image, viewer/takeover in the PWA, approval per task.
  Image and host run script in `ops/computer-use/` ([docs/computer-use.md](../computer-use.md)): same gVisor flags,
  filtered network required, viewer on 127.0.0.1 only, view-only and takeover passwords per task, one desktop per
  approved task. Approval: the agent judges which actions are critical and asks; anything delete-related always needs approval, at every trust level, Open included. Tool, approval action and PWA viewer are not built. Depends on the shell-sandbox feature
  (`ops/shell-egress.sh`, `ZIMPOEN_SHELL_IMAGE`), which must land first; the network must also have inter-container
  traffic off.

## 9. What is left after phase 1

- ~~Broker as a separate systemd unit~~ built, then **dropped** (Karma's decision): credentials run in the server only, so
  there is no socket, peer check, broker user or `ops/` unit, and no systemd-creds store. Secrets are files under
  `<data>/secrets/broker/creds`. Tokens are long-lived per project.
- ~~Web UI for bots and trust levels~~: built (1e, §10).
- Real Telegram, real whisper.cpp model and real broker credentials were never used: tested against fakes.

## 10. Phase 1e: web UI for bots and trust levels (built)

- **Bots page** (`/bots`, sidebar): lists bots, creates one (name, id, emoji, instructions, presets) and deletes one
  (asks once more in the page). The owner acting directly: no approval. The server runs the same `createBot`/`deleteBot`
  as the approval actions (`createOwnerBots`), so the 8-bot cap, slug rules, 6 000-char soul and preset allowlist hold;
  owner-made rows have `approved_via = 'owner'` and a `owner:<uuid>` call id.
- **Settings → Trust levels:** the PA's level and one per broker-policy project. Stored in `trust_setting`
  (`apps/server/src/trust-settings.ts`), a server-only table no tool can write. A stored level overrides
  `ZIMPOEN_PA_TRUST` / the policy's `trust`; "Default" removes the override. Read at each tool call and at approval time.
- API: `GET|POST /api/bots`, `DELETE /api/bots/:slug`, `GET /api/settings/trust`, `PUT /api/settings/trust/pa`,
  `PUT /api/settings/trust/projects/:id` (ARCHITECTURE §5.5).
- `cred_run`'s description lists project ids without levels now: the level can change while the server runs.
- The CTO's push/merge/deploy go through the same `cred_run`, so they follow the stored project level too (the server decides).
  A trust level change also posts a display-only note in the PA's thread. `ZIMPOEN_CTO_TRUST` (the CTO's own hand-over level) is
  still env-only; not yet in Settings.
