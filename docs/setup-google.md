# Connecting Gmail and Google Calendar

The Inbox agent reads mail and calendar **read-only**. You create a Google OAuth client once, then run one command per
Gmail account. The requested scopes are fixed in `apps/server/src/google/oauth.ts`.

> Not yet tested against Google itself. Console menu names change; where a step is likely to differ, it says so.

## 1. Create the OAuth client (once)

1. In <https://console.cloud.google.com/>, create a project.
2. **APIs & Services → Library:** enable the **Gmail API** and the **Google Calendar API**.
3. **Google Auth Platform** (older consoles call it *OAuth consent screen*):
   - Audience: **External**.
   - Test users: add every Gmail address you'll connect.
   - Data access (or *Scopes*): add `gmail.readonly` and `calendar.readonly`, and nothing else.
4. **Clients → Create:** type **Desktop app**. A *Web application* client won't work and is refused.
5. **Download JSON** and save it:

   ```bash
   mkdir -p data/secrets && chmod 700 data/secrets
   mv ~/Downloads/client_secret_*.json data/secrets/google-oauth.json
   chmod 600 data/secrets/google-oauth.json
   ```

   `pnpm connect:google` uses `./data` unless `ASSISTANT_DATA_DIR` is set. Use the same folder as the server.
6. **Publish the app** (Audience → Publish app). This is recommended. In *Testing* mode, Google may expire sign-ins
   after 7 days. The app stays unverified, which is fine for one user, but you'll see a "Google hasn't verified this app"
   warning when approving.

## 2. Connect each account

```bash
pnpm connect:google
```

Open the link it prints in a browser (on this machine or any other, see below), sign in, and approve both permissions. When Google warns the app
is unverified, choose **Advanced → Go to Assistant**. The terminal then prints `Connected you@gmail.com`. Repeat for each
account.

| Option | Use |
|---|---|
| `--login-hint <email>` | Preselect an account |
| `--port 8765` | Use a fixed callback port |
| `--timeout-minutes 10` | Wait longer than the default 5 minutes |
| `--list` | Show connected accounts |

**No browser on the machine:** open the link in a browser anywhere and approve. Google then redirects that browser to
`http://127.0.0.1:<port>/?code=...`, which won't load because nothing listens there on your computer. That's expected:
copy the whole address from the address bar, paste it into the terminal where `pnpm connect:google` is waiting, and
press Enter. An address from another run or sign-in is refused, and it asks again.

Alternatively, over SSH, forward the port so the redirect reaches the machine directly:

```bash
ssh -L 8765:127.0.0.1:8765 you@the-machine
pnpm connect:google --port 8765
```

## 3. Check it works

- `pnpm connect:google --list` shows `connected`.
- **Settings → Google accounts** shows the last sync. The server notices a new sign-in immediately when you open that
  page, and otherwise within 10 minutes.
- The first sync reads the last 14 days of mail (up to 1,000 messages) and calendar events from yesterday to two weeks
  ahead.

After a week, check that the account still says *Connected*. If it says *Needs to be connected again*, the app is still
in Testing mode: publish it (step 1.6), then reconnect.

## When the sign-in stops working

The account shows **Needs to be connected again**, and the PA posts a notice. Common causes:

- The Testing-mode 7-day expiry
- You removed access at <https://myaccount.google.com/permissions>
- You changed the Google password
- The account wasn't used for 6 months

To fix it, run `pnpm connect:google --login-hint you@gmail.com` with the same data directory as the server. No restart
is needed. The sync catches up from Gmail's history.

## What it can access

- **Read** Gmail and the primary calendar, plus your address (`openid`, `email`). Nothing else.
- **No** send, reply, label, archive or delete: those tools don't exist, and the client only makes `GET` requests to
  Google's API hosts.
- **Stored per mail:** headers, snippet, and up to 8,000 characters of text. Attachments are never stored. Text the Inbox
  agent reads goes to the model provider.
- **Tokens** are kept in `<data>/secrets/google-accounts.json` (mode 0600).

**Disconnect** (in Settings) forgets the sign-in and stops the sync. Already-copied mail stays, and Google's access isn't
revoked. To revoke it, remove the app at <https://myaccount.google.com/permissions>.

## Errors

| Message | Fix |
|---|---|
| `There is no Google OAuth client yet` | Save `google-oauth.json` in the folder named in the message (step 1.5) |
| `is a "Web application" client` / `redirect_uri_mismatch` | Create a **Desktop app** client instead |
| `invalid_client` | Download the client JSON again |
| `Error 403: access_denied` | Add the account as a test user, or publish the app |
| `Access was approved without calendar.readonly` | Run it again and leave both permission boxes ticked |
| `Google did not return a refresh token` | Remove the app at myaccount.google.com/permissions, then run it again |
| `Calendar API has not been used in project …` | Enable the Calendar API. Mail still works meanwhile |
| `Nobody approved the sign-in within 5 minutes` | Run it again, with `--timeout-minutes` if you need longer |
| `…google-accounts.json is not valid JSON` | Fix the file, or delete it and reconnect every account |
