import type { AppDb, SqlParam } from "@assistant/db";

// ---------------------------------------------------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------------------------------------------------

export type ProfileRow = {
	senderName: string;
	senderDetails: string;
	clientName: string;
	clientAddress: string;
	description: string;
	/** The usual amount in minor units. Absent until the owner gives one. */
	amountMinor?: number;
	currency: string;
	paymentTermsDays: number;
	paymentDetails: string;
	notes: string;
	numberPattern: string;
	nextSeq: number;
	updatedAt: number;
};

type ProfileRecord = {
	sender_name: string;
	sender_details: string;
	client_name: string;
	client_address: string;
	description: string;
	amount_minor: number | null;
	currency: string;
	payment_terms_days: number;
	payment_details: string;
	notes: string;
	number_pattern: string;
	next_seq: number;
	updated_at: number;
};

const PROFILE_COLUMNS =
	"sender_name, sender_details, client_name, client_address, description, amount_minor, currency, payment_terms_days, payment_details, notes, number_pattern, next_seq, updated_at";

export function getProfile(db: AppDb): ProfileRow | undefined {
	const record = db.get<ProfileRecord>(`SELECT ${PROFILE_COLUMNS} FROM invoice_profile WHERE id = 1`);
	if (record === undefined) return undefined;
	return {
		senderName: record.sender_name,
		senderDetails: record.sender_details,
		clientName: record.client_name,
		clientAddress: record.client_address,
		description: record.description,
		...(record.amount_minor === null ? {} : { amountMinor: record.amount_minor }),
		currency: record.currency,
		paymentTermsDays: record.payment_terms_days,
		paymentDetails: record.payment_details,
		notes: record.notes,
		numberPattern: record.number_pattern,
		nextSeq: record.next_seq,
		updatedAt: record.updated_at,
	};
}

/** The fields a call may change; absent means unchanged. `amountMinor: null` clears the usual amount. */
export type ProfileChange = {
	senderName?: string;
	senderDetails?: string;
	clientName?: string;
	clientAddress?: string;
	description?: string;
	amountMinor?: number | null;
	currency?: string;
	paymentTermsDays?: number;
	paymentDetails?: string;
	notes?: string;
	numberPattern?: string;
	nextSeq?: number;
};

const COLUMN_OF: Record<keyof ProfileChange, string> = {
	senderName: "sender_name",
	senderDetails: "sender_details",
	clientName: "client_name",
	clientAddress: "client_address",
	description: "description",
	amountMinor: "amount_minor",
	currency: "currency",
	paymentTermsDays: "payment_terms_days",
	paymentDetails: "payment_details",
	notes: "notes",
	numberPattern: "number_pattern",
	nextSeq: "next_seq",
};

/**
 * Change the profile (making it, with `currency`, on the first call) and record the call that did it, in one transaction.
 * False when the call had been applied already: a replay changes nothing, so it cannot undo a later edit (rule 8).
 */
export function applyProfileChange(
	db: AppDb,
	input: { change: ProfileChange; currency: string; callId: string; tool: string; subject: string; now: number },
): boolean {
	return db.transaction(() => {
		if (findCall(db, input.callId) !== undefined) return false;
		db.run(
			"INSERT INTO invoice_profile (id, currency, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING",
			input.currency,
			input.now,
		);
		const sets: string[] = [];
		const params: SqlParam[] = [];
		for (const [field, column] of Object.entries(COLUMN_OF) as Array<[keyof ProfileChange, string]>) {
			const value = input.change[field];
			if (value === undefined) continue;
			sets.push(`${column} = ?`);
			params.push(value);
		}
		sets.push("updated_at = ?");
		params.push(input.now);
		db.run(`UPDATE invoice_profile SET ${sets.join(", ")} WHERE id = 1`, ...params);
		db.run(
			"INSERT INTO invoices_call (source_call_id, tool, subject, applied_at) VALUES (?, ?, ?, ?)",
			input.callId,
			input.tool,
			input.subject,
			input.now,
		);
		return true;
	});
}

export function findCall(db: AppDb, callId: string): { tool: string; subject: string } | undefined {
	return db.get<{ tool: string; subject: string }>(
		"SELECT tool, subject FROM invoices_call WHERE source_call_id = ?",
		callId,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Invoices made
// ---------------------------------------------------------------------------------------------------------------------

export type IssuedRow = {
	id: number;
	number: string;
	seq: number;
	period: string;
	issueDate: string;
	dueDate: string;
	amountMinor: number;
	currency: string;
	clientName: string;
	description: string;
	fileId: string;
	filePath: string;
	createdAt: number;
};

type IssuedRecord = {
	id: number;
	number: string;
	seq: number;
	period: string;
	issue_date: string;
	due_date: string;
	amount_minor: number;
	currency: string;
	client_name: string;
	description: string;
	file_id: string;
	file_path: string;
	created_at: number;
};

const ISSUED_COLUMNS =
	"id, number, seq, period, issue_date, due_date, amount_minor, currency, client_name, description, file_id, file_path, created_at";

const issuedOf = (record: IssuedRecord): IssuedRow => ({
	id: record.id,
	number: record.number,
	seq: record.seq,
	period: record.period,
	issueDate: record.issue_date,
	dueDate: record.due_date,
	amountMinor: record.amount_minor,
	currency: record.currency,
	clientName: record.client_name,
	description: record.description,
	fileId: record.file_id,
	filePath: record.file_path,
	createdAt: record.created_at,
});

export function issuedByCallId(db: AppDb, callId: string): IssuedRow | undefined {
	const record = db.get<IssuedRecord>(`SELECT ${ISSUED_COLUMNS} FROM invoice_issued WHERE source_call_id = ?`, callId);
	return record === undefined ? undefined : issuedOf(record);
}

export function issuedByNumber(db: AppDb, number: string): IssuedRow | undefined {
	const record = db.get<IssuedRecord>(`SELECT ${ISSUED_COLUMNS} FROM invoice_issued WHERE number = ?`, number);
	return record === undefined ? undefined : issuedOf(record);
}

/** The latest invoice made for a month (`2026-10`), if there is one. */
export function issuedForPeriod(db: AppDb, period: string): IssuedRow | undefined {
	const record = db.get<IssuedRecord>(
		`SELECT ${ISSUED_COLUMNS} FROM invoice_issued WHERE period = ? ORDER BY id DESC LIMIT 1`,
		period,
	);
	return record === undefined ? undefined : issuedOf(record);
}

export function latestIssued(db: AppDb): IssuedRow | undefined {
	const record = db.get<IssuedRecord>(`SELECT ${ISSUED_COLUMNS} FROM invoice_issued ORDER BY id DESC LIMIT 1`);
	return record === undefined ? undefined : issuedOf(record);
}

/** Newest first. */
export function listIssued(db: AppDb, limit: number): { rows: IssuedRow[]; total: number } {
	const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM invoice_issued")?.n ?? 0;
	const rows = db
		.all<IssuedRecord>(`SELECT ${ISSUED_COLUMNS} FROM invoice_issued ORDER BY id DESC LIMIT ?`, limit)
		.map(issuedOf);
	return { rows, total };
}

/** The profile changed between reading the running number and using it, so the number is not the one that was taken. */
export class ProfileChangedError extends Error {
	constructor() {
		super("The invoice profile changed while the invoice was being made. Nothing was used up: try again.");
		this.name = "ProfileChangedError";
	}
}

export type NewIssued = Omit<IssuedRow, "id" | "createdAt"> & { now: number };

/**
 * Record an invoice and take its running number in one transaction: `seq` must still be the profile's next number, or
 * nothing is written. A number is therefore used once, however many calls race.
 */
export function insertIssued(db: AppDb, input: NewIssued, callId: string): IssuedRow {
	return db.transaction(() => {
		const bumped = db.run(
			"UPDATE invoice_profile SET next_seq = ? WHERE id = 1 AND next_seq = ?",
			input.seq + 1,
			input.seq,
		);
		if (bumped.changes !== 1) throw new ProfileChangedError();
		db.run(
			`INSERT INTO invoice_issued (number, seq, period, issue_date, due_date, amount_minor, currency, client_name, description, file_id, file_path, created_at, source_call_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			input.number,
			input.seq,
			input.period,
			input.issueDate,
			input.dueDate,
			input.amountMinor,
			input.currency,
			input.clientName,
			input.description,
			input.fileId,
			input.filePath,
			input.now,
			callId,
		);
		return issuedByCallId(db, callId) as IssuedRow;
	});
}
