import type { Migration } from "@assistant/db";

/** Tables of the routines module. Never edit one that has shipped: add `routines/00N_...` after it. */
export const routinesMigrations: readonly Migration[] = [
	{
		id: "routines/001_routine",
		up: (db) => {
			db.exec(`
				CREATE TABLE routines_routine (
					id TEXT PRIMARY KEY,
					-- Where it runs: the conversation the agent made it in, and that agent.
					conversation_id INTEGER NOT NULL,
					agent TEXT NOT NULL,
					title TEXT NOT NULL,
					message TEXT NOT NULL,
					kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly', 'hourly')),
					local_time TEXT CHECK (local_time IS NULL OR local_time GLOB '[0-2][0-9]:[0-5][0-9]'),
					-- ISO weekdays, comma separated (1 = Monday), for kind = 'weekly'.
					days TEXT,
					every_hours INTEGER CHECK (every_hours IS NULL OR every_hours >= 1),
					-- What "every N hours" counts from.
					anchor_at INTEGER NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
					-- The slot the timer waits for (epoch ms). The row is the truth, the Durable task a timer (PLAN §5.4).
					due_at INTEGER NOT NULL,
					last_slot_at INTEGER,
					last_run_at INTEGER,
					runs INTEGER NOT NULL DEFAULT 0,
					skipped INTEGER NOT NULL DEFAULT 0,
					gen INTEGER NOT NULL DEFAULT 0,
					durable_task_id INTEGER,
					-- Rule 8: the create_routine call that made it.
					source_call_id TEXT NOT NULL UNIQUE,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					cancelled_at INTEGER
				) STRICT;

				CREATE INDEX routines_routine_active ON routines_routine (status, due_at);

				-- Rule 8 for cancel_routine.
				CREATE TABLE routines_call (
					source_call_id TEXT PRIMARY KEY,
					tool TEXT NOT NULL,
					subject TEXT,
					applied_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
];
