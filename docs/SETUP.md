# Setting it up: everything the owner does, in one ordered list

This is the whole checklist for a first real deployment, in the order to do it. Every step has the exact command and how to see that it worked; the long ones
link to their own guide instead of repeating it. Nothing here is done by the software for you, and nothing is needed twice. At the end, `ops/check.sh` checks the
result in one go (step 14).

Commands run from the repository root, on the laptop that will run the assistant. `<data>` is the data directory: `./data` for the production server (relative to the
repository), `./data-dev` for `pnpm dev`, or what `ASSISTANT_DATA_DIR` says.

> **To verify.** Several steps touch services this repository could not reach while it was built: OpenAI, Tailscale, the push services, Google and Jev. Each step
> says what is **to verify** at your first real run; `docs/PLAN.md` §9 lists everything that was written without being run against the real thing.

## 1. Laptop: keep it awake and on power

A suspended laptop reminds nobody: reminders fire from timers inside the server, and nothing wakes a sleeping machine. Turn suspending off and keep it on mains power
(a power cut loses the last writes of one database: [design-notes](design-notes.md#two-databases-two-durability-levels)).

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo install -d /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' | sudo tee /etc/systemd/logind.conf.d/assistant.conf
sudo systemctl restart systemd-logind     # on some desktops this ends the graphical session: reboot instead if you prefer
```

GNOME: also Settings → Power → Automatic Suspend off. **Verify:** `systemctl is-enabled sleep.target` prints `masked`. Details and undo: [`docs/OPS.md`](OPS.md#keep-the-machine-awake).

## 2. Node 24 and pnpm 10

```bash
node -v      # v24.x
pnpm -v      # 10.x   (if missing: corepack enable && corepack prepare pnpm@10.15.1 --activate)
```

## 3. Get the code and build it

`/opt` belongs to root, so make a folder of your own in it first (any folder you own works: use it instead of `/opt/assistant` everywhere below). The code has to reach it from
somewhere, and this repository has no remote yet: either push it to a private one (in the checkout you have now: `git remote add origin <url> && git push -u origin main`)
and clone that, or clone the checkout that is on this machine. Only what is committed is cloned, so commit what you want to run first.

```bash
sudo install -d -o "$USER" -g "$(id -gn)" /opt/assistant
git clone <the url of your private repository, or the path of the checkout you have now> /opt/assistant
cd /opt/assistant
pnpm install --frozen-lockfile
pnpm build
```

**Verify:** `ls apps/server/dist/main.js apps/web/.next` finds both, and `pnpm typecheck && pnpm test` pass (a couple of minutes).

## 4. The settings file

The server reads its settings from environment variables; a systemd unit reads them from one file that holds nothing secret (the sign-ins live in `<data>/secrets/`).
The folder is readable by your group and the file is yours (mode 0600), so that you can read it, and so can `ops/check.sh`; systemd reads it as root.

```bash
sudo install -d -m 0750 -o root -g "$(id -gn)" /etc/assistant
sudo install -m 0600 -o "$USER" -g "$(id -gn)" ops/assistant.env.example /etc/assistant/assistant.env
sudoedit /etc/assistant/assistant.env
```

Replace the three required lines (`sudoedit` opens `$VISUAL` or `$EDITOR`: `EDITOR=nano sudoedit …` if you want nano). `ASSISTANT_PUSH_SUBJECT` is `mailto:you@example.com`: a contact for the push services (the VAPID key pair itself is made by the server at its first start, into
`<data>/secrets/vapid.json`). `ASSISTANT_OWNER_LOGIN` is your Tailscale login, the only identity let in, and `ASSISTANT_PUBLIC_HOST` the name of this machine on your tailnet: if you
do not know them yet, step 6 prints both, and you edit the file again then. The example values are accepted by the server and refused by `ops/check.sh`. Your name, time zone,
currency and height are optional and explained in the file; every variable is in [README → Configuration](../README.md#configuration). A wrong value stops the server at start
with a message that names it.

If you set `ASSISTANT_DATA_DIR` there, give the same folder to the commands you run from your shell (`pnpm login:openai` in step 5 and `pnpm connect:google` in step 10):
`export ASSISTANT_DATA_DIR=/the/same/folder`. (The file is in systemd's format, not a shell script: do not `source` it.)

**Verify:** `ops/check.sh --env-file /etc/assistant/assistant.env --only host` reads the file and says `PASS  ASSISTANT_OWNER_LOGIN is set` once it is replaced (and `WARN` about the public host until step 6).
If it says `FAIL  cannot read the environment file`, the folder or the file does not have the owner and mode above.

## 5. Sign in to OpenAI (the model)

```bash
pnpm login:openai
```

It prints a link. Open it **in a browser on this computer**, sign in with your ChatGPT account and approve; the page confirms and the command finishes. If the browser is on another machine
(over SSH), approve there, then copy the whole address its last page shows (it starts with `http://127.0.0.1:1455/auth/callback`) and paste it into the terminal. The sign-in is saved in
`<data>/secrets/credentials.json` (mode 0600). The server reads it when it needs it: no restart is needed. `pnpm logout:openai` removes it.

Sign in separately for the assistant if you can: two programs sharing one refresh token can sign each other out when one of them refreshes it. The ChatGPT plan must let another program
use the sign-in: a plan that does not ends the command with an error saying the grant did not include `chatgpt.tokens.use.direct`; look at the plan's settings.

**Verify:** the command ends with `Signed in. The sign-in is saved in <data>/secrets/credentials.json (only you can read it).`, and
`ops/check.sh --env-file /etc/assistant/assistant.env --only files` says `PASS  the OpenAI sign-in is saved` (and `WARN  no push keys yet`: the server makes them at its first start).
**To verify, at the first real message (step 9):** that OpenAI accepts the saved sign-in for the server and that the refreshed token is written back (tested only against fakes). If `pnpm login:openai`
cannot be used, the old way still works: sign in with pi (`pi`, `/login`, OpenAI) and copy its `openai` entry from `~/.pi/agent/auth.json` into `<data>/secrets/credentials.json`, mode 0600, as `{ "openai": { ... } }`.

## 6. Tailscale: a private address, https, Funnel off

```bash
sudo tailscale set --hostname=<a-name-that-does-not-identify-you> --operator="$USER"
```

The hostname first, before https is on: names end up in public certificate-transparency logs. `--operator` lets you run `tailscale serve` without sudo from now on (once; without it Tailscale answers
"access denied"). Then, in the Tailscale admin console → DNS: turn **MagicDNS** and **HTTPS Certificates** on. Then:

```bash
ops/tailscale-serve.sh --dry-run        # the two commands, and what it checks afterwards; nothing changes
ops/tailscale-serve.sh                  # the web app at /, the API at /api; reads the configuration back; prints the address
```

It prints `https://<name>.<tailnet>.ts.net/` and the two lines for the settings file. Put them in `/etc/assistant/assistant.env` (`sudoedit` again):
`ASSISTANT_PUBLIC_HOST=<name>.<tailnet>.ts.net` (the server refuses every request that arrives by a name it does not know) and `ASSISTANT_OWNER_LOGIN=<your Tailscale login>`.
Running the script again changes nothing. Funnel (the public internet) is never turned on, and every `tailscale serve` run removes it from the port it serves; the script checks that it is off.
(Do not "turn Funnel off" with `tailscale funnel --https=443 off`: for a port that is served it deletes the mappings.)

**Verify:** the script ends with `Checked: / and /api are mapped as intended, and Funnel is off.`, and `tailscale serve status` lists `/` and `/api` (the API's target ends in `/api`: Tailscale removes the mount path before it
forwards, so the target puts it back). **To verify:** the flags and the way Serve stores them were read from Tailscale's source, and the script was only run with `--dry-run` here; and that Serve and https certificates are
available on your plan. Step 7's `ops/check.sh` asks for `https://<name>.<tailnet>.ts.net/api/agents` through Serve: that is the proof that `/api` works end to end.

## 7. Install the two services

```bash
ops/install-units.sh --dry-run          # the two units as they will be installed, and the commands; nothing changes
ops/install-units.sh                    # installs them (asks for sudo), makes the data folder, enables and starts both
journalctl -u assistant-server -n 40 --no-pager      # "listening on http://127.0.0.1:3001", the migrations applied
```

It fills in the lines marked `CHANGE` from this checkout and the machine: `User=` (you), the repository path, the absolute path of the Node that built it (`command -v node`; with nvm it is under
`~/.nvm/versions/node/`) and `ReadWritePaths=`, which must be exactly the data folder your settings file names (default: `<repository>/data`; the folder is made first, because systemd stops the start without it).
The files in `ops/systemd/` stay untouched, so `git pull` never conflicts with anything you did. Change an installed unit later with `sudo systemctl edit --full assistant-server`, and run the script again after moving the checkout or changing `ASSISTANT_DATA_DIR`.
Options: `--user`, `--repo`, `--node`, `--data-dir`, `--env-file` (`ops/install-units.sh --help`).

**Verify:** `systemctl is-active assistant-server assistant-web` prints `active` twice, and `ops/check.sh --env-file /etc/assistant/assistant.env` has no `FAIL` for the server, the lock, the ports (both on `127.0.0.1` only), the API and Serve.
After editing the settings file, `sudo systemctl restart assistant-server`. If a unit stops after repeated failed starts (`systemctl status` says `start-limit-hit`), read the journal, fix the cause, then
`sudo systemctl reset-failed assistant-server` and `sudo systemctl start assistant-server`. **To verify:** the hardening lines against a real start (they keep `~/Documents` and `~/Downloads` readable and the data directory
writable; if a start fails with a permission error, the journal names the path).

## 8. Your phone

Open `https://<name>.<tailnet>.ts.net` with Tailscale on (from nowhere else it must not open). Android Chrome: ⋮ → Install app. iPhone: Safari → Share → Add to Home Screen (iOS delivers pushes only to an installed web app).
Then **Settings → Enable notifications** and allow them. **Verify:** `remind me in 1 minute to stretch` in the assistant chat, close the app: a notification arrives and the card is in the thread. The Android share sheet ("Share → Assistant") stores
the files and opens `/capture`. **To verify:** delivery through FCM and Apple (only a fake sender was used), and that Chrome sends what the share target needs (design-notes: "The Android share target"). Back up `<data>/secrets/vapid.json`:
with a new key pair every device must enable notifications again.

## 9. First real message

Say hello to the assistant. **Verify:** the answer is real (the dev model's answers start with "Faux model (dev mode)"). The model is per agent under Settings; the daily schedule (briefing 07:30, inbox digests 12:30 and 19:00, wrap-up 21:00) is there too.

## 10. Google: Gmail and Calendar (read-only)

Follow [`docs/setup-google.md`](setup-google.md): create a Desktop OAuth client, **publish the app "In production"** (step 1.6: otherwise Google may expire each sign-in after 7 days), save the client's JSON as `<data>/secrets/google-oauth.json`, then run `pnpm connect:google` once per Gmail account and approve the two read-only permissions.
**Verify:** `pnpm connect:google --list` says `connected`, and **Settings → Google accounts** shows the account and its last sync. **To verify, a week later:** it still says *Connected*; if it says *Needs to be connected again*, run `pnpm connect:google` for it again.

## 11. Jev (optional)

Save the key as `<data>/secrets/jev.json` (mode 0600) and restart the server (the key is read at start). This reads it without leaving it in your shell history; run it from the repository root:

```bash
read -rsp 'Jev API key: ' KEY; echo
( umask 077; mkdir -p "${ASSISTANT_DATA_DIR:-./data}/secrets"; printf '{ "JEV_API_KEY": "%s" }\n' "$KEY" > "${ASSISTANT_DATA_DIR:-./data}/secrets/jev.json" ); unset KEY
sudo systemctl restart assistant-server
```

More in [`docs/setup-jev.md`](setup-jev.md). **Verify:** Settings → Google accounts shows **Jev** instead of **Rules mode**. **To verify:** the request shape in `jev-contract.ts` was written without Jev's documentation.

## 12. Your invoice template

Recreate your invoice as HTML once: [`docs/setup-invoice.md`](setup-invoice.md) (`<data>/templates/invoice.html`). Use a test numbering pattern while you try it: a number is used once, ever. **Verify:** `preview_invoice` in the Accountant chat gives a PDF marked PREVIEW that takes no number.

## 13. Make it yours (optional)

**Profile** in the sidebar: how you like the assistant to sound and explain (every agent is told), what it remembers (read, edit, pin, delete any line), the people it keeps. **Usage**: what each agent spends, and a weekly token limit per agent if you want one
(a soft limit: when an agent reaches it, its briefing, wrap-up and digests become plain cards until Monday, a banner says so, and what you type still gets an answer). **Activity**: what the agents did.

## 14. Check everything

```bash
ops/check.sh --env-file /etc/assistant/assistant.env
```

One line per check: `PASS`, `FAIL` (with what to do), `WARN`, `SKIP`; it exits 1 if anything failed. It checks the data and secrets folders and files are private, the OpenAI sign-in and push keys exist, the Google accounts are connected, Jev or Rules mode, the server is running,
the settings are not the example values, both ports listen on `127.0.0.1` only, the API answers with four agents and no parked task, Serve maps `/` to the web app and `/api` to the server's `/api`, Funnel is off, `https://<your host>/api/agents` answers through Serve,
the services are active, and the machine cannot suspend. It changes nothing on this machine and prints no key or token (it does print the public host name, and the addresses of Google accounts that need connecting again). `--only <groups>` and `--skip <groups>` run part of it.

## Backups

Not automated. Back up while the server is stopped, or copy both databases together: `<data>/app.sqlite` and `<data>/durable.sqlite` (with their `-wal` files), and `<data>/secrets/`, `<data>/templates/`, `<data>/workspace/invoices/` (an issued invoice cannot be made again under its number).
What and why: [`docs/OPS.md`](OPS.md#what-to-back-up-the-accountants-files). **Check:** restore into an empty folder and start a server with `ASSISTANT_DATA_DIR` pointed at it.

## When all of it is done

- [ ] The assistant answers (a real model), on your phone, over Tailscale only (`ops/check.sh` has no `FAIL`).
- [ ] A reminder arrives as a notification with the app closed.
- [ ] The briefing, the two inbox digests and the wrap-up are on, in your time zone (**Settings → Daily schedule**).
- [ ] **Settings → Google accounts** lists every Gmail account as connected, and says Jev or Rules mode.
- [ ] You know the things that need you again: `pnpm connect:google` when an account says "Needs to be connected again" (weekly, if the Google app was left in Testing), `pnpm login:openai` if the OpenAI sign-in stops working,
      and a restart after changing `jev.json` or the settings file.
