# Jev mail triage (optional)

The Inbox agent sorts mail into categories (important, needs a reply, newsletter, …). Without a key it uses **local
rules**: sender lists, Gmail categories, keywords, and your approved sender rules. With a
[TypeSafe Jev](https://docs.typesafe.ai) key, Jev classifies each new mail instead. Settings → Google accounts shows
which one is active.

## Setup

1. Get an API key from TypeSafe.
2. Save it as `<data>/secrets/jev.json`, mode 0600:

   ```json
   { "JEV_API_KEY": "your-key" }
   ```

3. Restart the server. The key is only read at start.

**Verify:** the log says `[jev] a key is saved`, and Settings shows **Jev** instead of **Rules mode**.

## What gets sent

For each new mail, one request goes to `https://api.typesafe.ai/v1/systemone`. The address is hardcoded and redirects
are refused. The request contains:

- the sender, recipients, subject and Gmail labels
- the first 1,500 characters of the text
- three questions: category, urgency (1–5), and whether it needs you personally

Attachments are never sent.

## When Jev fails

Mail is never left unsorted. The local rules answer instead, the result is marked provisional, and Jev is asked again at
the next sync.

After 3 failures in a row, Jev is paused for 15 minutes and Settings shows **Rules mode (Jev paused)**. A single sync
spends at most 90 s waiting on Jev. Restarting the server clears the pause.

| Settings says | Meaning |
|---|---|
| `Jev refused the key (HTTP 401/403)` | The key is wrong or revoked. Fix `jev.json` and restart |
| `HTTP 429/5xx` or `could not be reached` | Jev or the network is down. It's retried automatically |
| `…not in the shape this program expects` / `HTTP 400/404/422` | The API contract doesn't match (see below) |
| `…is not valid JSON` / `has no JEV_API_KEY` | Fix `jev.json` |

Your sender rules always apply first. A rule for every future mail from a sender is created only when you tap **Approve**
on the card. A typed YES doesn't count.

## API contract

The request and response shape follows [docs.typesafe.ai](https://docs.typesafe.ai) and lives in
`packages/extensions/src/inbox/triage/jev-contract.ts`:

- `category`: a Choice among the nine categories
- `urgency`: a five-level Score; its position (0–4) becomes urgency 1–5
- `needs_human`: a Noul; a probability of 0.5 or more counts as yes

If Jev changes its API, Settings shows `HTTP 422` or `…not in the shape this program expects`. Update
`jev-contract.ts` together with the fake server in `packages/extensions/test/inbox-triage.test.ts`.
