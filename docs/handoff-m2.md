# Handoff: M2 — Tasks, reminders, Web Push, approvals

Fresh implementation worker. Coordinator is tech lead; user asleep. Repo `/home/kzoeps/Projects/personal/assistant`,
branch **`main`** (personal project: work on main). M1 is committed (`git log`). Do NOT commit; coordinator commits.

Read first: `docs/PLAN.md` (§2 rules, §5.2–5.4, §5.6, §7 tasks/approvals), `README.md`, `docs/design-notes.md`,
the final sections of `docs/progress-m1.md` (deviations + remaining risks). Durable source for APIs:
`/home/kzoeps/Projects/personal/pi/packages/durable` (README "Sleeping and Waking Up", "Tools", "Hooks", "Busy
Conversations"; examples 11, 12, 16, 19, 22, 23). Verify every API against source.

## Objective
PA can capture tasks and reminders from chat, remind the user at the right time even across restarts, with zero model
tokens per reminder, and notify the phone via Web Push. Deletes require explicit approval.

## Scope
1. **Domain module pattern** (PLAN §5.2) made real in `packages/extensions`: `DomainModule { name, migrations, extension(deps) }`,
   server collects migrations from all modules. Resolve M1's deferred C12 policy: migration ids are namespaced per module
   (`tasks/001`), ordering enforced within a module only.
2. **tasks module**: `tasks_item` table (PLAN §7) with `source_call_id UNIQUE` idempotency (rule 8). Tools for PA:
   `add_task` (title, notes?, due?, remind_at? — natural-language times are resolved by the model into ISO with the
   configured timezone; tool validates and stores UTC ms), `list_tasks` (filters: open/done/due window), `update_task`,
   `complete_task`, `snooze_reminder`, `propose_delete_task`. Tool `details` carry typed cards (packages/shared) for a task
   list card and a single-task card. Prompt section: count of open tasks + next 3 due (keep cache-friendly: no clock in it;
   put "current local time" only in the user message timestamp if needed — decide and document).
3. **Reminder durable task** (PLAN §5.4): `wait --sleepUntil--> fire`. Fire = memo-guarded zero-token write
   `submit({type:"write", entry:{kind:"app.reminder", data}})` to PA conversation + push notification. Rescheduling/snooze/
   completion abort or replace the task correctly; task id stored on the row. Must survive restart (test with fake clock
   and with close/reopen; Durable supports `now`/`setTimer` injection).
4. **Web Push**: VAPID keypair generated on first start into `<data>/secrets/vapid.json` (0600). `POST /api/push/subscribe`,
   `DELETE` unsubscribe, `push_subscriptions` table. Sender behind an interface (`PushSender`); real impl with `web-push`
   npm package; tests use a fake. Payload minimal (rule: no sensitive text): e.g. `{title:"Reminder", body:"1 reminder", url:"/chat/pa"}`.
   Remove subscriptions on 404/410.
5. **PWA basics** needed for push: manifest, icons (simple generated SVG/PNG), service worker (push + notificationclick →
   focus/open URL), "Enable notifications" control in web settings. Share target is M4, not now.
6. **Approvals** (PLAN §5.6): `pending_actions` table; `beforeTool` hook blocks tools tagged destructive without an approved
   row; approval card in chat (Approve/Deny buttons → `POST /api/approvals/:id`); a literal "YES" user reply approves the latest
   pending action for that conversation (implement deterministically in server, not by model). After approval the action
   executes and posts the result. Expire pending actions after 24h.
7. **Web rendering**: `app.reminder` and `app.notice` entries render as system cards; task cards; approval card with state.
8. **Parked tasks retry** (M1 risk): `POST /api/admin/tasks/:id/retry` + button on the existing banner.
9. **Settings model list**: default to a curated list (models whose id starts with `gpt-6`), with a "show all" toggle.
10. Fold M1's listed deviations into `docs/PLAN.md` (§5.5 routes/ping/auth, §2 deny list, data dirs) and add M2 changes.
11. Tests: tools idempotency (same call id twice → one row), reminder fires once across crash between write and checkpoint
    (memo), snooze/complete cancels, approval hook blocks/permits, YES handling, push sender called with minimal payload and
    410 cleanup, web reducer renders reminder cards. Use faux provider scripted tool calls (see example 16).

## Out of scope
Follow-ups, agendas, birthdays (M3); briefing/wrap-up/share target (M4); any real network sends in tests.

## Constraints
Treat the coordinator's explicit handoff as the approved scope. Make routine implementation decisions within that scope
without pausing to reconfirm. If information is missing or a decision exceeds scope, ask the coordinator. No git commit/push.
No calls to OpenAI/Google/TypeSafe/real push services; no logins. npm installs allowed. Stop every server you start.
Context hygiene: at ~55% context finish the current item, write `docs/handoff-m2-2.md` (state, remaining items, verified API
facts), reply DONE-HANDOFF and stop.

## Done when
`pnpm typecheck && pnpm lint && pnpm test && pnpm build` green; a browser check (agent-browser, dev servers, faux model scripted
to call add_task with remind_at = now+1min, observe reminder card appear and push sender invoked via a dev fake) with screenshots in
`/tmp/assistant-shots/m2/`; report appended to `docs/progress-m2.md`; reply DONE-M2.
