import type { Migration } from "@assistant/db";

/**
 * Tables of the memory module (PLAN §7). Never edit one that has shipped: add `memory/00N_...` after it.
 *
 * Deviations from the first sketch: `seq` is the integer key the full-text index points at (a table keyed by text has
 * only an implicit rowid, which a VACUUM may renumber under an external-content index), `id` is what the model and the
 * profile page name a fact by; `pinned` and `slot` are what the prompt section and the profile page need; `source` says
 * whether the owner or an agent wrote it.
 */
export const memoryMigrations: readonly Migration[] = [
	{
		id: "memory/001_facts",
		up: (db) => {
			db.exec(`
				CREATE TABLE memory_fact (
					seq INTEGER PRIMARY KEY AUTOINCREMENT,
					id TEXT NOT NULL UNIQUE,
					-- 'shared' (every agent) or an agent id: the application checks it, so a new agent needs no migration.
					scope TEXT NOT NULL,
					kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact')),
					text TEXT NOT NULL,
					pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
					-- The preferences the profile page owns ('tone', 'explanations'): one row each, changed in place.
					slot TEXT CHECK (slot IN ('tone', 'explanations')),
					source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'owner')),
					-- Rule 8: a remember call that Durable runs again finds its own row.
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				) STRICT;
				CREATE UNIQUE INDEX memory_fact_slot ON memory_fact (slot) WHERE slot IS NOT NULL;
				CREATE INDEX memory_fact_scope ON memory_fact (scope, kind, updated_at DESC);

				-- Full-text search over the text (recall, and the profile page's search box).
				CREATE VIRTUAL TABLE memory_fact_fts USING fts5(
					text,
					content = 'memory_fact', content_rowid = 'seq', tokenize = 'unicode61 remove_diacritics 2'
				);
				CREATE TRIGGER memory_fact_fts_insert AFTER INSERT ON memory_fact BEGIN
					INSERT INTO memory_fact_fts (rowid, text) VALUES (new.seq, new.text);
				END;
				CREATE TRIGGER memory_fact_fts_delete AFTER DELETE ON memory_fact BEGIN
					INSERT INTO memory_fact_fts (memory_fact_fts, rowid, text) VALUES ('delete', old.seq, old.text);
				END;
				CREATE TRIGGER memory_fact_fts_update AFTER UPDATE OF text ON memory_fact BEGIN
					INSERT INTO memory_fact_fts (memory_fact_fts, rowid, text) VALUES ('delete', old.seq, old.text);
					INSERT INTO memory_fact_fts (rowid, text) VALUES (new.seq, new.text);
				END;
			`);
		},
	},
	{
		id: "memory/002_origin",
		up: (db) => {
			// Where an agent-written line came from (an agent, its conversation, when it was written or asked for). A preference
			// an agent proposed has the owner's approval; this is the record of who proposed it. Null for the owner's own lines.
			db.exec(`
				ALTER TABLE memory_fact ADD COLUMN origin_agent TEXT;
				ALTER TABLE memory_fact ADD COLUMN origin_conversation INTEGER;
				ALTER TABLE memory_fact ADD COLUMN origin_at INTEGER;
			`);
		},
	},
];
