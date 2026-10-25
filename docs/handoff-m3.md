# Handoff: M3 — Follow-ups, meeting agendas, people & birthdays

Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, branch `main` (M1+M2 committed). Coordinator commits; you don't.
Read: `docs/PLAN.md` (§2, §5.4, §7), `docs/design-notes.md` (reminders: row is truth, gen counter, display-only cards, reconcile/sweep),
`docs/handoff-m2-2.md` §3 (verified Durable API facts), `README.md`. Reuse M2's patterns (domain module, reminder scheduler,
idempotency by call id with lookup-before-validate, display-only posts + DB-derived prompt section, push, approvals for deletes).

## User intent (verbatim essence)
- "I emailed a firm about the Dabtonog house; I meet them at X time on Y date" → after the meeting the PA asks what the outcome was,
  whether it needs a follow-up, and when; then schedules that follow-up. Loops until resolved.
- Throughout the day the user adds agenda points for an upcoming meeting; at meeting time (configurable lead, default 15 min before)
  the PA pings with "today's agenda for <meeting>".
- Store friends' and family's birthdays; on the day, remind to wish them; later that day (default 18:00 local) ask whether they did.

## Scope
1. **followups module**: `followups_item` (+ `agenda_item`) per PLAN §7, extended as needed (meeting title, counterpart, event_at,
   ask_at default event_at + 30 min or end time, status waiting|asked|resolved, outcome, parent id for chains, source_call_id UNIQUE).
   Tools: `add_followup` (meeting/commitment with time), `add_agenda_point` (to a named/upcoming meeting; fuzzy match by title with
   disambiguation result when ambiguous), `list_followups`, `record_outcome` (outcome text, needs_followup bool, next_at? → creates
   chained follow-up), `resolve_followup`, `propose_delete_followup` (approval). Durable task: `FollowUp` phases
   `agenda_wait → agenda_ping (if agenda points exist; display-only card listing points + push) → ask_wait → ask (display-only question
   card + push) → done`; outcome recording happens through the tool, which ends the task's job. Same row-is-truth + generation +
   reconcile/sweep design as reminders (factor shared scheduling code rather than copy it, if clean).
2. **people module**: `people_person` (name, relation, birthday MM-DD, optional year, notes), `people_wish(person_id, year, wished)`.
   Tools: `add_person`, `update_person`, `list_people` (incl. upcoming birthdays), `record_wish` (wished yes/no), `propose_delete_person`.
   Durable yearly `Birthday` task per person: day-of morning reminder (default 09:00 local, card + push: "Wish <name> a happy birthday"),
   evening check (18:00) if not recorded → ask card. Next year scheduled on completion. Feb 29 → Feb 28 in non-leap years. DST-safe local times (timezone from config).
   People are **shared** (profile-level) data per PLAN; for now only PA gets the tools.
3. Prompt sections (cache-friendly, no clock): open follow-ups awaiting outcome; upcoming meetings with agenda counts; birthdays in next 7 days.
4. Web: cards for follow-up (question with quick "record outcome" hint), agenda ping card, birthday card, people list card.
5. Dev model `/tool` commands work for the new tools (README).
6. Tests (fake clock): agenda ping only when points exist; ask fires after event; record_outcome with next_at chains; birthday fires
   on day in local tz, evening check skipped when wished; Feb 29; restart/reconcile; idempotent replays.
7. Docs: README, design-notes, PLAN deviations, `docs/progress-m3.md` report.

## Constraints
Same as `docs/handoff-m2.md` constraints section (approved scope, no commits, no external network/logins, stop your servers,
context hygiene at ~55% → `docs/handoff-m3-2.md`, reply DONE-HANDOFF). Browser check with agent-browser + screenshots in
`/tmp/assistant-shots/m3/`.

## Done when
Gates green (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`), report appended, reply DONE-M3.
