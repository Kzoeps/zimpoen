# Handoff 2: M4 — finish the web, docs, browser check, gates

Second worker. Repo `/home/kzoeps/Projects/personal/assistant`, branch `main`, **nothing committed** (coordinator commits; do not commit or
push). Scope is `docs/handoff-m4.md`; constraints as in `docs/handoff-m2.md` (no OpenAI/Google/TypeSafe/real push, no logins, stop every
server you start, pnpm, never `railway`, **never `git checkout`/`git restore` on this tree**: everything is uncommitted). Context hygiene:
at ~55% write `docs/handoff-m4-3.md`, reply DONE-HANDOFF. Worker 1 stopped at the limit with all server-side work done and the web half
written but not yet seen in a browser. `docs/progress-m4.md` holds "M4 (partial)"; append the final report below it.

## 1. State

### Done and verified (last full run, after the last code change)

| Check | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm vitest run` | **37 files, 674 tests pass** (M3 end: 33 / 591), 20 s, serial |
| `pnpm lint` | **not clean, formatting only**: Biome wants line breaks / import order in the new files. First thing to do: `pnpm exec biome check --write .` then `pnpm lint` (Biome ignores `*.md`) |
| `pnpm build`, browser check | **not run yet** |
| servers | none running (tests start in-process servers on port 0 and close them); nothing listens on 3000–3009 |

New tests: `packages/extensions/test/{daily (34), files (20), facts (11)}.test.ts`, `apps/server/test/m4.test.ts` (18). Changed on purpose:
`apps/server/test/m3.test.ts` (the PA's extension list gained `daily`, `files`; its offered tools gained `describe_file`, `read_file`,
`save_journal`), `apps/server/test/support.ts` (`appDepsFor` gives stubs for `daily`, `timezone`, `filesDir` and migrates `files`),
`packages/extensions/test/support.ts` (fixture: modules incl. `daily` and `files`, options `timezone`, `wrapAsk`, `env`, `files`,
`providers`, field `asked`, a PA row in `agents`).

Scope item by item (numbers of `docs/handoff-m4.md`):

1. **Daily schedule engine — done, tested.** Module `daily` (`packages/extensions/src/daily/`): `schedule_daily` row per job, Durable task
   `app.daily` (phases `wait → run`, input `{ job, gen }`), row-is-truth + generation + `reconcile()` like reminders (`createTimerScheduler`),
   `nextOccurrence`/`occurrenceOn` (calendar arithmetic via `addDays`/`atLocalTime`, DST-safe: tested New York 1 Nov 2026 and 8 Mar 2026),
   late window (briefing 210 min → 11:00, wrap-up 180 min, both capped at the end of the day), `DailyService` (`ensureRows`, `list`, `update`),
   `GET /api/settings/schedule`, `PUT /api/settings/schedule/:job` (`{ localTime?, enabled? }`), repair at start and in the 10-minute sweep,
   repair log lines (`[daily] …`). **Settings UI is written but never seen** (`components/schedule-card.tsx`).
2. **Morning briefing — done server-side, tested.** Facts providers (`DomainModule.facts` → `DomainDeps.facts()`): `tasks/facts.ts` (today +
   reminders today, overdue), `followups/facts.ts` (today with agenda counts, open *asked* ones), `people/facts.ts` (birthdays today + 3 days),
   `daily/index.ts` `createJournalFacts` (carried over from the last answered day within 3 days). Request = `deps.ask(conversationId,
   { content, requestId: "briefing:<date>", entry: { kind: "app.daily", data } })` (Durable input with a custom entry kind, `whenBusy:
   followUp`), generic push "Your morning briefing"; nothing to say → display-only `app.daily` card (`empty: true`, requestId
   `briefing:<date>:empty`, zero tokens: asserted by faux call count). Instructions are in the PA's code-owned rules (`PA_DAILY_RULES` in
   `apps/server/src/agents.ts`), the input holds only the facts.
3. **Evening wrap-up + done-log — done server-side, tested.** Same engine; requestId `wrapup:<date>`; it always asks (even with no facts);
   a `pa_journal` row is created when asked (`asked_at`, `auto_summary`); tools `save_journal(date, user_log, carried_over[])` (replay-safe by
   call id via `daily_call`; a later call for the same day replaces) and `get_journal(date | from,to)` (deferred); prompt section `journal`
   lists wrap-ups still waiting (last 3 days). Next morning's briefing carries items over (tested whole-server).
4. **Uploads — server done and tested, web written (untested).** `POST /api/uploads` (`apps/server/src/http/uploads.ts`): one file per
   request, 20 MB, multipart only, `Sec-Fetch-Site` **required** (`same-origin`|`none`), Host allowlist and cross-site refusal from the global
   guard, auth applies; content sniffing (`packages/extensions/src/files/sniff.ts`: PNG/JPEG/GIF/WebP/PDF by signature, else UTF-8 text without
   NUL; `.csv` by name; a private-key text is refused); stored `<data>/files/<yyyy-mm>/<id>-<safe name>.<ext by content>` (0600, temp file +
   rename); `files_index` row; `GET /api/files/:id` (uploads only, inside the uploads folder, `nosniff`, CSP sandbox, images inline else
   attachment). The JSON-only exemption is **registration order** in `http/app.ts` (the route is mounted before `requireJsonContentType`; a test
   proves every other write still refuses a form with 415). PA tools (module `files`): offered `read_file(file_id, offset?, limit?)`,
   `describe_file(file_id, description, tags?)`; deferred `search_files`, `list_dir`, `read_file_path` (registers the file in `files_index`,
   idempotent by path). `readForModel` (own code, not the nested `read` tool): text/CSV 200 lines / 32 KB per call, images through the Photon
   processor (`createNodePhotonImages()` created in `server.ts`, option `StartServerOptions.images`), PDFs and binaries answer "cannot read".
   The deny list holds through the tools (whole-server test: `.env*`, `id_*`, `*.pem`, `*.key`, `auth.json`, `.ssh/**`, `.npmrc`, links into
   them, `<data>/secrets`, the databases, anything outside the roots; `list_dir` hides them). Prompt section `files` (folders + newest 5 files).
5. **Android share target — written, untested.** `app/manifest.ts` has `share_target` (POST multipart to `/share`, params title/text/url/files);
   `app/share/route.ts` → `lib/share.ts` `handleShare`: refuses unless `Sec-Fetch-Site` is `none`/`same-origin`, forwards each file to
   `${ASSISTANT_API_ORIGIN}/api/uploads` passing on `tailscale-user-login`, `sec-fetch-site` and `x-forwarded-host` (the API's guards decide),
   shared text over 1500 chars becomes `shared-text.txt`, answers `303` to `/capture?title=&text=&url=&files=<json>&problem=…`; `readCapture`
   reads it back (ids must match `fi_[0-9a-f]{8}`, names lose line breaks, brackets and `·`). **The capture page itself does not exist yet.**
6. **Web — written, typechecks, never run.** `lib/ui-messages.ts` (`app.daily` card, `journal`/`file`/`file_list` tool cards, chip on the first
   assistant answer after a non-empty daily card until the next user message, user messages split into text + file chips), `convert-message.ts`
   (`metadata.custom.chip` / `.files`), `card-text.ts`, `components/cards.tsx` (`DailyCard` with collapsible facts and "sent late" chip,
   `JournalCardView`, exported `FileChip`, file cards), `components/composer-attachments.tsx` (`useAttachments`, `AttachButton`, `AttachmentTray`),
   `components/thread-view.tsx` (chips, attach button, tray, a "send files" button when there is no text; `onNew` names the stored files with
   `withAttachments`), `lib/api.ts` (`uploadFile` over XHR for progress, `fetchSchedule`, `updateSchedule`, `fileUrl`), `lib/attachments.ts`
   (pure list reducers, `refusal`), `lib/schedule-form.ts`, `components/schedule-card.tsx` + `settings-view.tsx`.

### What is not done

No CSS for any new class; no capture page; no web tests; no docs; no browser check; no `pnpm build`; no final report.

## 2. Remaining items, in order

1. `pnpm exec biome check --write .` then `pnpm lint` (must be clean) and `pnpm typecheck`.
2. **Capture page** `apps/web/src/app/(app)/capture/page.tsx` (the empty directory exists; it is untracked) + a client component (e.g.
   `components/capture-view.tsx`): `useSearchParams()` inside `<Suspense>` → `readCapture(params)`; show `problems` as `notice--error`, the file
   chips (`FileChip`), an editable `<textarea>` prefilled with `shareText(shared)`, an agent `<select>` from `useChat().agents` (default `pa`),
   **Send to {agent}** → `sendMessage(agent.conversationId, { content: withAttachments(text, files), requestId: newRequestId() })` then
   `router.push("/chat/<id>")`; error text on failure; a "Cancel" link to `/chat/pa`. Needs text or files to enable Send.
3. **CSS** in `apps/web/src/app/globals.css` for: `.chip`, `.chip--late`; `.msg__files`; `.file-chip`, `.file-chip__thumb` (≤ 64 px),
   `.file-chip__icon`, `.file-chip__name`, `.file-chip__size`; `.card--daily`, `.card--file`, `.card__facts` (+ `summary`), `.card__section`,
   `.facts`, `.journal-day`, `.file-detail`; **composer**: `.composer` becomes `flex-direction: column; align-items: stretch` and the old row
   layout moves to the new `.composer__row` (`display: flex; align-items: flex-end; gap: 8px`), `.composer__attach` (44 px round, like
   `.composer__button` but neutral), `.attachments`, `.attachment`, `.attachment--uploading|ready|error`, `.attachment__name`,
   `.attachment__progress`, `.attachment__error`, `.attachment__remove`; `.schedule-job`, `.schedule-job__head|label|switch|row`; capture page
   classes. Keep the 390 px layout in mind (cards are `max-width: min(100%, 520px)`, `.msg--card` has `padding-left: 40px`).
4. **Web tests** (vitest, node environment, pure functions like the existing ones; `apps/web/test/`):
   - `cards.test.ts` (extend) or new file: `toUiMessages` with synthetic entries: an `app.daily` entry → `{ type: "daily" }` card; the first
     assistant answer after it has `chip`, the second does not; a user message ends it; an `empty` daily card gives no chip; a `pi.user` entry whose
     text ends in `[Attached file: …]` lines → `files` + clean `text`; `journal`/`file` tool results → cards; `cardSummary` for each.
   - `attachments.test.ts`: reducers, `refusal` (too big, empty, 10 files), `attached`, `isUploading`.
   - `api.test.ts` (extend): `uploadFile` with a fake `UploadRequest` (progress fractions, 201 → file, 413/415 body message, 5xx text, network
     error, abort → code `aborted`).
   - `share.test.ts`: `handleShare` with a fake `fetch`: 403 without `Sec-Fetch-Site` none|same-origin (also `cross-site`); forwards the three
     headers (and `x-forwarded-host` from `host`); several files; a refused file becomes a `problem`; text > 1500 chars becomes a file named
     `shared-text.txt` and `text` is empty; redirect is `303` to `captureUrl`; `readCapture` rejects a bad id/mime and cleans names;
     `shareText` de-duplicates.
   - `schedule-form.test.ts`: `scheduleChange`.
5. **Docs** (Biome ignores them): `README.md` (status paragraph → M4; quickstart: dev-model examples `/tool save_journal {...}`, the daily jobs and
   how to see one quickly, `curl -F file=@x.png -H 'Sec-Fetch-Site: none' http://127.0.0.1:3001/api/uploads`; layout; data tree `files/<yyyy-mm>/`;
   security rules (uploads, file tools, deny list holds); "How it fits together": the routes `POST /api/uploads`, `GET /api/files/:id`,
   `GET|PUT /api/settings/schedule`, the daily jobs and the journal; tests paragraph; **no new environment variable was added**: times are
   settings in `schedule_daily`, edited in Settings); `docs/design-notes.md` (rewrite "Uploads (planned, M4)" as built; new section "The daily
   jobs": row is truth, late window, first-start and edit rule, plan memo, power-cut recovery, YES window closed by `ask`, providers; "Files the
   PA can read": own reader, deny list, PDFs); `docs/OPS.md` (daily repair lines; nothing to clear by hand; the share target needs the
   installed app and https); `docs/PLAN.md` (§5.4 MorningBriefing/EveningWrapUp as built, §5.5 routes, §6 share target done, §7 columns of
   `schedule_daily`, `pa_journal`, `files_index`, the two ledgers, §8 M4 done, deviations list); final report in `docs/progress-m4.md`.
6. **Browser check** (agent-browser per `docs/handoff-m2-2.md` §3: `--args "--no-sandbox"`, named session, `set viewport W H`), screenshots in
   `/tmp/assistant-shots/m4/`. The laptop clock is +06 (Asia/Thimphu), so to see a job without waiting: start `pnpm dev` with a fresh
   `ASSISTANT_DATA_DIR`, set a job's time 1–2 minutes ahead in Settings → Daily schedule (or `PUT /api/settings/schedule/briefing`), add a task
   due today with `/tool add_task {"title":"Pay rent","due":"<today>T23:00"}`, wait: briefing card (collapsed facts) + chip on the dev model's
   echo; the empty-day card (no tasks); the wrap-up; `/tool save_journal {"date":"<today>","user_log":"…","carried_over":["…"]}` and its card.
   Uploads: attach a PNG and a CSV in the composer (progress bar, tray, remove), send with and without text, chips in the sent message
   (image thumbnail), `/tool read_file {"file_id":"fi_…"}`. **Check a 15–20 MB upload through the Next dev proxy (`/api/*` rewrite): Next may
   buffer or cap proxied bodies; if it does, say so in OPS/README (production has no proxy) or set the Next option that lifts it.** Share target:
   `curl -i -X POST -H 'Sec-Fetch-Site: none' -F title=T -F text=hello -F files=@pic.png http://127.0.0.1:3000/share` → `303 /capture?…`, open
   that URL in the browser, send to the PA; also without the header → 403. A 390 px screenshot. Verify at runtime what only typechecks now:
   `state.thread.composer.text` (the "send files" button appears when the text is empty), `<ComposerPrimitive.Send disabled>` while uploading.
7. **Final gates** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`; then smoke the bundle (`handoff-m2-2.md` §1:
   `ASSISTANT_DATA_DIR=… ASSISTANT_READ_PATHS=/usr/share/doc ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux node apps/server/dist/main.js`) and
   read an uploaded PNG with `/tool read_file` to prove the Photon worker starts from the built bundle (`@earendil-works/pi-durable` is
   external in `scripts/build.mjs`, so it should). Confirm nothing listens on 3000–3009 and remove scratch dirs (keep the screenshots).
8. Optional, as in M3: break-and-restore checks that the new tests fail when they should: `requireBrowserOrigin` (m4 "refuses a request without
   Sec-Fetch-Site"), the mount order of the uploads route (m4 "still refuses JSON here, and every other write still refuses a form"),
   `lateMinutes: 0` for a first row (daily "does not run a job that has just been created…"), the plan memo (daily "repeats what the first
   attempt decided…"), `recoverRuns` (daily "after a power cut").
9. Append the final report to `docs/progress-m4.md` (M3 style: changed files, decisions, commands and results, could not verify, risks, commit
   grouping), then reply **DONE-M4**.

## 3. Verified API facts (Durable 1.4.0 as installed; more in `handoff-m2-2.md` §3)

- `conversation.submit({ type: "input", content, requestId, whenBusy: "followUp", entry: { kind, data } })`: the input is placed as an entry
  of that custom kind (must not start with `pi.`) whose `model` is still the user message; it starts a run; the same `requestId` returns the
  first submission (tested: one `app.daily` entry, one `pi.assistant` after a repeat). A `write` with only `kind`/`data` never starts a run
  (`entry.model` is undefined: the empty briefing card).
- `TaskRuntime.memo(name, candidate, ctx)`: first writer wins, durable; used for the day's plan. Crash simulation (as in `reminders.test.ts`):
  a wrapper that awaits a promise it can reject after the real call; start `harness.close(ctx)`, reject, await the close, `db.close()`,
  reopen with the same `dir` and `clock`: the phase reruns from its top (tested for `ask`).
- `harness.resume()` wakes sleepers whose time has passed on the injected `now`; fixture `f.advance(0)` after setting `f.clock.now`.
- Tool `execute(args, api, context)`: `api.env` is the scoped environment (`ExecutionEnv`); `env.openBinaryReader(path, undefined, ctx)` →
  `reader.info/read/scanLines/close`; `getOrThrow` from `@earendil-works/pi-durable/env`; `env.canonicalPath` and `listDir` are guarded by the
  path policy (symlinks resolved, denied entries hidden); a refusal is an `Error` with "Access denied: …". `ToolExecutionResult.output` may
  hold `{ type: "image", data, mimeType }` blocks (the dev model ignores non-text parts).
- `createNodePhotonImages()` (`@earendil-works/pi-durable/images/node`) is async, starts its worker thread lazily and falls back in-process;
  `DEFAULT_IMAGE_LIMITS` and `ImageProcessor` are exported by `@earendil-works/pi-durable/tools`. A 1×1 PNG read through it works under vitest.
- `TimerKind`/`createTimerScheduler` take string ids; `claim` may throw (a row is reported as a failure and the rest is still repaired), but
  `pending()` must not throw (it runs outside the per-row `try`).
- Hono runs middleware and handlers in registration order; a route registered before `app.use("/api/*", mw)` that returns a response is not
  subject to `mw`. `bodyLimit` counts streamed bodies; `formData()` buffers. Node's `fetch` (undici) ignores a `host` header: test Host rules with
  `node:http`; it does accept `Sec-Fetch-Site`.
- Next 16: `MetadataRoute.Manifest.share_target` is typed (`params.files: { name, accept }[]`). assistant-ui 0.15.31: `useAuiState((s) =>
  s.thread.composer.text)` typechecks (**not run**); `MessageNotSentError` hands the text back to the composer.
- **The laptop's clock is +06 and tests run on the real clock**: a fresh data directory used to run the briefing at start whenever a test ran
  between 07:30 and 11:00 (the e2e tests failed at 08:09). Fixed (decision 3); the only remaining time-of-day exposure is a run that straddles
  21:00 (wrap-up due today) by a few seconds.

## 4. Decisions (for the report; each cheap to reverse; veto points marked ★)

1. Module `daily` owns `schedule_daily`, `pa_journal`, `daily_call` (names from the plan/handoff, so they do not carry the module prefix);
   module `files` owns `files_index`, `files_call`. Migrations `daily/001_schedule`, `daily/002_journal`, `files/001_index`.
2. ★ The briefing and the wrap-up are Durable **inputs** with `entry: { kind: "app.daily" }`: the thread shows a card (facts folded) instead of
   a user bubble, the model reads the same text as a user message, and the PA's answer is an ordinary message with a chip. The push goes right
   after the request is placed, not after the answer, with generic text ("Your morning briefing", "Time for your evening wrap-up").
3. ★ The late window (briefing until 11:00, wrap-up until midnight) is for a timer that wakes late and for the repair. It is **not** applied to a
   job's first row (a first start has no past) nor to edits in Settings (setting 07:00 at 07:45 means tomorrow, switching a job on after its time
   means tomorrow). A day that ran never runs again, however the time is edited.
4. The day's facts are a durable memo (first attempt's plan stands after a crash); `empty: true` only marks a briefing that stands alone.
5. `recoverRuns` at start: a job whose `last_run_date` is today is delivered again with the same request id and no push, because a power cut can
   lose the request from Durable's database while `app.sqlite` remembers the run.
6. Every question the daily jobs ask goes through `closingYesWindowOnAsk` (like timer cards): a "yes" typed to a wrap-up cannot approve a deletion.
7. Facts providers are registered per module (`DomainModule.facts`) and read through `DomainDeps.facts()`; one that throws is left out and
   reported, the others still speak. Health/expenses add theirs without touching the jobs.
8. `save_journal` replaces the earlier answer for a day (the model merges); `date` may not be in the future. `get_journal` and the other four
   rarely used file/journal tools are deferred (named in the PA's instructions); `read_file`, `describe_file`, `save_journal` are offered.
9. ★ Uploads take one file per request, 20 MB, and judge by content; text that holds a private key is refused; the stored extension follows the
   content; `GET /api/files/:id` serves uploads only. Message text names files with `[Attached file: name · mime · size · id fi_xxxxxxxx]` lines
   (`withAttachments`/`splitAttachments` in `@assistant/shared`), composed by the client; `POST …/messages` is unchanged.
10. ★ The file tools use their own reader instead of nesting Durable's `read` tool (testable without a harness, bounded the way the PA needs,
    one place for the PDF answer). PDFs are not readable yet and say so; adding text extraction is a dependency decision for later.
11. ★ Share target: the "draft message" is a capture page with an agent picker, not a prefilled composer; the Next route passes the caller's
    identity, `Sec-Fetch-Site` and host to the API instead of vouching for the request itself. Not tried on a device (Chrome is assumed to send
    `Sec-Fetch-Site: none` for a share-target POST).

## 5. Known gaps and risks

- Nothing of the web is seen in a browser; the share target is untried on Android; the Next dev proxy's body limit for large uploads is unknown.
- No real model has used the briefing rules, `read_file` on an image, `tool_search` for the deferred file tools or `save_journal`.
- An upload whose row insert fails after the file was renamed is removed; a crash between the rename and the insert leaves an orphan file (no sweep).
- `search_files` is `LIKE` over name, description and tags (every word must match); no ranking.
- Unchanged: the `file-lock` flake under CPU starvation (`progress-m2.md` §5), run suites serially when judging gates.
- `docs/handoff-m4.md` stays untracked, as handed over.
