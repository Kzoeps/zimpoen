# Setting it up: everything the owner does, in one list

This is the whole checklist for a first real deployment, in the order to do it. Each item has the command and how to see
that it worked; the long ones link to their own guide instead of repeating it. Nothing here is done by the software for
you, and nothing here is needed twice.

Commands run from the repository root, on the machine that will run the assistant. `<data>` is the data directory:
`./data` for the production server, `./data-dev` for `pnpm dev`, or what `ASSISTANT_DATA_DIR` says.

> Items 2, 3 and 4 touch services this repository could not reach while it was built (OpenAI, Tailscale, push services,
> Google, Jev). Each says what is **to verify** at the first real run. `docs/progress-m*.md` list them per milestone.

## 1. Install and build

```bash
pnpm install
pnpm build
```

Needs Node 24 and pnpm 10. **Verify:** `pnpm typecheck && pnpm test` pass (about a minute), and `apps/server/dist/main.js` exists.

## 2. Sign in to OpenAI (the model)

The server asks the `openai` provider and reads its sign-in from `<data>/secrets/credentials.json` (mode 0600, the shape of
pi's `auth.json`: `{ "openai": { "type": "oauth", "access": …, "refresh": …, "expires": … } }`; extra keys such as
`clientId` are kept as they are). **There is no sign-in command yet**: `pnpm login:openai` is on the plan (PLAN §8, Ops).
Until then you sign in with pi and copy its record, one command (it prints no token):

```bash
# 1. sign in with ChatGPT in pi: run `pi`, type /login, choose OpenAI, then quit
# 2. copy the "openai" entry of ~/.pi/agent/auth.json into the server's credential file:
node -e '
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi/agent/auth.json"), "utf8"));
if (auth.openai === undefined) throw new Error("pi has no openai sign-in: run pi, /login, choose OpenAI, then try again");
fs.mkdirSync("data/secrets", { recursive: true, mode: 0o700 });
fs.chmodSync("data/secrets", 0o700);
fs.writeFileSync("data/secrets/credentials.json", JSON.stringify({ openai: auth.openai }, null, "\t") + "\n", { mode: 0o600 });
fs.chmodSync("data/secrets/credentials.json", 0o600);
console.log("saved the openai sign-in in data/secrets/credentials.json");
'
```

(The command was run against a stand-in `auth.json`: it makes the file with mode 0600 in a 0700 folder, and the server's
credential store reads and refreshes that shape: `apps/server/test/credentials.test.ts`.)

Sign in separately for the assistant if you can: two programs sharing one refresh token can sign each other out when one of
them refreshes it. **To verify:** that OpenAI accepts the copied refresh token for the server, and that the server's refreshed
token is written back (the credential store does that; it was tested only against a fake). **Check:** after step 4, a message
to the assistant gets a real answer (the dev model's answers start with "Faux model (dev mode)").

## 3. Tailscale: a private address, https, Funnel off

```bash
sudo tailscale set --hostname=<a-name-that-does-not-identify-you>
tailscale serve --bg --https=443 http://127.0.0.1:3000                        # the web app
tailscale serve --bg --https=443 --set-path=/api http://127.0.0.1:3001         # the API
tailscale serve status
tailscale funnel status                                                          # must say Funnel is off
```

Choose the machine name **before** turning on https certificates: names end up in public certificate-transparency logs.
HTTPS certificates are switched on in the Tailscale admin console (DNS → HTTPS Certificates). The `serve` flags are those of
Tailscale 1.52 and later; if `tailscale serve --help` shows otherwise on your version, follow it (not checked here).
**Check:** `https://<name>.<tailnet>.ts.net` opens the assistant from your phone with Tailscale on, and from nowhere else.

## 4. Configure and start the server

Export these (a `.env` file is not read; use a systemd unit or your shell, and keep both processes running; a unit file is
not provided yet, see `docs/OPS.md`):

| Variable | Set it to |
|---|---|
| `ASSISTANT_OWNER_LOGIN` | **required.** Your Tailscale login, for example `you@example.com`. Only this identity is let in |
| `ASSISTANT_PUBLIC_HOST` | **required for the browser.** `<name>.<tailnet>.ts.net` (step 3) |
| `ASSISTANT_PUSH_SUBJECT` | **required.** A contact for the push services: `mailto:you@example.com` |
| `ASSISTANT_OWNER_NAME`, `ASSISTANT_CURRENCY`, `ASSISTANT_OWNER_HEIGHT_CM`, `ASSISTANT_TIMEZONE` | optional: your name, `BTN`, your height in cm (for BMI), `Asia/Thimphu` |
| `ASSISTANT_READ_PATHS` | optional: the folders the PA may read (default `~/Documents:~/Downloads`; they must exist) |
| `ASSISTANT_INBOX_SYNC_MINUTES` | optional: minutes between two syncs of a mailbox (default 10) |

```bash
pnpm start                                  # the server, production mode (127.0.0.1:3001)
pnpm --filter @assistant/web start          # the web app (127.0.0.1:3000)
```

All settings are checked at start: a wrong one stops the server with a message that names every problem. Full table:
[README → Configuration](../README.md#configuration). **Check:** the log says the server is listening and which migrations
it applied; `curl -s http://127.0.0.1:3001/api/agents -H 'Tailscale-User-Login: you@example.com'` lists four agents (from the
machine itself; from your phone just open the page).

## 5. Notifications on each device

Open the assistant on the device, **Settings → Enable notifications**, allow them. On an iPhone, add the web app to the
Home Screen first. **Check:** a reminder (`remind me in 1 minute to stretch`) shows up as a notification while the app is
closed. **To verify:** delivery through FCM and Apple was never tried (only a fake sender). Back up `secrets/vapid.json`: with
a new key pair every device must enable notifications again.

## 6. Keep the machine awake

A suspended machine reminds nobody. Turn off automatic suspend and the lid switch: [`docs/OPS.md`](OPS.md#keep-the-machine-awake).
**Check:** close the lid, set a reminder two minutes ahead, wait.

## 7. Google: Gmail and Calendar (read-only)

Follow [`docs/setup-google.md`](setup-google.md): create a Desktop OAuth client, **publish the app "In production"** (step 1.6:
otherwise Google may expire each sign-in after 7 days), put the client's JSON in `<data>/secrets/google-oauth.json`, then run
`pnpm connect:google` once per Gmail account and approve the read-only permissions in the browser.
**Check:** `pnpm connect:google --list` says `connected`; **Settings → Google accounts** shows the account and its last sync
(the server notices a new sign-in when you open that card, and otherwise within ten minutes). **To verify, a week later:** the
account still says *Connected* ("The first week" in the guide). If it says *Needs to be connected again*, the 7-day expiry of a
Testing-mode token is real for you: publish the app and run `pnpm connect:google` for the account again.

## 8. Jev (optional)

Put `{ "JEV_API_KEY": "…" }` in `<data>/secrets/jev.json` (mode 0600) and restart: [`docs/setup-jev.md`](setup-jev.md).
**Check:** Settings → Google accounts shows **Jev** instead of **Rules mode**. **To verify:** the request shape in
`jev-contract.ts` was written without Jev's documentation; the guide says what to compare.

## 9. Your invoice template

Recreate your invoice as HTML once: [`docs/setup-invoice.md`](setup-invoice.md) (`<data>/templates/invoice.html`). Use a test
numbering pattern while you try it: a number is used once, ever. **Check:** `preview_invoice` in the Accountant chat gives a
PDF marked PREVIEW without taking a number.

## 10. Backups

Back up while the server is stopped, or copy both databases together: `<data>/app.sqlite` and `<data>/durable.sqlite` (with
their `-wal` files), and `<data>/secrets/`, `<data>/templates/`, `<data>/workspace/invoices/` (an issued invoice cannot be
made again under its number). What exactly and why: [`docs/OPS.md`](OPS.md#what-to-back-up-the-accountants-files). Automated backups
are not built yet. **Check:** restore into an empty folder and start a server with `ASSISTANT_DATA_DIR` pointed at it.

## When all ten are done

- [ ] The assistant answers (a real model), on your phone, over Tailscale only.
- [ ] A reminder arrives as a notification with the app closed.
- [ ] The morning briefing (07:30), the inbox digests (12:30, 19:00) and the evening wrap-up (21:00) are on, in your time zone
      (**Settings → Daily schedule**).
- [ ] **Settings → Google accounts** lists every Gmail account as connected, and says Jev or Rules mode.
- [ ] You know the two things that need you again: `pnpm connect:google` when an account says "Needs to be connected
      again" (weekly, if the Google app was left in Testing), and a restart after changing `jev.json`.
