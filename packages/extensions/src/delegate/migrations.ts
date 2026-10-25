import type { Migration } from "@assistant/db";

/** Tables of the delegate module (the PA's `ask_agent`). Never edit one that has shipped: add `delegate/00N_...` after it. */
export const delegateMigrations: readonly Migration[] = [
	{
		id: "delegate/001_asks",
		up: (db) => {
			db.exec(`
				-- One row per ask_agent call (rule 8: the call id is unique). The question lives in the other agent's conversation as an
				-- input with request_id; the row says whether the PA still waits, and whether a late answer reached the PA's thread.
				CREATE TABLE delegate_ask (
					id TEXT PRIMARY KEY,
					source_call_id TEXT NOT NULL UNIQUE,
					-- The conversation that asked (the PA's) and the agent that was asked.
					conversation_id INTEGER NOT NULL,
					agent TEXT NOT NULL CHECK (agent IN ('inbox', 'health', 'accountant')),
					question TEXT NOT NULL,
					request_id TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('waiting', 'answered', 'failed')),
					answer TEXT,
					-- The PA stopped waiting before the answer came: it is posted to the PA's thread as a card when it does.
					late INTEGER NOT NULL DEFAULT 0,
					posted_at INTEGER,
					created_at INTEGER NOT NULL,
					settled_at INTEGER
				) STRICT;
				CREATE INDEX delegate_ask_open ON delegate_ask (status) WHERE status = 'waiting';
			`);
		},
	},
];
