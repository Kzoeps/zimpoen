import type { Migration } from "@assistant/db";

/**
 * Tables of the daily module (PLAN §7). Never edit one that has shipped: add `daily/00N_...` after it. The two tables
 * keep the names the plan and the M4 handoff gave them (`schedule_daily`, `pa_journal`), which is why they do not start
 * with the module's name.
 */
export const dailyMigrations: readonly Migration[] = [
	{
		id: "daily/001_schedule",
		up: (db) => {
			db.exec(`
				CREATE TABLE schedule_daily (
					job TEXT PRIMARY KEY,
					-- What the owner sets: when the job runs, in the configured time zone, and whether it runs at all.
					local_time TEXT NOT NULL CHECK (local_time GLOB '[0-2][0-9]:[0-5][0-9]'),
					enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
					-- The run that is waiting: its local day and instant (epoch ms, UTC). The row is the truth and the Durable
					-- task only a timer (PLAN §5.4): a timer acts only while it carries the row's generation.
					due_date TEXT NOT NULL,
					due_at INTEGER NOT NULL,
					-- The latest day whose run was completed. A day runs at most once.
					last_run_date TEXT,
					last_run_at INTEGER,
					gen INTEGER NOT NULL DEFAULT 0,
					durable_task_id INTEGER,
					updated_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
	{
		id: "daily/002_journal",
		up: (db) => {
			db.exec(`
				CREATE TABLE pa_journal (
					-- The local day the wrap-up is about: YYYY-MM-DD.
					date TEXT PRIMARY KEY,
					-- What the owner said they got done; NULL while the wrap-up of that day waits for their answer.
					user_log TEXT,
					-- What the system recorded that day: the facts the wrap-up was asked with.
					auto_summary TEXT NOT NULL DEFAULT '',
					carried_over_json TEXT NOT NULL DEFAULT '[]',
					asked_at INTEGER,
					saved_at INTEGER,
					updated_at INTEGER NOT NULL
				) STRICT;

				-- Rule 8 for save_journal: its call id is recorded in the same transaction as the change.
				CREATE TABLE daily_call (
					source_call_id TEXT PRIMARY KEY,
					tool TEXT NOT NULL,
					subject TEXT,
					applied_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
];
