import { randomBytes } from "node:crypto";
import type { AppDb, SqlParam } from "@assistant/db";
import type { AccountKind } from "@assistant/shared";
import { merchantKey, nameKey } from "./keys.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------------------------------

export type AccountRow = {
	id: number;
	name: string;
	key: string;
	kind: AccountKind;
	currency: string;
	archived: boolean;
	createdAt: number;
};

type AccountRecord = {
	id: number;
	name: string;
	key: string;
	kind: AccountKind;
	currency: string;
	archived: number;
	created_at: number;
};

const ACCOUNT_COLUMNS = "id, name, key, kind, currency, archived, created_at";

const accountOf = (record: AccountRecord): AccountRow => ({
	id: record.id,
	name: record.name,
	key: record.key,
	kind: record.kind,
	currency: record.currency,
	archived: record.archived === 1,
	createdAt: record.created_at,
});

/** Accounts by name; archived ones only when asked for. A personal ledger has a handful of them. */
export function listAccounts(db: AppDb, includeArchived = false): AccountRow[] {
	return db
		.all<AccountRecord>(
			`SELECT ${ACCOUNT_COLUMNS} FROM ledger_account ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY name COLLATE NOCASE, id`,
		)
		.map(accountOf);
}

export function getAccount(db: AppDb, id: number): AccountRow | undefined {
	const record = db.get<AccountRecord>(`SELECT ${ACCOUNT_COLUMNS} FROM ledger_account WHERE id = ?`, id);
	return record === undefined ? undefined : accountOf(record);
}

export function accountByCallId(db: AppDb, callId: string): AccountRow | undefined {
	const record = db.get<AccountRecord>(
		`SELECT ${ACCOUNT_COLUMNS} FROM ledger_account WHERE source_call_id = ?`,
		callId,
	);
	return record === undefined ? undefined : accountOf(record);
}

export function accountByKey(db: AppDb, key: string): AccountRow | undefined {
	const record = db.get<AccountRecord>(`SELECT ${ACCOUNT_COLUMNS} FROM ledger_account WHERE key = ?`, key);
	return record === undefined ? undefined : accountOf(record);
}

export type NewAccount = { name: string; kind: AccountKind; currency: string; now: number };

/** Insert an account for tool call `callId`, or return the one that call already made. The name must be free (it is a unique key). */
export function insertAccount(db: AppDb, input: NewAccount, callId: string): { row: AccountRow; created: boolean } {
	return db.transaction(() => {
		const earlier = accountByCallId(db, callId);
		if (earlier !== undefined) return { row: earlier, created: false };
		db.run(
			"INSERT INTO ledger_account (name, key, kind, currency, source_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			input.name,
			nameKey(input.name),
			input.kind,
			input.currency,
			callId,
			input.now,
		);
		return { row: accountByCallId(db, callId) as AccountRow, created: true };
	});
}

export function setArchived(db: AppDb, id: number, archived: boolean): void {
	db.run("UPDATE ledger_account SET archived = ? WHERE id = ?", archived ? 1 : 0, id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------------------------------

export type CategoryRow = { id: number; name: string; key: string; kind: "expense" | "income"; parentId?: number };

type CategoryRecord = { id: number; name: string; key: string; kind: "expense" | "income"; parent_id: number | null };

const categoryOf = (record: CategoryRecord): CategoryRow => ({
	id: record.id,
	name: record.name,
	key: record.key,
	kind: record.kind,
	...(record.parent_id === null ? {} : { parentId: record.parent_id }),
});

export function listCategories(db: AppDb): CategoryRow[] {
	return db
		.all<CategoryRecord>("SELECT id, name, key, kind, parent_id FROM ledger_category ORDER BY kind DESC, id")
		.map(categoryOf);
}

export function categoryByCallId(db: AppDb, callId: string): CategoryRow | undefined {
	const record = db.get<CategoryRecord>(
		"SELECT id, name, key, kind, parent_id FROM ledger_category WHERE source_call_id = ?",
		callId,
	);
	return record === undefined ? undefined : categoryOf(record);
}

export function insertCategory(
	db: AppDb,
	input: { name: string; kind: "expense" | "income"; parentId?: number },
	callId: string,
): { row: CategoryRow; created: boolean } {
	return db.transaction(() => {
		const earlier = categoryByCallId(db, callId);
		if (earlier !== undefined) return { row: earlier, created: false };
		db.run(
			"INSERT INTO ledger_category (name, key, kind, parent_id, source_call_id) VALUES (?, ?, ?, ?, ?)",
			input.name,
			nameKey(input.name),
			input.kind,
			input.parentId ?? null,
			callId,
		);
		return { row: categoryByCallId(db, callId) as CategoryRow, created: true };
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------------------------

export type TxnSource = "chat" | "csv" | "receipt";

/** One entry with the names of its account and category joined in. `amountMinor` is signed: out is negative. */
export type TxnView = {
	seq: number;
	id: string;
	accountId: number;
	account: string;
	date: string;
	amountMinor: number;
	currency: string;
	categoryId?: number;
	category?: string;
	merchant: string;
	merchantKey: string;
	note: string;
	source: TxnSource;
	sourceRef?: string;
	transferId?: string;
	createdAt: number;
};

type TxnRecord = {
	seq: number;
	id: string;
	account_id: number;
	account_name: string;
	occurred_on: string;
	amount_minor: number;
	currency: string;
	category_id: number | null;
	category_name: string | null;
	merchant: string;
	merchant_key: string;
	note: string;
	source: TxnSource;
	source_ref: string | null;
	transfer_id: string | null;
	created_at: number;
};

const TXN_FROM = `FROM ledger_txn t
	JOIN ledger_account a ON a.id = t.account_id
	LEFT JOIN ledger_category c ON c.id = t.category_id`;

const TXN_COLUMNS = `t.seq, t.id, t.account_id, a.name AS account_name, t.occurred_on, t.amount_minor, t.currency, t.category_id,
	c.name AS category_name, t.merchant, t.merchant_key, t.note, t.source, t.source_ref, t.transfer_id, t.created_at`;

const txnOf = (record: TxnRecord): TxnView => ({
	seq: record.seq,
	id: record.id,
	accountId: record.account_id,
	account: record.account_name,
	date: record.occurred_on,
	amountMinor: record.amount_minor,
	currency: record.currency,
	merchant: record.merchant,
	merchantKey: record.merchant_key,
	note: record.note,
	source: record.source,
	createdAt: record.created_at,
	...(record.category_id === null ? {} : { categoryId: record.category_id }),
	...(record.category_name === null ? {} : { category: record.category_name }),
	...(record.source_ref === null ? {} : { sourceRef: record.source_ref }),
	...(record.transfer_id === null ? {} : { transferId: record.transfer_id }),
});

/** Short enough for a model to copy back correctly, long enough that a personal ledger never collides (retried on conflict). */
export const newTxnId = (): string => `x_${randomBytes(4).toString("hex")}`;
const newTransferId = (): string => `tr_${randomBytes(4).toString("hex")}`;

export { newTransferId };

export type NewTxn = {
	accountId: number;
	date: string;
	amountMinor: number;
	currency: string;
	categoryId?: number;
	merchant: string;
	note: string;
	source: TxnSource;
	sourceRef?: string;
	transferId?: string;
	/** Rule 8: unique per row. The tool call's id, with a suffix when one call writes several rows. */
	sourceCallId: string;
	/** A CSV row's fingerprint: a second row with the same one is a duplicate and is not written. */
	importHash?: string;
	now: number;
};

export type InsertOutcome = { status: "created" | "replay"; id: string } | { status: "duplicate" };

/**
 * Write one entry. A row with this `sourceCallId` is the tool call's own earlier insert (`replay`: nothing was written);
 * a row with this `importHash` is an entry an earlier import already made (`duplicate`).
 */
export function insertTxn(db: AppDb, input: NewTxn): InsertOutcome {
	return db.transaction(() => {
		for (let attempt = 0; attempt < 5; attempt++) {
			const id = newTxnId();
			const result = db.run(
				`INSERT INTO ledger_txn (id, account_id, occurred_on, amount_minor, currency, category_id, merchant, merchant_key, note,
				                         source, source_ref, transfer_id, source_call_id, import_hash, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT DO NOTHING`,
				id,
				input.accountId,
				input.date,
				input.amountMinor,
				input.currency,
				input.categoryId ?? null,
				input.merchant,
				merchantKey(input.merchant),
				input.note,
				input.source,
				input.sourceRef ?? null,
				input.transferId ?? null,
				input.sourceCallId,
				input.importHash ?? null,
				input.now,
			);
			if (result.changes > 0) return { status: "created", id };
			const earlier = db.get<{ id: string }>("SELECT id FROM ledger_txn WHERE source_call_id = ?", input.sourceCallId);
			if (earlier !== undefined) return { status: "replay", id: earlier.id };
			if (input.importHash !== undefined) {
				const known = db.get<{ one: number }>(
					"SELECT 1 AS one FROM ledger_txn WHERE import_hash = ?",
					input.importHash,
				);
				if (known !== undefined) return { status: "duplicate" };
			}
		}
		throw new Error("Could not find a free entry id after 5 tries. This should be impossible; check ledger_txn.");
	});
}

export function getTxn(db: AppDb, id: string): TxnView | undefined {
	const record = db.get<TxnRecord>(`SELECT ${TXN_COLUMNS} ${TXN_FROM} WHERE t.id = ?`, id);
	return record === undefined ? undefined : txnOf(record);
}

/** The entry that tool call `callId` wrote (for a transfer: the outgoing leg). */
export function txnByCallId(db: AppDb, callId: string): TxnView | undefined {
	const record = db.get<TxnRecord>(`SELECT ${TXN_COLUMNS} ${TXN_FROM} WHERE t.source_call_id = ?`, callId);
	return record === undefined ? undefined : txnOf(record);
}

/** The first entry that was recorded from this receipt or bill (a file id), if any. */
export function txnByReceipt(db: AppDb, fileId: string): TxnView | undefined {
	const record = db.get<TxnRecord>(
		`SELECT ${TXN_COLUMNS} ${TXN_FROM} WHERE t.source = 'receipt' AND t.source_ref = ? ORDER BY t.seq LIMIT 1`,
		fileId,
	);
	return record === undefined ? undefined : txnOf(record);
}

/** Both legs of a transfer, the outgoing one first. */
export function transferLegs(db: AppDb, transferId: string): TxnView[] {
	return db
		.all<TxnRecord>(
			`SELECT ${TXN_COLUMNS} ${TXN_FROM} WHERE t.transfer_id = ? ORDER BY t.amount_minor, t.seq`,
			transferId,
		)
		.map(txnOf);
}

export type TxnFilter = {
	/** First and last day, both included. */
	from?: string;
	to?: string;
	accountId?: number;
	categoryId?: number;
	uncategorized?: boolean;
	/** Words of the merchant's name (the merchant key contains them all, as part of a word too: "tea" is found in "steak"). */
	merchant?: string;
	/** The merchant's key equal to this name's: the same merchant, whatever the case, accents, punctuation or order number. */
	merchantExact?: string;
	/** Every one of these words is a whole word of the merchant's key: "tea" finds "Tea stall" and not "Steak House". */
	merchantWords?: string;
	/** Words of the merchant or the note. */
	text?: string;
	/** `expense`: out, not a transfer. `income`: in, not a transfer. `transfer`: either leg. Default: everything. */
	kind?: "expense" | "income" | "transfer" | "all";
	/** On the size of the amount, in minor units, whichever way it went. */
	minMinor?: number;
	maxMinor?: number;
	currency?: string;
	ids?: readonly string[];
	/** Entries written by a tool call made in this window (epoch ms): "added today". */
	createdFrom?: number;
	createdTo?: number;
};

function where(filter: TxnFilter): { sql: string; params: SqlParam[] } {
	const clauses: string[] = [];
	const params: SqlParam[] = [];
	const add = (clause: string, ...values: SqlParam[]): void => {
		clauses.push(clause);
		params.push(...values);
	};
	if (filter.from !== undefined) add("t.occurred_on >= ?", filter.from);
	if (filter.to !== undefined) add("t.occurred_on <= ?", filter.to);
	if (filter.accountId !== undefined) add("t.account_id = ?", filter.accountId);
	if (filter.categoryId !== undefined) add("t.category_id = ?", filter.categoryId);
	if (filter.uncategorized === true) add("t.category_id IS NULL AND t.transfer_id IS NULL");
	if (filter.currency !== undefined) add("t.currency = ?", filter.currency);
	if (filter.minMinor !== undefined) add("ABS(t.amount_minor) >= ?", filter.minMinor);
	if (filter.maxMinor !== undefined) add("ABS(t.amount_minor) <= ?", filter.maxMinor);
	if (filter.createdFrom !== undefined) add("t.created_at >= ?", filter.createdFrom);
	if (filter.createdTo !== undefined) add("t.created_at < ?", filter.createdTo);
	for (const word of nameKey(filter.merchant ?? "")
		.split(" ")
		.filter((part) => part !== "")) {
		add("t.merchant_key LIKE ?", `%${word}%`);
	}
	if (filter.merchantExact !== undefined) add("t.merchant_key = ?", merchantKey(filter.merchantExact));
	// A key holds letters, digits and single spaces only, so the words need no escaping for LIKE.
	for (const word of nameKey(filter.merchantWords ?? "")
		.split(" ")
		.filter((part) => part !== "")) {
		add("(' ' || t.merchant_key || ' ') LIKE ?", `% ${word} %`);
	}
	for (const word of nameKey(filter.text ?? "")
		.split(" ")
		.filter((part) => part !== "")) {
		add("(t.merchant_key LIKE ? OR lower(t.note) LIKE ?)", `%${word}%`, `%${word}%`);
	}
	if (filter.ids !== undefined) {
		if (filter.ids.length === 0) add("0");
		else add(`t.id IN (${filter.ids.map(() => "?").join(", ")})`, ...filter.ids);
	}
	switch (filter.kind) {
		case "expense":
			add("t.transfer_id IS NULL AND t.amount_minor < 0");
			break;
		case "income":
			add("t.transfer_id IS NULL AND t.amount_minor > 0");
			break;
		case "transfer":
			add("t.transfer_id IS NOT NULL");
			break;
		default:
			break;
	}
	return { sql: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

export type TxnPage = { rows: TxnView[]; total: number };

/** The entries a filter picks, newest day first (or oldest), one page of them, and how many there are in all. */
export function queryTxns(
	db: AppDb,
	filter: TxnFilter,
	page: { limit: number; offset?: number; order?: "newest" | "oldest" } = { limit: 50 },
): TxnPage {
	const { sql, params } = where(filter);
	const direction = page.order === "oldest" ? "ASC" : "DESC";
	const rows = db
		.all<TxnRecord>(
			`SELECT ${TXN_COLUMNS} ${TXN_FROM} ${sql} ORDER BY t.occurred_on ${direction}, t.seq ${direction} LIMIT ? OFFSET ?`,
			...params,
			page.limit,
			page.offset ?? 0,
		)
		.map(txnOf);
	const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n ${TXN_FROM} ${sql}`, ...params)?.n ?? 0;
	return { rows, total };
}

/** The most entries one analysis reads at once: a personal ledger holds thousands, not millions. */
export const MAX_ANALYSED_ROWS = 200_000;

/** Every entry a filter picks, oldest first, for the summaries that group them in code. */
export function allTxns(db: AppDb, filter: TxnFilter): TxnView[] {
	const { sql, params } = where(filter);
	return db
		.all<TxnRecord>(
			`SELECT ${TXN_COLUMNS} ${TXN_FROM} ${sql} ORDER BY t.occurred_on, t.seq LIMIT ${MAX_ANALYSED_ROWS}`,
			...params,
		)
		.map(txnOf);
}

/**
 * What a filter's entries add up to, per currency: money out and money in, as positive numbers. A transfer between the
 * owner's own accounts is neither (both legs would be counted, and nothing was spent or earned): {@link movedOf} has them.
 */
export function sumsOf(db: AppDb, filter: TxnFilter): Array<{ currency: string; outMinor: number; inMinor: number }> {
	const { sql, params } = where(filter);
	return db
		.all<{ currency: string; out_minor: number; in_minor: number }>(
			`SELECT t.currency AS currency,
			        COALESCE(SUM(CASE WHEN t.amount_minor < 0 THEN -t.amount_minor ELSE 0 END), 0) AS out_minor,
			        COALESCE(SUM(CASE WHEN t.amount_minor > 0 THEN t.amount_minor ELSE 0 END), 0) AS in_minor
			 ${TXN_FROM} ${sql === "" ? "WHERE" : `${sql} AND`} t.transfer_id IS NULL GROUP BY t.currency ORDER BY t.currency`,
			...params,
		)
		.map((row) => ({ currency: row.currency, outMinor: row.out_minor, inMinor: row.in_minor }));
}

/** What a filter's transfers moved between accounts, per currency (the outgoing legs). */
export function movedOf(db: AppDb, filter: TxnFilter): Array<{ currency: string; movedMinor: number }> {
	const { sql, params } = where(filter);
	return db
		.all<{ currency: string; moved_minor: number }>(
			`SELECT t.currency AS currency, COALESCE(SUM(-t.amount_minor), 0) AS moved_minor
			 ${TXN_FROM} ${sql === "" ? "WHERE" : `${sql} AND`} t.transfer_id IS NOT NULL AND t.amount_minor < 0
			 GROUP BY t.currency ORDER BY t.currency`,
			...params,
		)
		.map((row) => ({ currency: row.currency, movedMinor: row.moved_minor }));
}

/** The category an owner usually gives a merchant (the most used), so that a new entry or an import need not be told again. */
export function categoryForMerchant(db: AppDb, key: string): number | undefined {
	if (key === "") return undefined;
	return db.get<{ category_id: number }>(
		`SELECT category_id FROM ledger_txn WHERE merchant_key = ? AND category_id IS NOT NULL AND transfer_id IS NULL
		 GROUP BY category_id ORDER BY COUNT(*) DESC, MAX(seq) DESC LIMIT 1`,
		key,
	)?.category_id;
}

/** Entries on the same day with the same amount, account and merchant as one about to be written: probably the same purchase. */
export function similarTxn(
	db: AppDb,
	input: { accountId: number; date: string; amountMinor: number; merchant: string },
): string | undefined {
	return db.get<{ id: string }>(
		"SELECT id FROM ledger_txn WHERE account_id = ? AND occurred_on = ? AND amount_minor = ? AND merchant_key = ? ORDER BY seq LIMIT 1",
		input.accountId,
		input.date,
		input.amountMinor,
		merchantKey(input.merchant),
	)?.id;
}

/** Delete an entry, and the other leg when it is half of a transfer. Idempotent: returns the entries that were deleted. */
export function deleteTxn(db: AppDb, id: string): TxnView[] {
	return db.transaction(() => {
		const row = getTxn(db, id);
		if (row === undefined) return [];
		const rows = row.transferId === undefined ? [row] : transferLegs(db, row.transferId);
		for (const leg of rows) db.run("DELETE FROM ledger_txn WHERE id = ?", leg.id);
		return rows;
	});
}

export const newBatchId = (): string => `rc_${randomBytes(4).toString("hex")}`;

/** A bulk change of category that can be taken back: what was asked, and how many entries moved. */
export type RecategorizeBatch = {
	id: string;
	categoryId: number;
	categoryName: string;
	what: string;
	changed: number;
	createdAt: number;
	undoneAt?: number;
};

type BatchRecord = {
	id: string;
	category_id: number;
	category_name: string;
	what: string;
	changed: number;
	created_at: number;
	undone_at: number | null;
};

const BATCH_SELECT = `SELECT b.id, b.category_id, c.name AS category_name, b.what, b.changed, b.created_at, b.undone_at
	FROM ledger_recategorization b JOIN ledger_category c ON c.id = b.category_id`;

const batchOf = (record: BatchRecord): RecategorizeBatch => ({
	id: record.id,
	categoryId: record.category_id,
	categoryName: record.category_name,
	what: record.what,
	changed: record.changed,
	createdAt: record.created_at,
	...(record.undone_at === null ? {} : { undoneAt: record.undone_at }),
});

export function getBatch(db: AppDb, id: string): RecategorizeBatch | undefined {
	const record = db.get<BatchRecord>(`${BATCH_SELECT} WHERE b.id = ?`, id);
	return record === undefined ? undefined : batchOf(record);
}

export function batchByCallId(db: AppDb, callId: string): RecategorizeBatch | undefined {
	const record = db.get<BatchRecord>(`${BATCH_SELECT} WHERE b.source_call_id = ?`, callId);
	return record === undefined ? undefined : batchOf(record);
}

/** What a batch moved, by merchant and by the category the entries came from: the words of the answer. */
export function batchMoves(
	db: AppDb,
	batchId: string,
): Array<{ merchant: string; from: string | undefined; count: number }> {
	return db
		.all<{ merchant: string; from_name: string | null; n: number }>(
			`SELECT MIN(t.merchant) AS merchant, old.name AS from_name, COUNT(*) AS n
			 FROM ledger_recategorization_row r
			 JOIN ledger_txn t ON t.id = r.txn_id
			 LEFT JOIN ledger_category old ON old.id = r.previous_category_id
			 WHERE r.batch_id = ?
			 GROUP BY t.merchant_key, r.previous_category_id
			 ORDER BY n DESC, merchant`,
			batchId,
		)
		.map((row) => ({ merchant: row.merchant, from: row.from_name ?? undefined, count: row.n }));
}

/**
 * Give entries a category and keep each one's earlier category, as one batch that {@link undoRecategorization} can take back
 * (rule 8: the call is in the ledger in the same transaction, so a replay changes nothing and does not undo a later change).
 * Transfers are never categorised, and an entry that already has the category is left out. Returns the batch, or undefined
 * when nothing needed to change; `applied` is false for a replay.
 */
export function recategorize(
	db: AppDb,
	input: { ids: readonly string[]; category: { id: number; name: string }; what: string; callId: string; now: number },
): { applied: boolean; batch?: RecategorizeBatch } {
	return db.transaction(() => {
		const recorded = findCall(db, input.callId);
		if (recorded !== undefined) {
			const batch = recorded.subject.startsWith("batch:") ? getBatch(db, recorded.subject.slice(6)) : undefined;
			return { applied: false, ...(batch === undefined ? {} : { batch }) };
		}
		const moved: Array<{ id: string; previous: number | null }> = [];
		for (const id of input.ids) {
			const row = db.get<{ category_id: number | null }>(
				"SELECT category_id FROM ledger_txn WHERE id = ? AND transfer_id IS NULL AND category_id IS NOT ?",
				id,
				input.category.id,
			);
			if (row === undefined) continue;
			db.run("UPDATE ledger_txn SET category_id = ? WHERE id = ?", input.category.id, id);
			moved.push({ id, previous: row.category_id });
		}
		if (moved.length === 0) {
			recordCall(db, input.callId, "recategorize", `none:${input.category.name}`, input.now);
			return { applied: true };
		}
		const id = newBatchId();
		db.run(
			"INSERT INTO ledger_recategorization (id, source_call_id, category_id, what, changed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			id,
			input.callId,
			input.category.id,
			input.what,
			moved.length,
			input.now,
		);
		for (const entry of moved) {
			db.run(
				"INSERT INTO ledger_recategorization_row (batch_id, txn_id, previous_category_id) VALUES (?, ?, ?)",
				id,
				entry.id,
				entry.previous,
			);
		}
		recordCall(db, input.callId, "recategorize", `batch:${id}`, input.now);
		return { applied: true, batch: getBatch(db, id) as RecategorizeBatch };
	});
}

/**
 * Put back what a batch changed: each entry still in the category the batch gave it goes back to the one it had; an entry
 * that someone changed again since, or deleted, is left alone and counted. A batch is undone once.
 */
export function undoRecategorization(
	db: AppDb,
	batchId: string,
	now: number,
): { restored: number; changedSince: number; gone: number } {
	return db.transaction(() => {
		const batch = getBatch(db, batchId) as RecategorizeBatch;
		let restored = 0;
		let changedSince = 0;
		let gone = 0;
		const rows = db.all<{ txn_id: string; previous_category_id: number | null }>(
			"SELECT txn_id, previous_category_id FROM ledger_recategorization_row WHERE batch_id = ?",
			batchId,
		);
		for (const row of rows) {
			const current = db.get<{ category_id: number | null }>(
				"SELECT category_id FROM ledger_txn WHERE id = ?",
				row.txn_id,
			);
			if (current === undefined) gone++;
			else if (current.category_id !== batch.categoryId) changedSince++;
			else {
				db.run("UPDATE ledger_txn SET category_id = ? WHERE id = ?", row.previous_category_id, row.txn_id);
				restored++;
			}
		}
		db.run("UPDATE ledger_recategorization SET undone_at = ? WHERE id = ?", now, batchId);
		return { restored, changedSince, gone };
	});
}

/** What a call ledger entry recorded, if the call is in it. */
export function findCall(db: AppDb, callId: string): { tool: string; subject: string } | undefined {
	return db.get<{ tool: string; subject: string }>(
		"SELECT tool, subject FROM ledger_call WHERE source_call_id = ?",
		callId,
	);
}

/** First write wins: false when this call id was already recorded. */
export function recordCall(db: AppDb, callId: string, tool: string, subject: string, now: number): boolean {
	return (
		db.run(
			"INSERT INTO ledger_call (source_call_id, tool, subject, applied_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
			callId,
			tool,
			subject,
			now,
		).changes > 0
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------------------------------------------------

export type SnapshotRow = {
	id: number;
	accountId: number;
	asOf: string;
	amountMinor: number;
	watermark: number;
	note: string;
	createdAt: number;
};

type SnapshotRecord = {
	id: number;
	account_id: number;
	as_of: string;
	amount_minor: number;
	txn_watermark: number;
	note: string;
	created_at: number;
};

const SNAPSHOT_COLUMNS = "id, account_id, as_of, amount_minor, txn_watermark, note, created_at";

const snapshotOf = (record: SnapshotRecord): SnapshotRow => ({
	id: record.id,
	accountId: record.account_id,
	asOf: record.as_of,
	amountMinor: record.amount_minor,
	watermark: record.txn_watermark,
	note: record.note,
	createdAt: record.created_at,
});

export function snapshotByCallId(db: AppDb, callId: string): SnapshotRow | undefined {
	const record = db.get<SnapshotRecord>(
		`SELECT ${SNAPSHOT_COLUMNS} FROM ledger_balance_snapshot WHERE source_call_id = ?`,
		callId,
	);
	return record === undefined ? undefined : snapshotOf(record);
}

/** Record what an account held on a day, for tool call `callId`, once (a replay finds the first insert). */
export function insertSnapshot(
	db: AppDb,
	input: { accountId: number; asOf: string; amountMinor: number; note: string; now: number },
	callId: string,
): { row: SnapshotRow; created: boolean } {
	return db.transaction(() => {
		const earlier = snapshotByCallId(db, callId);
		if (earlier !== undefined) return { row: earlier, created: false };
		const watermark = db.get<{ top: number }>("SELECT COALESCE(MAX(seq), 0) AS top FROM ledger_txn")?.top ?? 0;
		db.run(
			`INSERT INTO ledger_balance_snapshot (account_id, as_of, amount_minor, txn_watermark, note, source_call_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			input.accountId,
			input.asOf,
			input.amountMinor,
			watermark,
			input.note,
			callId,
			input.now,
		);
		return { row: snapshotByCallId(db, callId) as SnapshotRow, created: true };
	});
}

/** The newest snapshot of an account: the latest day, and of one day the one recorded last. `upTo` ignores later days. */
export function latestSnapshot(db: AppDb, accountId: number, upTo?: string): SnapshotRow | undefined {
	const record = db.get<SnapshotRecord>(
		`SELECT ${SNAPSHOT_COLUMNS} FROM ledger_balance_snapshot
		 WHERE account_id = ? ${upTo === undefined ? "" : "AND as_of <= ?"}
		 ORDER BY as_of DESC, id DESC LIMIT 1`,
		accountId,
		...(upTo === undefined ? [] : [upTo]),
	);
	return record === undefined ? undefined : snapshotOf(record);
}

export type Balance = {
	amountMinor: number;
	/** The snapshot the balance starts from; undefined when the owner never stated one (the balance is then the entries alone). */
	snapshot?: SnapshotRow;
	/** Entries that count on top of the snapshot (all of them, without one). */
	entriesSince: number;
};

/**
 * What an account holds: the latest snapshot plus the entries since. An entry is "since" when its day is after the
 * snapshot's, or it is of that very day and was written after the snapshot was (a higher `seq` than the one the snapshot
 * saw): "I have Nu. 15,000" and then "lunch 500" is 14,500, and "lunch 500" then "I have 14,500" is 14,500 too. An entry
 * dated before the snapshot is in it already, even if it was written later. `upTo` answers for the end of that day.
 */
export function accountBalance(db: AppDb, accountId: number, upTo?: string): Balance {
	const snapshot = latestSnapshot(db, accountId, upTo);
	const clauses = ["account_id = ?"];
	const params: SqlParam[] = [accountId];
	if (upTo !== undefined) {
		clauses.push("occurred_on <= ?");
		params.push(upTo);
	}
	if (snapshot !== undefined) {
		clauses.push("(occurred_on > ? OR (occurred_on = ? AND seq > ?))");
		params.push(snapshot.asOf, snapshot.asOf, snapshot.watermark);
	}
	const sum = db.get<{ total: number; n: number }>(
		`SELECT COALESCE(SUM(amount_minor), 0) AS total, COUNT(*) AS n FROM ledger_txn WHERE ${clauses.join(" AND ")}`,
		...params,
	);
	return {
		amountMinor: (snapshot?.amountMinor ?? 0) + (sum?.total ?? 0),
		...(snapshot === undefined ? {} : { snapshot }),
		entriesSince: sum?.n ?? 0,
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Exchange rates the owner gave
// ---------------------------------------------------------------------------------------------------------------------

export type FxRate = { date: string; from: string; to: string; rateMicro: number };

export function fxByCallId(db: AppDb, callId: string): FxRate | undefined {
	const record = db.get<{ date: string; from_currency: string; to_currency: string; rate_micro: number }>(
		"SELECT date, from_currency, to_currency, rate_micro FROM ledger_fx WHERE source_call_id = ?",
		callId,
	);
	return record === undefined
		? undefined
		: { date: record.date, from: record.from_currency, to: record.to_currency, rateMicro: record.rate_micro };
}

/** Save a rate for tool call `callId`, once. A later rate for the same pair and day replaces an earlier one when it is read. */
export function insertFx(
	db: AppDb,
	input: FxRate & { now: number },
	callId: string,
): { row: FxRate; created: boolean } {
	return db.transaction(() => {
		const earlier = fxByCallId(db, callId);
		if (earlier !== undefined) return { row: earlier, created: false };
		db.run(
			"INSERT INTO ledger_fx (date, from_currency, to_currency, rate_micro, source_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			input.date,
			input.from,
			input.to,
			input.rateMicro,
			callId,
			input.now,
		);
		return { row: fxByCallId(db, callId) as FxRate, created: true };
	});
}

/**
 * The rate to turn `from` into `to` on a day: the newest rate the owner gave dated on or before it, or (when there is none
 * that old) the oldest one after it; the pair stored the other way round counts too, as `inverse`. Undefined when the owner
 * never gave one: nothing is fetched or guessed.
 */
export function findRate(
	db: AppDb,
	from: string,
	to: string,
	date: string,
): { rateMicro: number; inverse: boolean; date: string } | undefined {
	const one = (a: string, b: string): { rate_micro: number; date: string } | undefined =>
		db.get<{ rate_micro: number; date: string }>(
			`SELECT rate_micro, date FROM ledger_fx WHERE from_currency = ? AND to_currency = ?
			 ORDER BY (date <= ?) DESC, CASE WHEN date <= ? THEN date END DESC, CASE WHEN date > ? THEN date END ASC, id DESC LIMIT 1`,
			a,
			b,
			date,
			date,
			date,
		);
	const direct = one(from, to);
	const inverse = one(to, from);
	// Both exist: the one nearer the day wins; the direct rate on a tie.
	const distance = (found: { date: string } | undefined): number =>
		found === undefined
			? Number.POSITIVE_INFINITY
			: Math.abs(Date.parse(`${found.date}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`));
	if (direct !== undefined && distance(direct) <= distance(inverse)) {
		return { rateMicro: direct.rate_micro, inverse: false, date: direct.date };
	}
	return inverse === undefined ? undefined : { rateMicro: inverse.rate_micro, inverse: true, date: inverse.date };
}

// ---------------------------------------------------------------------------------------------------------------------
// CSV imports
// ---------------------------------------------------------------------------------------------------------------------

export type ImportRecord = {
	id: string;
	fileId: string;
	fileName: string;
	accountId: number;
	status: "preview" | "imported";
	summaryJson: string;
	rowsJson: string;
	inserted?: number;
	duplicates?: number;
	/** Rows left out because they probably repeat an entry typed in chat or read from a receipt. */
	skippedMatches?: number;
	/** The `confirm_import` call that wrote the entries: a replay of that call is not "already imported". */
	confirmedCallId?: string;
	/** When the owner had the import's entries removed again (`undo_import`): its rows are gone and it cannot be confirmed. */
	undoneAt?: number;
	createdAt: number;
};

type ImportDbRow = {
	id: string;
	file_id: string;
	file_name: string;
	account_id: number;
	status: "preview" | "imported";
	summary_json: string;
	rows_json: string;
	inserted: number | null;
	duplicates: number | null;
	skipped_matches: number | null;
	confirmed_call_id: string | null;
	undone_at: number | null;
	created_at: number;
};

const importOf = (record: ImportDbRow): ImportRecord => ({
	id: record.id,
	fileId: record.file_id,
	fileName: record.file_name,
	accountId: record.account_id,
	status: record.status,
	summaryJson: record.summary_json,
	rowsJson: record.rows_json,
	createdAt: record.created_at,
	...(record.inserted === null ? {} : { inserted: record.inserted }),
	...(record.duplicates === null ? {} : { duplicates: record.duplicates }),
	...(record.skipped_matches === null ? {} : { skippedMatches: record.skipped_matches }),
	...(record.confirmed_call_id === null ? {} : { confirmedCallId: record.confirmed_call_id }),
	...(record.undone_at === null ? {} : { undoneAt: record.undone_at }),
});

const IMPORT_COLUMNS =
	"id, file_id, file_name, account_id, status, summary_json, rows_json, inserted, duplicates, skipped_matches, confirmed_call_id, undone_at, created_at";

export const newImportId = (): string => `im_${randomBytes(4).toString("hex")}`;

export function getImport(db: AppDb, id: string): ImportRecord | undefined {
	const record = db.get<ImportDbRow>(`SELECT ${IMPORT_COLUMNS} FROM ledger_import WHERE id = ?`, id);
	return record === undefined ? undefined : importOf(record);
}

export function importByCallId(db: AppDb, callId: string): ImportRecord | undefined {
	const record = db.get<ImportDbRow>(`SELECT ${IMPORT_COLUMNS} FROM ledger_import WHERE source_call_id = ?`, callId);
	return record === undefined ? undefined : importOf(record);
}

/** Keep what `import_csv` read, for tool call `callId`, once: a replay finds this import and makes no second one. */
export function insertImport(
	db: AppDb,
	input: {
		fileId: string;
		fileName: string;
		accountId: number;
		/** The preview card as JSON, made once the import's id is known: it holds it. */
		summaryJson: (id: string) => string;
		rowsJson: string;
		now: number;
	},
	callId: string,
): ImportRecord {
	return db.transaction(() => {
		const earlier = importByCallId(db, callId);
		if (earlier !== undefined) return earlier;
		for (let attempt = 0; attempt < 5; attempt++) {
			const id = newImportId();
			const result = db.run(
				`INSERT INTO ledger_import (id, file_id, file_name, account_id, status, summary_json, rows_json, source_call_id, created_at)
				 VALUES (?, ?, ?, ?, 'preview', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
				id,
				input.fileId,
				input.fileName,
				input.accountId,
				input.summaryJson(id),
				input.rowsJson,
				callId,
				input.now,
			);
			if (result.changes > 0) return getImport(db, id) as ImportRecord;
		}
		throw new Error("Could not find a free import id after 5 tries. This should be impossible; check ledger_import.");
	});
}

/** Which of these fingerprints an earlier import already wrote. */
export function existingHashes(db: AppDb, hashes: readonly string[]): Set<string> {
	const known = new Set<string>();
	for (let start = 0; start < hashes.length; start += 400) {
		const chunk = hashes.slice(start, start + 400);
		const rows = db.all<{ import_hash: string }>(
			`SELECT import_hash FROM ledger_txn WHERE import_hash IN (${chunk.map(() => "?").join(", ")})`,
			...chunk,
		);
		for (const row of rows) known.add(row.import_hash);
	}
	return known;
}

/** Mark an import done, once, in the caller's transaction. The rows are no longer needed: the entries hold them. */
export function markImported(
	db: AppDb,
	id: string,
	result: { inserted: number; duplicates: number; skippedMatches: number },
	callId: string,
	now: number,
): void {
	db.run(
		"UPDATE ledger_import SET status = 'imported', inserted = ?, duplicates = ?, skipped_matches = ?, rows_json = '[]', confirmed_call_id = ?, imported_at = ? WHERE id = ?",
		result.inserted,
		result.duplicates,
		result.skippedMatches,
		callId,
		now,
		id,
	);
}

/** The entries an import wrote (newest import rows last), for a total or for taking them back. */
export function importedEntries(db: AppDb, importId: string): TxnView[] {
	return db
		.all<TxnRecord>(
			`SELECT ${TXN_COLUMNS} ${TXN_FROM} WHERE t.source = 'csv' AND t.source_ref = ? ORDER BY t.occurred_on, t.seq`,
			importId,
		)
		.map(txnOf);
}

/**
 * Take an import back: delete the entries it wrote and mark it undone, in one transaction. Idempotent: an import that is
 * already undone removes nothing (`removed` 0). Entries are found by the import's id, so nothing else is touched.
 */
export function undoImport(db: AppDb, importId: string, now: number): { removed: number } {
	return db.transaction(() => {
		const removed = db.run("DELETE FROM ledger_txn WHERE source = 'csv' AND source_ref = ?", importId).changes;
		db.run("UPDATE ledger_import SET undone_at = ? WHERE id = ? AND undone_at IS NULL", now, importId);
		return { removed };
	});
}

/** An entry typed in chat or read from a receipt that a statement row may repeat. */
export type ManualEntry = {
	id: string;
	seq: number;
	date: string;
	amountMinor: number;
	merchant: string;
	source: TxnSource;
};

/**
 * The entries of an account that did not come from a CSV, dated within the days of a statement (padded by `slackDays` on both
 * sides): what its rows may be the bank's own record of.
 */
export function manualEntriesBetween(
	db: AppDb,
	accountId: number,
	from: string,
	to: string,
	slackDays: number,
): ManualEntry[] {
	return db
		.all<{ id: string; seq: number; occurred_on: string; amount_minor: number; merchant: string; source: TxnSource }>(
			`SELECT id, seq, occurred_on, amount_minor, merchant, source FROM ledger_txn
			 WHERE account_id = ? AND source != 'csv' AND occurred_on BETWEEN date(?, ?) AND date(?, ?)
			 ORDER BY seq`,
			accountId,
			from,
			`-${slackDays} days`,
			to,
			`+${slackDays} days`,
		)
		.map((row) => ({
			id: row.id,
			seq: row.seq,
			date: row.occurred_on,
			amountMinor: row.amount_minor,
			merchant: row.merchant,
			source: row.source,
		}));
}
