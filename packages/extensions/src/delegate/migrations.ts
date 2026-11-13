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
	{
		id: "delegate/002_bot_agents",
		up: (db) => {
			// ask_agent may ask a bot the PA created ('bot:<slug>', PLAN upgrade §4). SQLite cannot change a CHECK, so the table
			// is rebuilt without the fixed list of agents; the tool checks the agent instead.
			db.exec(`
				CREATE TABLE delegate_ask_new (
					id TEXT PRIMARY KEY,
					source_call_id TEXT NOT NULL UNIQUE,
					conversation_id INTEGER NOT NULL,
					agent TEXT NOT NULL CHECK (agent IN ('inbox', 'health', 'accountant') OR agent LIKE 'bot:%'),
					question TEXT NOT NULL,
					request_id TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('waiting', 'answered', 'failed')),
					answer TEXT,
					late INTEGER NOT NULL DEFAULT 0,
					posted_at INTEGER,
					created_at INTEGER NOT NULL,
					settled_at INTEGER
				) STRICT;
				INSERT INTO delegate_ask_new SELECT id, source_call_id, conversation_id, agent, question, request_id, status, answer,
					late, posted_at, created_at, settled_at FROM delegate_ask;
				DROP TABLE delegate_ask;
				ALTER TABLE delegate_ask_new RENAME TO delegate_ask;
				CREATE INDEX delegate_ask_open ON delegate_ask (status) WHERE status = 'waiting';
			`);
		},
	},
	{
		id: "delegate/003_scheduled",
		up: (db) => {
			// Rule 13: an ask made inside a scheduled run (routine, daily job, or another scheduled answer) keeps that origin, so
			// the run that posts its answer into the PA's thread is treated as scheduled too.
			db.exec("ALTER TABLE delegate_ask ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0 CHECK (scheduled IN (0, 1));");
		},
	},
	{
		id: "delegate/004_cto",
		up: (db) => {
			// ask_agent may ask the CTO (PLAN upgrade §7). Rebuilt as in 002, since SQLite cannot change a CHECK.
			db.exec(`
				CREATE TABLE delegate_ask_new (
					id TEXT PRIMARY KEY,
					source_call_id TEXT NOT NULL UNIQUE,
					conversation_id INTEGER NOT NULL,
					agent TEXT NOT NULL CHECK (agent IN ('inbox', 'health', 'accountant', 'cto') OR agent LIKE 'bot:%'),
					question TEXT NOT NULL,
					request_id TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('waiting', 'answered', 'failed')),
					answer TEXT,
					late INTEGER NOT NULL DEFAULT 0,
					posted_at INTEGER,
					created_at INTEGER NOT NULL,
					settled_at INTEGER,
					scheduled INTEGER NOT NULL DEFAULT 0 CHECK (scheduled IN (0, 1))
				) STRICT;
				INSERT INTO delegate_ask_new SELECT id, source_call_id, conversation_id, agent, question, request_id, status, answer,
					late, posted_at, created_at, settled_at, scheduled FROM delegate_ask;
				DROP TABLE delegate_ask;
				ALTER TABLE delegate_ask_new RENAME TO delegate_ask;
				CREATE INDEX delegate_ask_open ON delegate_ask (status) WHERE status = 'waiting';
			`);
		},
	},
];
