import type { Migration } from "@assistant/db";
import { nameKey } from "./keys.ts";

/** The categories a new ledger starts with: what the owner will spend on, and a few ways money comes in. */
export const SEED_EXPENSE_CATEGORIES = [
	"food",
	"groceries",
	"transport",
	"rent",
	"utilities",
	"phone/internet",
	"health",
	"shopping",
	"entertainment",
	"travel",
	"gifts",
	"fees",
	"other",
] as const;

export const SEED_INCOME_CATEGORIES = ["salary", "freelance", "refund", "interest", "other income"] as const;

const DAY = "GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";

/** Tables of the ledger module (PLAN §7). Never edit one that has shipped: add `ledger/00N_...` after it. */
export const ledgerMigrations: readonly Migration[] = [
	{
		id: "ledger/001_core",
		up: (db) => {
			db.exec(`
				CREATE TABLE ledger_account (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL,
					-- What two spellings of the name have in common: the owner names an account loosely ("bob savings").
					key TEXT NOT NULL UNIQUE,
					kind TEXT NOT NULL CHECK (kind IN ('cash', 'bank', 'wallet', 'card')),
					currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
					-- Archived accounts keep their entries and drop out of balances and of the choices a tool offers.
					archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL
				) STRICT;

				CREATE TABLE ledger_category (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL,
					key TEXT NOT NULL UNIQUE,
					parent_id INTEGER REFERENCES ledger_category (id),
					kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
					source_call_id TEXT UNIQUE
				) STRICT;

				-- Money is an integer count of minor units, signed from the account's side: out is negative. Never a float.
				CREATE TABLE ledger_txn (
					-- Rows are numbered in the order they were written, and a number is never used twice (AUTOINCREMENT): a balance
					-- snapshot remembers the highest one it saw, which is how an entry of the same day is told from before or after it.
					seq INTEGER PRIMARY KEY AUTOINCREMENT,
					id TEXT NOT NULL UNIQUE,
					account_id INTEGER NOT NULL REFERENCES ledger_account (id),
					-- The owner's local calendar day, YYYY-MM-DD.
					occurred_on TEXT NOT NULL CHECK (occurred_on ${DAY}),
					amount_minor INTEGER NOT NULL CHECK (amount_minor != 0),
					currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
					category_id INTEGER REFERENCES ledger_category (id),
					merchant TEXT NOT NULL DEFAULT '',
					-- The merchant's name without order numbers, to group by and to remember a category by.
					merchant_key TEXT NOT NULL DEFAULT '',
					note TEXT NOT NULL DEFAULT '',
					source TEXT NOT NULL CHECK (source IN ('chat', 'csv', 'receipt')),
					-- A receipt entry: the file id of the photo. A CSV entry: the import id.
					source_ref TEXT,
					-- The two legs of a transfer share this; transfers are not spending and not income.
					transfer_id TEXT,
					-- The tool call that wrote the row (rule 8); one call writing several rows suffixes it (':in', ':3').
					source_call_id TEXT UNIQUE,
					-- A CSV row's fingerprint, so importing the same statement twice (or two that overlap) adds nothing new.
					import_hash TEXT UNIQUE,
					created_at INTEGER NOT NULL
				) STRICT;
				CREATE INDEX ledger_txn_day ON ledger_txn (occurred_on);
				CREATE INDEX ledger_txn_account ON ledger_txn (account_id, occurred_on);
				CREATE INDEX ledger_txn_transfer ON ledger_txn (transfer_id) WHERE transfer_id IS NOT NULL;
				CREATE INDEX ledger_txn_merchant ON ledger_txn (merchant_key);

				-- What the owner said an account held, as of a day. The balance is the latest snapshot plus the entries since.
				CREATE TABLE ledger_balance_snapshot (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					account_id INTEGER NOT NULL REFERENCES ledger_account (id),
					as_of TEXT NOT NULL CHECK (as_of ${DAY}),
					-- Signed: a card that owes money holds a negative balance.
					amount_minor INTEGER NOT NULL,
					-- The highest ledger_txn.seq when it was recorded: an entry of day as_of with a higher seq came after it.
					txn_watermark INTEGER NOT NULL,
					note TEXT NOT NULL DEFAULT '',
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL
				) STRICT;
				CREATE INDEX ledger_snapshot_account ON ledger_balance_snapshot (account_id, as_of DESC, id DESC);

				-- Exchange rates the owner gave. Nothing is fetched from anywhere. One unit of from_currency is rate_micro / 1e6 of to_currency.
				CREATE TABLE ledger_fx (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					date TEXT NOT NULL CHECK (date ${DAY}),
					from_currency TEXT NOT NULL CHECK (from_currency GLOB '[A-Z][A-Z][A-Z]'),
					to_currency TEXT NOT NULL CHECK (to_currency GLOB '[A-Z][A-Z][A-Z]'),
					rate_micro INTEGER NOT NULL CHECK (rate_micro > 0),
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL
				) STRICT;
				CREATE INDEX ledger_fx_pair ON ledger_fx (from_currency, to_currency, date DESC, id DESC);
			`);
			const insert = (name: string, kind: "expense" | "income"): void => {
				db.run("INSERT INTO ledger_category (name, key, kind) VALUES (?, ?, ?)", name, nameKey(name), kind);
			};
			for (const name of SEED_EXPENSE_CATEGORIES) insert(name, "expense");
			for (const name of SEED_INCOME_CATEGORIES) insert(name, "income");
		},
	},
	{
		// A CSV is read once into rows the owner can look at; nothing reaches the ledger until they are confirmed.
		id: "ledger/002_imports",
		up: (db) => {
			db.exec(`
				CREATE TABLE ledger_import (
					id TEXT PRIMARY KEY,
					file_id TEXT NOT NULL,
					file_name TEXT NOT NULL,
					account_id INTEGER NOT NULL REFERENCES ledger_account (id),
					status TEXT NOT NULL CHECK (status IN ('preview', 'imported')),
					-- The preview card as the owner saw it, and the rows it stands for: what was shown is what is imported.
					summary_json TEXT NOT NULL,
					rows_json TEXT NOT NULL,
					inserted INTEGER,
					duplicates INTEGER,
					source_call_id TEXT UNIQUE,
					confirmed_call_id TEXT,
					created_at INTEGER NOT NULL,
					imported_at INTEGER
				) STRICT
			`);
		},
	},
	{
		// Rule 8 for the tools that change a row that exists (recategorize, archive_account): the call id is recorded in the
		// same transaction as the change, so a call Durable replays after a crash is recognised and a later change is not undone.
		id: "ledger/003_call_ledger",
		up: (db) => {
			db.exec(`
				CREATE TABLE ledger_call (
					source_call_id TEXT PRIMARY KEY,
					tool TEXT NOT NULL,
					-- What the call did, in a form the tool can answer a replay from.
					subject TEXT NOT NULL,
					applied_at INTEGER NOT NULL
				) STRICT
			`);
		},
	},
	{
		// Taking back a bulk change: an import that was wrong is removed as a unit, and a recategorization remembers each
		// entry's earlier category so that it can be undone. An import also remembers how many rows it left out because they
		// repeat an entry typed in chat or read from a receipt.
		id: "ledger/004_undo",
		up: (db) => {
			db.exec(`
				ALTER TABLE ledger_import ADD COLUMN skipped_matches INTEGER;
				ALTER TABLE ledger_import ADD COLUMN undone_at INTEGER;

				CREATE TABLE ledger_recategorization (
					id TEXT PRIMARY KEY,
					-- The recategorize call that made it (rule 8).
					source_call_id TEXT NOT NULL UNIQUE,
					category_id INTEGER NOT NULL REFERENCES ledger_category (id),
					-- What the owner asked for, in words: "every entry of 'tea stall'", "3 entries by id".
					what TEXT NOT NULL,
					changed INTEGER NOT NULL,
					created_at INTEGER NOT NULL,
					undone_at INTEGER
				) STRICT;

				-- The category each entry had before: NULL for none. The entry may have been deleted since.
				CREATE TABLE ledger_recategorization_row (
					batch_id TEXT NOT NULL REFERENCES ledger_recategorization (id) ON DELETE CASCADE,
					txn_id TEXT NOT NULL,
					previous_category_id INTEGER,
					PRIMARY KEY (batch_id, txn_id)
				) STRICT
			`);
		},
	},
];
