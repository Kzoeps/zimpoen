# Assistant

A personal assistant that runs on one always-on Linux machine and is reached privately, over Tailscale, from a
ChatGPT-style web chat. Several themed agents (`pa`, `inbox`, `health`, `accountant`) each keep one endless,
crash-safe conversation on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable): if the
process dies mid-answer, the next start picks the work up where it stopped.

Status: **all eight milestones are implemented; the latest is M8 (memory and profile, the activity log, usage with a weekly limit, and the deployment files)**. You can open the web UI, pick an agent, chat, and watch
the answer stream in. The `pa` agent keeps a task list and reminds you at the right time; it also follows your meetings:
after one it asks how it went and, if something has to be followed up, when, and then asks about that follow-up in turn;
through the day you add agenda points, and shortly before the meeting it posts them; and it keeps your friends' and
family's birthdays, reminding you in the morning to wish them well and asking in the evening whether you did. All of it
survives a restart, costs no model tokens until you answer, and also sends a Web Push notification to your phone. Deleting
anything needs your explicit approval. Every morning (07:30) it writes you a briefing from what the system knows (today's
tasks, overdue ones, meetings and follow-ups, birthdays, what you carried over from yesterday), and every evening (21:00)
it asks what you got done and keeps your answer in a journal; both times are settings. You can attach images, PDFs, CSV
and text files to a message (or share them from your phone's share sheet), and the PA can read them, remember what each
one is, and read files in the folders you allow. In dev mode the model is a scripted stand-in and pushes go to a file, so
nothing leaves the machine. The `health` agent keeps your weight (one entry a day; pounds are converted, kilograms stored) and
your gym sessions (exercises, sets, reps, weight lifted), and answers "how is my weight trending" and "how much am I picking
up" from numbers computed in code: the 7-day moving average, the change over a range, the estimated one-rep max (Epley),
the volume and your personal records, each with a small chart in the thread; a pull-up or dip done with a belt is followed
by the weight you added, and a wrongly named exercise can be renamed or merged into the right one. The evening wrap-up mentions
what you weighed and trained, and the morning briefing nudges you when yesterday's weight is missing. The `accountant` agent keeps your
money: expenses and income typed in chat, read from a receipt photo or imported from a bank or app CSV (shown to you first, then
confirmed; importing the same file twice adds nothing), in Ngultrum by default (`Nu. 1,234.50`) and in USD or INR when you say so,
with balances per account ("I have 12,000 in BoB" is recorded and the difference reported), and answers "where did I spend the most"
from sums and shares computed in code, with a bar chart in the thread. It splits a bill one friend paid (items, who had what, tax,
service and tip in proportion; the shares add up to the bill to the last chhertum) and remembers who owes whom until it is paid
back. Every month it makes your invoice as a PDF from your own template (`<data>/templates/invoice.html`, see
[`docs/setup-invoice.md`](docs/setup-invoice.md)) with the next invoice number, and gives it to you as a download in the chat:
it never sends it anywhere. Every number comes from a tool, never from the model; for an analysis the tools do not cover it
writes a short script in Durable's code mode. A script may call any tool the Accountant has (a write goes through the same
approval rule as in chat), and has no network, no files and no model; it is stopped after 30 seconds, or after the time it asks
for, never more than two minutes. The `inbox` agent reads your Gmail accounts (as many as you connect) and your Google
Calendar **read-only**: it keeps a local copy of the recent mail (synced every ten minutes), sorts it (important, needs a reply,
follow-up, newsletter, ...) with TypeSafe's Jev or, without a key, with local rules, and at 12:30 and 19:00 writes you a digest of
only the mail that needs you, each item a link to its conversation in Gmail, so that nothing important is lost among the app
mail. It never sends, replies, labels or deletes: those tools do not exist. When a mail or a meeting commits you to something it
suggests a follow-up, which appears in the assistant's chat as a card with **Add** and **Dismiss** (nothing is added unless you
press Add; one nobody answers expires after a week), and the assistant can ask it a question on your behalf (`ask_agent`). To connect your accounts, see
[`docs/SETUP.md`](docs/SETUP.md) (everything you have to do, in one list), [`docs/setup-google.md`](docs/setup-google.md) and
[`docs/setup-jev.md`](docs/setup-jev.md).
The PA, Health and the Accountant also have a **memory** (the Inbox agent reads it and never writes it: it reads untrusted mail): one plain line at a
time, either a *preference* (only when you ask it to remember something: "remember that I like short answers") or a *fact* (a detail no
tool has a place for, like a favourite gym). An agent cannot write a preference by itself: it asks, as an approval card in its chat, and the
line exists once you approve it (for that agent alone or for every agent; it keeps who asked). A fact an agent notes stays with that agent
until you move it to every agent on the **Profile** page. The lines are in the agent's prompt (about 2,400 characters, which is about 600
tokens of English), and are listed on the **Profile** page, where you search, edit, pin, move and delete any of them without anyone's
approval (an agent that wants to forget one needs yours). **Activity** lists what the agents did, worked out from
the conversations themselves, with filters by agent and day. **Usage** shows the tokens each agent and model spent this
week and day by day, and lets you set a weekly limit per agent: past it, that agent's briefing, wrap-up and digests are
posted as plain cards that cost no model tokens until Monday, a banner says so on every page, and what you type still gets
an answer. Putting it on the always-on machine is one ordered checklist, [`docs/SETUP.md`](docs/SETUP.md), with its files
in `ops/`.
The full design and milestone list is in [`docs/PLAN.md`](docs/PLAN.md).

## Quickstart

Needs Node 24 and pnpm 10.

```bash
pnpm install
pnpm dev          # server on 127.0.0.1:3001, web on 127.0.0.1:3000
```

Open <http://127.0.0.1:3000>. Dev mode uses the scripted `faux` model (it echoes your message and streams it back in
small chunks, with a "Thinking" block) and turns authentication off unless you export `ASSISTANT_AUTH` yourself. Data goes
to `./data-dev`; production uses `./data` (both ignored by git), so a dev database full of scripted-model agents can never
be opened by a production server.

The scripted model has no judgement, so it never decides to use a tool itself. To try the `pa` agent's tools without a real
model, tell it what to call: `/tool <name> {json}`. For example `/tool add_task {"title":"Stretch","remind_in_minutes":1}`
saves a task with a reminder one minute from now, and a minute later the reminder card appears in the thread. The tools
are `current_time`, `add_task`, `list_tasks`, `update_task`, `complete_task`, `snooze_reminder` and `propose_delete_task`
(arguments: `packages/extensions/src/tasks/tools.ts`).

The same works for the M3 tools (arguments in `packages/extensions/src/followups/tools.ts` and `people/tools.ts`):
`add_followup`, `add_agenda_point`, `list_followups`, `update_followup`, `record_outcome`, `resolve_followup`,
`propose_delete_followup`, `add_person`, `update_person`, `list_people`, `record_wish` and `propose_delete_person`.

The Health agent's tools work the same way (arguments: `packages/extensions/src/health/tools.ts`), in its own thread:
`/tool log_weight {"weight":72.4}` (`"unit":"lb"` converts, `"date":"yesterday"` or `"2026-10-23"` picks the day),
`/tool log_workout {"exercises":[{"name":"bench","sets":[{"reps":8,"weight":60,"count":3}]}]}` (`count` makes 3 identical
sets; `bench` is matched to Bench press), `/tool weight_trend {"range":"30d"}`, `/tool exercise_progress {"exercise":"bench"}`
and `/tool list_workouts`. A weighted exercise needs its weight on every set; the refusal names the way out for one done
unloaded (`lunges` with no weight: log `Bodyweight lunge`), and a bodyweight exercise (`pull ups`, `dips`) may take the weight
you added (`"weight":20`), after which its progress is that weight. `/tool rename_exercise {"exercise":"cable crossover","new_name":"Cable fly"}`
keeps the old name working. `propose_delete_weight`, `propose_delete_workout` and `propose_merge_exercises` (two exercises that are
really one: it moves every set) load with `/tool tool_search {"query":"delete a workout"}` or `"merge two exercises"` first, like the
PA's deletion tools, and then a reply of YES (or the Approve button) carries them out.

The Accountant's tools work the same way (arguments: `packages/extensions/src/ledger/tools.ts`, `splits/tools.ts` and
`invoices/tools.ts`), in its own thread. Amounts are plain numbers of major units (`1234.5` is Nu. 1,234.50); more decimals than
the currency has is refused, never rounded:
`/tool add_account {"name":"BoB savings","kind":"bank","balance":100000}`, `/tool add_expense {"amount":1250.5,"merchant":"Druk Mart","category":"groceries"}`,
`/tool add_income {"amount":120000,"category":"salary"}`, `/tool add_transfer {"from_account":"BoB","to_account":"Cash","amount":5000}`,
`/tool set_balance {"account":"BoB","balance":98000}`, `/tool spending_summary {"range":"this_month","group_by":"category"}`,
`/tool balances` and `/tool list_txns {"range":"30d"}`. A statement: attach a CSV (or `curl -F file=@bank.csv -H 'Sec-Fetch-Site: none'
http://127.0.0.1:3001/api/uploads`), then `/tool import_csv {"file_id":"fi_...","account":"BoB savings"}` shows what was found, and
`/tool confirm_import {"import_id":"im_..."}` (the card's Confirm button says it in the chat) adds it. A row that looks like an
entry you already typed or photographed (same account and amount, within two days) is listed apart and left out unless you say
it is a different purchase (`include_lines` or `include_matches`), and the preview warns when every row goes one way, as a
Dr/Cr column read wrongly would make it. A wrong import is taken back as a whole with `propose_undo_import`. Bills:
`/tool split_bill {"title":"Lunch","payer":"Pema","people":["me","Pema","Tashi"],"items":[{"description":"Momos","amount":450,"shared_by":["me","Pema"]},{"description":"Thukpa","amount":300,"shared_by":["Tashi"]}],"extras":[{"label":"Service charge","percent":10}],"total":825}`,
`/tool who_owes` and `/tool record_settlement {"from":"Pema","to":"me","amount":300}` (a name that is only part of a friend's,
"Pema" for "Pema Dorji", records nothing and asks which person). Invoices:
`/tool set_invoice_profile {"client_name":"Acme Pte Ltd","amount":50000,"sender_name":"Dorje"}`, `/tool preview_invoice` (a PDF
marked PREVIEW that takes no number: use it to try a template) and `/tool generate_invoice`.
`recategorize`, `undo_recategorize`, `propose_delete_txn`, `propose_undo_import`, `archive_account`, `add_category`,
`set_fx_rate`, `list_splits`, `propose_delete_split`, `list_invoices` and `get_invoice_profile` load with `/tool tool_search`
first; deleting asks for your approval as everywhere else. `recategorize` matches a merchant by its whole name, shows what would
change before it moves more than 20 entries, and can be undone.
`/tool codemode {"code":"const page = await tools.ledger_query({kind:'expense'}); return page.total"}` runs a script over the
ledger's query tools (which only scripts are given).

**Rarely used tools are not offered until loaded.** The PA is offered `current_time`, `add_task`, `list_tasks`,
`complete_task`, `snooze_reminder`, `add_followup`, `add_agenda_point`, `record_outcome`, `add_person`, `record_wish` and
`tool_search`; `update_task`, `list_followups`, `update_followup`, `resolve_followup`, `list_people`, `update_person`, the
`propose_delete_*` tools and the `delete_*` tools load when the model calls `tool_search` (the real model does; its
instructions name them). The dev model's `/tool` is refused with "Tool X is not available" until you load the tool the
same way: `/tool tool_search {"query":"propose delete task"}` first, then `/tool propose_delete_task {...}`. To watch a meeting go through its
whole life in a few minutes, start the server with `ASSISTANT_FOLLOWUP_ASK_DELAY_MINUTES=1` and say
`/tool add_followup {"title":"Meeting about the house","counterpart":"Dabtonog Realty","event_in_minutes":3,"agenda_lead_minutes":1}`,
then `/tool add_agenda_point {"text":"Ask about the price","meeting":"Dabtonog"}`: the agenda card arrives two minutes
later and the question at minute four; answer it with `/tool record_outcome {"followup_id":"f_…","outcome":"They
agreed","needs_followup":true,"next_in_minutes":2}` and the chained follow-up (a commitment: a "due now" card at its time, the
question half a delay later) is asked about two minutes after that. A question nobody answers is asked once more the next
morning (`ASSISTANT_FOLLOWUP_REASK_TIME`).
Birthdays fire at the configured times of day (`ASSISTANT_BIRTHDAY_REMIND_TIME`, `ASSISTANT_BIRTHDAY_CHECK_TIME`): save one
for today with `/tool add_person {"name":"Pema","birthday":"1990-10-25"}` (use today's month and day) and set the check time
a minute or two ahead.

**The daily briefing and wrap-up** are two jobs whose times are settings, not environment variables: **Settings → Daily
schedule** (or `PUT /api/settings/schedule/briefing` with `{"localTime":"08:15","enabled":true}`). To see one without
waiting, set it two minutes ahead, add something to report (`/tool add_task {"title":"Pay rent","due":"2026-10-25T23:00"}`,
today's date) and watch the thread: a briefing card (what the assistant looked at, folded) and the PA's answer under a
"Morning briefing" chip, plus a push. With nothing to report the briefing is a one-line card and costs no model tokens. A
job that is edited or switched on after its time means tomorrow; a server that was down at the time still sends the briefing
when it starts before 11:00 (a wrap-up before midnight), and a day that ran never runs twice. Answer the wrap-up, or play
the PA's part: `/tool save_journal {"date":"2026-10-25","user_log":"Paid rent.","carried_over":["Renew the licence"]}`
(`get_journal` is loaded with `tool_search` first); tomorrow's briefing lists what you carried over.

**Files.** The paperclip in the composer uploads as you pick (one request per file, up to 20 MB: PNG, JPEG, GIF, WebP,
PDF, CSV or text; the server judges by content, not by name) and the message names the files for the PA. To try it from a
shell: `curl -F file=@receipt.png -H 'Sec-Fetch-Site: none' http://127.0.0.1:3001/api/uploads` (the header stands in for
the browser; a request without it is refused). Then `/tool read_file {"file_id":"fi_…"}` (images come back as images, text
and CSV as lines, at most 200 lines or 32 KB per call) and `/tool describe_file {"file_id":"fi_…","description":"The
March bank CSV","tags":["bank"]}`. `search_files`, `list_dir` and `read_file_path` (files in the folders of
`ASSISTANT_READ_PATHS`, indexed when used) are loaded with `tool_search` first. PDFs are stored and shown but not yet
readable by the PA. The Android share sheet (installed app, https) posts to `/share`, which stores the files and opens
`/capture`, where you choose the agent and send; on a laptop try it with `curl -i -X POST -H 'Sec-Fetch-Site: none' -F
text=hello -F files=@pic.png http://127.0.0.1:3000/share`. Dev mode also keeps pushes on the machine
(`ASSISTANT_PUSH_MODE=fake`): after you press **Enable notifications** in Settings, each reminder appends one line per
subscribed device to `./data-dev/dev-push-outbox.jsonl`, which is what your phone would have been sent.

**The Inbox.** In development `ASSISTANT_GOOGLE_MODE` is `fake`: the Inbox agent reads a scripted demo mailbox of two accounts
(`demo.owner@example.com` and `demo.work@example.com`: a realtor asking you to confirm a visit, a bank statement, a newsletter,
an overdue invoice, a pull request notice, a few calendar events) and nothing leaves the machine. **Settings → Google accounts**
lists them and says **Rules mode** (no Jev key). In the Inbox thread try `/tool search_mail {"query":"plot"}`,
`/tool read_mail {"id":1}`, `/tool list_events {"range":"week"}`, `/tool mark_triage {"id":2,"category":"newsletter"}` and
`/tool suggest_followup {"mail_id":1,"title":"Follow up with the realtor","at":"2026-12-01T15:00"}` (a future time): a card with
**Add** and **Dismiss** appears in the PA's thread, and Add makes the PA run on a message written from those details (the dev
model only echoes it; a real model calls `add_followup`). The digests are two more jobs under **Settings → Daily schedule** (move
one two minutes ahead): a card lists the mail that needs you since the last digest, open, each row a link to Gmail, and the Inbox
agent's answer sits under a chip; with nothing to report it is one line, costs no tokens and sends no push. In the PA's thread
`/tool ask_agent {"agent":"inbox","question":"Is there mail from the bank?"}` puts the question to the Inbox agent and brings its
answer back. `ASSISTANT_GOOGLE_MODE=real` (the default in production) reads real Gmail once an account is connected with
`pnpm connect:google`: [`docs/setup-google.md`](docs/setup-google.md) (publish the Google app "In production" there: in Testing mode
Google may expire each sign-in after 7 days, which this guide marks as to verify).

**Memory, profile, activity and usage.** In the PA's, Health's or the Accountant's thread `/tool remember {"text":"The dentist is Dr Wangmo"}`
keeps a fact for that agent and shows a card; `/tool remember {"text":"Tea without sugar","kind":"preference"}` asks you to approve a preference
(`"scope":"shared"` for every agent) and the line exists once you press Approve or reply YES; `/tool recall {"query":"tea"}` searches what that
agent and the shared scope hold (the Inbox agent has `recall` too). Forgetting asks you first: `/tool tool_search {"query":"forget"}`, then
`/tool forget {"id":"m_…"}` (the id is in the text `recall` gives the model and in the Activity list, not on its card; the Profile page deletes a line
directly) and press Approve. **Profile** in the sidebar lists, searches, edits, pins and deletes the lines, and sets the tone and the explanations
every agent is told; **Activity** filters by agent and day and pages with **Load more**; **Usage** has a weekly limit box per
agent (`500k`, `2m`). To see the limit work, set `1k` on the Assistant, spend a few turns, and move the briefing two minutes
ahead as above: its card says it is a plain version, and lists the tasks and mail it found instead of a model's text. The dev
model never decides to remember anything; the real one follows the rules in its instructions (preferences only when you ask,
nothing from a file or an email).

On first start the server must be able to read `~/Documents` and `~/Downloads`, which agents may read once file tools
exist. If you do not have them, point it elsewhere and it will tell you what is wrong in any case:

```bash
ASSISTANT_READ_PATHS=/some/folder:/another/folder pnpm dev
```

| Command | What it does |
|---|---|
| `pnpm dev` | Server (restarts on file changes, resuming interrupted work) and web dev server |
| `pnpm build` | Bundles the server to `apps/server/dist/main.js` and builds the web app |
| `pnpm start` | Runs the built server in production mode (`NODE_ENV=production`: auth on and cannot be turned off, OpenAI model, `./data`). Run the built web app with `pnpm --filter @assistant/web start` |
| `pnpm connect:google` | Connects a Gmail account (read-only), once per account: prints a link, waits for the approval in your browser, saves the sign-in in `<data>/secrets/google-accounts.json`. `--list` shows the accounts. [`docs/setup-google.md`](docs/setup-google.md) |
| `pnpm login:openai` | Signs the assistant in to OpenAI with your ChatGPT subscription: prints a link, waits for the approval in your browser (or a pasted address, over SSH), saves the sign-in in `<data>/secrets/credentials.json`. `pnpm logout:openai` removes it. [`docs/SETUP.md`](docs/SETUP.md) |
| `ops/check.sh` | Checks the deployment (private folders and files, sign-ins, the server, the ports on `127.0.0.1` only, the API, Tailscale Serve with Funnel off and `/api` answering through it, the services) and prints one `PASS`/`FAIL`/`WARN` line each; `--dry-run` lists the checks, `--only`/`--skip` pick groups. `ops/tailscale-serve.sh` publishes the web app and the API on your tailnet (idempotent; `--dry-run`). `ops/install-units.sh` fills in and installs the two systemd units in `ops/systemd/` (`--dry-run`), `ops/assistant.env.example` is the settings file |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | Vitest for the whole workspace |
| `pnpm lint` | Biome (lint and format check) |
| `node apps/server/scripts/record-fixtures.ts` | Re-records the event streams the web tests replay (see below) |

## Layout

```text
apps/
  server/        Node process: Durable Harness, HTTP API, SSE, Web Push. Entry: src/main.ts
  web/           Next.js (App Router) + assistant-ui over the server's API; PWA manifest and service worker for pushes
packages/
  shared/        API contracts: DTOs, error shape, stream event types, card types (types, plus tiny constants and guards)
  db/            app.sqlite: node:sqlite wrapper and the migration runner (ids per module), core tables
  extensions/    Durable extensions the server installs: domain modules `tasks`, `followups`, `people`, `approvals`, `daily` (briefing, wrap-up, journal), `files`, `health` (weight, lifts; the Health agent's), `ledger`, `splits` and `invoices` (the Accountant's: accounts and entries in integer minor units, CSV import, bills and who owes whom, the invoice PDF made with pdfkit and Mustache), `inbox`, `delegate`, `memory` (remembered lines with a full-text index), `usage` (what Durable's totals say each agent spent, and the weekly limits) and `profile` (who the owner is, in the prompt)
ops/             deployment files: systemd units, `install-units.sh`, `tailscale-serve.sh`, `check.sh`, `assistant.env.example` (docs/SETUP.md)
docs/            PLAN.md (architecture), SETUP.md (the install checklist), OPS.md (running it), design-notes.md (security and durability reasoning), handoff and progress notes
```

Workspace packages export TypeScript source. Node 24 runs it directly in dev, Next compiles `@assistant/shared`
(`transpilePackages`), and `pnpm build` bundles the server with esbuild.

## Configuration

All settings are environment variables, read and checked at startup. A bad value stops the server with one message that
names every problem, the setting, why it is wrong and what to do. A `.env` file is not loaded: export the variables, or
use a systemd unit.

| Variable | Default | Meaning |
|---|---|---|
| `ASSISTANT_DATA_DIR` | `./data-dev`, or `./data` when `NODE_ENV=production` (relative to the working directory; the scripts run from the repo root) | Where all state lives |
| `ASSISTANT_READ_PATHS` | `~/Documents:~/Downloads` | Folders agents may read, absolute, separated by `:`. `<data>/files` is always added. Set but empty is an error, not "the defaults" |
| `ASSISTANT_AUTH` | `on` (`pnpm dev` uses `off` unless you export it) | `off` accepts every identity: local development only, and refused when `NODE_ENV=production` |
| `ASSISTANT_OWNER_LOGIN` | none | Your Tailscale login. Required while auth is on |
| `ASSISTANT_PUBLIC_HOST` | none | The name you open the assistant by through Tailscale Serve, for example `my-laptop.tail1234.ts.net` (comma-separate several; add `:port` if it is not the default HTTPS port). The API answers only to `127.0.0.1`, `localhost`, `[::1]` on its own port, and these names |
| `ASSISTANT_MODEL_MODE` | `faux`, or `openai` when `NODE_ENV=production` | `faux` is the scripted dev model; `openai` is gpt via ChatGPT sign-in |
| `ASSISTANT_PUSH_MODE` | `fake`, or `web-push` when `NODE_ENV=production` | `web-push` sends reminders through the browser vendors' push services (FCM, Apple), the only outbound call a reminder makes. `fake` sends nothing: it appends what it would have sent to `<data>/dev-push-outbox.jsonl` |
| `ASSISTANT_PUSH_SUBJECT` | `mailto:assistant@localhost` in `fake` mode; **required** in `web-push` mode | How a push service can contact the operator (the VAPID `sub` claim): a `mailto:` or `https:` URL you control, sent with every push. Some push services may refuse a placeholder, so the server will not start in `web-push` mode without one |
| `ASSISTANT_TIMEZONE` | `Asia/Thimphu` | IANA time zone told to every agent, and the one the times below are in (also across a change of the clock) |
| `ASSISTANT_AGENDA_LEAD_MINUTES` | `15` | A meeting's agenda is posted this long before it starts, when it has points (1 to 1440). A tool call can set it for one meeting |
| `ASSISTANT_FOLLOWUP_ASK_DELAY_MINUTES` | `30` | The owner is asked how a meeting went this long after it started, unless it has an end time (1 to 1440) |
| `ASSISTANT_FOLLOWUP_REASK_TIME` | `09:00` | Local time of day of the one re-ask of a follow-up question nobody answered: the morning after it was asked |
| `ASSISTANT_FOLLOWUP_DEFAULT_TIME` | `10:00` | Local time of day a follow-up starts when the owner gave a date and no time ("on Monday"); the PA is told it chose it |
| `ASSISTANT_BIRTHDAY_REMIND_TIME` | `09:00` | Local time of day (24-hour `HH:MM`) of the birthday reminder |
| `ASSISTANT_BIRTHDAY_CHECK_TIME` | `18:00` | Local time of day of the evening question whether the owner wished them well; later than the reminder |
| `ASSISTANT_CURRENCY` | `BTN` | ISO 4217 default currency told to every agent |
| `ASSISTANT_OWNER_NAME` | `the owner` | Your name, as agents address you |
| `ASSISTANT_OWNER_HEIGHT_CM` | unset | Your height in centimetres (100 to 250, for example `176`). Only the Health agent uses it, for the BMI in its weight results; unset means no BMI anywhere. Not told to the other agents |
| `ASSISTANT_GOOGLE_MODE` | `fake`, or `real` when `NODE_ENV=production` | `real` reads Gmail and Calendar through Google's APIs with the accounts `pnpm connect:google` saved. `fake` is a scripted demo mailbox of two accounts: nothing is read from Google |
| `ASSISTANT_INBOX_SYNC_MINUTES` | `10` | Minutes between two syncs of one Gmail account (1 to 1440); a failing account is tried again after twice as long each time, up to an hour. The digests' times are settings (Settings → Daily schedule) |
| `ASSISTANT_PORT` | `3001` | API port. It always binds to `127.0.0.1` |
| `ASSISTANT_API_ORIGIN` | `http://127.0.0.1:3001` | Where the web app proxies `/api/*` (web only). It is baked into `apps/web/.next` by `next build`: changing it, or `ASSISTANT_PORT`, needs a rebuild of the web app |

Changing `ASSISTANT_MODEL_MODE` on an existing data directory leaves agents pointing at the old mode's model. The server
warns at start-up when that happens, and **Settings** in the web app (or `PUT /api/settings/agents/:id`) points each
agent at a model the server can serve.

To try the production build on your own machine, where the browser cannot send a Tailscale identity, run it outside
production mode: `ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux node apps/server/dist/main.js` and
`pnpm --filter @assistant/web start`. `pnpm start` itself refuses `ASSISTANT_AUTH=off`.

OpenAI mode reads credentials from `<data>/secrets/credentials.json` (mode 0600, pi-ai's `CredentialStore` format). There is
made by `pnpm login:openai` (Sign in with ChatGPT: it prints a link, you approve it in a browser; `pnpm logout:openai` removes it; [`docs/SETUP.md`](docs/SETUP.md) step 5), and the server never logs in or calls OpenAI by itself.
Google and Jev are read from two more files in the same folder, which you make from their guides: `google-oauth.json` (the OAuth
client you created) and `jev.json` (the key); `pnpm connect:google` writes `google-accounts.json`. A missing `jev.json` means local
rules, a missing `google-oauth.json` means no Google account can be connected; neither stops the server.

Real push notifications need two things the server cannot provide. The page must be served over https (Tailscale Serve),
because browsers allow service workers and push subscriptions only on secure origins; `http://127.0.0.1` counts as one,
which is why development works. And on an iPhone the web app must first be added to the Home Screen. Then press
**Enable notifications** in Settings on each device. M2 was built and tested against the fake sender: a delivery through
FCM or Apple's push service has not been tried yet.

## Data directory

```text
data/
  app.sqlite       domain tables (agents, tasks, follow-ups, people, approvals, push subscriptions, daily schedule, journal, file index, health, ledger, splits, invoices, the inbox's accounts, mail with its full-text index, events, rules, suggestions and digest windows, questions between agents, remembered lines with their full-text index, the usage ledger and the weekly limits), WAL
  durable.sqlite   Durable's storage: conversations, entries, tasks (reminder timers included), WAL
  files/           uploads, `<yyyy-mm>/<id>-<name>`, mode 0600. Agents may read; the browser gets them back through `GET /api/files/:id`
  workspace/       generated files. The only place agents may write
    invoices/          the invoice PDFs, `<number>.pdf`; the browser gets them through `GET /api/files/:id`
      previews/        PDFs marked PREVIEW from `preview_invoice`, one per call; nothing refers to them but a chat card, so
                       the folder may be emptied at any time
  templates/       your document templates, mode 0700: `invoice.html` (the server writes a default the first time and never over yours)
                   and the images it uses. Agents can neither read nor change it
  secrets/         credentials and keys, mode 0700. Never readable by an agent
    credentials.json   the OpenAI sign-in, mode 0600, written by `pnpm login:openai`
    device-id          the installation id sent with the OpenAI sign-in, mode 0600, created the first time it is needed
    vapid.json         the Web Push key pair, mode 0600, created at the first start
    google-oauth.json  the Google Cloud OAuth client (Desktop app) you made: id and secret. You put it there (docs/setup-google.md)
    google-accounts.json  one refresh token per connected Gmail account, mode 0600, written by `pnpm connect:google`
    jev.json           `{ "JEV_API_KEY": "..." }`, optional: without it mail is sorted by local rules (docs/setup-jev.md)
  server.lock      held while a server runs on this directory (see below)
  dev-push-outbox.jsonl   what the fake push sender would have sent; only with ASSISTANT_PUSH_MODE=fake
```

Back both databases up together: `agents` in `app.sqlite` points at conversations in `durable.sqlite`, and the server
refuses to start if they disagree. (A crash between creating a conversation and recording it is repaired by itself at the
next start: every conversation is tagged with its agent inside the commit that creates it.) A task's reminder is also
split across the two: the `tasks_item` row says whether it is wanted and a Durable task is the timer, so at every start
the server recreates a timer the row wants and Durable lost. `app.sqlite` is written with `synchronous=FULL` and Durable's
database with `NORMAL`; see [`docs/design-notes.md`](docs/design-notes.md) for what that means after a power cut. Back up
`secrets/vapid.json` too: with a new key pair every device must enable notifications again.

One server per data directory: it holds `<data>/server.lock` while it runs, and a second start fails with the pid of the
first before it touches either database. A lock left behind by a crash is recognised as stale and taken over.

## Security rules

[`docs/PLAN.md` §2](docs/PLAN.md) is the source of truth. Where each rule lives in code:

- **No outbound actions, no bash:** no such tools exist. The file environment's `exec` always fails
  (`apps/server/src/env/scoped-env.ts`).
- **Deletes need your approval (rule 3):** the model can only ask. `delete_task`, `delete_followup` and `delete_person` are
  blocked by a `beforeTool` hook in code unless an approved request exists for exactly that task, follow-up or person in that
  conversation, whatever the model says
  (`packages/extensions/src/approvals`). You answer with the **Approve/Deny** buttons (`POST /api/approvals/:id`) or by
  replying exactly `YES`, which the server handles itself before the model sees it (only when one request is waiting and
  you have sent nothing else since it was made; otherwise use the buttons); the server then carries out the deletion. A
  request expires after 24 hours.
- **What the model provider sees:** everything you say to an agent and every tool result goes to the model provider (OpenAI
  in production), like any chat. For the Health agent that is your weight, the BMI when `ASSISTANT_OWNER_HEIGHT_CM` is set,
  your workouts and the notes you add. The PA is given a few lines of it (what you weighed and trained, a missed weighing) as
  facts for the briefing and the wrap-up, and what it writes in the journal may repeat them. Only the Health agent is told
  your height. For the Accountant it is your account names and balances, your entries, the receipts and statements you attach,
  the names of friends on a split bill, and what you tell it for the invoice (client, amount, bank details); the template file
  and the PDF are never put to the model. The PA is given the day's spending by category and what came in as facts for the
  wrap-up, and what it writes in the journal may repeat them. Pushes carry none of it (see "Pushes carry no content" below). In dev mode nothing
  leaves the machine.
- **What leaves the machine for mail (M5):** Gmail and Calendar are read through Google's APIs (`gmail.googleapis.com`,
  `www.googleapis.com`) over https with `GET` requests only. A copy of each mail (headers, snippet, up to 8,000 characters of text,
  never attachments) is kept in `app.sqlite`. When the Inbox agent reads or searches mail, what it reads goes to the model
  provider like anything else you say to an agent. If a Jev key is saved, each new mail's sender, recipients, subject, Gmail labels
  and the first 1,500 characters of its text go to `api.typesafe.ai` and to no other host. The morning briefing quotes the subjects of
  the top three mails that need you (one short line each, stripped of markup and hidden characters) to the PA's model. Pushes about
  mail say only "Your inbox digest", "The Inbox has a suggestion" or that an account needs to be connected again.
- **Files are an allowlist:** reads inside `ASSISTANT_READ_PATHS`, `<data>/files` and the workspace; writes only inside
  `<data>/workspace`. Always refused, in any letter case: `.ssh`, `.env*`, `auth.json`, `*.pem`, `*.key`, `.netrc`, `.npmrc`,
  `.aws`, `.git-credentials`, `.gnupg`, `id_*` and `<data>/secrets/**`. The data directory, the workspace and the secrets
  folder are resolved through symlinks at startup and every path is resolved before the check, so a link cannot smuggle a
  protected file in. A read path that would expose the databases is rejected at startup. The PA's file tools
  (`read_file`, `list_dir`, `read_file_path`, `search_files`) go through the same environment, so the list holds for them
  too: `list_dir` does not show a protected file, and a read of one or of a path outside the folders is refused with the
  reason. An upload cannot be a way around it: it is stored under `<data>/files` by an id the server chooses, judged by
  its content (an image, a PDF, CSV or UTF-8 text; text holding a private key is refused), served back with `nosniff`, a
  sandboxing CSP, and as a download unless it is an image.
- **Templates and invoices:** `<data>/templates` is not a read path and not the write path, so no agent can read or change the
  owner's invoice template (an `ASSISTANT_READ_PATHS` entry inside it is rejected at startup). The template can only reach a PDF
  through fixed fields (`docs/setup-invoice.md`): fields are HTML-escaped, nothing in it runs, an image must be a file below that
  folder (links resolved) or a `data:` PNG or JPEG, and a web address is refused, so rendering fetches nothing. Invoice PDFs are
  written in `<data>/workspace/invoices`, served only from there (`GET /api/files/:id` resolves the path again at each request), as
  downloads with `Content-Security-Policy: sandbox`. There is no tool that sends an invoice anywhere (PLAN rule 1).
- **Mail is read-only, and email is untrusted (rules 1 and 6):** the Google permissions asked for are constants
  (`gmail.readonly`, `calendar.readonly`, `openid`, `email`: `apps/server/src/google/oauth.ts`), the HTTP clients behind the Inbox
  tools only `GET` and only to Google's hosts, and no tool can send, reply, label, archive or delete, so there is nothing for a
  prompt to talk a model into. The Inbox agent has no file tools, no approval or search tools and no way to call another agent:
  its only tools are `search_mail`, `read_mail`, `list_events`, `mark_triage`, `propose_sender_rule`, `suggest_followup`,
  `recall` (it reads memory and never writes it) and `current_time` (capability by tool presence, tested through the whole server). Text from an email is data: every tool result
  frames it as such, the Inbox's and the PA's instructions say never to follow it, and what it can reach is bounded:
  `mark_triage` changes one mail's category and nothing else, a lasting rule for every later mail of a sender is only a card
  (`propose_sender_rule`) that takes effect when you tap **Approve** (a typed YES does not count), `suggest_followup` only writes
  a card, and the PA acts on it only when you press **Add**, on a message the server writes from the stored suggestion (not from
  model text).
  Only `ask_agent` (the PA's alone) crosses between agents. Disconnecting an account in Settings is your own action, local and
  without approval (rule 3 is about the assistant deleting); it deletes no mail.
- **Secrets:** `<data>/secrets` is 0700 (`pnpm connect:google` closes it too if you made it by hand); `credentials.json`,
  `vapid.json` (the Web Push private key, created at the first start) and `google-accounts.json` (the Gmail refresh tokens) are
  0600, written atomically and fsynced; `google-oauth.json` and `jev.json` are yours to place, and the server tightens `jev.json` and
  `google-accounts.json` to 0600 if they are wider. Access tokens are kept in memory only. The private key never leaves that folder: browsers get only the public
  key. The credential store is locked (`credentials.json.lock`) against a second writer, such as a future login command
  running beside the server, and removes temp files a crashed write left behind. The data directory is set to 0700 at
  every start.
- **Pushes carry no content:** a push travels through Google's or Apple's servers, so it says only "Reminder" and
  "1 reminder", "1 meeting is about to start", "1 question: how did it go?" or "1 birthday today" and links to the chat
  (`reminder.ts`, `followups/task.ts`, `people/task.ts`). Task titles, meeting names, agenda points and people's names stay
  on this machine and in the chat. Only `apps/server/src/push/sender.ts` talks to a push service; a subscription it reports gone (404/410) is
  deleted.
- **Network:** the server binds `127.0.0.1` only. For every API request, in both auth modes: the `Host` header must be one
  the server is meant to answer to (the loopback names on its port, plus `ASSISTANT_PUBLIC_HOST`), which defeats DNS
  rebinding; state-changing requests that the browser marks `Sec-Fetch-Site: cross-site` are refused; every POST/PUT must be
  `application/json`, which makes a cross-site form post impossible. The one exception is `POST /api/uploads`, which takes
  one `multipart/form-data` file per request and so cannot be protected by that rule: it **requires**
  `Sec-Fetch-Site: same-origin` or `none` (every browser sends it; a script or a form on another site cannot forge it),
  on top of the `Host` rule and the auth below, and nothing else is exempt. Tailscale identifies the owner by device, not by
  cookie, so without these another website could act as the owner from the owner's browser. With auth on, the peer must
  also be loopback and `Tailscale-User-Login` must equal `ASSISTANT_OWNER_LOGIN`. JSON bodies are limited to 256 KB, an
  upload to 20 MB, and at most 8 event streams stay open. The reasoning is in [`docs/design-notes.md`](docs/design-notes.md).
- **The browser never sees** the system prompt (the agent's `instructions`), server paths or opaque provider signatures
  (`apps/server/src/wire.ts`). It does see the agent's model name and thinking level.

## How it fits together

```text
browser ──/api/*──► Next (dev proxy)  ──►  Hono API ──► Durable Harness ──► durable.sqlite
   ▲                                          │  └─► app.sqlite (agents, tasks, approvals, push)
   └──────── SSE: snapshot, then deltas ◄─────┘   stream.ts (the only user of watchEvents)
```

- `GET /api/agents` (agents plus `health`: how many tasks are parked, and which), `GET|POST /api/conversations/:id/messages`,
  `POST …/abort`, `GET …/stream` (SSE), `GET /api/settings/agents`, `GET|PUT /api/settings/agents/:id` (model and thinking
  level, validated against the models this server serves), `GET /api/push/config` (the public VAPID key),
  `POST|DELETE /api/push/subscribe` (one device's subscription), `POST /api/approvals/:id`
  (`{ "decision": "approve" | "deny" }`), `POST /api/admin/tasks/:id/retry`, `GET /api/settings/schedule` and
  `PUT /api/settings/schedule/:job` (`{ "localTime"?, "enabled"? }`, job `briefing` or `wrapup`), `POST /api/uploads`
  (multipart, one `file` field) and `GET /api/files/:id` (an upload, back). The owner's pages use `GET /api/profile`,
  `PUT /api/profile/preferences` (`{ "tone"?, "explanations"? }`, `null` clears one), `GET /api/memory` (`scope`, `kind`, `q`,
  `limit` up to 500), `PATCH /api/memory/:id` (`{ "text"?, "pinned"?, "scope"? }`: `scope` moves the line), `DELETE /api/memory/:id`, `GET /api/activity` (`agent`, `from`, `to`, `limit`, `cursor`), `GET /api/usage` and
  `PUT /api/settings/budget/:agent` (`{ "weeklyTokens": 500000 | null }`). Errors are
  `{ "error": { "code", "message" } }`. Types are in `packages/shared`. Only conversations that belong to an agent are
  reachable.
- A message needs a client-generated `requestId`; resending it never sends the message twice. The web app keeps one id per
  message across retries.
- Every SSE connection starts with a `snapshot` event (system entries removed, newest 200 entries, and why recent messages
  were never answered), followed by Durable's agent events as they are committed, every 100 ms while an answer streams.
  A named `ping` event arrives every 15 s; the browser reconnects after 40 s of silence, and when the tab or the network
  comes back. Reconnecting just gets a fresh snapshot. Older history comes from `GET …/messages?before=`.
- The port is bound before Durable is opened and answers 503 "starting" meanwhile.
- **Reminders cost no model tokens.** `add_task` with a reminder time (or `snooze_reminder`) starts a Durable task that
  sleeps until then. When it wakes it writes an `app.reminder` entry into the `pa` conversation (shown as a card; display-only,
  the model is never called for it, even if an earlier run failed and left a message queued) and sends the push. "Snooze
  it" still works because the `tasks` prompt section lists the reminders that were sent for tasks that are still open. The
  `tasks_item` row is the truth and the Durable task only a timer: rescheduling, snoozing, completing or deleting change
  the row, and an outdated timer ends itself. A reminder that came due while the server was down fires when it starts again,
  and the server checks for due reminders every 30 seconds and repairs lost or failed timers every 10 minutes, so a machine
  that wakes from suspend catches up (it does not wake itself: [`docs/OPS.md`](docs/OPS.md)). The model learns what time it
  is from the `current_time` tool, works in `ASSISTANT_TIMEZONE`, and times are stored as UTC.
  Reasoning: [`docs/design-notes.md`](docs/design-notes.md).
- **Follow-ups and birthdays work the same way as reminders** (the `followups` and `people` modules): a row in `app.sqlite`
  is the truth and a Durable task is its timer, with the repair at start and every ten minutes shared with reminders
  (`packages/extensions/src/timers.ts`). A meeting's timer sleeps until the agenda is due, posts it only if there are
  points, sleeps until the end of the meeting and posts the question (a commitment is also nudged when it is due), and asks
  once more the next morning if nobody answered; the answer comes through the `record_outcome` tool, which resolves it and,
  when something has to be followed up, creates the next link of the chain. A person's timer wakes in the morning of their
  birthday and in the evening, then starts next year's; the birthday cards that a power cut took from Durable's database
  after the cycle had ended are posted again at start. A card that a timer posts is display-only
  and costs no model call; the `followups` and `people` prompt sections (from the database, no clock beyond the local date)
  tell the model which questions are open, so "they agreed to a viewing on Friday" and "yes, I did" find what they answer.
  Reasoning: [`docs/design-notes.md`](docs/design-notes.md).
- **The daily jobs work the same way again** (the `daily` module): `schedule_daily` has one row per job (local time, on or off,
  the run that is waiting) and a Durable task `app.daily` is its timer. At the time the server gathers facts from every
  module that registered a provider (today's tasks and reminders, overdue tasks, meetings and follow-ups with their agenda
  counts, open questions, birthdays today and in three days, yesterday's carried-over items) and puts them to the PA as one
  request, an `app.daily` entry that the thread shows as a card, with a generic push; the instructions for writing the
  briefing live in the PA's rules, not in the day's text. With nothing to report the briefing is a card and no model call. The
  wrap-up always asks what you got done, with what the system recorded, and `save_journal` keeps the answer in `pa_journal`
  (one row per day, replaced by a later answer; replaying a call changes nothing). The briefing is run late, once, when the
  server starts or wakes after its time and before 11:00 (a wrap-up before midnight); a job's first start, an edit in
  Settings and a day that already ran are never "late". Times are local to `ASSISTANT_TIMEZONE` and follow its clock changes.
  Reasoning: [`docs/design-notes.md`](docs/design-notes.md).
- **Files.** `POST /api/uploads` stores a file under `<data>/files/<yyyy-mm>/` and indexes it in `files_index` (name,
  type found by looking at the content, size, a description and tags the PA can add). A message names its files with one
  `[Attached file: …]` line each, which the web app writes and shows back as chips; the PA reads them with `read_file` (its
  own bounded reader: text and CSV by lines, images through the image processor so that the model sees them, PDFs not
  yet). Behind the Next dev proxy (`next dev`, or `next start` without Tailscale Serve) uploads work up to the cap because
  `apps/web/next.config.ts` lifts Next's 10 MB limit on proxied bodies; in production Tailscale Serve sends `/api/*` to
  the server directly.
- **Parked tasks:** a task cut off by crashes (not by a normal stop) five times in a row is parked by Durable and does
  nothing until retried. The server logs it as an error at every start and the web app shows a banner with a **Retry**
  button (`POST /api/admin/tasks/:id/retry`; from a shell it needs `Content-Type: application/json` even without a body, see
  [`docs/OPS.md`](docs/OPS.md)). Nothing retries it automatically: find out why the process kept dying first.
- **A restart mid-answer** keeps what had been written as an interrupted message and answers again from the same
  question, once. Nothing is sent twice. The browser shows "Reconnecting…" meanwhile.

## Tests

`pnpm test` runs everything against the faux model with no network and no push service: the migration runner (ids per
module), config validation, the file environment, credential store and file locks, agents, the HTTP API, the stream module,
the full server over real HTTP and SSE including a restart in the middle of an answer and a child process killed with
SIGKILL, and the web reducer and store. M2 added, all with a fake clock and a fake push sender:

- the task tools, driven by scripted tool calls: the same call id twice makes one row (also when the replay runs after the
  reminder time has passed), and a replayed snooze does not move the reminder twice;
- reminders: fire once, including across a crash between posting the card and recording it, and again when Durable's
  database comes back older than app.sqlite (a simulated power cut); snoozing, completing, clearing or deleting cancels;
  close and reopen; a timer Durable lost or faulted is recreated (at start, and by the periodic repair); the card never
  starts a model run, even with a failed run's message queued; the server wakes a due reminder by itself;
- approvals: the hook blocks and permits, a reply of YES (only the exact word, only when it is the one request waiting and
  nothing else was said since, resends, other conversations), the 24 hour expiry, notices lost in a power cut come back,
  rows of a conversation that is gone are reported and do not stop the server;
- push: the sender gets the minimal payload, a 404/410 removes the subscription, the key file is created 0600, endpoints
  that are not public hosts are refused, the subscription follows the server's key and the push service's changes;
- the web: reminder, notice, task and approval cards rendered from a recording of the real server, the agenda, question and
  birthday cards, the service worker
  (including addresses that leave the site only after URL parsing), the notification setup, and the API client's approval
  and retry calls.

M4 added: the daily engine with a fake clock (the next run across the clock changes of New York in 2026 and across midnight,
the late window, once per day, a first start and an edit are not late, a crash between the plan and the request, a power
cut), the facts providers and an empty day that costs no model call, the journal tools (a replayed call, a later answer, a
future date), the uploads (the `Sec-Fetch-Site` rule, `Host`, size, type by content, a private key, every other write still
refusing a form), the file tools and the deny list through them (`.env*`, `id_*`, keys, links into them, the databases,
anything outside the roots), the share target route with a fake `fetch`, and the web pieces that need no browser (cards,
chips, attachments, the capture address, the upload client over a fake request).

M3 added, again with a fake clock and a fake push sender: the follow-up life cycle (the agenda only when there are points and
only before the meeting began, the question after the end time, the chain of follow-ups until one resolves, repair, a
restart, a crash between posting and recording, Durable's database coming back older than app.sqlite), agenda points matched
to meetings by words (and the list of candidates when it is ambiguous), the birthday cycle (local morning and evening, skipped
when wished, 29 February, years missed during a long stop, across a change of the clock), the prompt sections, the
configuration of the times, and the whole server over HTTP for both. The review fixes added: a YES typed to a question a timer
asked, birthday cards lost to a power cut (also over the whole server), a birthday corrected within the year, the re-ask, the
nudge of a commitment, a date without a time, `update_followup`, and which tools the PA is offered.

The web reducer is tested against event streams recorded from the real server (`apps/web/test/fixtures/*.json`; M2 added
`reminders-approvals.json`: a reminder firing and a deletion approved with the button). Durable's event protocol is
experimental: after upgrading it, run `node apps/server/scripts/record-fixtures.ts` (it re-records all five), review the
diff, and run the tests.

M6 added: the unit conversions (pounds to kilograms once, precision of a scale), exercise names (aliases, plurals, spacing,
unknown names, no two built-in exercises sharing a name), the arithmetic as pure functions (7-day moving average with its
window edges, trend and weekly rate, Epley, top set, volume, personal records over the whole history, bodyweight by reps,
thinning a chart, ranges), the tools driven by their call id (a replay on another day writes once; a replaced weight is not
undone by a replay of an earlier call; a workout is written whole or not at all), the one-weighing-a-day rule with its
`replace` flag, deleting through approval with the hook in front of both deletion tools, the prompt section (no clock: the
same bytes whenever nothing is logged), the facts the wrap-up and the briefing get, the whole server (the Health agent has
its own tools and the PA does not, a YES in the Health thread, the daily jobs carrying the health lines), and in the web the
chart geometry and the cards rendered to markup with `react-dom/server`.

M6's review fixes added: what an exercise is measured in (a bodyweight exercise follows its added weight once a set has
one, unloaded days counting 0; a new exercise logged first without a weight is followed by its load later), the refusal that names
`Bodyweight <exercise>`, averages, trends and changes checked against an integer oracle on 300 random histories (a mean exactly
half-way between two tenths is rounded once), a chart thinned to 90 points that still ends with the latest five days and keeps
the newest records, a replayed `log_workout` answering with the same records and new-exercise notes as the first run, renaming
(and a replay that does not undo a later rename) and merging (approval, set numbers, aliases, the refusals), names in any
script and `-ies` plurals, ranges that reach too far, the height kept out of every other agent's prompt (read from what the
model was told, with a positive control), and in the web the card of a loaded bodyweight exercise.

M7 added: the money arithmetic as pure functions (amounts turned into minor units by their digits and refused with too many
decimals, percentages, largest-remainder sharing, conversions at an owner-given rate, bank amounts such as `(500.00)`, `500 DR` and
`1.234,50`), the ledger (balances as the latest stated balance plus what was written after it, in either order on the same day;
transfers that are neither spending nor income; summaries whose shares add up to exactly 100.0 %; merchant memory; replays by call
id; deleting through approval with the hook in front), CSV import (encodings, separators, a header below title lines, day-first
dates, the preview before anything is written, an idempotent confirm and the same file twice), code mode through a real Harness
(a script that sums the ledger, its nested calls journaled once, the approval hook applying to a script's call), splits (600 random
bills whose shares add up to the total exactly and are within one unit of each person's exact claim, tax and service in proportion,
netting per pair and currency, settlements, deleting a bill through approval), invoices (numbers never reused and idempotent per
call, two calls at once taking two numbers, a failing template using none, a real PDF whose text is read back, fields escaped,
a template with a bad tag or a field that does not exist, images only from the templates folder), the rebuilt file index, the whole
server (the Accountant's tools and nobody else's, a YES in its thread, a script in the sandbox, an invoice downloaded through the
API, a template that survives a restart, files served only from the folder their kind belongs in), and in the web the cards
rendered to markup.

M7's review fixes added: code mode with a time limit (a script that never ends stops at 30 seconds, a request for a day is cut
to two minutes, and a script a restart interrupted past its deadline ends with an error instead of starting again); hostile CSV
cells (200,000 spaces, `T`s, digits or colons read in a few milliseconds, each under a time bound); Dr/Cr columns in the three
shapes bank files use, with a loud warning when every row of a long statement goes one way; rows that repeat an entry typed or
photographed earlier (left out by default, one entry answering for one row, a deleted twin imported after all) and taking a whole
import back through approval, also after it was read again; a settlement whose name is only part of a friend's (nothing is
recorded, the full name is asked for, and a bill is only flagged); the bulk `recategorize` (the merchant's whole name, a
confirmation above 20 entries, an undo by batch that leaves later changes alone); the PREVIEW watermark and an invoice preview that
takes no number; and the file-serving tests, which now create one real file per row and read it back before trusting a status (a
link to the outside, a sibling folder, and a control that stays inside and is served).

M5 added (all against fakes: no call to Google, TypeSafe or OpenAI): the whole sign-in against a fake token endpoint on 127.0.0.1
(the consent link has exactly the four scopes and a PKCE S256 challenge, the verifier sent with the code hashes to it, a request
with the wrong state, path, method or `Host` is refused and the flow keeps waiting, the listener is bound to 127.0.0.1, the token
file is 0600 in a 0700 folder, a sign-in without a scope, a refresh token or for another client saves nothing, `invalid_grant`
marks the account); the Gmail and Calendar clients over a fake `fetch` (GET only, Google's hosts only, retries, history, an
expired history, all-day events) and the MIME reader against hostile input in bounded time; the sync with a fake Gmail history
(incremental, deleted and relabelled mail, an expired history read again, one message that fails every time without holding the
others back, given up on after five syncs and shown in Settings); the triage rules by category and reason, what the
owner approved, Jev's contract played by a fake server (the exact URL, no redirect, the three questions, 1,500 characters, the
answer shapes, a refused key, an outage, a never-ending answer), a sync with Jev down and back, Jev paused after three failures in
a row and asked again after the cool-down, and a slow Jev that cannot stretch a sync; the digests through the daily
engine (selection, the three-day limits, windows that tile and survive a rerun and a power cut, the empty digest that costs no
tokens and sends no push, the briefing's Inbox line); the Inbox tools (FTS search that words cannot break out of, bounded
`read_mail`, events, `mark_triage` once per call id and for one mail only, a sender rule that exists only after Approve, suggestions
posted once, Add and Dismiss, the first answer standing, a suggestion that expires after a week); `ask_agent` (replay, timeout,
a late answer); the capability boundaries through the whole server, real mode with the saved sign-in (revoked, reconnected) and
Jev; and the web's mail, digest, suggestion and Settings cards rendered to markup, a mail link that only ever goes to Gmail.
