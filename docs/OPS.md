# Operations

Running Zimpoen after [SETUP.md](SETUP.md). The reasoning behind the design is in [design-notes.md](design-notes.md).

## Keep the machine awake

Nothing wakes a suspended machine for a reminder. After a wake, overdue reminders fire within about 30 s and show when
they were due. To stop the machine suspending:

- **GNOME:** Settings → Power → Automatic Suspend off.
- **Lid:** set `HandleLidSwitch=ignore`, `HandleLidSwitchExternalPower=ignore` and `HandleLidSwitchDocked=ignore` in
  `/etc/systemd/logind.conf.d/`.
- **Everything else:** `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` (undo with
  `unmask`).

Keep it on mains power. A power cut can lose Durable's last writes; the server repairs what it can on the next start
and logs it.

## Services

`assistant-server` runs `apps/server/dist/main.js` and `assistant-web` runs `next start`. Both run as your user with
`Restart=on-failure` and read `/etc/assistant/assistant.env`.

```sh
systemctl status assistant-server assistant-web
journalctl -u assistant-server -f
sudo systemctl restart assistant-server        # after changing settings or jev.json
sudo systemctl reset-failed assistant-server && sudo systemctl start assistant-server   # after start-limit-hit
```

A unit that fails 10 times in 5 minutes stops for good (`start-limit-hit`). Read the journal, fix the cause, then run the
`reset-failed` line.

A permission error at start almost always means one of two things:

- `ReadWritePaths=` doesn't match `ASSISTANT_DATA_DIR`. Rerun `ops/install-units.sh`.
- A read path is somewhere the unit can't see.

To edit an installed unit, run `sudo systemctl edit --full assistant-server`.

## Health check

```sh
ops/check.sh --env-file /etc/assistant/assistant.env
ops/check.sh --dry-run                     # list checks
ops/check.sh --only files,api              # groups: files lock host ports api web tailscale systemd power
```

| Check | A `FAIL` means |
|---|---|
| Data and secrets permissions | Something is readable by other users. `chmod` it as the line says |
| OpenAI sign-in, push keys | Run `pnpm login:openai`. `vapid.json` is created on the server's first start |
| `ASSISTANT_OWNER_LOGIN`, `ASSISTANT_PUBLIC_HOST` | Unset, or still the example values |
| Google accounts, Jev | An account needs reconnecting. No Jev key is only a `WARN` |
| Server, lock | Not running. Check `journalctl -u assistant-server` |
| Ports | 3000/3001 are listening on something other than `127.0.0.1` |
| API | A parked task (see below). An agent over its weekly limit is a `WARN` |
| Tailscale | Mappings are wrong or Funnel is on. Rerun `ops/tailscale-serve.sh` |
| Services, power | Only `WARN`s |

## Tailscale Serve

`ops/tailscale-serve.sh` maps `/` to the web app and `/api` to the server. Running it again changes nothing. The `/api`
target deliberately ends in `/api`, because Serve strips the mount path before forwarding. If the target is missing that
suffix, the page loads but every request returns 404. If you rename the machine, rerun the script and update
`ASSISTANT_PUBLIC_HOST`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Banner: agent used its weekly limit | Nothing is broken: daily jobs post plain cards until Monday and chat still works. Raise or clear the limit under **Usage**. If Usage shows only zeros, the provider isn't reporting usage |
| A task is parked | Read the journal for the crash cause, fix it, then press **Retry** |
| Account says "Needs to be connected again" | `pnpm connect:google --login-hint <address>`. Mail is kept |
| Agents answer with a model error | `pnpm login:openai` (no restart needed) |
| An agent remembered something wrong | Edit or delete it under **Profile** |
| An agent asks you to approve a preference | Deny it unless you asked for it: preferences go into prompts as your instructions |
| Page loads but nothing works | The `/api` mapping is wrong. Run `ops/check.sh --only tailscale`, then `ops/tailscale-serve.sh` |
| Notifications stopped on one phone | Settings → Enable notifications. If every phone stopped after a restore, `vapid.json` changed |
| Large uploads hang (dev or `next start` without Serve) | Next may have renamed `experimental.proxyClientMaxBodySize`. Look for `Failed to proxy` in the Next log |
| Share to app answers 403 | The browser didn't send `Sec-Fetch-Site: none`. See [design-notes](design-notes.md#the-android-share-target) |

## Repairs the server can't make

At start and every 10 minutes, the server repairs reminders, meetings, birthdays, daily jobs and approval notices. If it
can't repair one, it logs the SQL that clears it and keeps running. For example, after `DELETE FROM agents`:

```sh
# drop a task's reminder
sqlite3 <data>/app.sqlite "UPDATE tasks_item SET remind_at = NULL WHERE id = 't_ab12cd34'"
# re-home a meeting or person onto the PA's current conversation
sqlite3 <data>/app.sqlite "UPDATE followups_item SET conversation_id = (SELECT conversation_id FROM agents WHERE id = 'pa') WHERE id = 'f_ab12cd34'"
sqlite3 <data>/app.sqlite "UPDATE people_person SET conversation_id = (SELECT conversation_id FROM agents WHERE id = 'pa') WHERE id = 'p_ab12cd34'"
# stop retrying an approval notice
sqlite3 <data>/app.sqlite "UPDATE pending_actions SET notified_at = 0 WHERE id = 'ap_ab12cd34'"
```

Stop the server before editing `app.sqlite` by hand.

`[durable] N task(s) cannot run` means a sleeping timer no longer matches any installed definition. Restore the code
that defined it, or add a migration. **Retry** doesn't help here. See
[design-notes](design-notes.md#changing-a-task-that-may-be-sleeping).

## Files

Uploads are in `<data>/files/<yyyy-mm>/`, mode 0600, indexed by path in `files_index`. Nothing deletes them. A file
with no matching row (left by a crash during upload) is harmless and can be removed.

To upload from a shell:

```sh
curl -F file=@x.png -H 'Sec-Fetch-Site: none' http://127.0.0.1:3001/api/uploads
```

## Backups

Not automated. With the server stopped, back these up together:

- `app.sqlite` and `durable.sqlite` (with `-wal`). They reference each other.
- `files/`
- `secrets/`. Losing `vapid.json` means every device has to re-enable notifications.
- `templates/`: your invoice template. The server never overwrites it.
- `workspace/invoices/`. An invoice can't be regenerated under the same number. `previews/` can be deleted.

## Admin API from a shell

Every write must be JSON, even with no body. With auth on, also send the header Serve would add:

```sh
curl -X POST http://127.0.0.1:3001/api/admin/tasks/17/retry \
  -H 'Content-Type: application/json' -H 'Tailscale-User-Login: you@example.com'
```

Leaving out the content type gives `415`; leaving out the header gives `401`.
