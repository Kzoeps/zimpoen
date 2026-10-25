import type { Migration } from "@assistant/db";

/** Tables of the followups module (PLAN §7). Never edit one that has shipped: add `followups/00N_...` after it. */
export const followupsMigrations: readonly Migration[] = [
	{
		id: "followups/001_items",
		up: (db) => {
			db.exec(`
				CREATE TABLE followups_item (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					-- Who or what the meeting is with: a person, a firm.
					counterpart TEXT NOT NULL DEFAULT '',
					-- Why it matters: what was emailed, what is at stake. Shown to the model, never invented by it.
					context TEXT NOT NULL DEFAULT '',
					kind TEXT NOT NULL CHECK (kind IN ('meeting', 'commitment')),
					-- Epoch milliseconds, UTC. When the meeting starts or the commitment is due.
					event_at INTEGER NOT NULL,
					ends_at INTEGER,
					-- When to ask how it went: the end time when there is one, else event_at plus the configured delay.
					ask_at INTEGER NOT NULL,
					-- The agenda is sent this long before event_at, when it has points.
					agenda_lead_minutes INTEGER NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('waiting', 'asked', 'resolved')),
					outcome TEXT,
					-- The follow-up this one came out of, and the one the outcome created: a chain that ends when someone resolves it.
					parent_id TEXT REFERENCES followups_item (id) ON DELETE SET NULL,
					next_followup_id TEXT,
					-- Bumped whenever the timer has to be replaced. The Durable task carries the number it was created with
					-- and only acts while it is still the row's current one (PLAN §5.4).
					gen INTEGER NOT NULL DEFAULT 0,
					durable_task_id INTEGER,
					agenda_pinged_at INTEGER,
					asked_at INTEGER,
					resolved_at INTEGER,
					-- The conversation that created it: the agenda and the question are posted there.
					conversation_id INTEGER NOT NULL,
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				) STRICT;
				CREATE INDEX followups_item_status_event ON followups_item (status, event_at);

				CREATE TABLE followups_agenda (
					id INTEGER PRIMARY KEY,
					followup_id TEXT NOT NULL REFERENCES followups_item (id) ON DELETE CASCADE,
					text TEXT NOT NULL,
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL
				) STRICT;
				CREATE INDEX followups_agenda_followup ON followups_agenda (followup_id, id);
			`);
		},
	},
	{
		// Rule 8 for tools that change an existing row: the call id is recorded in the same transaction as the change,
		// so a call Durable replays after a crash is recognised and not applied twice.
		id: "followups/002_call_ledger",
		up: (db) => {
			db.exec(`
				CREATE TABLE followups_call (
					source_call_id TEXT PRIMARY KEY,
					tool TEXT NOT NULL,
					followup_id TEXT,
					applied_at INTEGER NOT NULL
				) STRICT
			`);
		},
	},
	{
		// A question nobody answers is asked once more, the next morning (`reasked_at`: when that was posted; NULL while it
		// is still to come, which is what keeps a row that wants this timer in the repair). `time_assumed` marks a time the
		// owner never gave (only a date): the tools say so, until it is confirmed or changed.
		id: "followups/003_reask_and_assumed_time",
		up: (db) => {
			db.exec(`
				ALTER TABLE followups_item ADD COLUMN reasked_at INTEGER;
				ALTER TABLE followups_item ADD COLUMN time_assumed INTEGER NOT NULL DEFAULT 0 CHECK (time_assumed IN (0, 1));
			`);
		},
	},
];
