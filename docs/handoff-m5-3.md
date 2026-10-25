# Handoff 3: M5 — Inbox agent (Gmail + Calendar, read-only) and Jev triage

Third worker. Repo `/home/kzoeps/Projects/personal/assistant`, branch **`main`**, **nothing committed** (the coordinator commits: do not commit or push).
Read first: `docs/handoff-m5.md` (the scope and "Bar for done": a reviewer fails the milestone on anything the owner must do beyond
credentials, `pnpm connect:google`, `JEV_API_KEY`), `docs/handoff-m5-2.md` (§4 verified Durable facts and §5 worker 1's decisions still
hold), this file. Rules that still apply: no calls to Google or TypeSafe (fakes only), no logins, stop every server you start, pnpm, no
`railway`, **never `git checkout`/`git restore` on this tree** (everything is uncommitted). Context hygiene: at ~55% finish the current
item, write `docs/handoff-m5-4.md`, reply DONE-HANDOFF.

**What is left is small: the browser check, the final report in `docs/progress-m5.md`, a last run of the gates, then reply DONE-M5.**

## 1. State: done and verified

Last full run (serial, after the last code change; only docs were edited after it):

| Check | Result |
|---|---|
| `pnpm typecheck` | 5 packages, 0 errors (web included) |
| `pnpm lint` | 309 files, clean |
| `pnpm test` | **66 files, 1458 tests, all pass** (before M5: 55 / 1185; handoff 2 left 11 failing, all fixed) |
| `pnpm build` | ok; `apps/server/dist/main.js` 889 kB |
| Bundle smoke (`ASSISTANT_DATA_DIR=/tmp/m5-smoke … ASSISTANT_PORT=3005 node apps/server/dist/main.js`) | applied all 29 migrations incl. `inbox/001_accounts_mail`, `inbox/002_rules_suggestions`, `inbox/003_digest_state`, `delegate/001_asks`; logged `[daily] scheduled for the first time: briefing, wrapup, digest_midday, digest_evening`; both demo accounts synced (4 and 2 mails); `GET /api/settings/google` → `mode fake`, `triage rules`, `syncMinutes 10`; `GET /api/settings/schedule` lists the 4 jobs; clean SIGTERM; data dir and log removed |
| Break-and-restore, 22 mutants | **all killed**, every mutated file restored and checked identical (sha256 in the script, `cmp` afterwards). Table in §6 |
| Not run yet | the **browser check**; nothing is running now (nothing on 3000–3099, no browser of mine; the Slack/Brave processes in `pgrep` are the owner's) |

### What this worker did (items of `handoff-m5-2.md` §2)

1. **The 11 failing tests and the job order: done.** `DailyService.list()` now sorts by `DAILY_JOBS` (briefing, wrapup, digest_midday, digest_evening);
   `config.test.ts` (3 new paths + tests for `ASSISTANT_GOOGLE_MODE` and `ASSISTANT_INBOX_SYNC_MINUTES`), `m3.test.ts` (PA extension `delegate`,
   tool `ask_agent`; the birthday power-cut test counts only pushes tagged `birthday`), `m4.test.ts` (4 jobs, log line), `m6.test.ts` (Inbox `["profile","inbox"]`),
   `daily.test.ts` (`open({ inbox: {} })` for the first-start test, 4 jobs in `list()`). `apps/server/test/domain-support.ts` `setup()` passes an **empty
   `createFakeGoogle`** to every whole-server test, so the demo mailbox does not add an Inbox line to old tests; a test that wants the demo mailbox passes
   `{ fakeGoogle: undefined as never }` through `h.start(undefined, more)`.
2. **Web: done** (`pnpm --filter @assistant/web typecheck` clean, 298 web tests pass). New: `components/inbox-cards.tsx` (mail list, mail, events, note, suggestion (+ the one sent),
   `ask_agent` answer, delegated question, late answer; `gmailLink()` follows only `https://mail.google.com/…`), `google-accounts.tsx` (Settings view, pure) and
   `google-card.tsx` (fetch, Disconnect with an in-page confirmation, "Check again"), `lib/suggestion-form.ts` (`answeredTheOtherWay`: buttons stay off only after a 409).
   Changed: `lib/ui-messages.ts` (cards `suggestion` with state from the later `app.notice` whose `data.suggestion.suggestionId` matches, first answer wins; `delegated`;
   `late_answer`; `InboxCard`; digest chip "📥 Inbox digest" for the Inbox thread), `lib/card-text.ts` (`DAILY_LABEL`, `isDigest`, `TRIAGE_LABEL`, `ASKED_AGENT_LABEL`, `cardSummary`
   for every new card), `lib/api.ts` (`decideSuggestion`, `fetchGoogleSettings`, `disconnectGoogleAccount`), `components/cards.tsx` (dispatch, `SuggestionButtons`, the daily card:
   a digest's mail is **open** with rows, the briefing's facts stay folded, the empty digest says "No mail needs your attention since the last digest."), `settings-view.tsx`
   (`<GoogleCard />`), `schedule-card.tsx` (hint mentions the digests), `globals.css` (an "Inbox" section; classes are `google-*`, `mail*`, `event*`, `card--suggestion`,
   `card--delegated`: `.account` is the Accountant's, do not reuse it).
3. **Tests: done** (all in §5's list). **Docs: done except `progress-m5.md`**: `docs/setup-google.md`, `docs/setup-jev.md`, `docs/SETUP.md` (new), README (status, quickstart paragraph for the Inbox,
   two config variables, `pnpm connect:google` in the commands table, data tree, "What leaves the machine for mail", the Inbox security bullet, secrets bullet, tests paragraph),
   `docs/design-notes.md` (new section "Inbox: …"), `docs/PLAN.md` (status, §2 rules 6 and 9, §5.1, §5.2, §5.4, §5.5, §6, §7 tables, §8 M5 row, §9).
4. Two code changes the tests forced (both small, both ★ below): `apps/server/src/google/mime.ts` (a real quadratic fixed) and `apps/server/src/google/connect.ts` (`chmod 0700` of `<data>/secrets`).

### New and changed files of this session (on top of `docs/handoff-m5-2.md` §1's tree)

```text
NEW   apps/web/src/components/{inbox-cards,google-accounts,google-card}.tsx   apps/web/src/lib/suggestion-form.ts
NEW   apps/web/test/{inbox-cards (30 tests), google-accounts (10)}.test.ts      (api.test.ts +3)
NEW   apps/server/test/{google-oauth (39), google-clients (35), m5 (16)}.test.ts (agents.test.ts +5, config.test.ts +2 tests and a row)
NEW   packages/extensions/test/{inbox-triage (58), inbox-digest (17), inbox-tools (26)}.test.ts
NEW   docs/{setup-google,setup-jev,SETUP}.md
MOD   apps/web/src/{app/globals.css, components/{cards,schedule-card,settings-view}.tsx, lib/{api,card-text,ui-messages}.ts}
MOD   apps/server/src/google/{connect,mime}.ts          packages/extensions/src/{daily/service,index}.ts (list order; exports MAX_DIGEST_LOOKBACK_MS, MAX_NEWS_AGE_MS)
MOD   apps/server/test/{config,domain-support,m3,m4,m6,agents}.test.ts       packages/extensions/test/{daily,support}.test.ts|ts
MOD   README.md  docs/PLAN.md  docs/design-notes.md
```
`packages/extensions/test/support.ts`: `openFixture` now **reuses the Inbox conversation recorded in `agents`** when it reopens the same files (before, a restart made an orphan
second Inbox conversation and `f.inboxEntries()` read the wrong one). New dependencies: none.

## 2. Remaining items, in order

1. **Browser check** (the only thing not run). `pnpm dev` with a throwaway data dir, faux model, the default **fake Google = demo mailbox**, `agent-browser --args "--no-sandbox"`
   (named session via `AGENT_BROWSER_SESSION`, `set viewport W H`, `eval "<js>"`; run `agent-browser skills get core --full` if a command is unclear), screenshots in `/tmp/assistant-shots/m5/`.
   Example start: `ASSISTANT_DATA_DIR=/tmp/m5-browser ASSISTANT_READ_PATHS=/usr/share/doc ASSISTANT_AUTH=off pnpm dev` (config refuses a read path that contains the data dir).
   Find a server's pid with `ss -ltnp | grep :3001`: **`pkill -f 'node apps/server/…'` also kills the shell that runs it** (the command line matches itself).
   Check, at 1100 px and at 390 px (`document.documentElement.scrollWidth === 390`, no card wider than the viewport, nothing scrolling inside a card, a script after each group, as in `progress-m7.md` §3):
   - **Settings → Google accounts**: two demo accounts connected with last sync and mail counts, the **Rules mode** badge and its sentence, the fake-mode note, no "client file missing";
     **Disconnect** → in-page confirmation → Cancel, then Disconnect → status "Disconnected", the Disconnect button gone, mail still counted, "Check again" works. **Settings → Daily schedule** lists four jobs.
   - Inbox thread (`/chat/inbox`): `/tool search_mail {"query":"plot"}` (rows, category chips, links with `target=_blank`), `/tool read_mail {"id":N}` (text folded), `/tool list_events {"range":"week"}`,
     `/tool mark_triage {"id":N,"category":"newsletter"}` (note card).
   - **Suggestion**: `/tool suggest_followup {"mail_id":N,"title":"Follow up with the realtor","at":"<a future ISO time>"}` in the Inbox thread → the "sent" card there and a card with **Add** and **Dismiss** in `/chat/pa`;
     press **Add** (buttons go off at once; the notice card appears and the PA answers: the dev model echoes the message, say so in the report), and a second suggestion with **Dismiss** (outcome line, no model run).
   - **Digest**: `PUT /api/settings/schedule/digest_midday {"localTime":"HH:MM"}` a minute or two ahead (or use Settings), wait: a digest card in the Inbox thread with the mail **open**, each row a link to Gmail,
     the Inbox agent's answer under an "📥 Inbox digest" chip, and a push line in `<data>/dev-push-outbox.jsonl` (tag `digest`, no mail text).
   - **`ask_agent`**: `/tool ask_agent {"agent":"inbox","question":"Is there mail from the bank?"}` in `/chat/pa` → the answer card; the Inbox thread shows "Asked by the assistant".
   - Dark mode if cheap. Stop every server, remove the scratch data dir. Fix what the check finds (as M7's did: say each finding and the fix), then re-run the gates.
2. **`docs/progress-m5.md`**: keep the worker-1 report ("M5 (partial)") and **append the final report in the M7 style**: state table by scope item, commands and results (§1 above, plus the browser check), changed files (§1 here + `handoff-m5-2.md` §1),
   decisions with ★ (§4), could-not-verify, known gaps and risks (§5), the break-and-restore table (§6), suggested scoped commits (§7). Fix the old "not started" rows of its §1 table and its §6 "open" list, which are now done.
3. **Gates once more if anything changed** (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`, serially: `file-lock.test.ts` is a known flake under CPU starvation, memory note), then reply **DONE-M5** (servers stopped, scratch removed).

## 3. Failing checks right now

None. (If `pnpm test` shows a failure, run that file alone first; the only known flake is `apps/server/test/file-lock.test.ts` "serializes critical sections of many contenders" when two suites overlap.)

## 4. Decisions of this session (★ = for the coordinator to veto; each is cheap to reverse; worker 1's are in `handoff-m5-2.md` §5)

1. ★ **`pnpm connect:google` closes `<data>/secrets` to 0700** (after `mkdir -p`): the owner makes the folder by hand to put `google-oauth.json` in (default 0755) and PLAN rule 9 says 0700. Tested (`google-oauth.test.ts`).
2. ★ **Fixed a real quadratic in `decodeEntities`** (`google/mime.ts`): the `;` of an entity was searched to the end of the part for every `&` (about 290 ms for a 256 KB part of ampersands, and a hostile mail can carry many parts); it now looks 12 characters ahead (`closingSemicolon`). Pinned by `google-clients.test.ts`.
3. ★ **An empty digest still pushes** ("Your inbox digest"), as worker 1 built it and as the briefing's empty card does. Twice a day an empty digest is noise; a per-job `pushWhenEmpty: false` on `DailyJob` is the cheap change if the coordinator agrees. Not changed; documented in `design-notes.md` and PLAN §9.
4. ★ **Whole-server test helper default is an empty fake Google** (`domain-support.ts`), and `openFixture` reuses the recorded Inbox conversation on reopen (`support.ts`).
5. `DailyService.list()` is in `DAILY_JOBS` order (briefing, wrapup, digest_midday, digest_evening), not chronological; Settings shows that order.
6. The digest card shows its mail **open** (links are the point); the briefing and wrap-up facts stay folded. Disconnect asks once more in the page (the owner's own action: no approval, local only).
7. `SETUP.md` gives the OpenAI credential steps and the `tailscale serve` flags **as "to verify"**: there is no `pnpm login:openai`, and neither could be run here. The `openai` provider id is the one the server asks for; pi's own `~/.pi/agent/auth.json` has an `openai` OAuth record (I read only the key names, never a value).

## 5. Known gaps and risks (for the report)

- **Never exercised for real**: Google's REST (history 404, label records, `historyTypes` repeated, a Desktop client's loopback redirect, id-token handling), the 7-day Testing-mode refresh-token expiry (**stated as "to verify" in `setup-google.md`**), Jev's request and answer shape
  (`triage/jev-contract.ts`, `TODO(verify)`, stated in `setup-jev.md`), and a **real model** driving the Inbox instructions, the digests, `ask_agent` and the PA's use of a suggestion. All tested against fakes only.
- The web's **clicks** (Add, Dismiss, Disconnect's confirmation) are verified by static render and the pure helper (`answeredTheOtherWay`) only: the web tests have no DOM library. The browser check is where they get pressed.
- `mailItem`/`mailLine` do not re-clip a stored subject: the sync bounds it to 300 characters on write and the briefing re-clips to 80, so a row that bypassed the sync (impossible today) would not be bounded. Not changed (outside the task); a one-line `safeLine` there is the fix.
- A pending suggestion does not expire: if its time passes before the owner presses Add, the PA's `add_followup` may refuse a past time (the PA says so in chat).
- Opening Settings → Google accounts calls `refresh()` (by design: a sign-in made with the CLI is noticed at once), so a read has a side effect: it can start a sync.
- The briefing quotes the top three subjects (an untrusted-text channel into a model with write tools): bounded by the PA's rules, rule 3 and the owner-confirmed Add (design-notes says so).
- Older `/tmp/assistant-shots/` (M7's) and `/tmp/assistant-review-*` are not from this work. The `/tmp/assistant-ext-*`, `/tmp/assistant-google-*`, `/tmp/assistant-test-*` directories of my test runs are removed (none left).

## 6. Break-and-restore (for the report: one rule broken at a time, the targeted tests run, the file restored and checked identical)

| Mutant | Tests that failed (killed) |
|---|---|
| M1 loopback accepts any `state` (`oauth.ts`) | `google-oauth` "refuses a request with the wrong state and keeps waiting" |
| M2 PKCE verifier not sent | "trades the code and the PKCE verifier…" |
| M3 loopback listens on `0.0.0.0` | "listens on 127.0.0.1 and on no other address" |
| M4 a write scope (`gmail.modify`) is asked for | "asks for exactly the two read-only scopes…" and the CLI test |
| M5 loopback ignores the `Host` header | "answers 404 to another path, another method and a foreign Host header" |
| M6 an ID token for another client is accepted | 2 tests |
| M7 `invalid_grant` does not mark the account (`accounts.ts`) | `google-oauth` and `m5` (revoked flow) |
| M8 an unreadable account file counts as empty | "refuses a file it cannot read instead of treating it as empty" |
| M9 the secrets folder is left as the owner made it (`connect.ts`) | "saves the sign-in in a file only its owner can read, in a folder only its owner can enter" |
| M10 the ampersand scan is quadratic again (`mime.ts`) | "does not run away on input made to hurt" |
| M11 history 404 is not `HistoryExpiredError` | `google-clients` |
| M12 the clients send `POST` | `google-clients` and `m5` ("GET only, to Google's hosts") |
| M13 search ignores hidden mail (`store.ts`) | `inbox-tools` "leaves out mail Gmail deleted or trashed" |
| M14 the digest window is not saved (`facts.ts`) | 6 tests in `inbox-digest` |
| M15 what the owner taught is ignored (`rules.ts`) | 4 tests in `inbox-triage`/`inbox-tools` |
| M16 Jev may follow a redirect (`jev.ts`) | `inbox-triage` "goes to the official address and to no other…" |
| M17 Jev gets the whole text, not 1,500 characters | "shows Jev the sender, the subject and at most the first 1,500 characters…" |
| M18 the other answer to a suggestion is allowed (`suggestions.ts`) | 3 tests (`inbox-tools`, `m5`) |
| M19 `read_mail` lets the text close its own frame | "frames the text as data…" |
| M20 a card links wherever the data says (`inbox-cards.tsx`) | 2 tests |
| M21 a mail link keeps the opener | 2 tests |
| M22 a digest ignores the three-day limit | "never reaches back more than three days…" |

## 7. Suggested scoped commits (the coordinator commits; replaces the list in `progress-m5.md` §7)

1. `shared: add the Inbox's wire types, cards and digest job ids` — `packages/shared/src/*`
2. `extensions: add the inbox module (sync, triage, digests, suggestions) and ask_agent` — `packages/extensions/src/{inbox,delegate,daily,module,index}*`, `packages/extensions/test/*`
3. `server: add Google sign-in, the Gmail and Calendar clients and the Inbox wiring` — `apps/server/src/**`, `apps/server/test/**`, both `package.json` (the `connect:google` scripts)
4. `web: add the Inbox's cards, the suggestion buttons and Settings → Google accounts` — `apps/web/**`
5. `docs: add the Google and Jev setup guides, the owner's checklist and M5 notes` — `README.md`, `docs/{PLAN,design-notes,SETUP,setup-google,setup-jev,progress-m5,handoff-m5*}.md`
