import type { Migration } from "@assistant/db";

/** Tables of the tasks module (PLAN §7). Never edit one that has shipped: add `tasks/00N_...` after it. */
export const tasksMigrations: readonly Migration[] = [
	{
		id: "tasks/001_items",
		up: (db) => {
			db.exec(`
				CREATE TABLE tasks_item (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					notes TEXT NOT NULL DEFAULT '',
					status TEXT NOT NULL CHECK (status IN ('open', 'done', 'dropped')),
					-- Epoch milliseconds, UTC. A due date without a time of day is stored as the end of that day.
					due_at INTEGER,
					due_all_day INTEGER NOT NULL DEFAULT 0 CHECK (due_all_day IN (0, 1)),
					remind_at INTEGER,
					-- Bumped whenever a reminder is scheduled or rescheduled. The Durable reminder task carries the number it
					-- was created with and only fires while it is still the row's current one.
					remind_gen INTEGER NOT NULL DEFAULT 0,
					-- The Durable task that will fire the current reminder; NULL until one is created. Used to abort it.
					durable_task_id INTEGER,
					reminded_at INTEGER,
					-- The conversation that created the task: reminders are posted there.
					conversation_id INTEGER NOT NULL,
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					done_at INTEGER
				) STRICT;
				CREATE INDEX tasks_item_status_due ON tasks_item (status, due_at);
				CREATE INDEX tasks_item_reminder ON tasks_item (status, remind_at);
			`);
		},
	},
	{
		// Rule 8 for tools that change an existing row: the tool call id is recorded in the same transaction as the
		// change, so a call Durable replays after a crash is recognised and not applied twice (a relative snooze would
		// otherwise move the reminder again).
		id: "tasks/002_call_ledger",
		up: (db) => {
			db.exec(`
				CREATE TABLE tasks_call (
					source_call_id TEXT PRIMARY KEY,
					tool TEXT NOT NULL,
					task_id TEXT,
					applied_at INTEGER NOT NULL
				) STRICT
			`);
		},
	},
];
