import type { Migration } from "@assistant/db";

const DAY = "GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";

/** Tables of the splits module (PLAN §7). Never edit one that has shipped: add `splits/00N_...` after it. */
export const splitsMigrations: readonly Migration[] = [
	{
		id: "splits/001_bills",
		up: (db) => {
			db.exec(`
				-- One bill one person paid and several shared. Money is integer minor units; the shares add up to total_minor exactly.
				CREATE TABLE splits_bill (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					occurred_on TEXT NOT NULL CHECK (occurred_on ${DAY}),
					-- People are matched by the key of their name (accents, case and punctuation dropped); 'me' is the owner.
					payer_key TEXT NOT NULL,
					payer_name TEXT NOT NULL,
					total_minor INTEGER NOT NULL CHECK (total_minor > 0),
					currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
					-- 1: shared equally with no items.
					equal INTEGER NOT NULL CHECK (equal IN (0, 1)),
					-- Tax, service, tip, discounts as [{label, amount_minor}], percentages already turned into amounts.
					extras_json TEXT NOT NULL,
					-- The photo of the bill: a file id (fi_...).
					source_ref TEXT,
					note TEXT NOT NULL DEFAULT '',
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL
				) STRICT;
				CREATE INDEX splits_bill_day ON splits_bill (occurred_on DESC, created_at DESC);

				CREATE TABLE splits_item (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					bill_id TEXT NOT NULL REFERENCES splits_bill (id) ON DELETE CASCADE,
					description TEXT NOT NULL,
					amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
					-- Display names of those who had it.
					shared_by_json TEXT NOT NULL
				) STRICT;
				CREATE INDEX splits_item_bill ON splits_item (bill_id);

				CREATE TABLE splits_share (
					bill_id TEXT NOT NULL REFERENCES splits_bill (id) ON DELETE CASCADE,
					person_key TEXT NOT NULL,
					person_name TEXT NOT NULL,
					-- The person of the same name in the birthdays list, when exactly one has it. Nothing depends on it.
					person_id TEXT REFERENCES people_person (id) ON DELETE SET NULL,
					items_minor INTEGER NOT NULL,
					extras_minor INTEGER NOT NULL,
					owed_minor INTEGER NOT NULL CHECK (owed_minor >= 0),
					PRIMARY KEY (bill_id, person_key)
				) STRICT;
				CREATE INDEX splits_share_person ON splits_share (person_key);

				-- "from" paid "to": it lowers what from owes to (or raises what to owes from, when it was more).
				CREATE TABLE splits_settlement (
					id TEXT PRIMARY KEY,
					occurred_on TEXT NOT NULL CHECK (occurred_on ${DAY}),
					from_key TEXT NOT NULL,
					from_name TEXT NOT NULL,
					to_key TEXT NOT NULL,
					to_name TEXT NOT NULL,
					amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
					currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
					note TEXT NOT NULL DEFAULT '',
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
];
