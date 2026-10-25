# Connecting Gmail and Google Calendar

The Inbox agent reads your mail and calendar, **read-only**. This guide is everything you do: make a Google Cloud OAuth
client once (about ten minutes), then run one command per Gmail account. Nothing here sends, replies, labels or deletes:
the permissions asked for are fixed in the code (`apps/server/src/google/oauth.ts`) and are all read-only.

> **Not verified.** This was written without access to Google: the console's menu names change from time to time and
> every step below comes from knowledge of it, not from a run. Where a step is the likeliest to differ it says so. The
> first real run is yours; `docs/progress-m5.md` lists what could not be checked.

## What you need

- A Google account to own the Cloud project (any; it can be one of the Gmail accounts you will connect).
- The assistant installed on the machine that runs it, with `pnpm install` done.
- A web browser **on that machine** for the one approval step per account (no browser there: see "No browser on the
  machine" below).

## 1. Create the OAuth client (once)

1. Open <https://console.cloud.google.com/> and create a project, for example `assistant`.
2. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API** (search for each, press Enable).
3. **Google Auth Platform** (older consoles: *APIs & Services → OAuth consent screen*):
   - App name `Assistant`, your address as support and contact email.
   - Audience (user type) **External**. The publishing status starts as **Testing**: leave it while you set the screen up;
     step 6 moves it to production, which you want (see there why).
   - **Test users**: add every Gmail address you will connect, yours included. Only test users can sign in while the app
     is in Testing, so this is what lets the first approval work before step 6.
   - **Data access** (older: *Scopes*): add `.../auth/gmail.readonly` and `.../auth/calendar.readonly`. The `openid` and
     `email` scopes are there by default. Add nothing else.
4. **Clients** (older: *APIs & Services → Credentials → Create credentials → OAuth client ID*): application type
   **Desktop app**, name `Assistant desktop`, Create. A "Web application" client does not work: the sign-in comes back to
   `http://127.0.0.1:<port>/`, and the assistant refuses such a client with a message that says so.
5. Press **Download JSON** and save it, unchanged, as `<data>/secrets/google-oauth.json`:

   ```bash
   mkdir -p data/secrets && chmod 700 data/secrets
   mv ~/Downloads/client_secret_*.json data/secrets/google-oauth.json
   chmod 600 data/secrets/google-oauth.json
   ```

   `<data>` is `./data` for the production server (`pnpm start`) and `./data-dev` for `pnpm dev`; `ASSISTANT_DATA_DIR`
   overrides both. `pnpm connect:google` prints the file it saves into, and it uses the production folder (`./data`) unless
   you set `ASSISTANT_DATA_DIR`: a different folder for the command and the server is the one way to get this wrong.
6. **Publish the app ("In production"): recommended, so that you do not have to connect again every week.**
   Google Auth Platform → **Audience** → **Publish app** → confirm. You are the only user of this client, so nothing else
   changes for you and you do not submit it for verification.
   - **Why (to verify on your first setup).** Google's documentation says that a refresh token issued to an *External* app
     whose publishing status is *Testing* expires after **7 days** when it was approved for scopes such as these, and that an
     app *In production* does not have that limit. The assistant would then show every account as "Needs to be connected
     again" about a week after you approved it, and again every week after that. This could not be checked here, which is
     why it is a step to verify: see "The first week" below.
   - **What it costs.** The app stays **unverified**, so Google shows "Google hasn't verified this app" each time you
     approve an account (step 2 says what to press). An unverified app is limited to 100 users; you are the one. Verification
     for the Gmail scope is a security review meant for products with many users: skip it.
   - **If you would rather stay in Testing:** that is allowed and everything works, but plan to run
     `pnpm connect:google` for every account about once a week (see "When the sign-in stops working").

## 2. Connect each Gmail account (once per account)

```bash
pnpm connect:google
```

It prints a link and waits (up to five minutes). Open the link in a browser on this machine, sign in with the Gmail
account, and approve the two read-only permissions (leave every box ticked). Google shows "Google hasn't verified this
app": that is expected, because the app is yours and was never submitted for verification (in Testing and in production
alike). Choose **Advanced → Go to Assistant (unsafe)**, which here means your own client. The terminal then says
`Connected you@gmail.com` and the page in the browser says you can close it.

Run the command again for every other Gmail account. A second approval of the same account replaces its record.

Options: `--login-hint you@gmail.com` preselects an account, `--port 8765` fixes the port it listens on (127.0.0.1 only),
`--timeout-minutes 10` waits longer, `--list` shows the connected accounts and `--help` the rest.

### No browser on the machine

The approval has to reach the machine by `http://127.0.0.1:<port>/`. Over SSH, forward that port and open the link in the
browser of the computer you are sitting at:

```bash
ssh -L 8765:127.0.0.1:8765 you@the-machine      # from your own computer
pnpm connect:google --port 8765                 # on the machine, in that session
```

## 3. Check that it works

- `pnpm connect:google --list` shows each account as `connected`.
- Open the assistant's **Settings → Google accounts**: each account with its status and its last sync and how many mails
  it kept. The server notices a new sign-in the moment you open that card and otherwise within ten minutes; the first sync
  then starts at once. The first read takes the last 14 days (newest first, at most 1,000 mails); the calendar covers
  yesterday to two weeks ahead.
- In the **Inbox** chat: "what came in today?" or `search_mail` words. A digest arrives at 12:30 and 19:00 (**Settings →
  Daily schedule** changes the times).

Mail is classified by local rules until you add a Jev key ([`setup-jev.md`](setup-jev.md)); Settings says which.

## The first week (to verify)

Two things in this guide were written from knowledge of Google and not from a run. Check them once:

1. **Did the sign-in survive the first week?** Eight days after you approved the first account, open **Settings → Google
   accounts**. *Connected* with a recent "Last synced" means the app is not subject to the 7-day limit (it is In
   production, as step 6 recommends). *Needs to be connected again* about a week after approving means it is, which means
   the app is still in **Testing**: do step 6, then connect every account again as described below.
2. **Does the approval reach the machine?** If the browser step in section 2 fails in some way not in the table at the end,
   `docs/progress-m5.md` says what else could not be checked (the loopback redirect of a Desktop client, Gmail's history
   behaviour).

## When the sign-in stops working

The account turns **"Needs to be connected again"** in Settings, the PA's chat gets a notice and your phone a generic push
("A Gmail account needs to be connected again"). Mail from that account stops until you connect it again. Causes:

- **Testing-mode expiry** (about a week after each approval): step 6 of section 1 removes it.
- **You removed the access** at <https://myaccount.google.com/permissions>.
- **You changed the Google account's password.** Google revokes the sign-ins that carry Gmail permissions when the
  password changes (from Google's documentation of refresh-token expiry; not checked here).
- **The sign-in was not used for six months** (same source; not possible while the assistant syncs it, but possible for an
  account you disconnected).

### Connecting again

On the machine that runs the assistant, with the same data directory as the server:

```bash
pnpm connect:google --login-hint you@gmail.com
```

Approve the same account in the browser, as in section 2. The terminal says `Connected you@gmail.com`; the server needs no
restart. It sees the newer sign-in when you open **Settings → Google accounts** and otherwise within ten minutes, and the
account then shows *Connected* and syncs at once: mail that arrived meanwhile is read from Gmail's history, or by reading
the last 14 days again when Gmail no longer has it. Nothing you decided (a mail marked, a suggestion answered) is lost.

## What the assistant can and cannot do with the access

- It can **read** Gmail (`gmail.readonly`) and the primary calendar (`calendar.readonly`), and know which address each
  account is (`openid`, `email`). Nothing else is requested; there is no setting that widens it.
- It cannot send, reply, forward, archive, label, delete or unsubscribe: no such tool exists, and the HTTP client behind
  the Gmail and Calendar tools only makes `GET` requests, only to `gmail.googleapis.com` and `www.googleapis.com`.
- Each mail is copied into the assistant's database as a few headers, the snippet and up to 8,000 characters of text
  (never attachments). When the Inbox agent reads a mail with `read_mail`, that text goes to the model provider like
  everything you say to an agent. Jev, if you use it, sees only an excerpt ([`setup-jev.md`](setup-jev.md)).
- The refresh token is stored in `<data>/secrets/google-accounts.json` (mode 0600, in a 0700 folder; no agent can read
  that folder). The client secret is in `google-oauth.json`. Back both up with the rest of `secrets/`, or connect again.

## Disconnecting

**Settings → Google accounts → Disconnect** forgets the sign-in on this machine and stops the sync. It is local: the mail
already copied stays, and **nothing is revoked at Google**. To take Google's access away, remove *Assistant* at
<https://myaccount.google.com/permissions>.

## If something goes wrong

| What you see | What it means |
|---|---|
| `There is no Google OAuth client yet` | `google-oauth.json` is not in the folder the message names. Step 1.5 |
| `is a "Web application" client` / `redirect_uri_mismatch` | The client must be a **Desktop app** (step 1.4) |
| `invalid_client` | The id or secret in the file is wrong: download the client's JSON again |
| `Error 403: access_denied` in the browser | The app is in Testing and the account is not among the test users (step 1.3): add it, or publish the app (step 1.6) |
| `Access was approved without calendar.readonly` | A permission box was unticked: run it again and leave all ticked |
| `Google did not return a refresh token` | Google gives one only the first time an app is approved: remove *Assistant* at myaccount.google.com/permissions and run it again |
| Settings shows an error under an account, `Calendar API has not been used in project …` | Enable the Calendar API (step 1.2): mail still works, the calendar is the part that failed |
| `Nobody approved the sign-in within 5 minutes` | Run it again; `--timeout-minutes` waits longer |
| The port is busy | `--port 8765` |
| `…google-accounts.json is not valid JSON` | The file was edited by hand. Fix it, or delete it and connect the accounts again (it holds only sign-ins) |
