# M3 review (read-only), advisory for the coordinator

Reviewed: `HEAD 14084d3` (the M2 commits) plus the working tree: 22 modified and 24 new files (this brief included); node_modules/.next/dist/data* excluded.
Read: `handoff-m3`, `progress-m3`, PLAN §2/§5.4/§7, `design-notes`, `handoff-m2(-2)`, `progress-m2` (C1-C4 claims), `review-m2`; every new or changed source and test file; screenshots 02, 03, 07, 09.
Durable behaviour was checked in the installed 1.4.0 `dist` (`packages/extensions/node_modules/@earendil-works/pi-durable/dist`), not the checkout.

**Verdict: 0 blockers, 3 should-fix (B1-B3), 2 decisions for you (D1-D2), 13 nits (N1-N13), 7 unverified risks (U1-U7).**
The core holds: row-is-truth with a generation counter, the shared `timers.ts` (M2's reminder tests are unchanged and green), zero-token cards,
rule 8 on every write tool, the hook on the two new delete tools, per-module migrations, DST/leap-day arithmetic. Act first on B2 and B3 (cheap, realistic); B1 is the M2-C1 class again.

Claims in the docs that do **not** fully hold:
- "the phases tolerate a timer that is back from before its own card" (PLAN §5.4:214, design-notes:195): true for follow-ups, **false for the last phase of a birthday cycle** (B1).
- "a card's `requestId` names what it is about" (progress-m3 §2.2/3, design-notes): a year is not what a birthday card is about (B2).
- "there is no `tool_search`" (progress-m3:83,139): Durable 1.4.0 ships it (N5). "one prompt-cache miss a day at most" (progress-m3:138): not how Durable applies sections (N5).
- PLAN §5.4:204 "Recurrence … create the next instance in the same commit" is stale: M3 does row first, successor after.

---

## A. Confirmed defects (reproduced against the code as submitted)

Repro scripts: `/tmp/m3-review-scratch/*.ts`, run with `node <file>` (Node 24 strips types; they import the repo and write only to temp dirs).

### B1 [should-fix, low likelihood] A power cut loses the birthday cards of a finished cycle
- Where: `packages/extensions/src/people/task.ts:145-163` (`check`: post, `startNextYear`, `finish`), `people/store.ts:347` (`isCurrent` asks only `gen`), `:374` (`advanceCycle` bumps `gen`, clears `reminded_at` and `durable_task_id`).
- Evidence `e1-birthday-rewind.ts`: person with birthday today, snapshot `durable.sqlite` while the timer sleeps, run to 19:00 (card 1, push 1, row `cycle_year` 2027, `asked_year` 2026), close, restore the snapshot (what a lost WAL tail looks like), reopen, `reconcile()`: **0 cards in the thread**, 0 pushes. The row still says `asked_year = 2026`, and the `people` section tells the model "the owner was asked … and has not answered" for a card the owner never saw.
  Control `e1b-birthday-morning-rewind.ts` (the cut lands before the cycle ends): the card is posted again, 1 card. So the hole is exactly "after `advanceCycle`".
- Mechanism: the follow-up timer was made tolerant (`isCurrent` accepts `asked`, test "is posted again when Durable's database comes back older…"). A birthday cannot be: finishing the cycle moves the row on with a new `gen`, so the rewound timer wakes in `check_wait`/`remind_wait`, sees `row.gen !== input.gen`, ends "superseded", and nothing re-posts. Same class as M2 C1 (a flag in the FULL database is not proof that the NORMAL one has the card). The push has usually gone out already, so the owner got a nudge and no card.
- Fix (simulated in `e1-fixed.ts`, not patched into the repo): at start, post again, idempotently (same `requestId`), the evening question of every person in `unansweredQuestions` whose `asked_at` is in the last 24 h, as `ApprovalService.recover` does for notices (`approvals/service.ts` `NOTICE_RECHECK_MS`). Healthy server: still 1 card; after the cut: 1 card. Build the card from `asked_year`, not `cycle_year` (already advanced). The morning card cannot be rebuilt (`reminded_at` is cleared); keep a `reminded_year` if you want it too. Add the rewind test for the birthday cycle (the follow-up one is the model) and correct the PLAN/design-notes sentence.

### B2 [should-fix] Correcting a birthday in the same year silently drops the new day's card, but the push is sent
- Where: `people/task.ts:131` and `:156`: `requestId = birthday:remind|check:<person>:<year>`. The date is not in the key.
- Evidence `e2-birthday-correction.ts`: person 10-26, card and push on 26 Oct 09:00; `update_person` birthday 10-27 (new cycle, same year); 27 Oct 09:00: **cards still 1, pushes 2** (the owner gets "1 birthday today" and finds no card). The evening card of the 27th posts only because no `check` card existed yet for 2026; if the wrong date's evening question had been posted, that one is lost too.
- Mechanism: Durable returns the first entry for a repeated `requestId` (design-notes relies on this); `update_person` starts a new cycle inside a year that already has a card. A follow-up that "moves" gets a new key because the key holds the time (`followups/task.ts:128,159`); a birthday key holds only the year.
- Fix (verified in a copy, `/tmp/m3-review-scratch/pkgs/extensions`: `people.test.ts` + `followups.test.ts` 66/66 green, and the repro then posts both days' cards): `birthday:remind:${row.id}:${date}` and `birthday:check:${row.id}:${occurrenceDate(row.birthdayMd, year)}`. Add a test: update the date after the old date's card was posted.

### B3 [should-fix] A bare "yes" typed to the new birthday question approves a waiting deletion
- Where: `approvals/service.ts:231-249` (`tryYes`), `approvals/store.ts:162` (`closeYesWindow`, called only from `tryYes`), the only caller is `http/app.ts:261`. The question card: `people/task.ts:152-158`.
- Evidence `e3-yes-vs-birthday-question.ts` (service level, the route only forwards the text): a `propose_delete_followup` is waiting; at 18:00 the timer posts "Did you wish Tashi a happy birthday?"; `tryYes(conversation, "yes")` returns a notice: "You replied YES. Deleted follow-up …", the meeting is gone, the model never saw the message.
- Mechanism: M2 closed the YES window on every message **the owner sends** (U1 fix). Cards that timers post do not close it. M2 accepted "a yes typed to a different yes/no question from the model" (veto point 2); M3 widens it: timers now ask yes/no questions by themselves, at any moment of the 24 h window, and the owner has "Yes, I did" next to a composer where "yes" is the natural reply. Needs a request left unanswered and no other message since, so low likelihood, but the effect is an irreversible deletion that no card announced.
- Fix (simulated in `e3-fixed.ts`): the `post` that `createDomain` gives the modules calls `closeYesWindow(conversationId)` after any entry that is not an approval notice (expose it on `ApprovalService`). A bare "yes" then goes to the model, and the approval card's "if you have not written anything since" stays true in spirit. Add a test next to `approvals.test.ts` "YES after another message".

---

## B. Decisions for you (product, not defects)

- **D1 [should-fix if you read "loops until resolved" literally] Nothing nudges or re-asks.** (a) The question is asked once; unanswered, nothing comes again: it stays a card in the thread and a line in the prompt section (progress-m3 §2.2/5 flags it). (b) A chained commitment ("call the firm Friday 10:00", `followups/tools.ts:433-444`, kind `commitment`, `askAt = eventAt + 30 min`) gets **no card at its due time**: the first thing the owner sees is "How did it go?" 30 minutes after they should have called (`followups/task.ts:142-165`); the PA rules do not tell the model to pair it with `add_task`. (c) A date-only answer ("Monday") is refused (`tool-support.ts:36`), so the model must ask for a time or invents one. Suggest: a nudge card at `eventAt` for commitments, one re-ask the next morning (and put "open `asked` follow-ups" into the M4 briefing row of PLAN), a default time of day for date-only follow-ups.
- **D2 Moving a meeting loses its agenda.** No `update_followup` (deferred by the worker): `resolve_followup` + `add_followup` leaves the accumulated points on the resolved row and nothing copies them. Cheap to add (title/time change, `gen` bump; the `requestId` already holds the time).

---

## C. Nits

- N1 `followups/store.ts:198` `WHERE status = '${filter.status}'`: M2's N5 pattern again. Safe (Durable validates arguments against the schema, `harness/tool.js:176-178`); parameterise.
- N2 `people/index.ts:33` lists today..today+7 (8 days) under a heading that says 7 days, today included (`:42`); `list_people upcoming_days: 7` is 7 days. The test "Edge" pins the 8-day reading. Pick one.
- N3 `followups/store.ts:449` deleting a child leaves the parent's `next_followup_id` pointing at it (no FK; `e6-migrations.ts`): `describeFollowup` prints `next: f_gone`, and a replayed `record_outcome` then answers "Nothing to follow up".
- N4 `people/task.ts:145-163` the evening question has no age limit (the morning card has `isDayOver`): after a long stop, "did you wish X?" arrives for a birthday months ago. Documented choice; consider a cut-off.
- N5 Doc facts: (a) `tool_search` exists in Durable 1.4.0 (`@earendil-works/pi-durable/tool-search`; `deferred?: true` and `callers` in `harness/types.d.ts:258-268`), the repo just does not install it. (b) Durable does not re-render the prompt: a changed section is appended as a `pi.system` patch holding the section's whole text, the prefix stays cacheable (`harness/prompt.js planSections`; `e8-sections.ts`: baseline entry carries 21 tools and 3 sections, the next day's change appended one `people` patch). Cost is one patch per change (a handful per birthday per year) until compaction, not a cache miss. (c) PLAN:204 stale (above).
- N6 21 tools = 15.8 KB of names, descriptions and schemas ≈ 3.9k tokens by chars/4 (a real tokenizer likely says 4-5k; `e5-tool-cost.ts`). M2's 8 ≈ 1.4k, M3 adds ≈ 2.6k; PA instructions ≈ 0.8k. They sit in the cacheable baseline, so this is latency and context more than a per-turn bill. The 3 `delete_*` tools (≈0.36k) are never meant to be called: `deferred: true` keeps the hook meaningful and costs nothing until loaded; the 3 `propose_delete_*`, `resolve_followup` and `update_person` are rare too.
- N7 `add_followup` has no duplicate guard (`add_person` has `findDuplicate`): a model retry after a tool error (`ensureScheduled` throwing at `followups/tools.ts:178`) creates a second meeting and asks twice.
- N8 `server.ts:465` log text "periodic repair of reminders and approvals failed" now also covers meetings and birthdays.
- N9 `timers.ts:108-117` `reconcile()` calls `harness.inspect()` even when no row is pending; the sweep does it three times now. Harmless at this size.
- N10 `cards.tsx` follow-up question and birthday cards stay actionable after they were answered (no derived state, unlike approvals); a later tap ends in the model's "already resolved".
- N11 Free text goes unescaped into system-role sections (`followups/index.ts:35,38,45`, `people/index.ts:47,62`): a newline or `</followups>` in a title or counterpart renders verbatim (`e11-section-escaping.ts`). Owner-typed today; M5's inbox hand-off will put email-derived text there. Collapse whitespace and strip `<`/`>` when storing, before M5.
- N12 `FollowupCard.event "updated"` is never produced; chained titles grow "Follow up: Follow up: …" until the 200-char cut (`followups/tools.ts:433`).
- N13 `apps/server/src/config.ts:4` imports all of `@assistant/extensions` for two constants.

---

## D. Unverified risks (mechanism read from code or Durable; not reproduced)

- U1 **A real model** (progress-m3 §4, acknowledged): `add_followup`'s own `kind` text calls "call the bank" a commitment, while `add_task` + reminder is how M2 reminds you to call the bank; the PA rules separate them only by "will need a follow-up". Meetings are matched by words only, and the model must copy ids from the prompt sections.
- U2 **Yearly timers across deploys.** Birthday timers are the first tasks that sleep for up to a year. Changing `createBirthdayTask` phases or state without `version` + `migrate` makes every sleeping timer `blocked` (Durable `#fit`/`inspect`); `liveTimers()` (`timers.ts:108-117`) counts any non-aborted task of the kind as live, so `reconcile()` never replaces it and the logs say nothing: birthdays stop until the date they were due. Put "never rename a phase; bump `version`, write `migrate`" in design-notes, and consider counting `blocked` (not only parked) tasks in the health report.
- U3 The size of what a power cut takes from Durable (`synchronous=NORMAL`, until the next checkpoint) is unmeasured; B1's likelihood depends on it.
- U4 Cards go to `row.conversationId` (the creator's conversation) while the pushes link to `/chat/pa` (`followups/task.ts:18`, `people/task.ts:14`): wrong chat if a non-PA agent ever gets these tools (M5/M6).
- U5 `people_person.notes` is free text in one table with no scope; give it one before another agent gets `list_people`.
- U6 Real push delivery. One tag per kind: two birthdays or two agendas at once collapse into one banner ("1 birthday today").
- U7 The new buttons (`Record outcome`, `Yes, I did`) have no component test; the one bug found there ("Composer is not available") was found only in the browser. Screenshots 02/03/07/09 match the report.

---

## E. Did the M2 guarantees regress with the shared scheduling code? No, with B1 as the exception

`tasks/scheduler.ts` is now an instance of `createTimerScheduler`. I diffed it against HEAD line by line (same claim, attach, detach, `identify` and reconcile logic, same `TIMER_TASK_OPTIONS`); `tasks/store.ts`, `tasks/reminder.ts`, `post.ts` and `reminders.test.ts` are unchanged, and that suite is green.

| M2 guarantee | Reminders | Follow-ups | Birthdays |
|---|---|---|---|
| C1 a rewound Durable still gets its card | unchanged, tested | holds (`isCurrent` ignores `asked`; rewind test) | **B1** after the cycle ends; holds before |
| C2 zero tokens | holds | holds: `entry.model` undefined asserted, model call count unchanged | holds |
| C3 replay answers from the first run before validating | holds | `add_followup`, `add_agenda_point`, `record_outcome`, `resolve_followup`: lookup first, tests replay after the time passed | `add_person`, `update_person`, `record_wish`: lookup first |
| C4 periodic safety net | holds | `sweep()` reconciles all three kinds (server test "makes the timer again, while running…"); a phase that throws faults the task and the sweep re-creates it: 1 card, 1 push (`e12-faulted.ts`) | same (`e12`) |

Race check `e7-race.ts`: `ensureScheduled` x2 and `reconcile` x2 at once on a row with no timer create 4 timers; the generation makes 3 stale; after the due time: **1 card, 1 push**.

---

## F. Checked and holding (no need to re-check)

- **Follow-up state machine** (`waiting → asked → resolved`; timer `agenda_wait → agenda_ping → ask_wait → ask`): agenda only with points and only within 5 min after the start; late timer skips it and still asks; `ask` posts once (`requestId followup:<id>:<askAt>`, tested with a crash between card and row); `record_outcome` resolves, bumps `gen`, creates the child and writes the ledger in one transaction, replay makes no second child; `needs_followup` without a time and the contradiction are errors that say what to do; deleting a parent nulls the child's `parent_id` (FK on, verified); Stop does not cancel timers (background tasks; test); the stale timer of a resolved or deleted row ends "superseded" without posting.
- **Birthdays**: local morning/evening, skipped when wished, "not yet" does not silence the evening, added after 09:00 gets only the evening, years missed are skipped. **DST end to end** (`e9-dst-e2e.ts`, America/New_York, fake clock, a copy of the fixture with a timezone option): 8 Mar 2026 reminds at 13:00Z (09:00 EDT) and asks at 22:00Z, next year 14:00Z/23:00Z; 1 Nov 2026 14:00Z/23:00Z, next year 13:00Z/22:00Z. 29 Feb → 28 Feb in 2027, 29 Feb in 2028 (`e4`), midnight renders `00:00` not `24:00` (`e10`).
- **Approvals**: `delete_followup`/`delete_person` are registered (`createDomain` registers every module's actions); the hook blocks a model call (real Harness, scripted model, both tests); the tools also refuse without an approved request (`runApproved`); target strings are tool-qualified (`followup:<id>`, `person:<id>`), so no aliasing; YES is reachable only from `POST …/messages` (B3 aside). `approvals/` is untouched.
- **Zero tokens**: all three card kinds use `deps.post` (no `model` anywhere in `followups/`, `people/`, `timers.ts`); pushes are four constants without names.
- **Migrations**: M2 database upgrades with exactly `followups/001, 002` and `people/001, 002`, rows kept, second run applies 0 (`e6`); module order in `MODULES` does not matter by policy. Existing PA conversations get the new extensions through `ensureAgents → reconcileAgent` (read; `agents.test.ts:133` covers it).
- **Surface not touched by M3**: no new route, nothing under `apps/server/src/http`, `apps/web/public/sw.js`, `push/`, `packages/db` (`git diff HEAD` empty), so guards, VAPID permissions, 404/410 cleanup, the SW origin check and the retry endpoint are as `review-m2` left them. No `dangerouslySetInnerHTML`/`innerHTML` in `apps/web/src`; cards render text.
- **Long sleeps**: `nativeTimer` waits out delays beyond `setTimeout`'s limit in steps (`dist/timers.js`), as the design-notes say; the 30 s `resume()` tick is the backstop.
- Rule 7 holds for ages: `turns` is computed by code (`turnsIn`), never by the model.

---

## G. Test quality

- Strong: real SQLite and Durable, fake clock, crash windows simulated (hung `post` + close + reopen, rewound `durable.sqlite`), whole-server tests over HTTP with the dev model, mutation spot-checks reported by the worker. I ran the three M3 suites plus `reminders.test.ts` three times at once: 93/93 each, stable.
- Missing, each guards a finding: rewind of a finished birthday cycle (B1); date correction after a card (B2); YES after a timer-posted question (B3); a faulted (not aborted) follow-up or birthday timer (behaviour verified in `e12`, no test); Stop keeps birthday timers (shared code, so low value); button flows in the web (U7).
- Weak spots: 150 ms `settle()` sleeps prove absence by waiting (stable in 3 concurrent runs); no real-model test is possible here.
- Unrelated and pre-existing: in my **first** full run `apps/server/test/file-lock.test.ts › serializes critical sections of many contenders` failed (`LockHeldError` at `file-lock.ts:159`; 552/553); the second full run was 553/553. This is the flake described in `progress-m2.md` §5; the suggested fix there still stands (keep polling in `acquireFileLock` while the deadline has not passed).

---

## H. What I did and did not do

- Ran: `pnpm typecheck` (5 packages ok), `pnpm lint` (155 files ok), `pnpm test` twice (above), the three-way concurrent run of 4 suites, and the scratch scripts (temp directories only, no server, no network).
- The repo is untouched: sha256 of every non-ignored file (182) is identical before and after (`/tmp/review-m3-baseline.sha`, `/tmp/review-m3-after.sha`). No edits, installs, formatting, git commands that change anything, `pnpm build`, logins or long-lived servers. Fixes were tried only in a copy (`/tmp/m3-review-scratch/pkgs/extensions`) or simulated in scripts.
- Not done: build, browser, real push service, a real model.
- Left in `/tmp` (deleting needs your yes): `/tmp/m3-review-scratch/` (scripts e1…e11, the package copy), `/tmp/review-m3-{typecheck,lint,test,test-b,conc-1,conc-2,conc-3}.log`, `/tmp/review-m3-{baseline,after}.sha`. The worker's `/tmp/assistant-shots/m3/` is as it left it.
