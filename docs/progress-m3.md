# M3 progress log (worker → coordinator)

# FINAL REPORT — Milestone 3: follow-ups, meeting agendas, people and birthdays

Branch `main` (as the handoff instructs). Nothing committed or pushed. No OpenAI, Google or TypeSafe call, no real push service, no
login, no `railway`; nothing written outside this repository except the screenshots in `/tmp/assistant-shots/m3/` (kept on purpose).
One worker, no handoff needed. Scope: `docs/handoff-m3.md`. Verified Durable facts are in `docs/handoff-m2-2.md` §3 and §2.3 below.

## 1. Changed files and directories

```text
packages/shared/       cards.ts (entry kinds app.agenda / app.followup / app.birthday and their data; tool cards followup,
                       followup_list, person, people_list), index.ts
packages/extensions/   NEW  timers.ts (the scheduling code reminders, follow-ups and birthdays share), schedule.ts (ScheduleSettings,
                            defaults, scheduleOf), tool-support.ts (text, asDetails, TIME_HELP, resolveInstant)
                       NEW  followups/{index,migrations,store,task,scheduler,tools,match}.ts
                       NEW  people/{index,migrations,store,task,scheduler,tools,birthdays}.ts
                       edited: module.ts (DomainDeps.schedule), time.ts (localDate, addDays, atLocalTime, endOfLocalDay), index.ts,
                               tasks/scheduler.ts (now an instance of timers.ts; same behaviour and report shape),
                               tasks/tools.ts (imports the three helpers that moved to tool-support.ts; nothing else)
                       tests: NEW followups.test.ts (35), people.test.ts (31); edited support.ts (modules, `schedule` option, textOf)
apps/server/           edited: domain.ts (four modules, repair and sweep for follow-ups and birthdays), config.ts (four settings),
                       server.ts (schedule into the domain; repair log for follow-ups and people), agents.ts (PA instructions)
                       tests: NEW m3.test.ts (7), domain-support.ts (helpers for whole-server tests); edited config.test.ts (+4)
apps/web/              edited: lib/{ui-messages,card-text}.ts, components/cards.tsx, app/globals.css
                       tests: cards.test.ts (+4)
docs/                  README.md, PLAN.md, design-notes.md (new section), OPS.md, progress-m3.md (this file)
```

About 4,800 lines of source and tests added, 22 tracked files modified (+1,100 / −180 including docs). No new dependency.

## 2. Decisions and deviations

### 2.1 Where M3 differs from the handoff
- **`agenda_item` is `followups_agenda`** (module prefix rule of PLAN §5.2), with an integer id. `followups_item` gained `kind`
  (meeting | commitment), `counterpart`, `ends_at`, `agenda_lead_minutes`, `gen`, `durable_task_id`, `agenda_pinged_at`, `asked_at`,
  `resolved_at`, `conversation_id`. PLAN §7 shows the final tables. Ledgers `followups_call` and `people_call` (rule 8 for the tools
  that change a row) as in M2.
- **Four settings** (`ASSISTANT_AGENDA_LEAD_MINUTES` 15, `ASSISTANT_FOLLOWUP_ASK_DELAY_MINUTES` 30, `ASSISTANT_BIRTHDAY_REMIND_TIME`
  09:00, `ASSISTANT_BIRTHDAY_CHECK_TIME` 18:00), validated in `config.ts` (the check must be later than the reminder); the agenda
  lead can also be set per meeting (`agenda_lead_minutes`), the end of a meeting with `ends_at`. "Configurable" in the handoff.
- **`event_in_minutes` and `next_in_minutes`** next to `event_at` / `next_at` (as M2's `remind_in_minutes`): a relative ask needs
  no clock, and the browser check and the README examples need them.
- **No `update_followup` tool.** It is not in the scope, so a meeting that moves is `resolve_followup` or a deletion plus
  `add_followup`. The row/generation design makes it cheap to add (see §6).
- **Birthday required** on `add_person` (the column is `NOT NULL`); `update_person` cannot clear it or the birth year (a birthday
  without a year keeps the saved one).
- **A recorded "not yet" does not silence the evening question** (the handoff says "if not recorded"). A "yes" does, and so does
  recording it before the morning (then no morning card either).
- **Push payloads** (all generic, no names): "1 meeting is about to start", "1 question: how did it go?", "1 birthday today",
  "1 question: did you wish them?"; tags `agenda`, `followup`, `birthday`.
- **Web:** besides the cards, the question card has a *Record outcome* button and the evening birthday card *Yes, I did* / *Not yet*;
  they only put a sentence in the composer (the answer still goes through the chat).

### 2.2 Decisions to review (reasoning in `docs/design-notes.md`, "Follow-ups, agendas and birthdays"; each is cheap to reverse)
1. **Shared scheduling code** (`timers.ts`: `createTimerScheduler` + one `TimerKind` per module). M2's `createReminderScheduler` is now
   an instance of it; its tests are unchanged and green. `ReconcileReport` keeps its shape (`itemId`), so the server's repair log
   treats the three kinds alike (each with its own remedy SQL: re-point the row at the PA's current conversation).
2. **Every phase of a multi-phase timer accepts a row that already says "asked".** The first version let only `ask` do so; the test
   with Durable's database rewound (power cut) failed, because the timer comes back at `agenda_wait` while `app.sqlite` says "asked"
   and ended itself as superseded: the same loss C1 fixed for reminders. All phases now fall through to `ask`, which posts again
   idempotently.
3. **A card's `requestId` names what it is about** (`agenda:<id>:<event time>`, `followup:<id>:<ask time>`,
   `birthday:remind|check:<person>:<year>`), not the timer's generation, so a repaired timer cannot post a second one.
4. **Late agenda is skipped** (more than 5 minutes after the meeting began); a late question is always asked. A point added after the
   ping time is saved, not posted.
5. **No re-ask.** The timer ends at the question (`asked`); the open question stays in the `followups` prompt section and in
   `list_followups`. A follow-up open for days is a briefing item (M4), not a nagging timer. The handoff's phases end at `ask`.
6. **`record_outcome` with `needs_followup` and no time is an error that tells the model to ask the owner when**; the contradiction
   (`needs_followup: false` with a time) is an error too. The parent resolves and the child is created in one transaction with the
   ledger entry.
7. **Birthday cycle kept in the row** (`cycle_year`, `remind_at`, `check_at`). A person added after the morning moment gets no
   reminder (only the evening question); a reminder that wakes late is posted only within the day; after a long stop the next cycle is
   the first whose evening is still to come (missed years are skipped, one late question is posted for the one that was waited for).
   The successor timer is created by the finishing task after the row has moved on, and by the periodic repair if that fails.
8. **The `people` prompt section reads the local date** (absolute dates only, so it renders the same bytes all day and changes when a
   birthday enters or leaves the week, or an evening question is asked or answered). "Birthdays in the next 7 days" cannot be written
   without it; the `followups` section needs no clock at all. Both are pinned by tests.
9. **People are shared data, the cards are not:** a birthday card is posted into the conversation that created the person. Only the PA
   has the tools.
10. **Deleting an earlier link of a chain** leaves the later one with no parent (`ON DELETE SET NULL`), so its question is not marked
    as a follow-up of a follow-up. Seen in the browser check.
11. **PA tools are all visible** (21 now; none deferred, there is no `tool_search`: *wrong, Durable 1.4.0 ships it; see "M3 review fixes" below*). The instructions gained two short rule blocks.

### 2.3 Durable 1.4.0 facts learned in M3 (for M4 and later)
- `runtime.commit((tx, current) => …)` gives a task the transaction, and `tx.createTask()` defaults to the task's conversation, so a
  terminal commit can create a successor. I did not use it: the row-first scheme (new generation in `app.sqlite`, then create the
  timer) is self-healing, whereas a successor created inside Durable's commit is not known to the row.
- Long sleeps are fine: the default timer waits out delays beyond `setTimeout`'s limit in steps (`dist/timers.js`), so a year-long
  `sleepUntil` needs nothing special; the 30-second `resume()` tick still wakes it after a suspend.
- A timer that is rewound comes back at an **earlier phase** than the one that last ran. Every phase must therefore accept the states
  the later phases leave in the row, or a multi-phase task will lose its effect after a power cut (decision 2).
- `ToolExecutionResult.output` is optional in the types (use a `textOf` helper in tests); `structuredOutput` is rejected unless the
  tool declares a `structuredOutputSchema`, so disambiguation results travel as text plus a card.
- assistant-ui 0.15: inside a message, `aui.composer()` is the message's own (edit) composer and throws "Composer is not available" for
  a message that is not being edited; the thread's composer is `aui.thread().composer()` (found in the browser check, fixed).

## 3. Commands run and results

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm lint` | `Checked 155 files … No fixes applied` |
| `pnpm test` | **32 files, 553 tests passed** (M2 after fixes: 29 / 472), 12 s; serial runs and two runs at the same time: stable. With four runs at once one run failed `file-lock.test.ts › serializes critical sections of many contenders`, the pre-existing CPU-starvation flake described in `progress-m2.md` (not touched here; the other three were green) |
| `pnpm build` | `next build` ok (same routes), server bundle `dist/main.js` 240.8 kB (was 156.3) |
| M2 → M3 upgrade, by script (`migrate` with the M2 module list, a task row, then the M3 list) | exactly `followups/001`, `followups/002`, `people/001`, `people/002` applied, the row kept, a second run applies none |
| Guard checks (scratch edits, reverted): the agenda without points, an agenda after the meeting began, `isCurrent` refusing an `asked` row, 29 February as the 29th, the evening question despite "wished", a morning reminder the next day | each made at least one test fail (killed); the seventh (starting the year loop earlier) is an equivalent mutant: the loop skips the same years |
| Browser check (agent-browser, `pnpm dev`, faux model, fake push; **9 screenshots in `/tmp/assistant-shots/m3/`**, below) | see below |
| Cleanup | dev servers stopped (SIGTERM, clean), nothing on 3000–3009, browser session closed, scratch data directories and logs removed |

### Browser check
Server started with `ASSISTANT_AGENDA_LEAD_MINUTES=1`, `ASSISTANT_FOLLOWUP_ASK_DELAY_MINUTES=1` and birthday times three and six minutes
ahead, through `/tool` commands in the chat of the PA. Seen:
- `01` task-style cards from tools: birthday saved, follow-up saved, "Added to the agenda" twice (the second point matched the meeting by
  "the house meeting"). `02` the birthday reminder card and **"Today's agenda"** appeared by themselves at their moments (05:53:00 and
  05:53:52 local). `03` the follow-up question (05:55:52) and the evening birthday question (05:56:00.010) with their buttons; the fake
  outbox holds `{"title":"Follow-up","body":"1 question: how did it go?","url":"/chat/pa","tag":"followup"}` and the birthday one.
- `04` *Record outcome* puts `Outcome of “Meeting about the Dabtonog house”: ` in the composer (it did not before the fix of §2.3).
  `05` `record_wish` card and the outcome card with the next follow-up; the chained question arrived one minute later (`09`, at 390 px).
  `06` list cards (people: birthdays in the next 30 days). `07`/`08` follow-up list and the delete approval card; Approve deleted the
  row and its agenda (database check), and left the chained follow-up waiting.
- One console error in the dev log, from the first click before the fix ("Composer is not available"); none after.

## 4. Could not verify
- **A real model using these tools.** Every test and the browser check drive the tools with scripted calls. No GPT model has chosen
  `add_followup` / `add_agenda_point` / `record_outcome`, matched a name to a meeting, asked "when?" for a follow-up with no time or
  turned "my sister's birthday is 5 March" into a call, so the tool descriptions, the PA's rules and the two prompt sections are
  untested against real model behaviour. This is the largest open risk of M3.
- **Real Web Push delivery** (as in M2) and a birthday in a zone with daylight saving time end to end (the arithmetic is tested
  with New York; the server was only run in Asia/Thimphu).
- **A real year**: a yearly timer was exercised by jumping the fake clock a year (and several), not by waiting.

## 5. Known risks
- A question nobody answers is never asked again (decision 5); it stays listed in the prompt section and `list_followups`.
- A follow-up that changes (meeting moved) needs delete + add until an `update_followup` exists.
- The agenda is posted once, at the lead time: a meeting added with less notice than the lead gets no agenda ping, and points added
  later are only visible through `list_followups`.
- The `people` section changes at day boundaries (decision 8): *not a cache miss: Durable appends a system entry with the section's new text and the prefix stays cacheable (see "M3 review fixes")*.
- 21 tools in every PA request: more tokens per turn than in M2 (*fixed by deferring the rarely used ones, see "M3 review fixes"*).
- A push the push service refuses (not 404/410) is logged and not retried, as in M2.
- Unchanged from M2: the `file-lock` test flake under CPU starvation (fix suggested there: keep polling in `acquireFileLock` while
  the deadline has not passed), two processes taking one stale lock at the same instant, `node --watch` restarts interrupting answers in dev.

## 6. For the coordinator
- **Veto points:** decisions 2.2/5 (no re-ask), 2.1 "recorded not-yet does not silence the evening question", 2.2/4 (5 minutes of grace
  for a late agenda), 2.2/8 (a section that reads the date).
- **Cheap follow-ups, not done (outside the scope):** `update_followup` (reschedule, rename; one more ledger tool and a generation
  bump); a re-ask timer; deferring rarely used tools; an `ASSISTANT_*` default for a per-meeting end time.
- **Commit grouping** (shared types change together with server and web, so the middle commits will not typecheck alone; use one commit if
  every commit must be green):
  `extensions: share the timer scheduling code, add followups and people modules` ·
  `shared, server: add follow-up and birthday cards, settings, repair and PA instructions` ·
  `web: render agenda, follow-up question and birthday cards` ·
  `docs: describe M3 in plan, readme, design notes and ops, add M3 report`.
- **Leftovers:** `/tmp/assistant-shots/m3/` (kept on purpose, like M1 and M2). `docs/handoff-m3.md` is untracked, as handed over.


---

# M3 review fixes (worker → coordinator)

Handoff: `docs/handoff-m3-fixes.md` (adjudication of `docs/review-m3.md`). Branch `main`, nothing committed. No network, no login,
no `railway`; no server of mine is running (the tests start in-process servers on port 0 and close them). Everything the review
reproduced (`/tmp/m3-review-scratch/e1…e12`) is now a test in the repository.

**Gates:** `pnpm typecheck` 5 packages ok · `pnpm lint` 158 files ok · `pnpm test` **33 files, 591 tests** (was 32 / 553; two runs, stable)
· `pnpm build` ok (server bundle 257.4 kB, was 240.8). Tests marked *mutant* were checked by breaking the code they guard and
seeing them fail (then restored).

## 1. Item → status → test

| Item | Status | Test (file › name) |
|---|---|---|
| **B1** birthday cards lost after a finished cycle | **fixed**: `people/recovery.ts` `recoverCards`, run by `domain.repair()` before any timer; `reminded_year` (migration `people/003`); card built from `asked_year`/`reminded_year` by `people/cards.ts` (shared with the timer) | `people.test.ts › cards a power cut took from Durable's database` (5: both cards again as they were, no push; harmless on a healthy thread; morning card of a day that is over is left out; nothing after "wished" or after 24 h; a person whose conversation is gone is reported, the others done) · `m3.test.ts › birthday cards after a power cut` (whole server, real snapshot/restore of `durable.sqlite`; *mutant*: no recovery call → fails) |
| **B2** same-year date correction | **fixed**: `requestId = birthday:remind\|check:<person>:<day>`; a corrected birthday forgets the old day's cards (`reminded_*`, `asked_*`) | `people.test.ts › a birthday corrected after its card was posted (same year) › gets the cards of the new day` (*mutant*: year-only id → fails) |
| **B3** YES vs a timer's question | **fixed**: `ApprovalService.closeYesWindow` + `closingYesWindow(post, approvals)`; `createDomain` and the test fixture give modules the closing poster, the approval service keeps the plain one; closes *before* the write | `approvals.test.ts › a reply of "YES" › does not approve a deletion with a yes typed to a question the assistant asked by itself` · `m3.test.ts › a yes typed to a question the assistant asked by itself` (whole server; both *mutants* fail) |
| **D1a** re-ask once, next morning | **fixed**: phases `reask_wait → reask` after `ask`; 09:00 local of the next calendar day after it was asked (`ASSISTANT_FOLLOWUP_REASK_TIME`); `reasked_at`; a row that is `asked` and not re-asked still wants a timer (repair), and a repaired timer for it starts at `reask_wait` (`input.asked`), so no first question twice | `followups.test.ts › the question the morning after` (6: once more then never; not when answered in between; next morning not same morning; configured time; repair, no duplicate push; power-cut rewind) (*mutants*: same-day, repair without asked rows, start phase → fail) |
| **D1b** commitments nudge at `eventAt` | **fixed**: phases `nudge_wait → nudge` for `kind = commitment` (card stage `nudge`, push tag `followup-due`); skipped when it would come after the question's time | `followups.test.ts › a commitment` (3) (*mutant*: no late guard → fails) |
| **D1c** date-only → 10:00 | **fixed**: `resolveInstant` takes a default time (`ASSISTANT_FOLLOWUP_DEFAULT_TIME`); the result says "Note: no time of day was given, so it is set for 10:00 … use update_followup"; saved as `time_assumed` so a replay says the same and `list_followups` shows "time assumed" | `followups.test.ts › a date without a time of day` (3) + the changed "refuses what it cannot schedule" · `config.test.ts` (both settings) |
| D1 PLAN note | **done**: M4 `MorningBriefing` gathers "open asked follow-ups"; FollowUp phases, tables and the birthday recovery rewritten in §5.4/§7 | – |
| **D2** `update_followup` | **fixed**: title / counterpart / `event_at`·`event_in_minutes` / `ends_at`; a change of time bumps `gen` in the ledger transaction, puts an `asked` row back to waiting, keeps agenda points and (when it has an end) its length; produces the card event `updated` | `followups.test.ts › update_followup` (7: moves a waiting meeting; moves an asked one; rename only leaves the timer; end shifts; date-only note; errors say what to fix; replay) · `m3.test.ts › the PA's tools` (loaded through `tool_search`) |
| "not yet" does not suppress the evening check | **already so, now also consistent**: only `wished=true` suppresses (checked in `remind` and `check`); additionally `unansweredQuestions` no longer counts a "not yet" recorded *before* the question as its answer (prompt section and B1 recovery would otherwise have missed the open question) | `people.test.ts › is asked about in the evening even if the owner recorded 'not yet' earlier in the day` (extended) |
| **PA tool load** | **fixed**: 12 tools `deferred: true` (`update_task`, `list_followups`, `update_followup`, `resolve_followup`, `list_people`, `update_person`, the three `propose_delete_*`, the three `delete_*`); `createToolSearchExtension()` installed in the registry and selected by the PA (`domain.paExtensions`); the PA's instructions name the deferred tools. **Offered: 11 tools ≈ 10.3 kB (≈2.6k tokens by chars/4) instead of 21 ≈ 15.8 kB**; all 23 = 18.5 kB; instructions 4.3 kB (≈1.1k tokens) | `m3.test.ts › the PA's tools` (2: the exact offered set; `/tool update_followup` before loading → "Tool update_followup is not available", after `/tool tool_search {"query":…}` it works; a loaded `delete_followup` is still blocked by the hook) · `m2.test.ts` approvals now load `propose_delete_task` first · fixture loads deferred tools up front |
| **N1** | fixed (`listFollowups` parameterised) | `followups.test.ts › list_followups` |
| **N2** | fixed: the section is 7 days, today included, like `list_people upcoming_days: 7` | `people.test.ts › lists the birthdays of the next week…` (edge is 31 Oct, 1 Nov is out) |
| **N3** | fixed: deleting a link clears `next_followup_id` of the one before it | `followups.test.ts › a chain of follow-ups` |
| **N4** | fixed: no evening question for a birthday more than 2 days ago (`LATE_QUESTION_DAYS`) | `people.test.ts › asks late about a birthday two days after, or not at all once it is older than that` (it.each) · `› skips the years missed during a long stop` (now: no card) |
| **N5** | fixed in the docs: `tool_search` exists and is used; a changed section costs one system entry, not a cache miss; PLAN §5.4 recurrence sentence rewritten; the three stale lines of this file's M3 report are annotated | – |
| **N6** | fixed by the deferral (numbers above) | – |
| **N7** | fixed: `add_followup` with the same title (any case) at the same time as an open one answers "Already saved, nothing added." and re-tries its timer | `followups.test.ts › saving the same meeting twice` |
| **N8** | fixed (log text) | – |
| **N9** | fixed: `reconcile()` returns before reading the Harness when no row wants a timer | the existing reconcile tests (M2 and M3) |
| **N10** | fixed in the web: a question card is `answered` when a later card records the outcome / closes the follow-up (`followup` card, event `outcome`·`resolved`) or records the wish (`person` card, event `wish`, same year, "not yet" included); buttons give way to "Answered." | `apps/web/test/cards.test.ts › marks a question as answered…` |
| **N11** | fixed: titles, counterparts, names and relations are one line without `<` `>` (`oneLine`) | `followups.test.ts › what the follow-ups keep of the owner's words` · `people.test.ts › what the address book keeps of the owner's words` |
| **N12** | fixed: "Follow up: " is not stacked; `updated` is now produced | `followups.test.ts › a chain of follow-ups` |
| **N13** | fixed: `@assistant/extensions/schedule` subpath export; `config.ts` no longer pulls the whole package | typecheck + build |
| **U1** | **partly**: the tool descriptions and the PA's rules now separate a commitment (nudged, asked after) from a plain to-do or reminder (`add_task`) and say which tools load on demand. Still impossible to verify without a real model | – |
| **U2** | **fixed**: design-notes "Changing a task that may be sleeping" (never rename a phase; add phases, or bump `version` + `migrate`); the server logs blocked tasks that are not parked (`[durable] N task(s) cannot run`, `listUnrunnableTasks`); OPS.md | `apps/server/test/unrunnable.test.ts` |
| **U3** | **deferred**: the size of Durable's unsynced tail needs a real power cut on this laptop to measure; B1's recovery makes the cards independent of it | – |
| **U4**, **U5** | **deferred**: only matter when another agent gets these tools (M5/M6); written down in design-notes ("People are shared data…") with what to do first | – |
| **U6** | **deferred**: a per-item tag changes the exported push constants and the tray behaviour for a case (two birthdays or agendas at the same minute) that cannot be tried without a real device | – |
| **U7** | **deferred**: the web has no DOM test setup (tests are pure functions over thread state); adding jsdom and an assistant-ui runtime mock is more than the nit is worth. The derived "answered" state of N10 is tested as a pure function; the composer call of the buttons is still only checked in a browser | – |

## 2. Decisions inside the adjudication (each cheap to reverse; veto points marked ★)

1. ★ **`current_time` stays offered** next to the nine tools the handoff lists: the PA's rules send the model to it for every relative date, so deferring it would put a `tool_search` in front of nearly every reminder.
2. ★ **Two new settings**, `ASSISTANT_FOLLOWUP_REASK_TIME` (09:00) and `ASSISTANT_FOLLOWUP_DEFAULT_TIME` (10:00), documented in the README table. The handoff made only the second configurable.
3. ★ **Every module post closes the YES window**, including the M2 reminder cards and a card that start-up recovery posts again: a restart can cost one "YES" (the button and the next request are unaffected). The alternative (telling a new card from a deduplicated one) needs a look into Durable's submissions for a case this rare.
4. **New migrations, not edits**: `followups/003_reask_and_assumed_time`, `people/003_reminded_year` (the shipped-migration rule), although M3 is not committed.
5. **Phases were added to the follow-up task without a `version` bump.** Adding phases keeps every stored phase valid, and `input.asked` is optional, so a timer made by the M3 code as submitted would still run (by reading; not tested).
6. A birthday **correction forgets** `reminded_*` and `asked_*` (they were about a day that is not the birthday), and the evening question has a **2-day cut-off**, skipped silently.
7. `FollowupEntryData.askedAt` is now `firedAt` (like the other three cards) and has a required `stage` (`nudge` | `ask` | `reask`); `FollowupResult` says `reasked`, and a superseded timer says whether the question had been asked.
8. `update_followup` on an **asked** row with a new time puts it back to waiting (the question was about a time that is no longer the time); title or counterpart alone never touch the timer.
9. The dev model does **not** load deferred tools by itself: `/tool tool_search {"query":"…"}` first (README, design-notes). Making `/tool` do it would be a second state machine in `dev-model.ts`.

## 3. Remaining risks

- **A real model and `tool_search`**: nothing here shows that gpt-6.1 calls `tool_search` when it should, or reads the instructions that name the deferred tools. If it does not, `update_followup`, `list_followups` and friends are unreachable for it (the always-on tools still work).
- A `tool_search` for an innocent query can load `delete_*` (BM25 over descriptions; "move a meeting" matched `delete_followup` in the test). The approval hook still blocks them; they cost tool tokens once loaded.
- The default time is an assumption the model is *told* to pass on to the owner; nothing forces it to.
- A date-only "today" whose default time has passed is refused as "in the past" with the time it assumed; the model has to ask for a time.
- Two things still assume the PA is the only user of the people and follow-up tools (push URL, `notes` scope): U4/U5.
- Unchanged: the `file-lock` flake under CPU starvation (`progress-m2.md` §5), not touched; it did not appear in these runs.

## 4. Files

`packages/extensions`: new `people/{cards,recovery}.ts`; edited `followups/{task,store,tools,scheduler,index,migrations}.ts`, `people/{task,store,tools,index,birthdays,migrations}.ts`, `tasks/tools.ts` (`deferred`), `approvals/service.ts`, `post.ts`, `tool-support.ts`, `timers.ts`, `schedule.ts`, `index.ts`, `package.json` (subpath). `packages/shared`: `cards.ts`. `apps/server`: `domain.ts`, `agents.ts`, `server.ts`, `config.ts`. `apps/web`: `cards.tsx`, `card-text.ts`, `ui-messages.ts`. Tests: `followups` (+22), `people` (+9), `approvals` (+1), `m3` (+4), new `unrunnable.test.ts` (+1), `cards.test.ts` (+1); `support.ts` (fixture), `domain-support.ts` (snapshot/restore), `m2.test.ts`, `config.test.ts` adjusted. Docs: README, PLAN (§5.4, §7), design-notes (new sections "Which tools the PA is offered", "Changing a task that may be sleeping"), OPS.

Commit grouping: unchanged from §6 above, plus `apps/server/test/unrunnable.test.ts` with the server commit.
