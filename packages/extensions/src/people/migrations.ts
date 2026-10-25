import type { Migration } from "@assistant/db";

/** Tables of the people module (PLAN §7). Never edit one that has shipped: add `people/00N_...` after it. */
export const peopleMigrations: readonly Migration[] = [
	{
		id: "people/001_people",
		up: (db) => {
			db.exec(`
				CREATE TABLE people_person (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					relation TEXT NOT NULL DEFAULT '',
					-- 'MM-DD'. 29 February is kept as it is; the yearly cycle moves it to 28 February in a year without one.
					birthday_md TEXT NOT NULL CHECK (birthday_md GLOB '[0-1][0-9]-[0-3][0-9]'),
					birthday_year INTEGER,
					notes TEXT NOT NULL DEFAULT '',
					-- The yearly cycle that is waiting to run: the year of the birthday, when to remind (NULL when that moment
					-- had already passed as the cycle began) and when to ask whether the owner did (epoch ms, UTC).
					cycle_year INTEGER NOT NULL,
					remind_at INTEGER,
					check_at INTEGER NOT NULL,
					reminded_at INTEGER,
					-- The latest evening question: its birthday's year and when it was posted. It outlives the cycle, so the
					-- prompt can say which birthday "yes, I did" answers.
					asked_year INTEGER,
					asked_at INTEGER,
					-- Bumped whenever the timer has to be replaced. The Durable task carries the number it was created with
					-- and only acts while it is still the row's current one (PLAN §5.4).
					gen INTEGER NOT NULL DEFAULT 0,
					durable_task_id INTEGER,
					-- The conversation that created the person: birthday cards are posted there.
					conversation_id INTEGER NOT NULL,
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				) STRICT;

				CREATE TABLE people_wish (
					person_id TEXT NOT NULL REFERENCES people_person (id) ON DELETE CASCADE,
					-- The year of the birthday.
					year INTEGER NOT NULL,
					wished INTEGER NOT NULL CHECK (wished IN (0, 1)),
					recorded_at INTEGER NOT NULL,
					PRIMARY KEY (person_id, year)
				) STRICT;
			`);
		},
	},
	{
		// Rule 8 for tools that change an existing row: the call id is recorded in the same transaction as the change,
		// so a call Durable replays after a crash is recognised and not applied twice.
		id: "people/002_call_ledger",
		up: (db) => {
			db.exec(`
				CREATE TABLE people_call (
					source_call_id TEXT PRIMARY KEY,
					tool TEXT NOT NULL,
					person_id TEXT,
					applied_at INTEGER NOT NULL
				) STRICT
			`);
		},
	},
	{
		// The morning card gets what the evening question already had (`asked_year`): which birthday it was for. With
		// `reminded_at` it now outlives the cycle, so that start-up can post again a card that a power cut took from Durable's
		// database after the cycle had ended (the row had moved on, and nothing else remembered the card).
		id: "people/003_reminded_year",
		up: (db) => {
			db.exec("ALTER TABLE people_person ADD COLUMN reminded_year INTEGER");
		},
	},
];
