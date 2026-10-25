# Running the assistant

Notes for whoever keeps the server up. Installing it is [`SETUP.md`](SETUP.md), one ordered list; settings are in the
[README](../README.md#configuration); the reasons behind the design are in [design-notes.md](design-notes.md). This file is
what to know once it is running: the services, the health check, and what to do when something needs you. It still grows with
the first real deployment (backups are not automated).

## Keep the machine awake

Reminders fire from timers inside the server process, so a machine that suspends does not remind anyone. The server checks
every 30 seconds for reminders that came due and fires them, so when the machine wakes up a late reminder arrives within
about half a minute (it says when it was due). But nothing wakes a suspended machine for a reminder, and one that falls due
during the sleep is as late as the sleep. On Linux Node's timers do not count suspended time (standard behaviour; not
measured on this laptop), and most desktop distributions suspend a laptop when the lid is closed.

If reminders matter, turn suspending off on the machine that runs the server:

- GNOME: Settings → Power → Automatic Suspend off (both on battery and plugged in); and what closing the lid does is a
  systemd setting, below.
- Closing the lid, any distribution with systemd: in `/etc/systemd/logind.conf` (or a file in
  `/etc/systemd/logind.conf.d/`) set

  ```ini
  HandleLidSwitch=ignore
  HandleLidSwitchExternalPower=ignore
  HandleLidSwitchDocked=ignore
  ```

  and reboot, or restart `systemd-logind` (restarting it can end the graphical session on some systems).
- Nothing may suspend it at all (idle timers, a power button): `sudo systemctl mask sleep.target suspend.target
  hibernate.target hybrid-sleep.target`. Undo with `unmask`. Check with `systemctl status sleep.target`.

Keep it on mains power too: a power cut loses the last writes of Durable's database (see
[design-notes: two databases](design-notes.md#two-databases-two-durability-levels)). The server repairs what it can at the
next start and says so in its log (`[tasks] … had no live timer … scheduled again`).

## The two services (systemd)

`ops/systemd/assistant-server.service` runs `apps/server/dist/main.js` and `assistant-web.service` runs the built web app
(`next start`, started through Node, so the unit needs no pnpm). Both run as an ordinary user, `Restart=on-failure` after 5 seconds,
with `NODE_ENV=production` and the settings of `/etc/assistant/assistant.env`; the lines marked `CHANGE` are the user, the
repository path, the absolute path of Node and the data folder. `ops/install-units.sh` fills them in and installs both (step 7 of [`SETUP.md`](SETUP.md)),
so the files in `ops/systemd/` are never edited; to change an installed unit, `sudo systemctl edit --full assistant-server`.

```sh
systemctl status assistant-server assistant-web
journalctl -u assistant-server -f                 # the server's log: [db] migrations, [daily], [inbox], [usage], errors
journalctl -u assistant-web -n 100 --no-pager
sudo systemctl restart assistant-server           # after editing the settings file or jev.json
sudo systemctl reset-failed assistant-server && sudo systemctl start assistant-server   # after `start-limit-hit`, below
```

A unit that fails to start ten times within five minutes (`StartLimitBurst=10` with `RestartSec=5`: about a minute of crash loop) is stopped for good so that a loop does not hammer the model or the push
services; `systemctl status` then says `start-limit-hit`. Read the journal, fix the cause, run the `reset-failed` line above.

What the hardening lines are for, and what they must not break: `ProtectSystem=strict` makes the system read-only and `ReadWritePaths=` (the data
directory, and only it) is the one place the server writes; `ProtectHome=read-only` (not `true`) keeps `~/Documents` and `~/Downloads` readable for
the file tools; `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges`, `CapabilityBoundingSet=` (empty), the `Protect…` and `Restrict…` lines and `UMask=0077`
take away what a Node server and a web app never use. There is no `MemoryDenyWriteExecute` because V8 needs memory that is writable and executable.
A start that fails with a permission error names the path in the journal: it is nearly always `ReadWritePaths=` not matching `ASSISTANT_DATA_DIR`, or a
folder in `ASSISTANT_READ_PATHS` under a directory the unit cannot see. `systemd-analyze verify` on the two files is silent when they are well formed.
A server that stops cleanly takes a last usage reading and releases `<data>/server.lock`; one that was killed leaves the lock, which the next start recognises as stale.

## The health check

`ops/check.sh --env-file /etc/assistant/assistant.env` reads the machine and prints one line per check: `PASS`, `FAIL` (what to do is in the line), `WARN` or `SKIP`;
it exits 1 if anything failed, so it can run from cron or a timer. `--dry-run` lists the checks without reading anything; `--only files` runs one group (the groups are
`files lock host ports api web tailscale systemd power`) and `--skip tailscale,systemd,power` leaves some out (on a laptop without Tailscale, say). It changes nothing on the machine and prints no key or token
(it does print the public host name, and the addresses of Google accounts that need connecting again); its requests, `GET /api/agents` here and through Serve, are ordinary reads. What each group means:

| Line starts with | Looks at | A `FAIL` means |
|---|---|---|
| the data folder, `secrets`, files in it | modes 0700 and 0600 | something readable by other users: `chmod` it as the line says |
| the OpenAI sign-in, push keys | `credentials.json`, `vapid.json` | `pnpm login:openai`; the server makes `vapid.json` at its first start (a `WARN` before it ever ran) |
| `ASSISTANT_OWNER_LOGIN`, `ASSISTANT_PUBLIC_HOST` | set, and not the example values of `ops/assistant.env.example` | the example values are accepted by the server and the phone is then refused (401, or 403 for the host) |
| Google accounts, Jev | `google-accounts.json`, `jev.json` | an account that needs connecting again (below); no Jev key is a `WARN` (Rules mode) |
| the server, the lock | `<data>/server.lock` names a live process | the service is not running: `journalctl -u assistant-server` |
| ports | 3000 and 3001 listen on `127.0.0.1` only | listening on another address would bypass Tailscale: fix `--hostname` in the web unit |
| the API | `GET /api/agents`: four agents, no parked task, no agent over its limit | a parked task: below. An agent over its weekly limit is a `WARN` |
| Tailscale | Serve maps `/` to the web app and `/api` to the server's `/api`, Funnel is off, and `https://<host>/api/agents` answers through Serve | run `ops/tailscale-serve.sh`; Funnel on makes the assistant public: run the script, which removes it |
| services, power | both units active; sleep targets masked | only ever a `WARN`: `systemctl status …` (fine if you start the services another way); a machine that can suspend reminds nobody |

## Tailscale Serve

`ops/tailscale-serve.sh` maps `https://<name>.<tailnet>.ts.net/` to the web app and `/api` to the server, reads the configuration back and prints the two lines for the settings file
(`ASSISTANT_PUBLIC_HOST` and `ASSISTANT_OWNER_LOGIN`). It replaces the mapping of each path, so running it again changes nothing; `--dry-run` prints the commands. It needs `sudo tailscale set --operator="$USER"` once.
**Funnel** (the public internet) is never turned on by anything here, and each `tailscale serve` run removes it from the port it serves; the script and `ops/check.sh` verify that it is off. Do not use
`tailscale funnel --https=443 off` for that: with no path given it deletes every handler of the port, the two mappings included.

**The `/api` target ends in `/api` on purpose.** Serve removes the mount path before it forwards (tailscale/tailscale#6571), so a request for `/api/agents` reaches the target as `/agents`; the server only
routes `/api/*`. With the target `http://127.0.0.1:3001/api` the server sees `/api/agents` again. A mapping without the suffix loads the page and answers 404 to everything the page asks: `ops/check.sh` says so.
`tailscale serve status` shows the result. The auth rule depends on it: the server only accepts a request that arrives from loopback with `Tailscale-User-Login` equal to `ASSISTANT_OWNER_LOGIN`, which
Serve adds, and only by a host name in `ASSISTANT_PUBLIC_HOST`. If the machine is renamed, run the script again and update `ASSISTANT_PUBLIC_HOST`. The flags and the stored form were read from Tailscale's source
and its `--help`, not run against a tailnet (PLAN §9): if `tailscale serve` rejects one, `tailscale serve --help` has the current form.

## What to do when…

- **A banner says an agent used its weekly limit.** Nothing is broken: its briefing, wrap-up and digests are plain cards (the facts, no model text) until Monday, and what you type still
  gets an answer. **Usage** shows what it spent; raise the limit there (`2m`) or clear the box for no limit, and the next run is normal. The meter is the provider's `totalTokens`, which
  includes cache reads, so an agent with a long conversation reaches a limit sooner than the visible text suggests. If the Usage page shows zeros while the agents answer, the provider
  is not reporting usage and the limit cannot trip.
- **The check or the Assistant says a task is parked.** Durable parks a task after repeated crashes (the Settings page lists it). Read the journal for the error, then
  **Retry** (or `POST /api/admin/tasks/<id>/retry`, [below](#calling-the-admin-endpoint-from-a-shell)) once the cause is fixed.
- **An account says "Needs to be connected again".** Google refused the saved sign-in (revoked, or expired after 7 days in Testing mode: [`setup-google.md`](setup-google.md)). `pnpm connect:google` for that
  address; its mail stays, and the next sync catches up.
- **The assistant stopped answering with a model error.** The sign-in may have been refused: `pnpm login:openai` again (`check.sh` says `FAIL` when none is saved). No restart is needed.
- **A remembered line is wrong or an agent remembered something it should not have.** **Profile → What is remembered**: edit or delete it (no approval is asked on that page); the agents see the change from their next message.
- **An agent asks you to approve a preference.** Only you can add one: an agent that thinks you asked for it files a request (an approval card in its chat; reply YES or tap Approve). Deny what you did not ask for: a preference
  goes into the prompt as your instruction, for one agent or for every agent. The line keeps who asked (Profile shows it). A fact an agent noted stays with that agent; **Move to → Every agent** on the Profile page shares it.
- **The page loads but nothing in it works** (no agents, every request fails). The `/api` mapping of Tailscale Serve is wrong: `ops/check.sh --only tailscale`, then `ops/tailscale-serve.sh`.
- **Notifications stopped on one phone.** The subscription expired: open the app, Settings → Enable notifications. If every phone stopped after a restore, the `vapid.json` key pair was replaced.

## Clearing what the server cannot repair

At start, and every ten minutes while it runs, the server repairs reminders, meetings, birthdays, the daily jobs and approval notices that a power cut or a crash
left inconsistent. One that cannot be repaired does not stop the server: it is logged once per run with the command that
clears it, for example after `DELETE FROM agents` (which makes new conversations and leaves the old tasks pointing at ones
Durable no longer has):

```sh
# the task keeps existing; only its reminder is dropped
sqlite3 <data>/app.sqlite "UPDATE tasks_item SET remind_at = NULL WHERE id = 't_ab12cd34'"
# a meeting or a person whose conversation is gone: point it at the assistant's current conversation, and the next repair
# gives it its timer again
sqlite3 <data>/app.sqlite "UPDATE followups_item SET conversation_id = (SELECT conversation_id FROM agents WHERE id = 'pa') WHERE id = 'f_ab12cd34'"
sqlite3 <data>/app.sqlite "UPDATE people_person SET conversation_id = (SELECT conversation_id FROM agents WHERE id = 'pa') WHERE id = 'p_ab12cd34'"
# the owner's answer is saved; stop trying to write its notice into a thread that is gone
sqlite3 <data>/app.sqlite "UPDATE pending_actions SET notified_at = 0 WHERE id = 'ap_ab12cd34'"
```

Stop the server before editing `app.sqlite` by hand, or at least expect it to be busy for a moment.

The daily briefing and wrap-up (`schedule_daily`) need nothing cleared by hand: the row is the truth, so a timer Durable lost is
made again, and a job whose conversation is gone is reported once (`[daily] could not give the briefing job its timer …`)
with what to check; switching the job off in Settings (or `UPDATE schedule_daily SET enabled = 0 WHERE job = 'briefing'`) silences it.
At a first start the log says `[daily] scheduled for the first time: briefing, wrapup` (a set-up, not a fault). The message
`[daily] N daily job(s) had no live timer … scheduled again` at any other start is the repair: it means Durable's database
lost a timer (a power cut) or ended it after an error.

Three things the server does without being asked, and does not log unless something is wrong:

- **Today's briefing or wrap-up a power cut took.** A run is written to `durable.sqlite` and recorded in `app.sqlite`. At every
  start, for a job that ran today, the server makes the same request again with the same request id (a thread that has it
  keeps one) and no push; the log says `[daily] checked that today's briefing is in the thread`.

- **Birthday cards a power cut took.** A birthday's card is written to `durable.sqlite` (which can lose its last writes in a
  power cut) and the row moves on to next year in `app.sqlite` (which cannot). At every start the server posts again the
  evening question of the last 24 hours that nobody answered, and the morning card while its day is not over, with the same
  request id (a thread that has them keeps one) and no push.
- **Tasks that cannot run.** `[durable] N task(s) cannot run` at start means Durable has a sleeping timer that no installed
  definition fits (its extension is gone, or its version has no migration): the reminder, meeting or birthday it stood for is
  silent. Put back the code that defined it, or add the migration (`docs/design-notes.md`, "Changing a task that may be
  sleeping"). This is not the parked state and **Retry** does nothing for it.

## Uploads and the share target

- **Where files are:** `<data>/files/<yyyy-mm>/<id>-<name>`, mode 0600, indexed in `files_index` (back them up with the two
  databases: the index points at them by path). Nothing deletes a file. An upload cut off between its rename and its row (a
  crash in that instant) leaves a file with no row; it is harmless and can be removed by hand.
- **Size limit and the web proxy:** an upload is capped at 20 MB by the server. `next dev`, and `next start` without Tailscale
  Serve, proxy `/api/*` and Next refuses proxied bodies over 10 MB unless told otherwise; `apps/web/next.config.ts` raises its
  limit to the upload cap (`experimental.proxyClientMaxBodySize`). If a Next upgrade renames that setting, large uploads
  hang and the browser shows "not answering properly (HTTP 500)" while the server log shows nothing: check the Next log for
  `Failed to proxy … socket hang up`. Behind Tailscale Serve the API gets `/api/*` directly.
- **From a shell**, an upload is the one multipart write and needs the header a browser would add:
  `curl -F file=@x.png -H 'Sec-Fetch-Site: none' http://127.0.0.1:3001/api/uploads`, plus `Tailscale-User-Login` when auth
  is on. Without `Sec-Fetch-Site` the answer is `403`.
- **The Android share target** only exists for the installed web app, which needs https (Tailscale Serve provides it); open
  the app from the home screen once after an update so that Chrome re-reads the manifest. If sharing to the app answers
  "The assistant takes a share only from the Android share sheet or its own page" (403), the browser did not send
  `Sec-Fetch-Site: none` for the share POST; see `docs/design-notes.md`, "The Android share target".

## What to back up (the Accountant's files)

Besides the two databases and `files/` (above), two folders hold what cannot be made again:

- **`<data>/templates/`** is your invoice template and the images it uses. Only you can change it, and the server never
  overwrites it, so a lost one is a lost layout.
- **`<data>/workspace/invoices/`** has the PDF of every invoice that was made, under its number (`INV-2026-004.pdf`). The database
  keeps the numbers, dates and amounts but not the PDF's layout, and an invoice cannot be made again under its own number: asking
  for the month again (`again: true`) takes a **new** number. A lost PDF is therefore lost, unless it was backed up or you sent it.
  The `previews/` folder under it can be emptied at any time.

## Calling the admin endpoint from a shell

Every write must be JSON, even one without a body. With authentication on, a request that does not come through Tailscale
Serve also needs the header Serve would add, naming the owner (`ASSISTANT_OWNER_LOGIN`):

```sh
curl -X POST http://127.0.0.1:3001/api/admin/tasks/17/retry \
  -H 'Content-Type: application/json' -H 'Tailscale-User-Login: you@example.com'
```

Without `Content-Type: application/json` the answer is `415`; without the header, `401`. With `ASSISTANT_AUTH=off`
(development only) no header is needed, but the content type still is.
