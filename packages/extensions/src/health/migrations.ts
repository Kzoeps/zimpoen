import type { Migration } from "@assistant/db";

/** Tables of the health module (PLAN §7). Never edit one that has shipped: add `health/00N_...` after it. */
export const healthMigrations: readonly Migration[] = [
	{
		id: "health/001_weight",
		up: (db) => {
			db.exec(`
				CREATE TABLE health_weight (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					-- The owner's local calendar day, YYYY-MM-DD. One weighing a day: a second one replaces the first, on request.
					measured_on TEXT NOT NULL UNIQUE CHECK (measured_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
					-- Kilograms, always: pounds are converted once, where they come in.
					kg REAL NOT NULL CHECK (kg > 0),
					note TEXT NOT NULL DEFAULT '',
					-- The tool call that inserted the row (rule 8). A replaced weighing keeps it.
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
	{
		id: "health/002_workouts",
		up: (db) => {
			db.exec(`
				CREATE TABLE health_exercise (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					-- The canonical name, as shown: "Bench press".
					name TEXT NOT NULL,
					-- What two spellings of the name have in common (lower case, letters and digits): "benchpress".
					key TEXT NOT NULL UNIQUE,
					-- JSON array of other names: ["bench", "flat bench"].
					aliases TEXT NOT NULL DEFAULT '[]',
					-- weighted: judged by estimated 1RM. bodyweight: judged by repetitions (kg is what was added, usually 0).
					kind TEXT NOT NULL CHECK (kind IN ('weighted', 'bodyweight')),
					created_at INTEGER NOT NULL
				) STRICT;

				CREATE TABLE health_session (
					id TEXT PRIMARY KEY,
					-- The owner's local calendar day, YYYY-MM-DD.
					date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
					note TEXT NOT NULL DEFAULT '',
					-- One log_workout call is one session, written in one transaction (rule 8).
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL
				) STRICT;
				CREATE INDEX health_session_date ON health_session (date);

				CREATE TABLE health_set (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					session_id TEXT NOT NULL REFERENCES health_session (id) ON DELETE CASCADE,
					exercise_id INTEGER NOT NULL REFERENCES health_exercise (id),
					-- 1, 2, 3... within the session and the exercise.
					set_no INTEGER NOT NULL CHECK (set_no >= 1),
					reps INTEGER NOT NULL CHECK (reps >= 1),
					kg REAL NOT NULL DEFAULT 0 CHECK (kg >= 0),
					rpe REAL CHECK (rpe IS NULL OR (rpe >= 1 AND rpe <= 10)),
					-- "<tool call id>:<n>": one call writes many sets, so each carries its own key (rule 8).
					source_call_id TEXT NOT NULL UNIQUE,
					UNIQUE (session_id, exercise_id, set_no)
				) STRICT;
				CREATE INDEX health_set_exercise ON health_set (exercise_id, session_id);
			`);
		},
	},
	{
		// Rule 8 for the tool that changes a row that exists: the call id is recorded in the same transaction as the change,
		// so a call Durable replays after a crash is recognised and a later correction is not undone.
		id: "health/003_call_ledger",
		up: (db) => {
			db.exec(`
				CREATE TABLE health_call (
					source_call_id TEXT PRIMARY KEY,
					tool TEXT NOT NULL,
					-- What the call touched: the day of a weighing.
					subject TEXT NOT NULL,
					applied_at INTEGER NOT NULL
				) STRICT
			`);
		},
	},
];
