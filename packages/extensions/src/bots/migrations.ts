import type { Migration } from "@assistant/db";

/** Tables of the bots module (PLAN upgrade §4). Never edit one that has shipped: add `bots/00N_...` after it. */
export const botsMigrations: readonly Migration[] = [
	{
		id: "bots/001_bots",
		up: (db) => {
			db.exec(`
				-- One row per specialist bot the PA created. The row is authoritative: the server makes sure each row has a
				-- conversation (agents row 'bot:<slug>') at every start, and archives a conversation whose row is gone.
				CREATE TABLE bots_bot (
					slug TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					avatar TEXT NOT NULL,
					soul TEXT NOT NULL CHECK (length(soul) <= 6000),
					-- JSON array of preset names from the code's allowlist.
					tools TEXT NOT NULL,
					-- How creating it was allowed: the owner approved it, or the PA's trust level was open (logged).
					approved_via TEXT NOT NULL CHECK (approved_via IN ('owner', 'open')),
					source_call_id TEXT NOT NULL,
					created_at INTEGER NOT NULL
				) STRICT;

				-- Rule 8: what a create_bot or delete_bot call answered, so a replay answers the same and does nothing twice.
				CREATE TABLE bots_call (
					call_id TEXT PRIMARY KEY,
					tool TEXT NOT NULL,
					output TEXT NOT NULL,
					created_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
];
