import type { Migration } from "@assistant/db";

/** Tables of the CTO module. Installed whether or not the CTO is on, so the flag can flip freely. */
export const ctoMigrations: readonly Migration[] = [
	{
		id: "cto/001_cards",
		up: (db) => {
			db.exec(`
				-- One row per delegate_coding call (rule 8): a replay finds the card it opened and opens no second one.
				CREATE TABLE cto_card (
					call_id TEXT PRIMARY KEY,
					conversation_id INTEGER NOT NULL,
					repo TEXT NOT NULL,
					goal TEXT NOT NULL,
					done_when TEXT NOT NULL,
					out_of_scope TEXT NOT NULL,
					-- creating: asked the board, no id back yet; created: the board has it; notified: the lead was told.
					status TEXT NOT NULL CHECK (status IN ('creating', 'created', 'notified', 'refused')),
					card_id TEXT,
					reason TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				) STRICT;
				CREATE UNIQUE INDEX cto_card_card ON cto_card (card_id) WHERE card_id IS NOT NULL;
			`);
		},
	},
];
