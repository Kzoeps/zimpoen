import type { Migration } from "@assistant/db";

/** Tables of the credential broker module. Installed whether or not the broker is on, so turning it off never strands a database. */
export const brokerMigrations: readonly Migration[] = [
	{
		id: "broker/001_calls",
		up: (db) => {
			db.exec(`
				-- One row per cred_run call (rule 8): a replay returns what the first execution decided and produced.
				-- Never holds a secret: output is stored after scrubbing.
				CREATE TABLE broker_call (
					call_id TEXT PRIMARY KEY,
					conversation_id INTEGER NOT NULL,
					project TEXT NOT NULL,
					cred_id TEXT NOT NULL,
					action TEXT NOT NULL,
					params TEXT NOT NULL,
					decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
					-- allow: running until the result is written; ask: waiting on approval_id; deny: refused.
					status TEXT NOT NULL CHECK (status IN ('running', 'done', 'asked', 'refused')),
					approval_id TEXT,
					exit_code INTEGER,
					output TEXT,
					redacted INTEGER,
					reason TEXT,
					created_at INTEGER NOT NULL,
					finished_at INTEGER
				) STRICT;
			`);
		},
	},
];
