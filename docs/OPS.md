# Running the assistant

Notes for whoever keeps the server up. Settings are in the [README](../README.md#configuration); the reasons behind the
design are in [design-notes.md](design-notes.md). This file is a stub: it holds what has bitten or will bite, and grows with
the first real deployment (systemd unit, backups, Tailscale Serve).

## Keep the machine awake

Reminders fire from timers inside the server process, so a machine that suspends does not remind anyone. The server checks
every 30 seconds for reminders that came due and fires them, so when the machine wakes up a late reminder arrives within
about half a minute (it says when it was due). But nothing wakes a suspended machine for a reminder, and one that falls due
during the sleep is as late as the sleep. On Linux Node's timers do not count suspended time (standard behaviour; not
measured on this laptop), and most desktop distributions suspend a laptop when the lid is closed.

If reminders matter, turn suspending off on the machine that runs the server:

- GNOME: Settings → Power → Automatic Suspend off (both on battery and plugged in); and what closing the lid does is a
  systemd setting, below.
- Closing the lid, any distribution with systemd: in `/etc/systemd/logind.conf` (or a file in
  `/etc/systemd/logind.conf.d/`) set

  ```ini
  HandleLidSwitch=ignore
  HandleLidSwitchExternalPower=ignore
  HandleLidSwitchDocked=ignore
  ```

  and reboot, or restart `systemd-logind` (restarting it can end the graphical session on some systems).
- Nothing may suspend it at all (idle timers, a power button): `sudo systemctl mask sleep.target suspend.target
  hibernate.target hybrid-sleep.target`. Undo with `unmask`. Check with `systemctl status sleep.target`.

Keep it on mains power too: a power cut loses the last writes of Durable's database (see
[design-notes: two databases](design-notes.md#two-databases-two-durability-levels)). The server repairs what it can at the
next start and says so in its log (`[tasks] … had no live timer … scheduled again`).

## Clearing what the server cannot repair

At start, and every ten minutes while it runs, the server repairs reminders, meetings, birthdays and approval notices that a power cut or a crash
left inconsistent. One that cannot be repaired does not stop the server: it is logged once per run with the command that
clears it, for example after `DELETE FROM agents` (which makes new conversations and leaves the old tasks pointing at ones
Durable no longer has):

```sh
# the task keeps existing; only its reminder is dropped
sqlite3 <data>/app.sqlite "UPDATE tasks_item SET remind_at = NULL WHERE id = 't_ab12cd34'"
# a meeting or a person whose conversation is gone: point it at the assistant's current conversation, and the next repair
# gives it its timer again
sqlite3 <data>/app.sqlite "UPDATE followups_item SET conversation_id = (SELECT conversation_id FROM agents WHERE id = 'pa') WHERE id = 'f_ab12cd34'"
sqlite3 <data>/app.sqlite "UPDATE people_person SET conversation_id = (SELECT conversation_id FROM agents WHERE id = 'pa') WHERE id = 'p_ab12cd34'"
# the owner's answer is saved; stop trying to write its notice into a thread that is gone
sqlite3 <data>/app.sqlite "UPDATE pending_actions SET notified_at = 0 WHERE id = 'ap_ab12cd34'"
```

Stop the server before editing `app.sqlite` by hand, or at least expect it to be busy for a moment.

Two things the server does without being asked, and does not log unless something is wrong:

- **Birthday cards a power cut took.** A birthday's card is written to `durable.sqlite` (which can lose its last writes in a
  power cut) and the row moves on to next year in `app.sqlite` (which cannot). At every start the server posts again the
  evening question of the last 24 hours that nobody answered, and the morning card while its day is not over, with the same
  request id (a thread that has them keeps one) and no push.
- **Tasks that cannot run.** `[durable] N task(s) cannot run` at start means Durable has a sleeping timer that no installed
  definition fits (its extension is gone, or its version has no migration): the reminder, meeting or birthday it stood for is
  silent. Put back the code that defined it, or add the migration (`docs/design-notes.md`, "Changing a task that may be
  sleeping"). This is not the parked state and **Retry** does nothing for it.

## Calling the admin endpoint from a shell

Every write must be JSON, even one without a body. With authentication on, a request that does not come through Tailscale
Serve also needs the header Serve would add, naming the owner (`ASSISTANT_OWNER_LOGIN`):

```sh
curl -X POST http://127.0.0.1:3001/api/admin/tasks/17/retry \
  -H 'Content-Type: application/json' -H 'Tailscale-User-Login: you@example.com'
```

Without `Content-Type: application/json` the answer is `415`; without the header, `401`. With `ASSISTANT_AUTH=off`
(development only) no header is needed, but the content type still is.
