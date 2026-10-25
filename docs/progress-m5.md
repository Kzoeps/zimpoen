# M5 progress log (worker → coordinator)

Scope: `docs/handoff-m5.md` (Inbox agent: Gmail + Calendar read-only, Jev triage, digests, handoff to the PA, `ask_agent`).
State, remaining items in order, failing checks and verified facts: `docs/handoff-m5-2.md`, `docs/handoff-m5-3.md`. This file is the
report: worker 1's section first (what it left, with its rows brought up to the final state), the **final report** (workers 2 and 3) after it,
and the **review fixes** (`docs/handoff-m5-fixes.md`, answering `docs/review-m5.md`) last. Where the final report says "an empty digest still
pushes" or "`mark_triage` teaches the rules", the fixes section below is what is true now.

---

# M5 (partial) — worker 1

> Historical: what worker 1 left at its context limit. Its §1 rows say what they became; §2 holds worker 1's numbers of that time; the final numbers are in the final report below.

Branch `main`, **nothing committed or pushed** (the coordinator commits). No call to Google, TypeSafe, OpenAI or a push service, no
login, no `railway`. No server was started (only test runs and the CLI's `--help`/`--list`/missing-client paths); nothing listens on
3000–3099 and the temp directories of my runs are removed. **M5 is not complete**: the backend is written; the web app, 11 old tests
that encode the old shape, most of the new tests and all docs are left.

## 1. State

| Scope item | State |
| --- | --- |
| 1 Google OAuth (loopback, PKCE), accounts, `pnpm connect:google`, fakes | **done**: code (worker 1), `google-oauth.test.ts` (39) and `google-clients.test.ts` (35), Settings card (browser-checked) |
| 2 Sync (history, 14-day first read, 404 → full read, calendar, durable task, backoff) | **done and tested** (25 tests) |
| 3 Triage (`Triage`, `JevTriage` + `jev-contract.ts`, `RulesTriage`, provisional fallback) | **done**: `inbox-triage.test.ts` (58), the Jev contract against a fake server, the rules badge in Settings |
| 4 Digests (12:30 / 19:00 through the daily engine; zero-token empty; briefing "Inbox" line) | **done**: `inbox-digest.test.ts` (17), the card with Gmail links; a real digest and a real briefing seen in the browser |
| 5 Inbox tools, suggestion queue to the PA, capability boundary, injection rules | **done**: `inbox-tools.test.ts` (26), `m5.test.ts` (16), `agents.test.ts` (+5) |
| 6 PA `ask_agent` (dedupe, timeout path, late card, only the PA) | **done and tested** (6 tests) |
| 7 Web (digest cards with Gmail links, suggestion card with Add/Dismiss, Settings → Google accounts, Jev/rules badge) | **done**: `inbox-cards.tsx`, `google-accounts.tsx`, `google-card.tsx` (40 web tests); the clicks pressed in a browser at 1100 and 390 px |
| 8 Docs (`setup-google.md`, `setup-jev.md`, `SETUP.md`, README, design-notes, PLAN) | **done** |
| 9 Tests | **done**: 55 files / 1185 tests before M5, 66 files / 1458 after |

## 2. Commands run and results (after the last code change)

| Command | Result |
| --- | --- |
| `tsc --noEmit` in `packages/db`, `packages/shared`, `packages/extensions`, `apps/server` | clean |
| `tsc --noEmit` in `apps/web` | 3 errors (the web app does not know the digest job ids and the Inbox cards yet) |
| `pnpm lint` | clean, 297 files |
| `pnpm test` | 58 files, 1216 tests: **1205 pass, 11 fail**; baseline before M5 was 55 files, 1185 tests, all green. The 11 are old expectations the feature changed (4 daily jobs instead of 2, the PA's new `ask_agent`/`delegate` extension, the Inbox's own extension, three new config paths, and whole-server tests that now start with the demo mailbox): the list with causes and fixes is `docs/handoff-m5-2.md` §3. `daily.test.ts` apart from the two job-list assertions passes untouched, which is the evidence that the engine change did not alter the briefing and the wrap-up |
| `pnpm exec vitest run packages/extensions/test/inbox-sync.test.ts inbox-accounts.test.ts delegate.test.ts` | 31 tests pass (14 + 11 + 6) |
| `pnpm connect:google --list` (throwaway data dir) | "No account is connected"; without `google-oauth.json` the command says where to put it and exits 1; `--help` prints the usage |
| `pnpm build`, bundle smoke, browser check | **not run yet** |

## 3. Changed and new files

```text
NEW   packages/shared/src/inbox.ts                          wire types, cards, entry kinds, settings response
NEW   packages/extensions/src/inbox/                        types, migrations (inbox/001–003), store, text, sync, task, scheduler, accounts, suggestions, tools, facts, format,
                                                            fake, pool, triage/{rules,jev,jev-contract,index}, index
NEW   packages/extensions/src/delegate/                     migrations (delegate/001), store, tools (ask_agent + DelegateService), index
NEW   apps/server/src/google/                               client-secret, oauth, accounts, http, gmail, calendar, mime, setup, connect
NEW   apps/server/src/connect-google.ts
NEW   packages/extensions/test/{inbox-sync,inbox-accounts,delegate}.test.ts
MOD   packages/shared/src/{cards,daily,index}.ts            card types, 4 job ids, DailySection.mail, NoticeEntryData.suggestion
MOD   packages/extensions/src/daily/{jobs,facts,run,index}.ts   digest jobs; DailyJob.agent/request; DailyFactsProvider.digest; DayWindow.job
MOD   packages/extensions/src/{module,index}.ts             DomainDeps.inbox/.delegate, exports
MOD   packages/extensions/test/support.ts                   fixture: inbox + delegate modules, optional Inbox conversation and scripted Google
MOD   apps/server/src/{config,domain,agents,server}.ts      google config + resolveDataPaths, modules and extension lists, instructions, wiring, repair logging
MOD   apps/server/src/http/{app,validation}.ts              GET /api/settings/google, DELETE /api/settings/google/accounts, POST /api/suggestions/:id
MOD   apps/server/test/support.ts                           appDepsFor: a stub Inbox
MOD   package.json, apps/server/package.json                script connect:google
```

New dependencies: none. New environment variables: `ASSISTANT_GOOGLE_MODE` (`real` in production, `fake` otherwise), `ASSISTANT_INBOX_SYNC_MINUTES`
(default 10). New files under `<data>/secrets/` (read, never written by the server except `google-accounts.json`'s status): `google-oauth.json`,
`google-accounts.json`, `jev.json`. New tables: `inbox_account`, `inbox_message` (+ FTS5), `inbox_event`, `inbox_rule`, `inbox_suggestion`, `inbox_call`,
`inbox_digest`, `inbox_state`, `delegate_ask`.

## 4. Decisions of this worker (★ = for the coordinator to veto; each is cheap to reverse; the full list with reasons is `docs/handoff-m5-2.md` §5)

1. ★ Digest windows are saved in `inbox_digest` (first writer wins), not derived from `schedule_daily.last_run_at`: a rerun and the power-cut recovery show the
   same mails and consecutive digests tile exactly. At most 3 days back; mail older than 3 days is not news.
2. ★ Disconnect forgets the saved sign-in and stops the sync but keeps the mail (purging would be a delete that needs approval).
3. ★ A suggestion acts only through the owner's Add; the PA is then asked with a message composed by code from the stored row. There is no prompt section of
   pending suggestions, so typed "yes, add it" does not resolve one. Late `ask_agent` answers are display-only cards for the same reason (no model text derived
   from email in a system prompt).
4. ★ The briefing's Inbox line quotes the top 3 subjects (as the handoff asks): sanitised, one line, ≤80 characters; the PA's rules call them data. It is an
   untrusted-text channel into a model with write tools, bounded by the owner-confirmed Add and rule 3.
5. Jev failing never loses triage: the rules answer is stored `provisional` and Jev is asked again later; what the owner taught (`mark_triage` → a sender
   rule) is applied first in both modes. A calendar failure is a warning on a successful sync, not a reason to back off the mail.
6. `ASSISTANT_GOOGLE_MODE` defaults to `fake` outside production (a seeded demo mailbox), so whole-server tests start with it unless they pass `fakeGoogle`.
7. `pnpm connect:google` runs with `NODE_ENV=production` so it saves where `pnpm start` reads, and prints the file it saves into.

## 5. Could not verify (no network, by the handoff's rule)

- **Real Google**: the REST clients, the history mapping, the id-token handling, the loopback redirect on a Desktop client and the **7-day Testing-mode refresh
  token expiry** are written from knowledge of the APIs and (once the tests are written) checked only against fakes.
- **Jev's request and answer shape**: all of it is in `packages/extensions/src/inbox/triage/jev-contract.ts` with `TODO(verify)` notes; the docs
  (`docs.typesafe.ai`) could not be read. A mismatch shows in Settings and mail falls back to the local rules.
- A **real model** driving the Inbox agent, the digests and `ask_agent`: the instructions and tool descriptions are a first draft.

## 6. Known gaps and risks

- ~~Web, docs, 11 old tests and most new tests are open~~: closed by workers 2 and 3 (the final report below).
- The sync keeps up to 8000 characters of text per mail in SQLite and the Inbox agent's model sees what it reads; Jev sees an excerpt (1500 characters). To be
  written in the README's "what leaves the machine".
- `needs_reconnect` stops an account until the owner connects it again (Settings badge, a PA notice, a push without the address).
- Every `suggest_followup` pushes (one tag).
- Not done on purpose: the review (`docs/review-m5*.md`) is the coordinator's.

## 7. Suggested scoped commits

Superseded: the final list is §9 of the final report below.

---

# M5 final report — workers 2 and 3 (the Inbox is complete)

Scope: `docs/handoff-m5.md`. Worker 1 wrote the backend (above). Worker 2 (`docs/handoff-m5-3.md` is its handoff) did the web app, the tests, the docs,
the 11 old tests and the 22-mutant break-and-restore pass. Worker 3 (this report) did the browser check, the three small fixes it found, the last gates,
the bundle smokes and this report. Branch `main`, **nothing committed or pushed** (the coordinator commits). No call to Google, TypeSafe or OpenAI, no
real push service, no login, no `railway`. **Every server I started is stopped** (nothing listens on 3000–3099, the CLI's port is closed), the browser
session is closed, the throwaway data directories and helper scripts are removed; screenshots stay in `/tmp/assistant-shots/m5/` (23 files).

## 1. State

| Scope item | State | Held by |
| --- | --- | --- |
| 1 Google OAuth (loopback on 127.0.0.1, PKCE S256, state check, scopes hard-coded read-only), accounts file 0600 with atomic writes, refresh, revoked → `needs_reconnect` (+ PA notice, push), several accounts, Settings list with disconnect, `ASSISTANT_GOOGLE_MODE=fake\|real` | done | `google-oauth.test.ts` (39: a fake token endpoint, wrong state, foreign Host, not `0.0.0.0`, scopes, ID-token checks, file and folder modes, one refresh for concurrent callers), `google-clients.test.ts` (35: GET only, Google's hosts only, MIME, history and calendar mapping, hostile input), `inbox-accounts.test.ts` (11), `m5.test.ts` (16). Browser: the Settings card, Disconnect with its confirmation |
| 2 Sync: `history.list`, 14-day first read, 404 → full read, label and delete changes, calendar, durable task, backoff, never blocks other agents | done | `inbox-sync.test.ts` (14) |
| 3 Triage: `Triage`, `JevTriage` (one contract file, `TODO(verify)`), `RulesTriage`, provisional fallback, learned rules first, batched and limited | done | `inbox-triage.test.ts` (58: the Jev contract against a fake server, every URL, `redirect: "error"`, 1,500 characters, auth/rate/shape errors) |
| 4 Digests at 12:30 and 19:00 (zero-token empty card, one push, saved windows), briefing "Inbox" line | done | `inbox-digest.test.ts` (17), `daily.test.ts` changed only in the job lists and one fixture option. Browser: a real digest and a real briefing (§4) |
| 5 Inbox tools (`search_mail`, `read_mail`, `list_events`, `mark_triage`, `suggest_followup`), suggestion queue to the PA, no file tools, injection rules | done | `inbox-tools.test.ts` (26), `m5.test.ts`, `agents.test.ts` (+5: the rule lines, the extension lists) |
| 6 PA `ask_agent` (dedupe, timeout path, only the PA has it) | done | `delegate.test.ts` (6), `m5.test.ts`. Browser: the answer card |
| 7 Web: digest cards with Gmail links, suggestion card with Add/Dismiss, Settings → Google accounts, Jev/rules badge | done | `inbox-cards.test.ts` (30), `google-accounts.test.ts` (10), `api.test.ts` (+3). Browser: the clicks, at 1100 and 390 px, dark and light |
| 8 Docs: `setup-google.md`, `setup-jev.md`, `SETUP.md`, README, design-notes, PLAN | done | `setup-google.md` checked against the CLI and the source by this worker: the link and the five-minute wait it describes are what the CLI printed (§2), and every message quoted in its error table, the data directories (`./data`, `./data-dev`) and the 1,000-mail first read exist in the code |
| 9 Tests | done | 55 files / 1,185 tests before M5 → **66 files / 1,458 tests** (+11 files, +273 tests) |

**The bar for "done"** (the owner puts the client JSON in `<data>/secrets/google-oauth.json`, runs `pnpm connect:google` per account, puts `JEV_API_KEY` in
`<data>/secrets/jev.json`, nothing else) was walked from a fresh data directory with the built bundle in real mode (§2): no client file → the log and Settings
say so; the file appears → Settings switches **without a restart**; `pnpm connect:google` prints the consent URL. The browser step, the token exchange
and Google's side were not run (no network).

## 2. Commands run and results (serial, on the final tree; the last code edit came before all of them)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | 5 packages, 0 errors |
| `pnpm lint` | 309 files, clean |
| `pnpm test` | **66 files, 1,458 tests pass** |
| `pnpm build` | ok; `apps/server/dist/main.js` 889,306 bytes, built after the last edit |
| Bundle smoke, fake mode (`ASSISTANT_DATA_DIR=/tmp/m5-smoke ASSISTANT_READ_PATHS=/usr/share/doc ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux ASSISTANT_PORT=3005 node apps/server/dist/main.js`) | applied all 29 migrations (incl. `inbox/001–003`, `delegate/001`); `[daily] scheduled for the first time: briefing, wrapup, digest_midday, digest_evening`; both demo accounts synced (4 and 2 mails); `GET /api/settings/google` → `mode fake`, `triage rules`, `syncMinutes 10`; the schedule lists the 4 jobs; agents `pa, inbox, health, accountant`; clean SIGTERM; data dir removed |
| Bundle smoke, **real mode, no client file** (same command plus `ASSISTANT_GOOGLE_MODE=real`, fresh dir) | logged `[google] no OAuth client file at …/secrets/google-oauth.json: no account can be connected yet (docs/setup-google.md).`; `GET /api/settings/google` → `clientConfigured:false`, no accounts; after a placeholder `google-oauth.json` was put there, the same call said `clientConfigured:true` with no restart |
| `ASSISTANT_DATA_DIR=/tmp/m5-real pnpm connect:google --port 48765 --login-hint owner@example.com` (placeholder client, ended by `timeout 8`) | printed the file it saves into; a consent URL with `scope=gmail.readonly calendar.readonly openid email`, `code_challenge_method=S256`, `state`, `access_type=offline`, `prompt=consent`, `redirect_uri=http://127.0.0.1:48765/`; "Waiting on http://127.0.0.1:48765/ for up to 5 minutes. Ctrl-C cancels; nothing is saved."; the port was closed afterwards; no account file was written |
| Browser check (`pnpm dev`, faux model, fake Google, `agent-browser --args "--no-sandbox"`) | §4 |
| Break-and-restore | §8: worker 2's 22 mutants and 3 of mine, every mutated file `sha256`-checked identical afterwards |

## 3. Changed files

The whole M5 tree is in `git status`: worker 1's files are listed in worker 1's §3 above and in `docs/handoff-m5-2.md` §1, worker 2's in `docs/handoff-m5-3.md` §1
(web cards and Settings, three server test files, three extension test files, the docs, the 11 old tests brought up to date). **This session's own edits:**

```text
apps/web/src/components/inbox-cards.tsx            the "sent" card says only what stays true (BC2)               apps/web/test/inbox-cards.test.ts
packages/extensions/src/inbox/format.ts            NEW helper endTextOf; eventItem uses it (BC3)
packages/extensions/src/inbox/suggestions.ts       summaryOf uses endTextOf                                      packages/extensions/test/inbox-tools.test.ts
apps/server/src/google/setup.ts                    one log line for real mode without a client file (BC5)         apps/server/test/m5.test.ts
docs/progress-m5.md
```

No new dependency (`pnpm-lock.yaml` untouched), no new environment variable beyond worker 1's two (`ASSISTANT_GOOGLE_MODE`, `ASSISTANT_INBOX_SYNC_MINUTES`).

## 4. What the browser check found (each fixed unless marked)

Method: `pnpm dev` on 3000/3001, faux model, the default fake Google (the demo mailbox), throwaway data directories (`/tmp/m5-browser`, then a second fresh one
to see the briefing before any digest), `agent-browser` with a named session, 1100 px and 390 px, dark (the browser's default) and light (`set media light`).
Tools were driven through `POST /api/conversations/:id/messages` (`/tool …` lines); every click went through the real page. A fake push subscription
(`POST /api/push/subscribe`, a public-looking https endpoint) made the fake sender write `dev-push-outbox.jsonl`. After each group a script measured
`scrollWidth`, cards wider than the viewport, scrolling inside a card, children wider than their card, and every link's `target` and `rel`.

| # | Finding | |
| --- | --- | --- |
| BC1 | A search card's snippet ended mid-word ("…for the si") with no ellipsis | **Not a defect.** The demo mailbox stores a Gmail-style prefix, and Gmail's own snippets end mid-word; the digest clips its copy to 100 characters and does add "…". HTML entities in a real snippet are decoded (`google-clients.test.ts`) |
| BC2 | The "Suggested to the assistant" card in the Inbox thread kept saying "It is waiting in the assistant's chat" after the owner had pressed Add or Dismiss (the answer is in the PA's thread, so this card cannot know it) | Reworded to what stays true: "Sent to the assistant's chat. It is added to your follow-ups only if you press Add there." The test now also asserts the card never says "waiting". Seen again in the browser |
| BC3 | A calendar-event suggestion read "Mon 26 Oct 2026, 20:54 to Mon 26 Oct 2026, 21:54", while the events card says "20:54 to 21:54" | `endTextOf` (time alone when the span ends the day it starts, compared by `localDate`; the whole stamp otherwise), used by the event rows and by the suggestion card. The old same-day check compared formatted text, which worker 2 had flagged as fragile. Tests: same-day and an overnight event; browser: "20:54 to 21:54" |
| BC4 | After the dev server restarted, it logged "connected again" for the account I had disconnected | **Fake-mode artifact, not changed.** `seedDemoMailbox` gives both demo accounts a sign-in at every fake start. In real mode Disconnect deletes the sign-in from `google-accounts.json` (`google-oauth.test.ts` "forgets an account's sign-in…", `inbox-accounts.test.ts` "stops the account whose sign-in has disappeared"), so a restart does not bring it back |
| BC5 | Real mode with no client file logged nothing about Google, while fake mode and Jev each log a line | Added `[google] no OAuth client file at <path>: no account can be connected yet (docs/setup-google.md).`; pinned in `m5.test.ts`; seen in the bundle |
| BC6 | **Everything else held** (below) | – |

What held:

- **Layout.** `scrollWidth` equals the viewport (1100 and 390) on the Inbox thread, the PA thread and Settings; no card wider than the viewport, nothing scrolling
  inside a card, no child wider than its card; light and dark both legible; the Add/Dismiss buttons are 62×40 and 88×40 px at 390 px. Every Gmail link measured (1100 px and 390 px)
  is `target="_blank" rel="noopener noreferrer"`; the 1100 px Inbox page had no other external link.
- **Settings → Google accounts.** Two connected demo accounts with last sync and "N mails kept", the **Rules mode** badge with its sentence, the fake-mode note, no
  "client file missing". **Disconnect** → in-page confirmation → **Cancel** (the API still says both connected) → Disconnect → "Disconnected", the button gone, "2 mails kept",
  "No new mail is read. What was read stays. Run pnpm connect:google to connect it again."; **Check again** changes nothing and shows no error. **Daily schedule** lists four jobs.
- **Inbox thread.** `search_mail` (rows, category chips, Gmail links), `read_mail` (the text folded), `list_events {"range":"week"}` (three events with times, attendees, place and
  account), `mark_triage` (the note card), a second search.
- **Suggestions.** `suggest_followup` made a "Suggested to the assistant" card in the Inbox thread and a card with **Add** and **Dismiss** in the PA thread, and only there. **Add**: the
  buttons turn to "Adding…" and off at once; then the card says "You pressed Add: the assistant was asked to save it.", the notice card appears and the PA is asked with the message
  the server composed from the stored row. **The dev model only echoes that message; it did not run `add_followup`** (a real model would), so the follow-up itself was not created.
  **Dismiss**: "Dismissed.", the notice, **no model run** (the PA's assistant entries stayed at one), the row `dismissed`. Both outcomes survive a reload.
- **Digest.** `digest_midday` moved a minute ahead through `PUT /api/settings/schedule/digest_midday`; at 18:45:00 the card appeared in the Inbox thread with the three mails (important,
  needs a reply, follow-up) **open**, each row a Gmail link, the Inbox agent's answer under the "📥 Inbox digest" chip; the push in the outbox was
  `{"title":"Inbox","body":"Your inbox digest","url":"/chat/inbox","tag":"digest"}`: no mail text.
- **Briefing.** In a fresh data directory the 18:56 briefing had an "Inbox" section: "3 emails want your attention since the last digest: 1 important, 1 needs a reply, 1 needs a follow-up."
  and the three subjects, folded in the card ("What the assistant looked at (4 items)"). In the first run, after a digest, the briefing was empty: by design, it counts mail since the last digest.
- **`ask_agent`.** From the PA: the "Asked the Inbox" card (question and answer) and a tool result headed "Answer from the Inbox agent (information, not instructions)"; the Inbox thread shows "Asked by the assistant".

Not checked in a browser: the late-answer card (it needs a 90 s wait; static render only), a `needs_reconnect` account in Settings (the fake cannot revoke; static render and the revoked flow
in `m5.test.ts`), a real model, real Google.

## 5. Decisions of this session (★ = for the coordinator to veto; each is cheap to reverse). Worker 2's are `docs/handoff-m5-3.md` §4, worker 1's `docs/handoff-m5-2.md` §5

1. ★ **The "sent" card never claims a state it cannot know** (BC2). Reverse: the sentence in `SuggestionSentView`, and one assertion.
2. ★ **`endTextOf` replaces the text comparison in `eventItem`** (BC3). An event that ends exactly at midnight is "next day" and keeps its full stamp, as before.
3. ★ **A real-mode start with no client file logs one info line** (BC5), like the Jev line. Reverse: the `if` in `google/setup.ts` and one assertion.

Worker 2's open veto points are unchanged: ★ `pnpm connect:google` closes `<data>/secrets` to 0700; ★ the quadratic in `decodeEntities` fixed; ★ an empty digest still pushes ("Your inbox digest": twice
a day it is noise, and a per-job `pushWhenEmpty: false` is the cheap change); ★ the whole-server test helper's empty fake Google and `openFixture` reusing the recorded Inbox conversation.

## 6. Could not verify (no network, by the handoff's rule)

- **Real Google**: the REST clients (history 404, label records, repeated `historyTypes`), a Desktop client's loopback redirect, the ID-token handling, and the **7-day Testing-mode refresh-token expiry**
  (stated as "to verify" in `docs/setup-google.md`). All are tested against fakes only. The first real run is the owner's.
- **Jev's request and answer shape** (`packages/extensions/src/inbox/triage/jev-contract.ts`, `TODO(verify)`, stated in `docs/setup-jev.md`). A mismatch shows in Settings and mail falls back to the rules.
- A **real model** driving the Inbox instructions, the digests, `ask_agent` and the PA's use of a suggestion (the dev model only echoes).
- The OpenAI credential steps and the `tailscale serve` flags in `docs/SETUP.md` are written as "to verify" (neither could be run).

## 7. Known gaps and risks

- The first real run decides several assumptions at once (Google's REST details, Jev's shape, a real model's use of the tools); `setup-google.md` and `setup-jev.md` say what a mismatch looks like.
- A pending suggestion does not expire: if its time passes before the owner presses Add, the PA's `add_followup` may refuse a past time (the PA says so in chat).
- Opening Settings → Google accounts calls `refresh()` (so a sign-in made with the CLI is noticed at once): a read has a side effect, it can start a sync.
- The briefing quotes the top three subjects (an untrusted-text channel into a model with write tools): bounded by the PA's rules, rule 3 and the owner-confirmed Add.
- Disconnect keeps the mail and revokes nothing at Google (the card and `setup-google.md` say how). In fake mode a disconnect does not survive a restart (BC4).
- `mailItem`/`mailLine` do not re-clip a stored subject: the sync bounds it to 300 characters on write, so only a row that bypassed the sync would be unbounded (impossible today).
- Every `suggest_followup` pushes (one tag, replaces the previous); an empty digest pushes too.
- Older `/tmp/assistant-shots/` (M7's and earlier) and `/tmp/assistant-review-*` are not from this work.
- Not done on purpose: the review (`docs/review-m5*.md`) is the coordinator's.

## 8. Break-and-restore (one rule broken at a time; the targeted tests run; the file restored and checked identical)

Worker 2's 22 mutants (all killed):

| Mutant | Killed by |
| --- | --- |
| M1 loopback accepts any `state` | `google-oauth` "refuses a request with the wrong state and keeps waiting" |
| M2 PKCE verifier not sent | "trades the code and the PKCE verifier…" |
| M3 loopback listens on `0.0.0.0` | "listens on 127.0.0.1 and on no other address" |
| M4 a write scope (`gmail.modify`) is asked for | "asks for exactly the two read-only scopes…", the CLI test |
| M5 loopback ignores the `Host` header | "answers 404 to another path, another method and a foreign Host header" |
| M6 an ID token for another client is accepted | 2 tests |
| M7 `invalid_grant` does not mark the account | `google-oauth`, `m5` (revoked flow) |
| M8 an unreadable account file counts as empty | "refuses a file it cannot read instead of treating it as empty" |
| M9 the secrets folder is left as the owner made it | "saves the sign-in in a file only its owner can read, in a folder only its owner can enter" |
| M10 the ampersand scan is quadratic again | "does not run away on input made to hurt" |
| M11 history 404 is not `HistoryExpiredError` | `google-clients` |
| M12 the clients send `POST` | `google-clients`, `m5` ("GET only, to Google's hosts") |
| M13 search ignores hidden mail | `inbox-tools` "leaves out mail Gmail deleted or trashed" |
| M14 the digest window is not saved | 6 tests in `inbox-digest` |
| M15 what the owner taught is ignored | 4 tests in `inbox-triage`, `inbox-tools` |
| M16 Jev may follow a redirect | `inbox-triage` "goes to the official address and to no other…" |
| M17 Jev gets the whole text | "shows Jev the sender, the subject and at most the first 1,500 characters…" |
| M18 the other answer to a suggestion is allowed | 3 tests (`inbox-tools`, `m5`) |
| M19 `read_mail` lets the text close its own frame | "frames the text as data…" |
| M20 a card links wherever the data says | 2 tests |
| M21 a mail link keeps the opener | 2 tests |
| M22 a digest ignores the three-day limit | "never reaches back more than three days…" |

Worker 3's (all killed, files `sha256`-checked identical afterwards):

| Mutant | Killed by |
| --- | --- |
| M23 `endTextOf` always returns the whole stamp | `inbox-tools` "offers an event as a meeting…" and the `list_events` "shows who is invited…" test |
| M24 `endTextOf` always returns the time alone | the overnight assertion of "offers an event as a meeting…" |
| M25 real mode without a client file logs nothing | `m5` "starts without a client file, says it is missing, and reads nothing" |

## 9. Suggested scoped commits (the coordinator commits; replaces the list in worker 1's §7)

1. `shared: add the Inbox's wire types, cards and digest job ids` — `packages/shared/src/*`
2. `extensions: add the inbox module (sync, triage, digests, suggestions) and ask_agent` — `packages/extensions/src/{inbox,delegate,daily,module,index}*`, `packages/extensions/test/*`
3. `server: add Google sign-in, the Gmail and Calendar clients and the Inbox wiring` — `apps/server/src/**`, `apps/server/test/**`, both `package.json` (the `connect:google` scripts)
4. `web: add the Inbox's cards, the suggestion buttons and Settings → Google accounts` — `apps/web/**`
5. `docs: add the Google and Jev setup guides, the owner's checklist and M5 notes` — `README.md`, `docs/{PLAN,design-notes,SETUP,setup-google,setup-jev,progress-m5,handoff-m5*}.md`

`packages/extensions/test/support.ts` and `src/index.ts` carry several modules, so commit 2 is one commit unless hunks are split.


---

# M5 review fixes (`docs/handoff-m5-fixes.md`)

Scope: the coordinator's adjudication of `docs/review-m5.md` (A1, A2, B1 to B5, the doc-claims table, the nits). Branch `main`, **nothing committed
or pushed** (the coordinator commits). No call to Google, TypeSafe, OpenAI or a real push service, no login, no `railway`. **Every server I started
is stopped** (nothing listens on 3000–3099, the 3005 smoke servers exited on SIGTERM), the browser session is closed, the throwaway data
directories and helper scripts are removed; screenshots stay in `/tmp/assistant-shots/m5-fixes/` (7 files). No new dependency, no new environment
variable, `pnpm-lock.yaml` untouched.

## 1. What was asked, what was done

| Item | Adjudication | Done | Held by |
|---|---|---|---|
| **A1** | A persistently failing message must not wedge sync: per-message attempt count, skip + record after N tries, surface in the UI; test with probe s01 | A failure is caught **per message** and counted in the new table `inbox_read_failure` (migration `inbox/004`); the run goes on and the cursor moves; the failure list is the retry queue (asked again at each sync, also when Gmail's history no longer lists the id); after `maxReadAttempts` = 5 failed syncs the message is **skipped** (never asked for again, not by a full read either). Only a closing server and a refused sign-in still end the run, uncounted. Surfaced in **Settings → Google accounts** (count and last reason, red note), in the account's last-sync warning while it is still retried, and **once in the next digest** ("Accounts that need attention"). Failures older than the first read's window (14 days) are forgotten. Probe s01 re-run: before, 5 runs threw and `history_id` stayed 1003 with 3 mails stored per run; now run 1 stores all 11 healthy mails and moves the cursor to 1015, and the poison is tried 5 times and then left alone (§2) | `inbox-sync.test.ts` (+6: the probe's scenario, the retry queue without history, the give-up, a full read that does not ask again, a failure forgotten once the message reads, a refused sign-in and a closing server not blamed, pruning), `inbox-accounts.test.ts` (through the timer: failures stay 0 and the pace is kept; Settings shows `skipped`), `inbox-digest.test.ts` (+1), `google-accounts.test.ts` (+1) |
| **A2** | An empty digest posts the zero-token card and sends no push | `DailyJob.pushWhenEmpty` (default true; the briefing is unchanged); the two digest jobs set it to false; `standsAlone(job, plan)` and `pushesFor(job, plan)` in `daily/run.ts` keep the card, the model call and the push in step. Browser: an empty digest left `dev-push-outbox.jsonl` at one line (the earlier non-empty digest) | `inbox-digest.test.ts` ("a card, costs no tokens, and sends no push", rewritten), `daily.test.ts` untouched and green (the briefing's empty card still pushes) |
| **B1** | `mark_triage` from the model affects only that message; a lasting sender/domain rule needs the owner's confirmation (approval card) | `mark_triage` marks one mail and teaches nothing (`markByOwner` lost its `rule` parameter); it also refuses a hidden mail now (the review's same-line nit). New tool **`propose_sender_rule(mail_id, category)`** makes an approval request in the Inbox's conversation (the rule-3 approval service: Approve and Deny, 24 hours) and returns; the server saves the rule when the owner taps **Approve** (`ApprovalAction` `teach_sender_rule`, registered by the inbox module). **No tool of the Inbox agent writes a rule.** The request is **button only**: the YES window is closed right after proposing, and the card says so (`ApprovalCard.buttonOnly`). The Inbox's instructions say to propose only when the owner asks for it | `inbox-tools.test.ts` (`mark_triage`'s four tests rewritten: one mail only, replay, no teaching, a hidden mail; +6 for the rule: the card and the typed YES, Approve saves and the next mail skips the classifier, Deny and expiry save nothing, one request per call id, refused mails, no tool writes a rule), `m5.test.ts` (the Inbox's seven tools), `inbox-cards.test.ts` (+2: the card's text) |
| **B2** | `setup-google.md`: explain the Testing-mode 7-day expiry, recommend "In production", mark "verify on first setup", document the reconnect flow | New **step 1.6 "Publish the app (In production)"** with why, what it costs (the unverified-app screen, 100 users) and the fallback of staying in Testing; a section **"The first week (to verify)"** says how to find out (look at Settings on day 8); **"When the sign-in stops working"** lists the causes and **"Connecting again"** gives the command (`pnpm connect:google --login-hint …`), what the owner sees and what happens to mail that arrived meanwhile. `SETUP.md` §7 and its closing checklist say the same; README mentions it | docs only |
| **B3** | Jev circuit breaker (N consecutive failures/timeouts → rules mode for a cool-down, UI badge), bounded total time per sync | **Breaker inside `createJevTriage`** (`triage/breaker.ts`): 3 mails in a row that Jev failed on (timeout, outage, refused key, unreadable answer; a cancelled request does not count) open it for 15 minutes; a paused call throws `JevPausedError` (an "unavailable" error: rules answer, provisional, asked again later) without touching the network; after the cool-down the first failure opens it again at once and a success closes it. `Triage.pausedUntil()` feeds Settings: badge **Rules mode (Jev paused)** and "not asked until …". And a **per-sync budget**: `maxTriageMs` = 90 s of the Harness clock; when spent the rest of the new mail is sorted by the rules without asking Jev (provisional) and the next sync gives it to Jev (`classifyMail({ rulesOnly })`) | `inbox-triage.test.ts` (+5: the breaker alone ×3, a sync that pays for four calls and then none and asks again after the cool-down, the budget), `inbox-accounts.test.ts` (Settings), `google-accounts.test.ts` (+1, the badge) |
| **B4, B5** | Accepted as built. Add: pending suggestions expire after 7 days | `SUGGESTION_TTL_MS` (shared); new status `expired` (migration `inbox/005`: the table is rebuilt, SQLite cannot change a CHECK); expired lazily when someone decides, suggests or the cards are delivered, and by the ten-minute sweep; Add and Dismiss are refused with a 409 that says why; the same follow-up may be suggested again; the card carries `expiresAt` and shows **Expired** (the web uses its clock, as for approvals) | `inbox-tools.test.ts` (+2), `inbox-cards.test.ts` (+2) |
| **Doc-claims table** | Make each claim true or fix the doc | See the table under this one | |
| **Nits** | Fix where < ~15 min | C1, C2, C4 fixed; C3 left on purpose (below) | |

**The review's doc-claims table**

| Claim | Now |
|---|---|
| `connect.ts:109` "The assistant reads it within a few minutes" | The CLI says it **notices the account within ten minutes, or at once when Settings → Google accounts is opened** (the 10-minute sweep and the refresh a Settings read does); `setup-google.md` §3 and `SETUP.md` §7 say the same |
| "The bar for done: owner only does 3 things" | True for the mechanics; for the weekly experience only with the app **In production**, which `setup-google.md` now recommends as a step of the setup (1.6), with the check on day 8 and the reconnect flow written down |
| `SETUP.md` §2, the OpenAI sign-in | The claim about the credential file is **verified**: the shape (`type: "oauth"`, `access`, `refresh`, `expires`, extra keys kept) against pi-ai's `OAuthCredential` and against the key names of the owner's own `~/.pi/agent/auth.json` (names only, no value read), and by a new test that feeds the store such a record, tightens its mode and keeps every key through a refresh (`credentials.test.ts`). The hand copy is now **one command that prints no token** (run against a stand-in `auth.json`: mode 0600 in a 0700 folder; it refuses with a message when pi has no `openai` entry). Still "to verify": that OpenAI accepts the copied refresh token for the server |

**Nits.** C1 `pnpm connect:google --port 80` now reports the bad flag (exit 2) **before** reading the client file or creating `<data>/secrets` (`checkFlags`; test, and checked through `pnpm`). C2 `remove()` bumps a per-account counter that a refresh in flight checks before it caches a token, so a removed account's token cannot reappear (test with a held token endpoint). C4 `GOOGLE_HOSTS` now says it is a host list and not the method guard. **C3 (`GET /api/settings/google` runs `refresh()`) is left as designed**: the side effect is idempotent and is how a sign-in made with the command shows up the moment the owner opens the card; an explicit check route would make the owner press a button for what the page does by itself. `design-notes.md` says so.

## 2. Commands and results (serial, on the final tree)

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, 0 errors |
| `pnpm lint` | 310 files, clean |
| `pnpm test` | **66 files, 1,489 tests pass** (before the fixes 66 / 1,458: +31 tests) |
| `pnpm build` | ok; `apps/server/dist/main.js` 904,129 bytes, built after the last source edit |
| Probe `s01-poison.ts` (the reviewer's, run unchanged through `node`) | **before** (this tree before the fix): `first read ok historyId 1003`, then 5 × `THROWS: Google's answer is larger than this program reads.`, `history_id` stays 1003, stored 6 → 9 → 12 → 14 → 14. **After**: run 1 `ok stored=11 historyId=1015`, runs 2 to 5 `ok stored=0`, 14 mails stored, `missing healthy: []` (the poison is asked for in runs 1 to 5 and then left alone) |
| Bundle smoke, fake mode (`ASSISTANT_DATA_DIR=/tmp/m5fix-smoke … ASSISTANT_PORT=3005 node apps/server/dist/main.js`) | applied the migrations including `inbox/004_read_failures` and `inbox/005_suggestion_expiry`; four daily jobs; both demo accounts synced; `GET /api/settings/google` → mode fake, triage rules, no `skipped`; exits on SIGTERM; dir removed |
| Bundle smoke, real mode, no client file | logged `[google] no OAuth client file at …/google-oauth.json…` and `[jev] no key…`; `clientConfigured:false`; `<data>/secrets` mode 700 |
| `pnpm connect:google --port 80`, no data dir | `--port must be a port number from 1024 to 65535.`, exit 2, nothing created; without flags: the missing-client message, exit 1 and `secrets` at 700; `--list` exit 0 |
| Browser check (`pnpm dev`, faux model, fake Google, `agent-browser`, 1100 and 390 px) | §3 |
| Break-and-restore | §6 |

## 3. What the browser check found

Method as in M5's (`pnpm dev`, throwaway data dir, faux model, fake Google, fake push subscription). The fake Google cannot fail on one message, so the read failure that Settings and the digest showed was a **row inserted into the scratch database** (the text and the numbers it produced come from the real code paths). The dev model only echoes `/tool` results: it did not act on anything.

| # | Finding | |
|---|---|---|
| BF1 | The approval card of a sender rule said "A reply of YES also works, if this is the only request waiting…", but the request is button only (the typed YES does nothing, checked: two requests pending, a "YES" sent to the Inbox, nothing approved) | **Fixed**: `ApprovalCard.buttonOnly` (set by `propose_sender_rule`) and the card says "Nothing happens until you tap Approve. A reply of YES does not count for this one." Other approvals keep their sentence. Tests in `inbox-cards.test.ts` and `inbox-tools.test.ts` |
| BF2 | The digest line about skipped mail ended "(Google's answer is larger than this program reads.)." (two stops) | **Fixed**: "…look for it in Gmail. Last reason: …"; the tests pin it |
| BF3 | The first digest after a skip is **not empty** (it carries the line about the skipped mail), so it asks the model and pushes | **By design** (decision 2): the digest said it once, and the next, with nothing, was a card with no push |
| BF4 | **Everything else held** | – |

What held: Settings → Google accounts shows the red note under the account with the count and the reason, no horizontal scroll at 390 px on Settings or the Inbox thread (`scrollWidth` 390, no card wider than the viewport, nothing scrolling inside a card). In the Inbox thread `mark_triage` answered "Only this mail changed." and made no rule; `propose_sender_rule` made an approval card with Approve and Deny; **Approve** (a real click) saved the rule (`inbox_rule` one row, request `executed`, via `button`) and the card turned "Approved". An **empty digest** (all three attention mails marked newsletter) at 20:21 posted the card "No mail needs your attention since the last digest." and `dev-push-outbox.jsonl` stayed at one line; the non-empty one before it had pushed `{"title":"Inbox","body":"Your inbox digest","url":"/chat/inbox","tag":"digest"}`.

Not checked in a browser: the **Jev paused** badge (it needs a Jev, which means a call to TypeSafe: static render and `settings()` tests only), an **expired** suggestion (it takes a week; the web test moves the clock), a real failing message.

## 4. Changed files (this session, on top of the final report's tree)

```text
NEW   packages/extensions/src/inbox/triage/breaker.ts                          the circuit breaker (service-agnostic)
MOD   packages/extensions/src/inbox/{migrations,store,types,sync,accounts,facts,tools,index,suggestions}.ts   004_read_failures, 005_suggestion_expiry; A1, B1, B3, B4
MOD   packages/extensions/src/inbox/triage/{jev,index}.ts                      JevPausedError, the breaker, classifyMail({ rulesOnly })
MOD   packages/extensions/src/daily/{jobs,run,task}.ts  packages/extensions/src/index.ts   A2 (pushWhenEmpty, standsAlone, pushesFor); exports
MOD   packages/shared/src/{inbox,cards,index}.ts       skipped, pausedUntil, expired, SUGGESTION_TTL_MS, expiresAt, ApprovalCard.buttonOnly
MOD   apps/server/src/{agents,domain}.ts               Inbox instructions; comment. apps/server/src/google/{connect,accounts,oauth}.ts   C1, C2, C4, the CLI's message
MOD   apps/web/src/{components/{google-accounts,inbox-cards,cards}.tsx, lib/ui-messages.ts, app/globals.css}
MOD   tests: packages/extensions/test/{inbox-sync,inbox-accounts,inbox-tools,inbox-triage,inbox-digest}.test.ts, apps/server/test/{google-oauth,credentials,m5}.test.ts, apps/web/test/{google-accounts,inbox-cards}.test.ts
MOD   docs: README.md, docs/{PLAN,design-notes,SETUP,setup-google,setup-jev}.md, this file
```

## 5. Decisions of this session (★ = for the coordinator to veto; each is cheap to reverse)

1. ★ **Five failed syncs, not a time, before a message is skipped** (`maxReadAttempts`), and a run where *every* message failed is still a run that moved on (it is not thrown, so it does not back off): the failures are counted and retried at the normal pace. The price: a Gmail outage that breaks fetching but not listing for five syncs in a row (about 50 minutes) would skip healthy mail; Settings and the digest say so, and the earlier behaviour (a throw that never moved the cursor) lost nothing but also never recovered. Reverse: raise the number.
2. ★ **The first digest after a skip says so** (so it is non-empty and pushes). Mail nobody can search for is a loss the owner should hear of without opening Settings. Reverse: drop the `news` argument in `facts.ts`.
3. ★ **B1 is button only and has no list of rules.** The request is created with its YES window closed; the card says so. Rules the owner approved can be overridden by approving another for the same sender, but there is no screen that lists or deletes them, and a `domain` rule still has no way to be made. Reverse: drop `closeYesWindow` (and `buttonOnly`).
4. ★ **The breaker lives in memory** and has no half-open limit of one probe: after the cool-down the next calls go through, the first failure reopens it. A restart forgets it (one more bout of failures). 3 mails, 15 minutes and 90 s are constants in `jev.ts` / `DEFAULT_SYNC`, not settings.
5. ★ **A suggestion's expiry is a status (`expired`) and costs a table rebuild** (migration `inbox/005`), rather than a derived state, so that duplicates, delivery and the sweep all see one fact. `inbox/001–003` were not edited.
6. ★ **C3 is left as it is.** 7. `setup-google.md` recommends publishing "In production" as a numbered step, still marked "to verify": if Google's 7-day rule turns out not to apply, the step is harmless.

## 6. Break-and-restore (one rule broken at a time, the targeted test file run, the file restored and checked byte-identical by the script)

| Mutant | Killed by |
|---|---|
| M1 a failing message ends the whole run again (A1) | 3 tests in `inbox-sync` (the probe's scenario among them) |
| M2 the failure list is not a retry queue | 2 tests in `inbox-sync` |
| M3 a full read asks again for a message it gave up on | "is not asked for again by a full read…" |
| M4 a message is never given up on | 2 tests in `inbox-sync` |
| M5 an empty digest pushes again (A2) | "is a card, costs no tokens, and sends no push…" |
| M6 the briefing stops pushing when empty | `daily` "posts a card and asks the model nothing…" |
| M7 `mark_triage` accepts a hidden mail | "refuses a mail that is not there and a mail that is hidden" |
| M8 the approved rule is not saved (B1) | "saves the rule when the owner taps Approve…" |
| M9 the YES window stays open for a proposed rule | "asks the owner with an approval card… cannot be answered by a typed YES" |
| M10 the breaker never counts a failure (B3) | 3 tests in `inbox-triage` |
| M11 the per-sync time budget is ignored | "stops spending time on Jev once a sync has used what it is given…" |
| M12 (was) Jev asked again for provisional mail while paused | **survived**: the check was an optimisation with no observable effect (a paused Jev refuses at once either way), so the check was removed rather than tested |
| M13 Settings is not told that Jev is paused | "says that Jev is paused, and until when…" |
| M14 a suggestion never expires (B4) | 2 tests in `inbox-tools` |
| M15 a bad flag is checked after the client file (C1) | 2 tests in `google-oauth` |
| M16 the web ignores a suggestion's expiry | "is expired once its week has passed unanswered…" |
| M17 the digest forgets mail it gave up on | "tells the owner once about mail that could not be read…" |
| C2 (by hand) a refresh in flight caches a token after `remove()` | "does not get the token kept…" |

## 7. Could not verify (no network, by the handoff's rule)

Everything the final report lists still stands (real Google, Jev's request and answer shape, a real model). Added by the fixes: that an unverified app **In production** really avoids the weekly sign-in expiry and still works for its owner; Google's password-change and six-month rules (written in `setup-google.md` as from its documentation); that a real model proposes a sender rule only when asked (the instruction is a first draft; the control is the card); the **Jev paused** badge against a live Jev; that OpenAI accepts the refresh token copied from pi for the server.

## 8. Known gaps and risks

- No screen lists, edits or deletes sender rules; a skipped message cannot be retried from the UI (it is forgotten after 14 days, and its note in Settings with it, although the mail is still missing from search: the note says where to look while it lasts, and the digest said it once).
- A skipped message is skipped by id: if Gmail's failure was transient for five syncs in a row it stays out. Decision 1.
- The breaker's state is not shared with Settings across restarts; a restart shows Jev as available until it fails again.
- Untouched, still true from the final report: the briefing quotes three subjects; Disconnect keeps mail; the first real run decides the Google and Jev assumptions.

## 9. Suggested commits

Unchanged from §9 of the final report: these fixes fold into the same five commits (new file: `packages/extensions/src/inbox/triage/breaker.ts`, with the extensions commit; `docs/handoff-m5-fixes.md` with the docs commit).
