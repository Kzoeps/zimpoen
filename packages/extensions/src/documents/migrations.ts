import type { Migration } from "@assistant/db";
import { invoicesMigrations } from "./legacy-invoices.ts";

/**
 * The documents module's tables. `invoices/001` is the retired invoice module's: it stays so that databases that applied it
 * still open, and its tables keep the invoices made before. Never edit one that has shipped.
 */
export const documentsMigrations: readonly Migration[] = [
	...invoicesMigrations,
	{
		id: "documents/001_number_series",
		up: (db) => {
			db.exec(`
				-- A running number per kind of document. next_seq only ever goes up.
				CREATE TABLE document_series (
					series TEXT PRIMARY KEY CHECK (series GLOB '[a-z]*' AND length(series) <= 40),
					pattern TEXT NOT NULL,
					next_seq INTEGER NOT NULL CHECK (next_seq >= 1),
					updated_at INTEGER NOT NULL
				) STRICT;

				-- Every number taken, with the tool call that took it: a call Durable replays gets the same number back.
				CREATE TABLE document_numbers (
					number TEXT NOT NULL,
					series TEXT NOT NULL REFERENCES document_series (series),
					seq INTEGER NOT NULL,
					label TEXT NOT NULL DEFAULT '',
					source_call_id TEXT UNIQUE,
					taken_at INTEGER NOT NULL,
					PRIMARY KEY (series, number)
				) STRICT;

				-- Every PDF make_pdf wrote, by the call that wrote it: a replayed call returns the same file instead of a second one.
				CREATE TABLE documents_made (
					source_call_id TEXT PRIMARY KEY,
					file_id TEXT NOT NULL,
					created_at INTEGER NOT NULL
				) STRICT;

				-- Invoices continue from where the old invoice module left off.
				INSERT INTO document_series (series, pattern, next_seq, updated_at)
				SELECT 'invoice', number_pattern, next_seq, updated_at FROM invoice_profile WHERE id = 1;
			`);
		},
	},
];
