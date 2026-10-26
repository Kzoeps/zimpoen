# Setup

Everything needed for a production install, in order. Run commands from the repository root on the machine that will
host the assistant. `<data>` means the data directory: `./data` in production, or whatever `ASSISTANT_DATA_DIR` is set
to.

> **First-run checks.** Some steps depend on services that were only tested against fakes: OpenAI sign-in, Tailscale
> Serve, push delivery, Google and Jev. Steps marked **Check** tell you what to confirm. See
> [ARCHITECTURE.md §8](ARCHITECTURE.md#8-known-gaps).

## 1. Keep the machine awake

Reminders fire from timers inside the server, and nothing wakes a suspended machine.

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo install -d /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' \
  | sudo tee /etc/systemd/logind.conf.d/assistant.conf
sudo systemctl restart systemd-logind   # may end your desktop session; reboot instead if you prefer
```

On GNOME, also turn off Settings → Power → Automatic Suspend. Keep the machine on mains power.

**Verify:** `systemctl is-enabled sleep.target` prints `masked`.

## 2. Node and pnpm

```bash
node -v   # v24.x
pnpm -v   # 10.x  (if missing: corepack enable && corepack prepare pnpm@10.15.1 --activate)
```

## 3. Get the code and build it

```bash
sudo install -d -o "$USER" -g "$(id -gn)" /opt/zimpoen
git clone <repo-url> /opt/zimpoen
cd /opt/zimpoen
pnpm install --frozen-lockfile
pnpm build
```

**Verify:** `apps/server/dist/main.js` and `apps/web/.next` exist, and `pnpm typecheck && pnpm test` passes.

## 4. Settings file

```bash
sudo install -d -m 0750 -o root -g "$(id -gn)" /etc/assistant
sudo install -m 0600 -o "$USER" -g "$(id -gn)" ops/assistant.env.example /etc/assistant/assistant.env
sudoedit /etc/assistant/assistant.env
```

Set the three required values:

- `ASSISTANT_PUSH_SUBJECT`: `mailto:you@example.com`
- `ASSISTANT_OWNER_LOGIN`: your Tailscale login
- `ASSISTANT_PUBLIC_HOST`: the machine's tailnet name

If you don't know the last two yet, step 6 prints them. The other settings are optional (see
[README → Configuration](../README.md#configuration)). The file uses systemd's format, so don't `source` it. If you set
`ASSISTANT_DATA_DIR` here, export the same value in your shell before running `pnpm login:openai` or
`pnpm connect:google`.

**Verify:** `ops/check.sh --env-file /etc/assistant/assistant.env --only host` shows `PASS ASSISTANT_OWNER_LOGIN is set`.

## 5. Sign in to OpenAI

```bash
pnpm login:openai
```

Open the link it prints and approve with your ChatGPT account. If you're connected over SSH, approve in your local
browser, then paste the final `http://127.0.0.1:1455/auth/callback…` address back into the terminal. The sign-in is saved
to `<data>/secrets/credentials.json`. Use a separate sign-in from other tools if you can: two programs sharing one refresh
token can log each other out. `pnpm logout:openai` removes the sign-in.

**Verify:** `ops/check.sh --env-file /etc/assistant/assistant.env --only files` shows `PASS the OpenAI sign-in is saved`.

## 6. Tailscale Serve

```bash
sudo tailscale set --hostname=<non-identifying-name> --operator="$USER"
```

Set the hostname before enabling HTTPS, because certificate names are public. In the Tailscale admin console → DNS,
enable **MagicDNS** and **HTTPS Certificates**. Then:

```bash
ops/tailscale-serve.sh --dry-run   # show what it will do
ops/tailscale-serve.sh             # map / to the web app and /api to the server
```

The script prints the URL plus the values for `ASSISTANT_PUBLIC_HOST` and `ASSISTANT_OWNER_LOGIN`. Put them in the
settings file. Funnel stays off. Don't run `tailscale funnel --https=443 off`: it deletes the mappings.

**Verify:** the script ends with `Checked: / and /api are mapped as intended, and Funnel is off.`

## 7. Install the services

```bash
ops/install-units.sh --dry-run
ops/install-units.sh
journalctl -u assistant-server -n 40 --no-pager   # look for "listening on http://127.0.0.1:3001"
```

The script fills in the user, repository path, Node path and data directory, then enables and starts both units. Run it
again if you move the checkout or change `ASSISTANT_DATA_DIR`. Restart the server after editing the settings file with
`sudo systemctl restart assistant-server`.

**Verify:** `systemctl is-active assistant-server assistant-web` prints `active` twice.

## 8. Phone

Open `https://<name>.<tailnet>.ts.net` with Tailscale on, then install the app:

- Android Chrome: ⋮ → Install app.
- iPhone Safari: Share → Add to Home Screen. iOS only delivers push to an installed app.

Then go to **Settings → Enable notifications**.

**Verify:** send `remind me in 1 minute to stretch` and close the app. A notification arrives.
**Check:** push delivery via FCM/Apple, and the Android share sheet.

## 9. First real message

Say hello. Replies starting with "Faux model (dev mode)" mean it's still on the scripted model. Model choice and the
daily schedule are under Settings.

## 10. Gmail and Calendar (optional)

Follow [setup-google.md](setup-google.md), then run `pnpm connect:google` once per account.

**Verify:** `pnpm connect:google --list` shows `connected`.
**Check:** after a week, the account still says Connected.

## 11. Jev (optional)

```bash
read -rsp 'Jev API key: ' KEY; echo
( umask 077; mkdir -p "${ASSISTANT_DATA_DIR:-./data}/secrets"
  printf '{ "JEV_API_KEY": "%s" }\n' "$KEY" > "${ASSISTANT_DATA_DIR:-./data}/secrets/jev.json" ); unset KEY
sudo systemctl restart assistant-server
```

**Verify:** Settings → Google accounts shows **Jev** instead of **Rules mode**. See [setup-jev.md](setup-jev.md).

## 12. Invoice template (optional)

See [setup-invoice.md](setup-invoice.md). Use a test numbering pattern while you experiment, because invoice numbers are
never reused.

**Verify:** asking the Accountant for a preview returns a PDF marked PREVIEW.

## 13. Final check

```bash
ops/check.sh --env-file /etc/assistant/assistant.env
```

It prints one `PASS`, `FAIL`, `WARN` or `SKIP` line per check, and exits 1 on any `FAIL`. It covers file permissions,
sign-ins, the server, port bindings, the API, Serve and Funnel, the services, and suspend. It changes nothing and prints
no secrets.

## Backups

Backups aren't automated. With the server stopped, copy these together:

- `app.sqlite` and `durable.sqlite`, with their `-wal` files
- `secrets/`
- `templates/`
- `workspace/invoices/`

To test a backup, restore it into an empty folder and start a server with `ASSISTANT_DATA_DIR` pointing there. See
[OPS.md](OPS.md#backups).

## Done when

- [ ] `ops/check.sh` shows no `FAIL`.
- [ ] A reminder arrives as a notification while the app is closed.
- [ ] The daily schedule is set (Settings → Daily schedule).
- [ ] Every Gmail account shows as connected.
