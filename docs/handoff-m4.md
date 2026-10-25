# Handoff: M4 — Morning briefing, evening wrap-up + done-log, uploads + Android share target

Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, `main` (M1–M3 committed). Coordinator commits; you don't.
Read: `docs/PLAN.md` (§2, §5.3–5.5, §7 `pa_journal`, files), `docs/design-notes.md` (reminder design, YES window, uploads plan, time in
prompts), `docs/progress-m3.md` (latest state/risks), `docs/handoff-m2-2.md` §3 (Durable API facts). Constraints: as in `docs/handoff-m2.md`.

## Scope
1. **Daily schedule engine**: one recurring durable task per daily job (row-is-truth like reminders; settings table
   `schedule_daily(job, local_time, enabled)` defaults: briefing 07:30, wrapup 21:00, Asia/Thimphu from config; DST-safe; recover after
   downtime: if the server was down at 07:30 and starts before 11:00, run the briefing once late; otherwise skip that day).
   Settings UI to change times/enable.
2. **Morning briefing**: code gathers facts (today's tasks + reminders due today, overdue tasks, follow-ups/meetings today with agenda
   counts, open *asked* follow-ups awaiting outcome, birthdays today/next 3 days, yesterday's journal carried-over items). Then one PA
   model run: `submit({type:"input", content: <structured brief request>, requestId: briefing:<date>})` with whenBusy followUp, and a push
   "Your morning briefing". If there is nothing at all, post a short display-only card instead (zero tokens). Keep the briefing
   instruction in a PA prompt section/instructions, not huge per-day text; facts go in the input.
3. **Evening wrap-up + done-log**: code gathers what the system knows happened today (tasks completed, follow-ups resolved/outcomes,
   birthdays wished, reminders fired; later milestones add health/expenses via a small "daily facts provider" interface each module can
   register). Posts PA input asking "what did you get done today?" with the auto-summary, push. User reply → PA tool
   `save_journal(date, user_log, carried_over[])` writes `pa_journal` (idempotent by date+call). Tool `get_journal(date|range)`.
   Next morning's briefing includes carried-over items.
4. **Uploads**: `POST /api/uploads` multipart (images, PDF, CSV, text; size cap e.g. 20 MB; content sniffing; stored under `<data>/files/<yyyy-mm>/<id>-<safe name>`),
   CSRF per design-notes (Host allowlist + Sec-Fetch-Site; explicit exemption from the JSON-only rule only for this route), `files_index` row.
   Composer attachment button; attached files are referenced in the message (file id + name + type) and PA has `read_file(file_id)`
   (text/CSV preview bounded; images passed as image content so the model can see receipts — use Durable `read` image handling or
   equivalent with resize via `createNodePhotonImages`) and `search_files(query)` over `files_index` (description/name/tags), plus
   `describe_file(file_id, description, tags)` so the PA remembers what a file is ("the March bank CSV").
   Read access to allowlisted dirs (`~/Documents`, `~/Downloads`) via the scoped env: `list_dir`, `read_file_path` tools on PA only,
   deny list enforced; register found files into `files_index` on use. No writes outside workspace.
5. **Android share target**: manifest `share_target` (POST multipart, text/url/files) → a Next route that forwards to the server upload +
   creates a draft message in the PA thread (or a capture page with "Send to PA" and agent picker). Works with the existing service worker.
6. Web: briefing/wrap-up render nicely (they are normal assistant messages; add a small header chip), journal card, file chips in
   messages, upload progress.
7. Tests: schedule fires at local time across DST/date change, late-run window, idempotent per date, nothing-to-report card is zero-token,
   journal save idempotent, upload guard (CSRF/Host/size/type), file path deny, share target route.
8. Docs: README, design-notes, PLAN deviations, `docs/progress-m4.md`. Browser check + screenshots `/tmp/assistant-shots/m4/`.

## Done when
Gates green, report appended, servers stopped, reply DONE-M4. Context hygiene at ~55% → `docs/handoff-m4-2.md`, reply DONE-HANDOFF.
