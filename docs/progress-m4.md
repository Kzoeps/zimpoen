# M4 progress log (worker → coordinator)

# M4 (partial) — worker 1, stopped at the context limit

Branch `main`, nothing committed or pushed. No OpenAI, Google or TypeSafe call, no real push service, no login, no `railway`; no server of
mine is running (the tests start in-process servers on port 0 and close them; nothing listens on 3000–3009). Scope: `docs/handoff-m4.md`.
What is left, in order, with the verified API facts and the decisions: `docs/handoff-m4-2.md`. The final report goes below this section.

## 1. State at the handoff

| Scope item | State |
|---|---|
| 1 Daily schedule engine | **done, tested** (module `daily`, Durable task `app.daily`, `schedule_daily`, settings routes); Settings card written, not seen |
| 2 Morning briefing | **done server-side, tested** (facts providers, request as an `app.daily` input, empty-day card with zero tokens, push) |
| 3 Evening wrap-up, done-log, journal | **done server-side, tested** (`pa_journal`, `save_journal`, `get_journal`, prompt section, carry-over into the next briefing) |
| 4 Uploads | **server done, tested** (`POST /api/uploads`, `GET /api/files/:id`, `files_index`, five PA file tools, deny list holds); composer UI written, not seen |
| 5 Android share target | manifest + `/share` route + `lib/share.ts` written; **capture page missing**, untested |
| 6 Web rendering | written and typechecked (daily card, chip, journal and file cards, file chips, composer attachments), **no CSS yet**, never run |
| 7 Tests | server and extensions done (+83); **web tests not written** |
| 8 Docs, browser check, screenshots | **not done** |

## 2. Changed files

```text
packages/shared/       NEW daily.ts, files.ts (entry kind app.daily, DailyEntryData, JournalCard, schedule DTOs, upload constants and DTOs,
                       FileCard/FileListCard, attachment line format); edited cards.ts (ToolCard union, CARD_TYPES), index.ts
packages/extensions/   NEW daily/{facts,jobs,occurrence,migrations,store,run,task,scheduler,service,tools,index}.ts
                       NEW files/{sniff,migrations,store,read,tools,index}.ts
                       NEW tasks/facts.ts, followups/facts.ts, people/facts.ts (+ read queries appended to the three stores)
                       edited module.ts (DomainDeps.ask/facts/files, DomainModule.facts), post.ts (createInputSubmitter, closingYesWindowOnAsk),
                              index.ts, tasks/index.ts, followups/index.ts, people/index.ts
                       tests: NEW daily.test.ts (34), files.test.ts (20), facts.test.ts (11); edited support.ts
apps/server/           NEW http/uploads.ts; edited domain.ts, server.ts, agents.ts, http/app.ts, http/validation.ts
                       tests: NEW m4.test.ts (18); edited m3.test.ts (expected extension and tool lists), support.ts
apps/web/              NEW lib/{attachments,share,schedule-form}.ts, components/{composer-attachments,schedule-card}.tsx, app/share/route.ts
                       edited lib/{api,ui-messages,convert-message,card-text}.ts, components/{cards,thread-view,settings-view}.tsx, app/manifest.ts
docs/                  handoff-m4-2.md, progress-m4.md (this file)
```

No new dependency. No new environment variable: the times of the jobs are rows in `schedule_daily`, edited in Settings.

## 3. Commands run and results

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors (after the last edit) |
| `pnpm vitest run` | **37 files, 674 tests passed** (M3 end: 33 / 591), 20 s; every run in this session was serial |
| `pnpm lint` | **formatting and import order only**, in the new files; `pnpm exec biome check --write .` fixes them (first item of the handoff) |
| `pnpm build`, browser check | not run |

## 4. Decisions and deviations so far

Listed in `docs/handoff-m4-2.md` §4 (11 items; ★ marks the ones to veto): the briefing and wrap-up are Durable inputs placed as `app.daily`
cards; the late window is for downtime, never for a first start or a settings edit; a durable memo keeps the first attempt's facts; start-up
redelivers today's run after a power cut; the YES window closes for every question the jobs ask; providers per module; one file per upload,
judged by content, a private key refused; the file tools have their own reader; the capture page stands in for a prefilled draft.

One thing found by the tests and worth the coordinator's eye: the laptop runs on +06, and the first version of the engine ran the briefing at
the first start of any fresh data directory between 07:30 and 11:00, which broke the e2e tests at 08:09. The late window now applies only to a
timer that wakes late and to the repair (`lateMinutes: 0` for a new row and for edits), which is also what a person expects of a first start.

## 5. Could not verify

- Everything in the browser: the composer attachments, chips, the cards, the Settings card, the capture page (not yet written).
- The Android share sheet (assumed `Sec-Fetch-Site: none` for the POST) and a 20 MB upload through the Next dev proxy.
- A real model with the briefing and wrap-up rules, `read_file` on a receipt, `tool_search` for the deferred tools, `save_journal`.
- The built bundle starting the Photon worker (`pnpm build` not run).

## 6. Known risks

See `docs/handoff-m4-2.md` §5. In short: web untested and unseen; no sweep of an upload file orphaned by a crash between the rename and the
row insert; PDFs unreadable by design; `search_files` is a plain word match; the `file-lock` flake of M2 is unchanged.


---

# FINAL REPORT — Milestone 4: daily briefing and wrap-up, uploads, share target (worker 2)

Branch `main`, nothing committed or pushed. No OpenAI, Google or TypeSafe call, no real push service, no login, no `railway`. Every server and
browser session I started is stopped (nothing listens on 3000–3009), scratch directories are removed, the screenshots are kept in
`/tmp/assistant-shots/m4/` (19 files). Scope: `docs/handoff-m4.md`; state at my start: `docs/handoff-m4-2.md`.

## 1. Changed files (this session, on top of worker 1's list above)

```text
apps/web/              NEW app/(app)/capture/page.tsx, components/capture-view.tsx (the capture page: shared files as chips, editable text, agent picker,
                       "Send to X" → POST message → /chat/<agent>; refused files shown as notices)
                       NEW test/{attachments,daily-cards,share,schedule-form}.test.ts; edited test/api.test.ts (+ uploadFile, schedule, fileUrl)
                       edited app/globals.css (every class the new components use; composer is a column with a `.composer__row`),
                              next.config.ts (see decision 1), components/thread-view.tsx (no empty bubble for a files-only message),
                              lib/ui-messages.ts (a card between a briefing and its answer no longer drops the chip)
packages/shared/       NEW test/files.test.ts (the attachment-line contract: withAttachments ⇄ splitAttachments, formatSize)
packages/extensions/   edited daily/{service,index}.ts (`ensureRows()` returns the jobs it created; `start` returns `DailyStart`), index.ts (export),
                              daily/store.ts (lint: `row?.enabled === true && …`); test/daily.test.ts (+ "the first start")
apps/server/           edited src/domain.ts (type), src/server.ts (the startup log: a job's first timer is a set-up, not a repair);
                       test/m4.test.ts (+ 2: the log at a first start, at a restart and for a really lost timer), test/support.ts (stub)
all                    `biome check --write` reformatted 32 files of worker 1 (formatting and import order only)
docs/                  README, design-notes, OPS, PLAN, progress-m4 (this report)
```

No new dependency. No new environment variable. One new Next setting (`experimental.proxyClientMaxBodySize`).

## 2. What the browser check found (dev servers, dev model, `agent-browser`; each is fixed unless marked)

| # | Finding | Fix / test |
|---|---|---|
| B1 | **Next 16 caps every proxied request body at 10 MB** (`experimental.proxyClientMaxBodySize`, default 10485760), the `/api/*` rewrite included: an 11 MB upload hung, the browser got a 500 ("socket hang up" in the Next log); 9 MB passed. Direct to the API: 18 MB in 0.16 s. Applies to `next dev` and to `next start` without Tailscale Serve (production behind Serve has no proxy) | `next.config.ts` sets it to `MAX_UPLOAD_BYTES + 1 MiB`, imported from `@assistant/shared` so the two cannot drift. After: 15 MB and 19.5 MB → 201 through the proxy; 21 MB → the server's own 413 message ("larger than 20 MB…"). No automated test (a Next setting) |
| B2 | A message made only of files drew an **empty bubble** under its chips | `UserMessage` renders the bubble only when there is text; checked in the DOM (`bubble: null`) |
| B3 | (found by reading, then seen) a tool card between a briefing request and the PA's answer (a `list_tasks` card, a reminder) **reset the chip**, so the answer to the briefing lost its label | `chipAnswers` keeps the pending chip across non-daily cards; `daily-cards.test.ts › keeps the chip when the assistant looks something up first…` |
| B4 | The first start of a data directory logged **"2 daily job(s) had no live timer (… after a power cut …)"** at WARN: a false alarm on every new install | `DailyStart.created`; the log says "[daily] scheduled for the first time: briefing, wrapup. Change the times in Settings."; a lost timer still warns. `m4.test.ts › what the log says about the daily jobs at start`, `daily.test.ts › the first start` |
| B5 | A failed attachment (two-line reason) squeezed its own name to "size-…" | a failed file is a full-width card: name and ✕ above, the reason below |
| B6 | tooling, not product: agent-browser's `fill` does not change Chrome's segmented time input; setting `value` with the native setter and dispatching `input` does | – |

Seen working in the browser: composer paperclip → tray → progress bars while the API was frozen (SIGSTOP, resumed) → "ready"; remove (✕) ; send
with and without text (image thumbnail, CSV icon, file names; files-only gets the "Send files" button, `state.thread.composer.text` is correct at
runtime); **Send is disabled while uploading** (`<ComposerPrimitive.Send disabled>` works); a refused file (too big, binary) shows the
server's reason; `/tool read_file` on a CSV (lines 1–3) and on a PNG (a text part plus an `image/png` content block through Photon);
`describe_file` card with thumbnail; deferred tools after `/tool tool_search` (`search_files` card, `list_dir` hides `.env` and the key,
`read_file_path` indexes a file, `.env` and `/etc/passwd` refused with a clear message); **Settings → Daily schedule** (edit a time through the
UI: "Next: Sun 25 Oct 2026, 08:46 · usual time 07:30"); **briefing at 08:46:00 exactly**: card with four fact sections (folded, "4 items"),
"☀️ Morning briefing" chip on the PA's answer, generic push "Your morning briefing" in the outbox; **wrap-up at 08:48** with the day's completed task,
🌙 chip, `pa_journal` row asked; `save_journal` and `get_journal` cards; next-day rollover shown by the settings; the **empty-day card** (no
model entry after it, push still sent); the share target: `curl` with `Sec-Fetch-Site: none` → 303 `/capture?…` with the stored files, none
or `cross-site` → 403, a binary → a problem notice with the server's reason, a 3000-character text → `shared-text.txt`; the capture page
in the browser, "Send to Assistant" → the thread shows the chips and the text; 390 px: thread with tray, capture page, Settings.

## 3. Decisions and deviations of this session (each cheap to reverse; veto points marked ★)

1. ★ **`proxyClientMaxBodySize` lifted to the upload cap + 1 MiB** (B1) instead of only documenting the 10 MB wall. Cost: Next may buffer up to 21 MiB per
   concurrent proxied upload in memory; for one owner that is nothing. The setting is `experimental`, so a Next upgrade can rename it (it did once
   already: `middlewareClientMaxBodySize` is deprecated).
2. The capture page is **inside the `(app)` group**, so it has the sidebar and the agent list; the shared files stay stored even if the owner
   cancels (they are in `files_index`, like any upload; no sweep, as for every orphan).
3. The capture page sends with the same rule as the thread store: the same content to the same agent after a failure keeps its request id, so the
   server posts it once.
4. The first-start log line is `info`, a lost timer stays `warn` (B4).
5. `chipAnswers` keeps a pending chip across cards other than another daily card; only the owner's next message, or another daily card, ends it (B3).

## 4. Commands run and results

| Command | Result |
|---|---|
| `pnpm exec biome check --write .` then `pnpm lint` | 32 files reformatted; one warning fixed by hand; **lint clean (198 files, no warnings)** |
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm test` (= `vitest run`, serial) | **42 files, 764 tests pass**, 15 s (start of session: 37 / 674; +90 tests in 5 new files: web 75 = attachments 10, daily-cards 13, share 34, schedule-form 8, api +10; shared `files` 12; extensions `daily` +1; server `m4` +2) |
| `pnpm build` | ok: `/capture` static, `/share` dynamic, server bundle 333 kB (M2: 150 kB) |
| Bundle smoke: `ASSISTANT_DATA_DIR=… ASSISTANT_READ_PATHS=/usr/share/doc ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux ASSISTANT_PORT=3005 node apps/server/dist/main.js` | starts, applies all 15 migrations, a 107 KB PNG uploaded and read with `/tool read_file` returns text + `image/png` (**the Photon path works from the built bundle**), no error in the log, clean SIGTERM |
| Browser check | see §2; 19 screenshots in `/tmp/assistant-shots/m4/` |

## 5. Break-and-restore checks (a deliberate break, the targeted tests, then restored byte for byte; `cmp` checked each)

| Break | Tests that failed (and only those) |
|---|---|
| `requireBrowserOrigin` removed from `POST /api/uploads` | m4 › refuses a request without Sec-Fetch-Site, or from another site… (1) |
| `requireJsonContentType` mounted before the upload route | 9 upload, file and read tests (every happy path gets a 415) |
| a job's first row gets the late window (`lateMinutes: job.lateMinutes`) | daily › does not run a job that has just been created… (1) |
| the day's plan memo removed | daily › repeats what the first attempt decided when the process dies after the request was placed (1) |
| `recoverRuns` skipped at start | daily › writes today's briefing again when Durable's database lost it… (1) |
| `created` never reported | daily › names the jobs that got their first row…, m4 › calls the first start a set-up… (2) |
| any card drops the briefing's chip (the bug of B3) | daily-cards › keeps the chip when the assistant looks something up first… (1) |
| share route: the `Sec-Fetch-Site` check removed | share › refuses no header / another site / a sibling subdomain (3) |
| capture address: the id check removed | share › leaves out an id that is not one of ours / upper case / tries to be more (3) |

After the last restore the full gates were run again: `pnpm typecheck` 0 errors, `pnpm lint` clean, `pnpm test` 42 files / 764 tests, `pnpm build` ok.

## 6. Could not verify

- **The Android share sheet on a device**: that Chrome sends `Sec-Fetch-Site: none` for the share POST, that the installed app (https) is offered as a target, that the capture page opens in the installed app's window. Everything after the POST was exercised with `curl` and the browser.
- **A real model** with the new instructions (`PA_DAILY_RULES`), `read_file` on a receipt photo (that it describes what it sees), `tool_search` finding `search_files` / `list_dir` / `read_file_path` / `get_journal` when it should, `save_journal` after the owner's answer. The dev model and the faux provider only prove the plumbing.
- **Push to a real device** (only the fake outbox: generic payloads "Your morning briefing" / "Time for your evening wrap-up"), **light mode** (every screenshot is dark: the headless browser prefers dark) and the **"sent late" chip in a browser** (late runs are tested in the engine and the card is a plain element).
- **A clock change in a real zone**: Asia/Thimphu has none; New York 8 March and 1 November 2026 are tested with a fake clock.
- **`next start` with a large upload**: the proxy limit was proven under `next dev`; `next build` prints the same setting (`proxyClientMaxBodySize: 22020096`), and the two use the same code path, but I did not run a production Next server with a 19 MB upload.

## 7. Known risks

- `experimental.proxyClientMaxBodySize` is an experimental Next option (the previous name is already deprecated). If an upgrade drops it, uploads over 10 MB hang behind the proxy; `docs/OPS.md` says how to recognise it.
- A crash between an upload's rename and its row insert leaves an orphan file (no sweep). PDFs are stored and shown but not readable by the PA. `search_files` is a word match, unranked.
- The share target depends on one assumption about Chrome (above); if it is wrong the share answers 403 with a message that names what it expected, and the fix is one line in `lib/share.ts`.
- Unchanged from M2/M3: the `file-lock` flake under CPU starvation (did not appear in any of my runs); tests run on the real clock of a +06 laptop, so a run that straddles 21:00 by a few seconds can see a wrap-up that was due.
- Noticed, not touched (outside M4): `.task__body` and `.card--task` are used by `cards.tsx` (M3) and have no rules in `globals.css`; a long task title in a card could overflow instead of wrapping.

## 8. For the coordinator

**Nothing is committed.** Suggested commits (scoped, in this order; the packages depend on each other that way):

1. `shared: add the daily, journal and file contracts` — `packages/shared/src/{daily,files,cards,index}.ts`, `packages/shared/test/files.test.ts`.
2. `extensions: add the daily and files modules and the facts providers` — `packages/extensions/src/{daily,files}/`, `{tasks,followups,people}/{facts,index,store}.ts`, `module.ts`, `post.ts`, `index.ts`, `packages/extensions/test/{daily,files,facts}.test.ts`, `test/support.ts`.
3. `server: schedule settings, uploads route, file serving and the daily wiring` — `apps/server/src/**`, `apps/server/test/{m3,m4,support}.test.ts`.
4. `web: attachments, capture page, share target, daily cards and schedule settings` — `apps/web/**` (including `next.config.ts`: the proxy body limit).
5. `docs: M4 as built` — `README.md`, `docs/{PLAN,design-notes,OPS}.md`, `docs/progress-m4.md`, `docs/handoff-m4-2.md`. `docs/handoff-m4.md` stays untracked, as handed over.

Veto points (each cheap to reverse): the proxy limit lifted in `next.config.ts` (§3.1), the capture page standing in for a prefilled composer (worker 1's decision 11), the chip surviving cards (§3.5), and the wording of the first-start log line.
Servers and sessions: none running; scratch directories under `/tmp` removed; `/tmp/assistant-shots/m4/` kept.
