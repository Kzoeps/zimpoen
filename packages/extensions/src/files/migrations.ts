import type { Migration } from "@assistant/db";

/** Tables of the files module (PLAN §7). Never edit one that has shipped: add `files/00N_...` after it. */
export const filesMigrations: readonly Migration[] = [
	{
		id: "files/001_index",
		up: (db) => {
			db.exec(`
				CREATE TABLE files_index (
					id TEXT PRIMARY KEY,
					-- Absolute, with symbolic links resolved. An upload lives under <data>/files/<yyyy-mm>/.
					path TEXT NOT NULL UNIQUE,
					name TEXT NOT NULL,
					mime TEXT NOT NULL,
					kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'csv', 'text', 'other')),
					size INTEGER NOT NULL,
					source TEXT NOT NULL CHECK (source IN ('upload', 'path')),
					-- What the PA wrote down about it ("the March bank CSV"), and words to find it by.
					description TEXT NOT NULL DEFAULT '',
					tags TEXT NOT NULL DEFAULT '',
					added_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				) STRICT;

				-- Rule 8 for describe_file: its call id is recorded in the same transaction as the change.
				CREATE TABLE files_call (
					source_call_id TEXT PRIMARY KEY,
					tool TEXT NOT NULL,
					file_id TEXT,
					applied_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
];
