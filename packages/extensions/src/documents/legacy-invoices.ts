import type { Migration } from "@assistant/db";

const DAY = "GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";

/** Tables of the invoices module (PLAN §7). Never edit one that has shipped: add `invoices/00N_...` after it. */
export const invoicesMigrations: readonly Migration[] = [
	{
		id: "invoices/001_invoices",
		up: (db) => {
			db.exec(`
				-- What stays the same from one month's invoice to the next. One row, made by the first set_invoice_profile.
				CREATE TABLE invoice_profile (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					sender_name TEXT NOT NULL DEFAULT '',
					sender_details TEXT NOT NULL DEFAULT '',
					client_name TEXT NOT NULL DEFAULT '',
					client_address TEXT NOT NULL DEFAULT '',
					-- The line on the invoice; {period}, {month} and {year} are replaced by the invoice's month.
					description TEXT NOT NULL DEFAULT '',
					-- The usual amount in minor units; NULL until the owner gives one.
					amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor > 0),
					currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
					payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
					payment_details TEXT NOT NULL DEFAULT '',
					notes TEXT NOT NULL DEFAULT '',
					number_pattern TEXT NOT NULL DEFAULT 'INV-{YYYY}-{seq:03}',
					-- The running number the next invoice takes. It only ever goes up as invoices are made.
					next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
					updated_at INTEGER NOT NULL
				) STRICT;

				-- Every invoice made. A number is never used twice, whatever happens to the file.
				CREATE TABLE invoice_issued (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					number TEXT NOT NULL UNIQUE,
					seq INTEGER NOT NULL,
					-- The month the invoice is for, YYYY-MM.
					period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
					issue_date TEXT NOT NULL CHECK (issue_date ${DAY}),
					due_date TEXT NOT NULL CHECK (due_date ${DAY}),
					amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
					currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
					client_name TEXT NOT NULL,
					description TEXT NOT NULL,
					-- The PDF: its id in files_index and its path in <data>/workspace/invoices.
					file_id TEXT NOT NULL,
					file_path TEXT NOT NULL,
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL
				) STRICT;
				CREATE INDEX invoice_issued_period ON invoice_issued (period);

				-- Rule 8 for set_invoice_profile: the call id is recorded in the same transaction as the change, so a call
				-- Durable replays after a crash does not undo a later edit.
				CREATE TABLE invoices_call (
					source_call_id TEXT PRIMARY KEY,
					tool TEXT NOT NULL,
					subject TEXT NOT NULL,
					applied_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
];
