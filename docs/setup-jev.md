# Jev: better triage of your mail (optional)

The Inbox agent decides which mail is important, which needs a reply and which is a newsletter. Without a key it does that
with **local rules** (sender and domain lists, Gmail's own categories and labels, a few keywords, and the sender rules you
approved): free, private, and cruder. With a [TypeSafe](https://docs.typesafe.ai) **Jev** key each new mail is classified
by Jev instead. Settings → Google accounts says which one is on: **Jev** or **Rules mode**.

## What you do

1. Get an API key from your TypeSafe account (their documentation is at <https://docs.typesafe.ai>; the steps for getting
   a key were not checked here).
2. Save it as `<data>/secrets/jev.json` (`./data/secrets/jev.json` for the production server):

   ```json
   { "JEV_API_KEY": "paste-the-key-here" }
   ```

   ```bash
   chmod 600 data/secrets/jev.json
   ```

   (The server tightens the file to 0600 itself if it is wider, and says so in its log.)
3. **Restart the server.** The key is read at start, not while it runs.

## How to check

- The server's log says `[jev] a key is saved: mail is classified by Jev (api.typesafe.ai).` (without a key:
  `[jev] no key in <data>/secrets/jev.json: mail is classified by local rules`).
- **Settings → Google accounts** shows the **Jev** badge instead of **Rules mode**.
- In the Inbox chat, `read_mail` on a new mail says how it was classified and why: `Classified as needs_reply, urgency 4 (Jev)`.
  Mail classified before the key was added keeps its old answer.

## What Jev is sent

For each new mail one request to **`https://api.typesafe.ai/v1/systemone`**, the official address and no other (it is a
constant in the code: there is no setting for it, and a redirect is refused so the key cannot be sent elsewhere). The key
travels only in the `Authorization` header. The request carries:

- the sender (name and address), the recipients, the subject, the Gmail labels, and whether it looks like a mailing list;
- the **first 1,500 characters** of the mail's text (its snippet when there is no text), and nothing after that;
- three questions: a category (one of nine), an urgency from 1 to 5, and whether you personally have to read or answer it;
  model `jev-1.14.0`.

Attachments, other mails and your other data are never sent. A first sync classifies at most 60 mails per run (every ten
minutes), so a big backlog is worked off over a few syncs, newest first.

## When Jev cannot be reached

The mail is never left unclassified: the local rules answer for it, the answer is marked *provisional*, and the next sync
asks Jev again. Settings shows why, with the time.

**A Jev that keeps failing is paused.** One mail costs at most about a minute when Jev does not answer (20 seconds a try, three
tries). After **three mails in a row** that Jev failed on (a timeout, an outage, a refused key, an answer this program cannot
read) Jev is not asked for **15 minutes**: new mail is sorted by the local rules at once, and Settings shows **Rules mode (Jev
paused)** with the time Jev is asked again. After that the first answer closes the pause; another failure opens it again for
another 15 minutes. Whatever the rules sorted meanwhile is looked at again by Jev. Separately, one sync never spends more than
90 seconds of its time waiting for Jev: what is left is sorted by the rules and goes to Jev at the next sync. A restart forgets
the pause (Jev is asked again, and three more failures pause it again).

| Settings says | What it means |
|---|---|
| `Jev refused the key (HTTP 401/403)` | The key is wrong or revoked: fix `jev.json`, restart |
| `Jev answered HTTP 429/5xx; it may be busy or down` or `could not be reached` | Jev or the network: nothing to do, it is tried again |
| `Jev answered, but not in the shape this program expects…` / `Jev refused the request (HTTP 400/404)…` | **The request or answer shape in this program does not match Jev's API** (below) |
| `…is not valid JSON` / `has no JEV_API_KEY` | `jev.json` is wrong; the server starts in Rules mode and says so |

What you taught the assistant is applied first, in both modes, without asking Jev. Marking a mail in the Inbox chat changes
that one mail only; a rule for **every later mail from a sender** ("always treat this sender as promo") is made only when you
approve it: the Inbox agent proposes it as a card with Approve and Deny in the Inbox chat, nothing changes until you tap
Approve (a typed YES does not count), and the card expires after 24 hours.

## To verify: the request shape was written without the documentation

**`TODO(verify)`.** Everything this program assumes about Jev's API is in one file,
`packages/extensions/src/inbox/triage/jev-contract.ts`, and it was written from the plan (a *state* plus typed questions:
a choice, a score and a yes/no), **not** from `docs.typesafe.ai`, which could not be read here. Before relying on Jev, compare
with the documentation:

- the endpoint path (`/v1/systemone`) and the model name (`jev-1.14.0`);
- how the key is sent (a bearer `Authorization` header here);
- the fields of a question (`id`, `type` = `choice`/`score`/`bool`, `prompt`, `choices`, `min`, `max`);
- the fields of the answer (`answers`, as an object of values or a list of `{ id, value }`).

A mismatch costs triage quality, not mail: Settings shows one of the "shape" messages above and everything falls back to
the local rules. To fix it, change `jev-contract.ts` and the fake Jev server in
`packages/extensions/test/inbox-triage.test.ts` together (the test pins the shape).
