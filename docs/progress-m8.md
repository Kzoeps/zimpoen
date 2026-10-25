# M8 + Ops progress log (worker → coordinator)

Scope: `docs/handoff-m8.md`. Worker 1 built the memory, usage, activity, owner API, login CLIs, ops files, the web pages and `SETUP.md`
(`docs/handoff-m8-2.md` has its state, designs and the verified facts); worker 2 (this report) did the browser check, fixed what it found,
finished the docs and ran the gates. **M8 and Ops are complete: all milestones are built.**
Branch `main`, nothing committed or pushed (the coordinator commits). No OpenAI, Google or TypeSafe call, no real push service, no login,
no `sudo`, no `railway`, no system service installed (the files in `ops/` are only written). **Every server I started is stopped, nothing
listens on 3000–3099**, the throwaway data directories are removed.

## 1. State

| Scope item | State |
| --- | --- |
| 1 memory: `memory_fact` + FTS5, scopes `shared` and per agent, kinds `preference`/`fact`, `remember`/`recall`/`forget`, a bounded prompt section, instruction lines | done, tested; **seen in a browser** (cards, the approval flow) |
| 2 Profile page: the two preferences, the memory editor (tabs with counts, search, edit, pin, delete with an in-page confirmation), the people list | done; **seen in a browser**, one defect found and fixed (BC-1) |
| 3 Activity log: derived from the threads, filters by agent and day, "Load more", link to the conversation | done; **seen in a browser**; one summary improvement (BC-3) |
| 4 Usage dashboard + weekly limit + guard in the daily jobs + banner + the plain card | done; **seen in a browser**: the limit set from the page, the banner on every page, a real degraded briefing card posted by the schedule engine |
| 5 `ops/systemd/*.service`, `ops/assistant.env.example` | done (`systemd-analyze verify` is silent); **not run as services** (nothing is installed) |
| 6 `ops/tailscale-serve.sh`, `ops/check.sh` | done; dry runs and real temporary directories in tests (shellcheck is not installed here: its two tests are `skipIf`) |
| 7 `pnpm login:openai` / `logout:openai` | done; **only against a fake provider** |
| 8 `docs/SETUP.md` (14 ordered steps), README | done (README finished this session: status, the paragraph on memory/usage, the `/tool` examples, layout, data directory, routes) |
| 9 tests | server, extension and web-markup tests; +1 this session (the activity summary); mutation check in §4 |
| 10 PLAN "all milestones built" + known-unverified list, design-notes, OPS.md, this report | done |

## 2. Commands run and results (serial, on the final tree)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | 5 packages, 0 errors |
| `pnpm lint` (`biome check .`) | clean (341 files) |
| `pnpm test` | **72 files, 1,604 tests pass, 2 skipped** (the two shellcheck tests: shellcheck is not installed). Before M8: 66 files / 1,489 |
| `pnpm build` | web builds (`/profile`, `/activity`, `/usage` listed) and the server bundle (`dist/main.js` 938.5 kB) |
| Bundle smoke: `ASSISTANT_DATA_DIR=/tmp/m8-smoke ASSISTANT_READ_PATHS=/usr/share/doc ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux ASSISTANT_PORT=3005 node apps/server/dist/main.js` | starts; applies `memory/001_facts` and `usage/001_ledger` with the others; `GET /api/agents`, `/api/usage` and `/api/memory` answer; SIGTERM closes it cleanly; the directory is removed |

## 3. What the browser check found (agent-browser, dark and light, 1100 and 390 px; screenshots in `/tmp/assistant-shots/m8/`)

Method: `pnpm dev` (faux model, fake Google, throwaway data directory), the agents driven by `POST …/messages` with `/tool` (the dev model only echoes a tool's result:
nothing here shows a real model deciding to remember), the pages driven with real clicks. Clean, 0 sideways scroll (`scrollWidth` = 390) on `/profile`, `/activity`, `/usage`,
`/chat/pa`, `/chat/health` and `/settings` at 390 px, with the banner showing; no card is wider than the screen.

| # | What | Verdict |
| --- | --- | --- |
| BC-1 | **Defect, fixed.** Editing or deleting the *tone* or *explanations* line in the memory list left the "How you like it" fields showing the old text (the server had cleared it): the form copied the profile once. | `ProfileView` reloads the profile after any change in the list and `PreferencesCard` follows what is stored (an effect on the two stored values, so unsaved typing survives unless they change). Verified in the browser (tone edited in the list → the field changed; typing in the other field kept). No unit test: the web package has no DOM test environment; the pure parts are covered in `owner-pages.test.ts` |
| BC-2 | An empty search after a search seemed to leave "Nothing matches that search". | Not a defect: `agent-browser fill ""` does not fire the input event, so the page's state kept the old word. Typing a character and pressing Backspace then Enter shows "Nothing is remembered for the inbox agent." |
| BC-3 | Activity showed `1 line matches:` for a `recall`: the first line of a result that only introduces a list says nothing. | Fixed in `activity.ts` (`summaryOf`): a first line that ends in `:` is joined with the line under it (`1 line matches: m_… [fact, yours] Deadlift day…`), still cut at 160 characters; one test added (`m8.test.ts`) |
| BC-4 | The `recall` card was headed "Remembered: “deadlift”", which reads as if something was saved. | Now "Recalled: “deadlift”" (`memory/tools.ts`; the web test's sample card follows) |
| BC-5 | The limit box's placeholder `no limit — try 500k or 2m` was cut at 390 px (`…or 2r`). | Now `no limit (e.g. 500k)` |
| BC-6 | Not defects, left as they are, for the coordinator: (a) on a phone the agent strip scrolls sideways (1,014 px wide at 390) and Profile, Activity, Usage and Settings are at its right end, reached by swiping; (b) the activity filters are three stacked rows on a desktop; (c) a degraded briefing's folded list is still labelled "What the assistant looked at" though it is the whole content (it is open by default); (d) Shared (n) counts the two profile lines, which also show in the list as "Preferred tone: …" | decisions for the owner |

Seen working, as the handoff asked: preferences saved ("Saved. Every agent is told from its next message."); memory edit, pin/unpin, delete with "Delete this line for good? / Keep it", search (FTS: `coffee` finds
"Black coffee, no sugar"), empty states, tab counts; the people list (two people with a birthday); a `remember` card ("Remembered · Fact for the health agent … Read, edit or delete it on the profile page") and a `recall` card; `forget` →
tool_search → an approval card → Approve → the line is gone and "Forgot “…”." is posted; the activity log (70 items from the four threads, 50 first, then "Load more" for the other 20 and the button is gone; the agent filter; a future
`from` date → "Nothing in this range."; the API refuses `from=garbage` with a 400 that names the parameter); usage (per-agent cards, the 14-day bars, per-model list, a limit saved as `500k` → "of 500,000", `abc` refused with a message,
a limit of `100k` on the Assistant past 1.8M → the red bar, the "Limit reached" line and the banner on Usage, Activity, Profile, Settings and chat); **a degraded briefing**: the schedule moved two minutes ahead on the over-limit PA, and at
the time the PA's thread got a "Morning briefing" card saying "Plain version: this agent has used its weekly token limit (1,778,929 of 100,000), so no model wrote this", with the two tasks due today and the inbox lines, and the activity
log lists it as "Morning briefing for Sun 25 Oct 2026 (plain card: the weekly token limit was reached)".
One screenshot taken straight after setting a scroll position showed the previous frame (a stale frame, not a layout bug: the geometry query agreed with the next screenshot).

## 4. Break-and-restore (one rule broken at a time, the targeted tests run, the file restored and `sha256`-checked)

| Mutation | Failing tests |
| --- | --- |
| `daily/run.ts` `withBudget`: the guard never trips | 4: the briefing as a plain card, the wrap-up as a plain card that still opens the journal day, the decision kept after a crash (`usage.test.ts`), and the whole-server briefing (`m8.test.ts`) |
| `usage/service.ts`: the first reading dates what was spent before to today | 1: "copies what was spent before the first look without dating it…" |
| `activity.ts`: the `from` day starts at UTC midnight, not the owner's | 1: "keeps to the days asked for, by the owner's calendar and not UTC…" |
| `domain.ts`: the Inbox gets `remember`/`forget` (`inboxExtensions: [inbox, memory]`) | 2: `m8.test.ts` (only the PA writes) and `m5.test.ts` (the Inbox's tool list) |

Every file was restored byte for byte (the script compares `sha256` before and after) and the full suite was run again after (§2).

## 5. Changed files (this session; the whole M8 tree is in `git status`)

Code: `apps/web/src/components/profile-view.tsx` (BC-1), `apps/web/src/components/usage-view.tsx` (BC-5), `apps/server/src/activity.ts` (BC-3), `packages/extensions/src/memory/tools.ts` (BC-4).
Tests: `apps/server/test/m8.test.ts` (+1), `apps/web/test/owner-pages.test.ts` (the sample heading).
Docs: `README.md`, `docs/PLAN.md` (status, §5.5 routes, §7 memory and usage tables as built, §8 rows, §9 the known-unverified list), `docs/design-notes.md` (Memory, Usage and the weekly limit, Activity, Deployment files),
`docs/OPS.md` (the services, the health check, Tailscale Serve, what to do when…), this file. `docs/SETUP.md` was written by worker 1 and read against the scripts and units: its commands, option names and `check.sh` skip groups match.

## 6. Decisions

Worker 1's nine (★ = for the coordinator to veto; each is cheap to reverse) are in `docs/handoff-m8-2.md` §3 and now in `docs/design-notes.md`: ★ the Inbox reads memory and never writes it; `forget` proposes and `delete_memory` is guarded;
★ "preferences only on request" is a prompt rule; the prompt section is bounded to about 600 tokens and contains no clock or ids; ★ the budget unit is the provider's `totalTokens` (cache reads included), the week is Monday to Sunday
in the owner's zone; usage is sampled, not hooked; the guard is once per daily run and never on what the owner types; the activity log is derived from the transcripts; the profile's name, zone, currency and height are display-only.
This session's: the recall card says "Recalled"; a heading line in an activity summary brings the next line with it; the profile page re-reads the profile after a list change; nothing else was changed in worker 1's design.

## 7. Could not verify (nothing here could run offline; `docs/PLAN.md` §9 has the same list)

- the `tailscale serve` and `tailscale funnel` flags (Tailscale 1.52+), and that Serve and https certificates work on the owner's plan;
- the systemd units on a real machine: the hardening options against a real Node/Next start, and `ReadWritePaths=` with a data directory under `/home`;
- `pnpm login:openai` against the real ChatGPT sign-in: the loopback callback on 127.0.0.1:1455, the pasted-address path over SSH, and that OpenAI accepts the saved refresh token for the server;
- push delivery through FCM and Apple; Google's REST behaviour, the 7-day expiry of a Testing-mode token, Jev's request shape (all from M5);
- a real model driving the memory rules (a preference only when asked, nothing remembered from a file or an email), and the Inbox, `ask_agent` and digest instructions;
- that the real provider's `totalTokens` is the number the owner expects (cache reads count) and that a ChatGPT sign-in's answers carry usage at all: if they report zeros the weekly limit never trips (the Usage page would show zeros);
- the Android share target on a device.

## 8. Known gaps and risks

- The weekly limit is soft by design and in `totalTokens`: on the faux model about 60 turns of a short thread passed 1.8 M (the cache reads of a long context count), so an owner who sets `100k` on a real conversation will trip it quickly. The Usage page shows input, output and cache so the number can be judged; OPS.md says so.
- Usage before the server first looked has no day (the page says so), and a day's figure is as fresh as the last reading (every ten minutes, and whenever the page or a daily job asks).
- The activity log reads at most 5,000 entries per thread per request; past that it says so and asks for narrower dates.
- The phone navigation (BC-6a) and the filter layout (BC-6b) are the two things I would change first if the owner finds them awkward.
- Nothing runs `ops/check.sh` on a schedule: it is a command to run after the install and whenever something seems wrong.

## 9. Suggested scoped commits (the coordinator commits)

1. `shared: add memory, usage and activity types, the budget banner and the degraded daily card` (`packages/shared/src/*`)
2. `extensions: add memory and usage modules and the weekly-limit guard in the daily jobs` (`packages/extensions/**`, with their tests)
3. `server: add the owner API, the activity log, usage sampling and the openai login CLIs` (`apps/server/src/**`, `apps/server/test/{m8,login-openai}.test.ts`, the five updated server tests, `apps/server/package.json`, root `package.json`)
4. `web: add profile, activity and usage pages, memory cards and the budget banner` (`apps/web/**`)
5. `ops: add systemd units, tailscale serve and check scripts and the env file example` (`ops/**`, `apps/server/test/ops.test.ts`)
6. `docs: finish SETUP as the install checklist, add M8 handoffs and progress, update PLAN, OPS and README` (`docs/**`, `README.md`)

---

## 10. Fix round (worker 3, `docs/handoff-m8-fixes.md`): DONE-FIXES

Worked on `main`, M8 still uncommitted (the coordinator commits). No OpenAI, Google, TypeSafe or push call, no login, no `sudo`, no `railway`, nothing installed as a service. Tailscale on this machine (1.102.2, running, no Serve config)
was only *read* (`status --json`, `serve status`); nothing it holds was changed. **Servers stopped** (nothing listens on 3000-3099), the throwaway data directory and `/tmp/m8fix-scratch` are removed. Screenshots: `/tmp/assistant-shots/m8-fixes/`.

### 10.1 Item by item

| Item | Verdict | What changed | Proof |
|---|---|---|---|
| **S1** agent-planted preference | **fixed as adjudicated** | `remember(kind: preference)` files an approval request (`save_preference`, `createPreferenceAction`): card "Remember for every agent: “…”", Approve or YES writes the row; nothing exists or reaches a prompt before. An agent's **facts always go to its own scope** (`scope: shared` on a fact is kept for the agent and the result says so). Provenance on the row: `origin_agent`, `origin_conversation`, `origin_at` (migration `memory/002_origin`), shown on the Profile page ("asked for by the Accountant agent, and you approved it"). The owner moves a line to any scope (`PATCH /api/memory/:id` `{scope}`, "Move to…" on the page); the profile's own lines cannot move; only a fact kept for one agent can be pinned (**N5**). Instruction lines and the tool description say so | `memory.test.ts` +9 (ask, approve with origin, deny/expire, replay and identical-waiting are one request, already-there, refused before asking, run twice, damaged request, model cannot call it), moves and pins +3; `m8.test.ts`: the Accountant plants, the Inbox is told nothing until Approve, origin on the row, the owner shares the fact, recall finds it; move/pin/scope refusals |
| **S2** banner query 500 | fixed | `GET /api/agents` gives `budget: { over: [] }` and one log line per distinct failure | `api.test.ts` (3 requests, 1 log line) |
| **S3** "harness" summaries | fixed | the summary drops the `<harness>` lines and `[error] ` | `m8.test.ts` (the reason is asserted for three failed calls) |
| **S4** month 13 is a 500 | fixed (also days before 2000 and a 401-character cursor are asserted: mutants S11, S12) | `parseDay` checks `getTime()` first | `m8.test.ts` (+7 values) |
| **S5** settings file unreadable | fixed | SETUP/env example: `install -d -m 0750 -o root -g "$(id -gn)"`, file `-o "$USER" -g "$(id -gn)"`; `check.sh --env-file` that cannot read the file is one `FAIL cannot read the environment file` and an end | `ops.test.ts` |
| **S6** step 3 | fixed | `sudo install -d -o "$USER" …/opt/assistant` first; the remote/local-clone sentence; step references corrected | read (doc) |
| **T1** owner routes and guards | fixed | table-driven over the eight routes: wrong Host (3 values, both auth modes), cross-site/same-site writes, form/text/multipart/no type 415, 300 KB 413, no or wrong login 401, no CORS/preflight, a positive control | `api.test.ts` +8; mutant S16 (mount moved before the guards) now fails 7 |
| **T2** | fixed | degraded digest still pushes (and the empty digest stays quiet); `report().over` reuses `standing()` and is asserted at exactly the limit; S3 and S4 above | `inbox-digest.test.ts` +2, `usage.test.ts` +3; mutants E17 and E02 killed |
| N1 | fixed | `PUT /api/profile/preferences` is one transaction | `m8.test.ts` |
| N2 | fixed | a day-filtered scan stops only at a *tool* result older than the range, never at a late-posted timer card | `m8.test.ts` |
| N3 | **wording fixed, reach deferred** | the page and notes say "only the newest 5,000 entries were searched". Reaching past the cap needs a time-to-entry lookup Durable does not have (entries carry no time; a search by id would have to read entries): more than 15 minutes with tests | design-notes |
| N4 | fixed | `GET /api/memory` lists up to 500 (a scope holds at most 400 + the 2 profile lines), the page asks for all and says "Showing x of y" if ever not | `owner-pages.test.ts` |
| N5 | fixed (S1) | no Pin button and a refusal for what is always, or never, in a prompt | `memory.test.ts`, `m8.test.ts` |
| N6 | fixed | fractional counters are rounded (they made a STRICT INTEGER write fail and the agent was skipped without a word); a failed reading is logged once per agent and cause (`DomainDeps.warn`) | `usage.test.ts` +2 |
| N7 | doc | "2,400 characters, about 600 tokens of English; Tibetan and Devanagari cost more" (code comment, README, design-notes) | |
| N8 | fixed | `check.sh` fails the example login and host (the server still accepts them: the example stays a valid configuration) | `ops.test.ts` |
| N9 | fixed | header and SETUP/OPS claims corrected (it prints the host name and reconnect addresses; its requests are ordinary reads); every group is skippable, `--only` added, an unknown group is an error, vapid before the first start is a WARN, so SETUP step 5 can verify before a server exists | `ops.test.ts` |
| N10 | doc | OPS.md and SETUP step 7: `start-limit-hit`, `systemctl reset-failed` | |
| N11 | **deferred** | a replay of `remember`/an approved preference after the owner deleted the line makes it again: needs a crash and a delete in one window, the owner deletes it again. A table of used call ids closes it (in PLAN §9) | |
| N12 | fixed | Profile memory list and Activity: only the newest request fills the list | read (no DOM test environment) and seen in the browser |
| N13 | doc | SETUP step 5: the plan must allow token sharing (the error text named); `tailscale-serve.sh` now prints `ASSISTANT_OWNER_LOGIN` as well as the host | |
| N14 | fixed | new **`ops/install-units.sh`** (see decisions): the tracked units are never edited | `ops.test.ts` +4 |
| **U1** `/api` target | **fixed, confirmed in Tailscale's source** | `ipn/ipnlocal/serve.go`: "Trim the mount point from the URL path before proxying (#6571)" then `SetURL(target)` joins the target's path: with the old target the server saw `/agents`. The target is now `http://127.0.0.1:3001/api`. `check.sh` reads `tailscale serve status --json` and asks for `https://<host>/api/agents` through Serve | `ops.test.ts` (stand-ins for `tailscale` and `curl`: both the script and the check, good and bad configurations) |
| **U2** `funnel off` | **fixed: it was worse than feared** | `tailscale funnel --https=443 off` runs `removeWebServe` with no path: it **deletes every handler of the port** (and first demands Funnel access, "TODO: remove funnel"). It is gone. Funnel is never turned on and `tailscale serve` removes it from its port (`applyFunnel`, allowFunnel=false); the script reads the config back and fails if Funnel is on | `ops.test.ts` (no `funnel` command is ever run) |
| U3 | fixed | SETUP: `tailscale set --hostname=… --operator="$USER"`; a refused command prints that hint | `ops.test.ts` |
| U4 | fixed | `install-units.sh` makes the data folder (0700, the user's); the unit comment no longer says the server creates it | `ops.test.ts` |
| U5, U6, U7 | unverified (need a real model, the real sign-in, the real provider's usage); U5's exploit is closed for preferences by S1. U6 and U7 are written into SETUP step 5 and PLAN §9 | | |
| U8 | doc | the limit covers the four daily jobs of that agent; a briefing can call `ask_agent` and spend a specialist's tokens (counted in its week, not blocked): PLAN §9. The banner text was already exact | |
| Doc claims 1–7 | fixed | SETUP steps 3–5 and 7 and their cross-references; unit comments; README memory paragraph, `/tool` examples, recall's ids, the Inbox's tool list; PLAN lines 39 and 180; `check.sh` header | |

### 10.2 The skipped tests

Two tests (now three: `install-units.sh` has its own) run `shellcheck` on each script and are skipped where `shellcheck` is not on the PATH, as on this machine. It is a system program (Haskell), not part of `pnpm install`, so they cannot run by themselves
here, and adding a binary download to the install of a machine that holds secrets is not worth it. **I ran them for real**: shellcheck 0.11.0 from `pip install shellcheck-py` in a throwaway venv (removed): `ops.test.ts` 44 passed, 0 skipped; all three scripts are clean.
The reason is now in the test file (a comment above the check, the title says "skipped without shellcheck on the PATH", and the file prints one warning line when it skips). Everything else in `ops.test.ts` runs without it.

### 10.3 SETUP.md, walked again

Run for real: `pnpm login:openai --help`, `pnpm connect:google --help`; `ops/install-units.sh --dry-run` and `--out` on this checkout, then `systemd-analyze verify` on the two rendered units (silent); `ops/check.sh --dry-run`, `--only`, `--env-file` on unreadable and example files;
`ops/tailscale-serve.sh --dry-run`; the Jev command (in a temp directory: file 0600, folder 0700, the key not echoed); step 5's and 7's `check.sh` verifications in tests. Read against this machine: `tailscale status --json` gives `Self.DNSName` and `User[Self.UserID].LoginName` (the script prints both);
`tailscale serve status --json` is `{}` with no config (the parsers handle it); **HTTPS certificates are not enabled on this tailnet yet** (`CertDomains` is empty), so step 6's admin-console step is really needed.
Not run (they need `sudo`, a login or change Tailscale): steps 1, 4's `sudo install`, 6's `tailscale set` and the real `ops/tailscale-serve.sh`, 7's real install, 8–12. What the walk found, besides S5 and S6: `source`-ing the settings file breaks on a value with a space (now: `export ASSISTANT_DATA_DIR=…`);
step 5's check ended in FAIL before any server existed; the units had to be edited by hand and could disagree with `ASSISTANT_DATA_DIR`; `tailscale funnel --https=443 off` (above); the Jev step had no command.

### 10.4 Gates (serial, on the final tree)

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, 0 errors |
| `pnpm lint` | clean (341 files) |
| `pnpm test` | **72 files, 1,657 tests pass, 3 skipped** (the shellcheck tests; before the round 1,604 / 2) |
| `pnpm build` | web (`/profile`, `/activity`, `/usage`) and `apps/server/dist/main.js` 946 kB |
| Bundle smoke (`ASSISTANT_DATA_DIR=… ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux node apps/server/dist/main.js` + `next start`) | applies `memory/001_facts`, `memory/002_origin`, `usage/001_ledger`; through the bundle: the PA's preference waits, Approve writes it with `origin: pa`, the Accountant's request stays pending and writes nothing, the owner moves a fact to shared; `/api/agents` answers through the Next proxy too. (`NODE_ENV=production` refuses `ASSISTANT_AUTH=off`: as designed) |
| Browser (`agent-browser`, 390 px) | `/profile`: `scrollWidth` 390; Shared (2) shows the moved fact "noted by the Health agent" and the preference "asked for by the Assistant agent, and you approved it"; Assistant (1): Edit, Pin, Move to…, Delete on one row; no Pin on the preference or the shared fact. Not repeated at 1100 px, light mode or the activity page (only the request-order guard changed there) |

### 10.5 Break-and-restore (27 one-line mutants, each file restored and `sha256`-checked)

26 killed, 1 equivalent. Killed: S1 (an agent writes a preference, an agent writes a shared fact, no origin, pin a shared fact, move a profile line), S2 (a 500; logged every time), S3, S4 (month 13, before 2000, the cursor cap), N1, N2, N6 (fraction; warn every reading), T1 (owner routes before the guards: 7 tests fail),
T2 (degraded digest without push; `>` for `>=`), S5, N8, U1 (script target; check accepting it), U2, U3, U4. **Equivalent**: running an approved preference with a new call id each time still finds the same line by its text.

### 10.6 Decisions for the coordinator (★ = veto; each is cheap to reverse)

1. ★ **All** preferences from an agent ask first, own scope too, not only the shared ones: the adjudication said "a preference from a model"; an own-scope line is also "what the owner asked" in that agent's prompt.
2. ★ A fact asked for with `scope: shared` is **kept for the agent, not refused**, and the result tells the model how to ask for what it meant (a preference). A refusal would have cost one more model call for nothing.
3. ★ **The owner can move any line** between scopes (new `scope` field on `PATCH /api/memory/:id`): the adjudication said facts stay per agent "unless the owner moves them", and nothing could move one before.
4. ★ **New file `ops/install-units.sh`** (with `--dry-run` and `--out`): "edit the CHANGE lines" was not a command, led to editing tracked files, and `ReadWritePaths=` could disagree with `ASSISTANT_DATA_DIR`. The scope said ops are "files only": it is a file; it was run only with `--dry-run` and `--out`.
5. ★ The Serve change of mapping target, and no `funnel` command at all (above). Both read from Tailscale's source, not run on a tailnet.
6. The approval action is named `save_preference` and is not a tool (a model that calls it by that name is blocked by the same hook as any destructive tool, and there is nothing to run). A new migration `memory/002_origin` instead of editing `001` (M8 is uncommitted, but a dev database may already hold `001`).
7. **Dev databases made by the pre-fix M8 build** can hold shared preferences an agent wrote without approval (`source: agent`, no origin): look at Profile → Shared once, and delete what you did not ask for. The owner's real database does not exist yet.

### 10.7 Not verified, and what is left

The Tailscale commands (read from source, run only with `--dry-run` and stand-ins), whether `curl https://<host>/api/agents` is answered from the same machine and carries the owner's identity (the check says so in its `WARN`/`FAIL` text, it does not block); a real model asking for a preference
(the faux model only echoes `/tool`); the Profile page at 1100 px and in light mode after this round (small CSS: one `select`). Deferred: N3 (reach past 5,000 entries), N11 (replay after delete). Nothing else from the review is open.

### 10.8 Changed in this round

Code: `packages/shared/src/{memory,index}.ts`; `packages/extensions/src/memory/{migrations,store,tools,index,section}.ts`, `usage/service.ts`, `module.ts`; `apps/server/src/{agents,activity,domain,server}.ts`, `http/{app,owner,validation}.ts`; `apps/web/src/components/{profile-view,activity-view}.tsx`, `lib/owner-pages.ts`, `app/globals.css`.
Ops: `ops/{check.sh,tailscale-serve.sh,assistant.env.example}`, `ops/systemd/*.service` (comments), **new** `ops/install-units.sh`. Tests: `packages/extensions/test/{memory,usage,inbox-digest}.test.ts`, `apps/server/test/{m8,api,ops,support}.test.ts`/`support.ts`, `apps/web/test/owner-pages.test.ts`.
Docs: `docs/{SETUP,OPS,PLAN,design-notes}.md`, `README.md`, this file. Suggested commits are those of §9; `ops/install-units.sh` goes in commit 5 (`ops:`), the S1 code in commits 1 to 4 with the files above.
