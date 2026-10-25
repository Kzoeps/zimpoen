import { randomBytes } from "node:crypto";
import type { AppDb } from "@assistant/db";
import { type Entry, netEntries } from "./compute.ts";

/** The key of the owner in every table of this module; the thread shows it as "You". */
export const OWNER_KEY = "me";
export const OWNER_NAME = "You";

export const newBillId = (): string => `b_${randomBytes(4).toString("hex")}`;
export const newSettlementId = (): string => `s_${randomBytes(4).toString("hex")}`;

// ---------------------------------------------------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------------------------------------------------

export type BillRow = {
	id: string;
	title: string;
	date: string;
	payerKey: string;
	payerName: string;
	totalMinor: number;
	currency: string;
	equal: boolean;
	extras: Array<{ label: string; amountMinor: number }>;
	sourceRef?: string;
	note: string;
	createdAt: number;
};

export type ItemRow = { description: string; amountMinor: number; sharedBy: string[] };

export type ShareRow = {
	personKey: string;
	personName: string;
	personId?: string;
	itemsMinor: number;
	extrasMinor: number;
	owedMinor: number;
};

export type BillView = BillRow & { items: ItemRow[]; shares: ShareRow[] };

type BillRecord = {
	id: string;
	title: string;
	occurred_on: string;
	payer_key: string;
	payer_name: string;
	total_minor: number;
	currency: string;
	equal: number;
	extras_json: string;
	source_ref: string | null;
	note: string;
	created_at: number;
};

const BILL_COLUMNS =
	"id, title, occurred_on, payer_key, payer_name, total_minor, currency, equal, extras_json, source_ref, note, created_at";

const billOf = (record: BillRecord): BillRow => ({
	id: record.id,
	title: record.title,
	date: record.occurred_on,
	payerKey: record.payer_key,
	payerName: record.payer_name,
	totalMinor: record.total_minor,
	currency: record.currency,
	equal: record.equal === 1,
	extras: (JSON.parse(record.extras_json) as Array<{ label: string; amount_minor: number }>).map((extra) => ({
		label: extra.label,
		amountMinor: extra.amount_minor,
	})),
	...(record.source_ref === null ? {} : { sourceRef: record.source_ref }),
	note: record.note,
	createdAt: record.created_at,
});

export type NewBill = {
	title: string;
	date: string;
	payerKey: string;
	payerName: string;
	totalMinor: number;
	currency: string;
	equal: boolean;
	extras: Array<{ label: string; amountMinor: number }>;
	sourceRef?: string;
	note: string;
	items: ItemRow[];
	shares: ShareRow[];
	now: number;
};

function viewOf(db: AppDb, row: BillRow): BillView {
	const items = db
		.all<{ description: string; amount_minor: number; shared_by_json: string }>(
			"SELECT description, amount_minor, shared_by_json FROM splits_item WHERE bill_id = ? ORDER BY id",
			row.id,
		)
		.map((item) => ({
			description: item.description,
			amountMinor: item.amount_minor,
			sharedBy: JSON.parse(item.shared_by_json) as string[],
		}));
	// Shares in the order they were written, which is the order the people were given.
	const shares = db
		.all<{
			person_key: string;
			person_name: string;
			person_id: string | null;
			items_minor: number;
			extras_minor: number;
			owed_minor: number;
		}>(
			"SELECT person_key, person_name, person_id, items_minor, extras_minor, owed_minor FROM splits_share WHERE bill_id = ? ORDER BY rowid",
			row.id,
		)
		.map((share) => ({
			personKey: share.person_key,
			personName: share.person_name,
			...(share.person_id === null ? {} : { personId: share.person_id }),
			itemsMinor: share.items_minor,
			extrasMinor: share.extras_minor,
			owedMinor: share.owed_minor,
		}));
	return { ...row, items, shares };
}

export function getBill(db: AppDb, id: string): BillView | undefined {
	const record = db.get<BillRecord>(`SELECT ${BILL_COLUMNS} FROM splits_bill WHERE id = ?`, id);
	return record === undefined ? undefined : viewOf(db, billOf(record));
}

export function billByCallId(db: AppDb, callId: string): BillView | undefined {
	const record = db.get<BillRecord>(`SELECT ${BILL_COLUMNS} FROM splits_bill WHERE source_call_id = ?`, callId);
	return record === undefined ? undefined : viewOf(db, billOf(record));
}

/**
 * Write a whole bill (the bill, its items and every share) in one transaction, for tool call `callId`; a call that was
 * written already returns what it wrote (rule 8).
 */
export function insertBill(db: AppDb, input: NewBill, callId: string): { bill: BillView; created: boolean } {
	return db.transaction(() => {
		const earlier = billByCallId(db, callId);
		if (earlier !== undefined) return { bill: earlier, created: false };
		const id = newBillId();
		db.run(
			`INSERT INTO splits_bill (${BILL_COLUMNS}, source_call_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.title,
			input.date,
			input.payerKey,
			input.payerName,
			input.totalMinor,
			input.currency,
			input.equal ? 1 : 0,
			JSON.stringify(input.extras.map((extra) => ({ label: extra.label, amount_minor: extra.amountMinor }))),
			input.sourceRef ?? null,
			input.note,
			input.now,
			callId,
		);
		for (const item of input.items) {
			db.run(
				"INSERT INTO splits_item (bill_id, description, amount_minor, shared_by_json) VALUES (?, ?, ?, ?)",
				id,
				item.description,
				item.amountMinor,
				JSON.stringify(item.sharedBy),
			);
		}
		for (const share of input.shares) {
			db.run(
				"INSERT INTO splits_share (bill_id, person_key, person_name, person_id, items_minor, extras_minor, owed_minor) VALUES (?, ?, ?, ?, ?, ?, ?)",
				id,
				share.personKey,
				share.personName,
				share.personId ?? null,
				share.itemsMinor,
				share.extrasMinor,
				share.owedMinor,
			);
		}
		return { bill: getBill(db, id) as BillView, created: true };
	});
}

/** Bills newest first (by the day they happened, then by when they were written). `personKey`: only bills that person paid or shared. */
export function listBills(
	db: AppDb,
	options: { personKey?: string; limit: number },
): { bills: BillView[]; total: number } {
	const where =
		options.personKey === undefined
			? ""
			: "WHERE payer_key = ?1 OR id IN (SELECT bill_id FROM splits_share WHERE person_key = ?1)";
	const params = options.personKey === undefined ? [] : [options.personKey];
	const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM splits_bill ${where}`, ...params)?.n ?? 0;
	const bills = db
		.all<BillRecord>(
			`SELECT ${BILL_COLUMNS} FROM splits_bill ${where} ORDER BY occurred_on DESC, created_at DESC, rowid DESC LIMIT ${Math.max(1, Math.floor(options.limit))}`,
			...params,
		)
		.map((record) => viewOf(db, billOf(record)));
	return { bills, total };
}

export function deleteBill(db: AppDb, id: string): BillView | undefined {
	return db.transaction(() => {
		const bill = getBill(db, id);
		if (bill === undefined) return undefined;
		db.run("DELETE FROM splits_item WHERE bill_id = ?", id);
		db.run("DELETE FROM splits_share WHERE bill_id = ?", id);
		db.run("DELETE FROM splits_bill WHERE id = ?", id);
		return bill;
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------------------------------------------------

export type SettlementRow = {
	id: string;
	date: string;
	fromKey: string;
	fromName: string;
	toKey: string;
	toName: string;
	amountMinor: number;
	currency: string;
	note: string;
	createdAt: number;
};

type SettlementRecord = {
	id: string;
	occurred_on: string;
	from_key: string;
	from_name: string;
	to_key: string;
	to_name: string;
	amount_minor: number;
	currency: string;
	note: string;
	created_at: number;
};

const SETTLEMENT_COLUMNS =
	"id, occurred_on, from_key, from_name, to_key, to_name, amount_minor, currency, note, created_at";

const settlementOf = (record: SettlementRecord): SettlementRow => ({
	id: record.id,
	date: record.occurred_on,
	fromKey: record.from_key,
	fromName: record.from_name,
	toKey: record.to_key,
	toName: record.to_name,
	amountMinor: record.amount_minor,
	currency: record.currency,
	note: record.note,
	createdAt: record.created_at,
});

export function getSettlement(db: AppDb, id: string): SettlementRow | undefined {
	const record = db.get<SettlementRecord>(`SELECT ${SETTLEMENT_COLUMNS} FROM splits_settlement WHERE id = ?`, id);
	return record === undefined ? undefined : settlementOf(record);
}

export function settlementByCallId(db: AppDb, callId: string): SettlementRow | undefined {
	const record = db.get<SettlementRecord>(
		`SELECT ${SETTLEMENT_COLUMNS} FROM splits_settlement WHERE source_call_id = ?`,
		callId,
	);
	return record === undefined ? undefined : settlementOf(record);
}

export type NewSettlement = Omit<SettlementRow, "id" | "createdAt"> & { now: number };

export function insertSettlement(
	db: AppDb,
	input: NewSettlement,
	callId: string,
): { row: SettlementRow; created: boolean } {
	return db.transaction(() => {
		const earlier = settlementByCallId(db, callId);
		if (earlier !== undefined) return { row: earlier, created: false };
		const id = newSettlementId();
		db.run(
			`INSERT INTO splits_settlement (${SETTLEMENT_COLUMNS}, source_call_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.date,
			input.fromKey,
			input.fromName,
			input.toKey,
			input.toName,
			input.amountMinor,
			input.currency,
			input.note,
			input.now,
			callId,
		);
		return { row: getSettlement(db, id) as SettlementRow, created: true };
	});
}

export function listSettlements(
	db: AppDb,
	options: { personKey?: string; limit: number },
): { rows: SettlementRow[]; total: number } {
	const where = options.personKey === undefined ? "" : "WHERE from_key = ?1 OR to_key = ?1";
	const params = options.personKey === undefined ? [] : [options.personKey];
	const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM splits_settlement ${where}`, ...params)?.n ?? 0;
	const rows = db
		.all<SettlementRecord>(
			`SELECT ${SETTLEMENT_COLUMNS} FROM splits_settlement ${where} ORDER BY occurred_on DESC, created_at DESC, rowid DESC LIMIT ${Math.max(1, Math.floor(options.limit))}`,
			...params,
		)
		.map(settlementOf);
	return { rows, total };
}

export function deleteSettlement(db: AppDb, id: string): SettlementRow | undefined {
	const row = getSettlement(db, id);
	if (row === undefined) return undefined;
	db.run("DELETE FROM splits_settlement WHERE id = ?", id);
	return row;
}

// ---------------------------------------------------------------------------------------------------------------------
// People and balances
// ---------------------------------------------------------------------------------------------------------------------

/** Every person any bill or settlement mentions, by key, with the name as it was last written. The owner is always "You". */
export function knownPeople(db: AppDb): Map<string, string> {
	const names = new Map<string, string>();
	for (const row of db.all<{ key: string; name: string }>(
		`SELECT key, name FROM (
			SELECT s.person_key AS key, s.person_name AS name, b.created_at AS at FROM splits_share s JOIN splits_bill b ON b.id = s.bill_id
			UNION ALL SELECT payer_key, payer_name, created_at FROM splits_bill
			UNION ALL SELECT from_key, from_name, created_at FROM splits_settlement
			UNION ALL SELECT to_key, to_name, created_at FROM splits_settlement
		) ORDER BY at`,
	)) {
		names.set(row.key, row.key === OWNER_KEY ? OWNER_NAME : row.name);
	}
	return names;
}

export type Debt = {
	debtorKey: string;
	debtorName: string;
	creditorKey: string;
	creditorName: string;
	amountMinor: number;
	currency: string;
};

/**
 * What is owed now, netted per pair of people and currency: for every bill each share of someone other than the payer is
 * a debt to the payer, and every settlement is a payment against it. Owner's pairs first, then the rest by name.
 */
export function openBalances(db: AppDb): Debt[] {
	const entries: Entry[] = [
		...db
			.all<{ currency: string; from_key: string; to_key: string; owed_minor: number }>(
				`SELECT b.currency, s.person_key AS from_key, b.payer_key AS to_key, s.owed_minor
				 FROM splits_share s JOIN splits_bill b ON b.id = s.bill_id
				 WHERE s.person_key != b.payer_key AND s.owed_minor > 0`,
			)
			.map((row) => ({ from: row.from_key, to: row.to_key, amountMinor: row.owed_minor, currency: row.currency })),
		...db
			.all<{ currency: string; from_key: string; to_key: string; amount_minor: number }>(
				"SELECT currency, from_key, to_key, amount_minor FROM splits_settlement",
			)
			.map((row) => ({ from: row.from_key, to: row.to_key, amountMinor: -row.amount_minor, currency: row.currency })),
	];
	const names = knownPeople(db);
	const nameOf = (key: string): string => names.get(key) ?? key;
	const ownerFirst = (debt: { debtorKey: string; creditorKey: string }): number =>
		debt.debtorKey === OWNER_KEY || debt.creditorKey === OWNER_KEY ? 0 : 1;
	return netEntries(entries)
		.map((pair) => ({
			debtorKey: pair.debtor,
			debtorName: nameOf(pair.debtor),
			creditorKey: pair.creditor,
			creditorName: nameOf(pair.creditor),
			amountMinor: pair.amountMinor,
			currency: pair.currency,
		}))
		.sort(
			(a, b) =>
				ownerFirst(a) - ownerFirst(b) ||
				(a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0) ||
				(`${a.debtorName}|${a.creditorName}` < `${b.debtorName}|${b.creditorName}` ? -1 : 1),
		);
}

/** What `a` and `b` owe each other now in `currency`: positive when `a` owes `b`, negative the other way round, 0 when even. */
export function balanceBetween(db: AppDb, a: string, b: string, currency: string): number {
	for (const debt of openBalances(db)) {
		if (debt.currency !== currency) continue;
		if (debt.debtorKey === a && debt.creditorKey === b) return debt.amountMinor;
		if (debt.debtorKey === b && debt.creditorKey === a) return -debt.amountMinor;
	}
	return 0;
}
