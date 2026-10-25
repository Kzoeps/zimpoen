import type { AppDb } from "@assistant/db";
import type { SuggestionKind, SuggestionStatus, TriageCategory, TriageResult } from "@assistant/shared";

// ----- accounts ------------------------------------------------------------------------------------------------------

export type AccountStatus = "connected" | "needs_reconnect" | "disconnected";

/** One row of `inbox_account`, in the shapes the rest of the code uses (camelCase, absent instead of NULL). */
export type AccountRow = {
	email: string;
	status: AccountStatus;
	historyId?: string;
	connectedAt: number;
	nextSyncAt: number;
	lastSyncAt?: number;
	lastOkAt?: number;
	lastError?: string;
	failures: number;
	needsReconnectAt?: number;
	calendarSyncedAt?: number;
	gen: number;
	durableTaskId?: number;
	createdAt: number;
	updatedAt: number;
};

type AccountDbRow = {
	email: string;
	status: AccountStatus;
	history_id: string | null;
	connected_at: number;
	next_sync_at: number;
	last_sync_at: number | null;
	last_ok_at: number | null;
	last_error: string | null;
	failures: number;
	needs_reconnect_at: number | null;
	calendar_synced_at: number | null;
	gen: number;
	durable_task_id: number | null;
	created_at: number;
	updated_at: number;
};

const ACCOUNT_COLUMNS =
	"email, status, history_id, connected_at, next_sync_at, last_sync_at, last_ok_at, last_error, failures, needs_reconnect_at, calendar_synced_at, gen, durable_task_id, created_at, updated_at";

function accountFrom(row: AccountDbRow): AccountRow {
	return {
		email: row.email,
		status: row.status,
		connectedAt: row.connected_at,
		nextSyncAt: row.next_sync_at,
		failures: row.failures,
		gen: row.gen,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.history_id === null ? {} : { historyId: row.history_id }),
		...(row.last_sync_at === null ? {} : { lastSyncAt: row.last_sync_at }),
		...(row.last_ok_at === null ? {} : { lastOkAt: row.last_ok_at }),
		...(row.last_error === null ? {} : { lastError: row.last_error }),
		...(row.needs_reconnect_at === null ? {} : { needsReconnectAt: row.needs_reconnect_at }),
		...(row.calendar_synced_at === null ? {} : { calendarSyncedAt: row.calendar_synced_at }),
		...(row.durable_task_id === null ? {} : { durableTaskId: row.durable_task_id }),
	};
}

export function getAccount(db: AppDb, email: string): AccountRow | undefined {
	const row = db.get<AccountDbRow>(`SELECT ${ACCOUNT_COLUMNS} FROM inbox_account WHERE email = ?`, email);
	return row === undefined ? undefined : accountFrom(row);
}

export function listAccounts(db: AppDb): AccountRow[] {
	return db.all<AccountDbRow>(`SELECT ${ACCOUNT_COLUMNS} FROM inbox_account ORDER BY email`).map(accountFrom);
}

/** A row for an account that has none: connected, and due now. False when it already had one (it is never replaced). */
export function insertAccount(db: AppDb, input: { email: string; connectedAt: number; now: number }): boolean {
	return (
		db.run(
			`INSERT INTO inbox_account (email, status, connected_at, next_sync_at, created_at, updated_at)
			 VALUES (?, 'connected', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
			input.email,
			input.connectedAt,
			input.now,
			input.now,
			input.now,
		).changes > 0
	);
}

/**
 * Take an account out of the sync, or put it back: a new generation in the same transaction, so the timer that waits for
 * the old run is stale at once. Returns the Durable task to abort. `due` is when a connected account is next synced.
 */
export function changeStatus(
	db: AppDb,
	email: string,
	change: { status: AccountStatus; now: number; due?: number; connectedAt?: number; error?: string },
): { row: AccountRow; replacedDurableTaskId?: number } | undefined {
	return db.transaction(() => {
		const before = getAccount(db, email);
		if (before === undefined) return undefined;
		const connected = change.status === "connected";
		db.run(
			`UPDATE inbox_account SET status = ?, connected_at = ?, next_sync_at = ?, failures = ?, last_error = ?,
			                          needs_reconnect_at = ?, gen = gen + 1, durable_task_id = NULL, updated_at = ?
			 WHERE email = ?`,
			change.status,
			change.connectedAt ?? before.connectedAt,
			change.due ?? before.nextSyncAt,
			connected ? 0 : before.failures,
			connected ? null : (change.error ?? before.lastError ?? null),
			change.status === "needs_reconnect" ? change.now : null,
			change.now,
			email,
		);
		const row = getAccount(db, email);
		if (row === undefined) return undefined;
		return { row, ...(before.durableTaskId === undefined ? {} : { replacedDurableTaskId: before.durableTaskId }) };
	});
}

/** Every account that wants a sync timer: the connected ones. */
export function pendingTimers(db: AppDb): AccountRow[] {
	return db
		.all<AccountDbRow>(`SELECT ${ACCOUNT_COLUMNS} FROM inbox_account WHERE status = 'connected' ORDER BY email`)
		.map(accountFrom);
}

/** Take the next timer generation for a connected account that has no timer, or undefined when it needs none. */
export function takeGeneration(db: AppDb, email: string): { gen: number } | undefined {
	return db.transaction(() => {
		const result = db.run(
			"UPDATE inbox_account SET gen = gen + 1 WHERE email = ? AND status = 'connected' AND durable_task_id IS NULL",
			email,
		);
		return result.changes === 0 ? undefined : { gen: getAccount(db, email)?.gen ?? 0 };
	});
}

/** Remember which Durable task serves generation `gen`. False when the row moved on meanwhile (the task is stale). */
export function attachDurableTask(db: AppDb, email: string, gen: number, durableTaskId: number): boolean {
	return (
		db.run(
			"UPDATE inbox_account SET durable_task_id = ? WHERE email = ? AND gen = ? AND durable_task_id IS NULL",
			durableTaskId,
			email,
			gen,
		).changes > 0
	);
}

/** Forget a Durable task that is gone (lost in a power cut), so a new one can be made. */
export function detachDurableTask(db: AppDb, email: string, durableTaskId: number): void {
	db.run(
		"UPDATE inbox_account SET durable_task_id = NULL WHERE email = ? AND durable_task_id = ?",
		email,
		durableTaskId,
	);
}

/** Is this the timer the row currently wants? A stale one (reconnected, disconnected, a run done) is not. */
export function isCurrent(row: AccountRow | undefined, input: { gen: number }): row is AccountRow {
	return row?.status === "connected" && row.gen === input.gen;
}

export type SyncOutcome =
	| {
			ok: true;
			historyId?: string;
			calendarSynced?: boolean;
			/** The mail synced, and something else did not (the calendar): shown beside the account, no reason to back off. */
			warning?: string;
	  }
	| { ok: false; error: string };

/**
 * What a finished sync leaves in the row: when the next one is due (a new generation and no timer yet, so that the timer
 * that is finishing is stale and the next one is made after the row changed), the history cursor, and the failures in a row.
 * False when the row moved on meanwhile (the account was disconnected or reconnected); then nothing is scheduled.
 */
export function advance(
	db: AppDb,
	email: string,
	gen: number,
	step: { outcome: SyncOutcome; nextSyncAt: number; now: number },
): boolean {
	return db.transaction(() => {
		const before = getAccount(db, email);
		if (before === undefined || before.gen !== gen || before.status !== "connected") return false;
		const { outcome } = step;
		db.run(
			`UPDATE inbox_account SET next_sync_at = ?, last_sync_at = ?, last_ok_at = ?, last_error = ?, failures = ?,
			                          history_id = ?, calendar_synced_at = ?, durable_task_id = NULL, gen = gen + 1, updated_at = ?
			 WHERE email = ?`,
			step.nextSyncAt,
			step.now,
			outcome.ok ? step.now : (before.lastOkAt ?? null),
			(outcome.ok ? outcome.warning : outcome.error) ?? null,
			outcome.ok ? 0 : before.failures + 1,
			(outcome.ok ? outcome.historyId : undefined) ?? before.historyId ?? null,
			outcome.ok && outcome.calendarSynced === true ? step.now : (before.calendarSyncedAt ?? null),
			step.now,
			email,
		);
		return true;
	});
}

/** Save the history cursor in the middle of a sync that has not ended (the first sync reads for a while). */
export function setHistoryId(db: AppDb, email: string, historyId: string): void {
	db.run("UPDATE inbox_account SET history_id = ? WHERE email = ?", historyId, email);
}

// ----- messages ------------------------------------------------------------------------------------------------------

export type MessageRow = {
	id: number;
	account: string;
	gmailId: string;
	threadId: string;
	fromName: string;
	fromAddr: string;
	toAddrs: string;
	subject: string;
	date: number;
	labels: string[];
	bulk: boolean;
	snippet: string;
	text: string;
	hidden: boolean;
	triage?: TriageResult;
	triagedAt?: number;
};

type MessageDbRow = {
	id: number;
	account: string;
	gmail_id: string;
	thread_id: string;
	from_name: string;
	from_addr: string;
	to_addrs: string;
	subject: string;
	date: number;
	labels: string;
	bulk: number;
	snippet: string;
	body_text_trunc: string;
	hidden: number;
	triage_json: string | null;
	triaged_at: number | null;
};

const MESSAGE_COLUMNS =
	"id, account, gmail_id, thread_id, from_name, from_addr, to_addrs, subject, date, labels, bulk, snippet, body_text_trunc, hidden, triage_json, triaged_at";

function parseLabels(json: string): string[] {
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((label): label is string => typeof label === "string") : [];
	} catch {
		return [];
	}
}

function parseTriage(json: string | null): TriageResult | undefined {
	if (json === null) return undefined;
	try {
		const parsed = JSON.parse(json) as Partial<TriageResult> | null;
		if (parsed === null || typeof parsed.category !== "string" || typeof parsed.urgency !== "number") return undefined;
		return parsed as TriageResult;
	} catch {
		return undefined;
	}
}

function messageFrom(row: MessageDbRow): MessageRow {
	const triage = parseTriage(row.triage_json);
	return {
		id: row.id,
		account: row.account,
		gmailId: row.gmail_id,
		threadId: row.thread_id,
		fromName: row.from_name,
		fromAddr: row.from_addr,
		toAddrs: row.to_addrs,
		subject: row.subject,
		date: row.date,
		labels: parseLabels(row.labels),
		bulk: row.bulk === 1,
		snippet: row.snippet,
		text: row.body_text_trunc,
		hidden: row.hidden === 1,
		...(triage === undefined ? {} : { triage }),
		...(row.triaged_at === null ? {} : { triagedAt: row.triaged_at }),
	};
}

/** Gmail marks these as not part of the mailbox the owner reads. */
const HIDDEN_LABELS: readonly string[] = ["TRASH", "SPAM"];
export const isHiddenByLabels = (labels: readonly string[]): boolean =>
	labels.some((label) => HIDDEN_LABELS.includes(label));

export type NewMessage = {
	account: string;
	gmailId: string;
	threadId: string;
	fromName: string;
	fromAddr: string;
	toAddrs: string;
	subject: string;
	date: number;
	labels: readonly string[];
	bulk: boolean;
	snippet: string;
	text: string;
};

export function getMessage(db: AppDb, id: number): MessageRow | undefined {
	const row = db.get<MessageDbRow>(`SELECT ${MESSAGE_COLUMNS} FROM inbox_message WHERE id = ?`, id);
	return row === undefined ? undefined : messageFrom(row);
}

export function getMessageByGmailId(db: AppDb, account: string, gmailId: string): MessageRow | undefined {
	const row = db.get<MessageDbRow>(
		`SELECT ${MESSAGE_COLUMNS} FROM inbox_message WHERE account = ? AND gmail_id = ?`,
		account,
		gmailId,
	);
	return row === undefined ? undefined : messageFrom(row);
}

/**
 * Keep a message: a new one is inserted (and waits for its triage); one already kept only has what Gmail can change
 * refreshed (its labels and snippet), so its triage, and the owner's marking, survive a re-read of the mailbox.
 */
export function saveMessage(db: AppDb, message: NewMessage, now: number): { id: number; inserted: boolean } {
	return db.transaction(() => {
		const existing = db.get<{ id: number; deleted_at: number | null }>(
			"SELECT id, deleted_at FROM inbox_message WHERE account = ? AND gmail_id = ?",
			message.account,
			message.gmailId,
		);
		const labels = JSON.stringify(message.labels);
		const hidden = isHiddenByLabels(message.labels) ? 1 : 0;
		if (existing !== undefined) {
			db.run(
				"UPDATE inbox_message SET labels = ?, snippet = ?, hidden = ?, deleted_at = NULL WHERE id = ?",
				labels,
				message.snippet,
				hidden,
				existing.id,
			);
			return { id: existing.id, inserted: false };
		}
		const { lastInsertRowid } = db.run(
			`INSERT INTO inbox_message (account, gmail_id, thread_id, from_name, from_addr, to_addrs, subject, date, labels, bulk,
			                            snippet, body_text_trunc, hidden, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			message.account,
			message.gmailId,
			message.threadId,
			message.fromName,
			message.fromAddr,
			message.toAddrs,
			message.subject,
			message.date,
			labels,
			message.bulk ? 1 : 0,
			message.snippet,
			message.text,
			hidden,
			now,
		);
		return { id: Number(lastInsertRowid), inserted: true };
	});
}

/** Apply the labels Gmail added and removed. A message this store does not have is not an error (it is older than the sync's reach). */
export function applyLabelChange(
	db: AppDb,
	account: string,
	gmailId: string,
	change: { added: readonly string[]; removed: readonly string[] },
): boolean {
	return db.transaction(() => {
		const row = db.get<{ id: number; labels: string; deleted_at: number | null }>(
			"SELECT id, labels, deleted_at FROM inbox_message WHERE account = ? AND gmail_id = ?",
			account,
			gmailId,
		);
		if (row === undefined) return false;
		const labels = new Set(parseLabels(row.labels));
		for (const label of change.removed) labels.delete(label);
		for (const label of change.added) labels.add(label);
		const next = [...labels];
		const hidden = row.deleted_at !== null || isHiddenByLabels(next) ? 1 : 0;
		db.run("UPDATE inbox_message SET labels = ?, hidden = ? WHERE id = ?", JSON.stringify(next), hidden, row.id);
		return true;
	});
}

/** Gmail deleted it: it stays as a row, hidden, so that nothing the owner sees mentions it. */
export function markDeleted(db: AppDb, account: string, gmailId: string, now: number): boolean {
	return (
		db.run(
			"UPDATE inbox_message SET hidden = 1, deleted_at = ? WHERE account = ? AND gmail_id = ? AND deleted_at IS NULL",
			now,
			account,
			gmailId,
		).changes > 0
	);
}

/** Mail the account still has that this store had hidden (a restored message): visible again, unless it is in the trash or spam. */
export function unhide(db: AppDb, account: string, gmailIds: readonly string[]): void {
	for (const gmailId of gmailIds) {
		const row = db.get<{ id: number; labels: string }>(
			"SELECT id, labels FROM inbox_message WHERE account = ? AND gmail_id = ? AND hidden = 1",
			account,
			gmailId,
		);
		if (row !== undefined && !isHiddenByLabels(parseLabels(row.labels))) {
			db.run("UPDATE inbox_message SET hidden = 0, deleted_at = NULL WHERE id = ?", row.id);
		}
	}
}

/**
 * After the mailbox was read in full: mail this store shows that arrived since `notBefore` and is not in `listed` is gone
 * from the mailbox (deleted, or moved to the trash or spam while the history was lost), so it is hidden.
 */
export function hideUnlisted(
	db: AppDb,
	account: string,
	listed: ReadonlySet<string>,
	notBefore: number,
	now: number,
): number {
	let hidden = 0;
	for (const row of db.all<{ gmail_id: string }>(
		"SELECT gmail_id FROM inbox_message WHERE account = ? AND hidden = 0 AND date >= ?",
		account,
		notBefore,
	)) {
		if (!listed.has(row.gmail_id) && markDeleted(db, account, row.gmail_id, now)) hidden += 1;
	}
	return hidden;
}

export function hasMessage(db: AppDb, account: string, gmailId: string): boolean {
	return (
		db.get("SELECT 1 AS one FROM inbox_message WHERE account = ? AND gmail_id = ? LIMIT 1", account, gmailId) !==
		undefined
	);
}

/** Messages that have no triage yet, newest first. */
export function toTriage(db: AppDb, limit: number): MessageRow[] {
	return db
		.all<MessageDbRow>(
			`SELECT ${MESSAGE_COLUMNS} FROM inbox_message WHERE triaged_at IS NULL AND hidden = 0 ORDER BY date DESC LIMIT ?`,
			limit,
		)
		.map(messageFrom);
}

export function provisionalMessages(db: AppDb, limit: number): MessageRow[] {
	return db
		.all<MessageDbRow>(
			`SELECT ${MESSAGE_COLUMNS} FROM inbox_message WHERE provisional = 1 AND hidden = 0 ORDER BY date DESC LIMIT ?`,
			limit,
		)
		.map(messageFrom);
}

/** Store a triage. `now` is read by the caller right before the write, with no `await` between: the digests select by it. */
export function setTriage(db: AppDb, id: number, result: TriageResult, now: number): void {
	db.run(
		`UPDATE inbox_message SET triage_json = ?, category = ?, urgency = ?, needs_human = ?, triage_source = ?,
		                          provisional = ?, triaged_at = ?
		 WHERE id = ?`,
		JSON.stringify(result),
		result.category,
		result.urgency,
		result.needsHuman ? 1 : 0,
		result.source,
		result.provisional === true ? 1 : 0,
		now,
		id,
	);
}

// ----- mail that could not be read -----------------------------------------------------------------------------------

export type ReadFailureRow = {
	account: string;
	gmailId: string;
	/** Syncs that failed on this message. */
	attempts: number;
	lastError: string;
	lastFailedAt: number;
	/** When it was given up on. Absent while it is still asked for. */
	skippedAt?: number;
};

type ReadFailureDbRow = {
	account: string;
	gmail_id: string;
	attempts: number;
	last_error: string;
	last_failed_at: number;
	skipped_at: number | null;
};

const READ_FAILURE_COLUMNS = "account, gmail_id, attempts, last_error, last_failed_at, skipped_at";

const readFailureFrom = (row: ReadFailureDbRow): ReadFailureRow => ({
	account: row.account,
	gmailId: row.gmail_id,
	attempts: row.attempts,
	lastError: row.last_error,
	lastFailedAt: row.last_failed_at,
	...(row.skipped_at === null ? {} : { skippedAt: row.skipped_at }),
});

/**
 * Count one more sync that failed on a message. At `giveUpAfter` failures the message is skipped (never asked for again), so
 * a message that fails every time costs a bounded number of tries and then stops holding the mail behind it back.
 */
export function recordReadFailure(
	db: AppDb,
	input: { account: string; gmailId: string; error: string; now: number; giveUpAfter: number },
): ReadFailureRow {
	return db.transaction(() => {
		db.run(
			`INSERT INTO inbox_read_failure (account, gmail_id, attempts, last_error, last_failed_at) VALUES (?, ?, 1, ?, ?)
			 ON CONFLICT (account, gmail_id) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error,
			                                               last_failed_at = excluded.last_failed_at`,
			input.account,
			input.gmailId,
			input.error,
			input.now,
		);
		db.run(
			"UPDATE inbox_read_failure SET skipped_at = ? WHERE account = ? AND gmail_id = ? AND attempts >= ? AND skipped_at IS NULL",
			input.now,
			input.account,
			input.gmailId,
			input.giveUpAfter,
		);
		const row = db.get<ReadFailureDbRow>(
			`SELECT ${READ_FAILURE_COLUMNS} FROM inbox_read_failure WHERE account = ? AND gmail_id = ?`,
			input.account,
			input.gmailId,
		);
		if (row === undefined) throw new Error("A failed read was not recorded. This should be impossible.");
		return readFailureFrom(row);
	});
}

/** The message was read after all (or is gone from Gmail): it is not a failure any more. */
export function clearReadFailure(db: AppDb, account: string, gmailId: string): void {
	db.run("DELETE FROM inbox_read_failure WHERE account = ? AND gmail_id = ?", account, gmailId);
}

/** Messages that failed before and are still asked for, oldest failure first. */
export function retryableReads(db: AppDb, account: string): string[] {
	return db
		.all<{ gmail_id: string }>(
			"SELECT gmail_id FROM inbox_read_failure WHERE account = ? AND skipped_at IS NULL ORDER BY last_failed_at, gmail_id",
			account,
		)
		.map((row) => row.gmail_id);
}

/** Which of `gmailIds` were given up on: they are not asked for again. */
export function skippedAmong(db: AppDb, account: string, gmailIds: readonly string[]): Set<string> {
	if (gmailIds.length === 0) return new Set();
	const skipped = new Set(
		db
			.all<{ gmail_id: string }>(
				"SELECT gmail_id FROM inbox_read_failure WHERE account = ? AND skipped_at IS NOT NULL",
				account,
			)
			.map((row) => row.gmail_id),
	);
	return new Set(gmailIds.filter((id) => skipped.has(id)));
}

/** The messages of an account that were given up on since `since` (epoch ms), newest first. */
export function skippedReads(db: AppDb, account: string, since: number): ReadFailureRow[] {
	return db
		.all<ReadFailureDbRow>(
			`SELECT ${READ_FAILURE_COLUMNS} FROM inbox_read_failure WHERE account = ? AND skipped_at >= ? ORDER BY skipped_at DESC, gmail_id`,
			account,
			since,
		)
		.map(readFailureFrom);
}

/** Forget failures that last happened before `before`: older than the mail a sync reads, so nobody asks for them any more. */
export function pruneReadFailures(db: AppDb, before: number): number {
	return db.run("DELETE FROM inbox_read_failure WHERE last_failed_at < ?", before).changes;
}

export type SearchQuery = {
	/** An FTS5 expression already made safe by {@link ftsQuery}; absent: no text filter. */
	match?: string | undefined;
	account?: string | undefined;
	category?: TriageCategory | undefined;
	/** Mail that arrived at or after this instant, epoch ms. */
	since?: number | undefined;
	/** Mail that arrived before this instant, epoch ms. */
	until?: number | undefined;
	limit: number;
};

/** `search_mail`: what matches, best first (newest first when there is no text), and how many matched in all. */
export function searchMessages(db: AppDb, query: SearchQuery): { rows: MessageRow[]; total: number } {
	const where: string[] = ["m.hidden = 0"];
	const params: Array<string | number> = [];
	if (query.account !== undefined) {
		where.push("m.account = ?");
		params.push(query.account);
	}
	if (query.category !== undefined) {
		where.push("m.category = ?");
		params.push(query.category);
	}
	if (query.since !== undefined) {
		where.push("m.date >= ?");
		params.push(query.since);
	}
	if (query.until !== undefined) {
		where.push("m.date < ?");
		params.push(query.until);
	}
	const columns = MESSAGE_COLUMNS.split(", ")
		.map((column) => `m.${column}`)
		.join(", ");
	if (query.match === undefined) {
		const clause = where.join(" AND ");
		const rows = db
			.all<MessageDbRow>(
				`SELECT ${columns} FROM inbox_message m WHERE ${clause} ORDER BY m.date DESC LIMIT ?`,
				...params,
				query.limit,
			)
			.map(messageFrom);
		const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox_message m WHERE ${clause}`, ...params)?.n ?? 0;
		return { rows, total };
	}
	const clause = `${where.join(" AND ")} AND inbox_message_fts MATCH ?`;
	const from = "FROM inbox_message_fts JOIN inbox_message m ON m.id = inbox_message_fts.rowid";
	const rows = db
		.all<MessageDbRow>(
			`SELECT ${columns} ${from} WHERE ${clause} ORDER BY bm25(inbox_message_fts), m.date DESC LIMIT ?`,
			...params,
			query.match,
			query.limit,
		)
		.map(messageFrom);
	const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n ${from} WHERE ${clause}`, ...params, query.match)?.n ?? 0;
	return { rows, total };
}

/**
 * An FTS5 expression from free text: every word quoted (so no word is read as an operator or a column name), each one a
 * prefix, all of them required. Undefined when the text has no word in it.
 */
export function ftsQuery(text: string): string | undefined {
	const words = text
		.normalize("NFKC")
		.split(/[^\p{L}\p{N}@._-]+/u)
		.map((word) => word.replace(/^[._-]+|[._-]+$/g, ""))
		.filter((word) => word !== "")
		.slice(0, 8)
		.map((word) => word.slice(0, 40));
	if (words.length === 0) return undefined;
	return words.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" ");
}

export type AttentionQuery = {
	/** Triaged after this instant, epoch ms. */
	since: number;
	/** ... and up to and including this one. */
	cutoff: number;
	/** Mail that arrived before this instant is not news, whenever it was triaged. */
	notBefore: number;
	categories: readonly TriageCategory[];
	limit: number;
};

/** What a digest lists: mail that wants attention, triaged in the window, most urgent first. `total` counts them all. */
export function attentionMessages(db: AppDb, query: AttentionQuery): { rows: MessageRow[]; total: number } {
	const marks = query.categories.map(() => "?").join(", ");
	const where = `hidden = 0 AND category IN (${marks}) AND triaged_at > ? AND triaged_at <= ? AND date >= ?`;
	const params = [...query.categories, query.since, query.cutoff, query.notBefore];
	const rows = db
		.all<MessageDbRow>(
			`SELECT ${MESSAGE_COLUMNS} FROM inbox_message WHERE ${where} ORDER BY urgency DESC, date DESC LIMIT ?`,
			...params,
			query.limit,
		)
		.map(messageFrom);
	const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox_message WHERE ${where}`, ...params)?.n ?? 0;
	return { rows, total };
}

/** How many of each attention category the window holds: the morning briefing says them in one line. */
export function attentionCounts(db: AppDb, query: Omit<AttentionQuery, "limit">): Map<TriageCategory, number> {
	const marks = query.categories.map(() => "?").join(", ");
	const rows = db.all<{ category: TriageCategory; n: number }>(
		`SELECT category, COUNT(*) AS n FROM inbox_message
		 WHERE hidden = 0 AND category IN (${marks}) AND triaged_at > ? AND triaged_at <= ? AND date >= ? GROUP BY category`,
		...query.categories,
		query.since,
		query.cutoff,
		query.notBefore,
	);
	return new Map(rows.map((row) => [row.category, row.n]));
}

export function countMessages(db: AppDb): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of db.all<{ account: string; n: number }>(
		"SELECT account, COUNT(*) AS n FROM inbox_message WHERE hidden = 0 GROUP BY account",
	)) {
		counts.set(row.account, row.n);
	}
	return counts;
}

export function countUntriaged(db: AppDb): number {
	return (
		db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbox_message WHERE triaged_at IS NULL AND hidden = 0")?.n ?? 0
	);
}

// ----- events --------------------------------------------------------------------------------------------------------

export type EventRow = {
	id: number;
	account: string;
	eventId: string;
	title: string;
	startAt: number;
	endAt: number;
	allDay: boolean;
	attendees: string[];
	location: string;
	updated: number;
};

type EventDbRow = {
	id: number;
	account: string;
	event_id: string;
	title: string;
	start_at: number;
	end_at: number;
	all_day: number;
	attendees: string;
	location: string;
	updated: number;
};

const EVENT_COLUMNS = "id, account, event_id, title, start_at, end_at, all_day, attendees, location, updated";

function eventFrom(row: EventDbRow): EventRow {
	return {
		id: row.id,
		account: row.account,
		eventId: row.event_id,
		title: row.title,
		startAt: row.start_at,
		endAt: row.end_at,
		allDay: row.all_day === 1,
		attendees: parseLabels(row.attendees),
		location: row.location,
		updated: row.updated,
	};
}

export type NewEvent = Omit<EventRow, "id">;

/**
 * Make the account's events in `[from, to)` exactly `events`: new ones are kept, changed ones updated, and the ones the
 * calendar no longer lists (cancelled, moved out of the window, deleted) go. Events outside the window are history and stay.
 */
export function replaceEvents(
	db: AppDb,
	account: string,
	window: { from: number; to: number },
	events: readonly NewEvent[],
): { kept: number; removed: number } {
	return db.transaction(() => {
		for (const event of events) {
			db.run(
				`INSERT INTO inbox_event (account, event_id, title, start_at, end_at, all_day, attendees, location, updated)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (account, event_id) DO UPDATE SET title = excluded.title, start_at = excluded.start_at,
				   end_at = excluded.end_at, all_day = excluded.all_day, attendees = excluded.attendees,
				   location = excluded.location, updated = excluded.updated`,
				event.account,
				event.eventId,
				event.title,
				event.startAt,
				event.endAt,
				event.allDay ? 1 : 0,
				JSON.stringify(event.attendees),
				event.location,
				event.updated,
			);
		}
		const keep = new Set(events.map((event) => event.eventId));
		let removed = 0;
		for (const row of db.all<{ id: number; event_id: string }>(
			"SELECT id, event_id FROM inbox_event WHERE account = ? AND start_at >= ? AND start_at < ?",
			account,
			window.from,
			window.to,
		)) {
			if (keep.has(row.event_id)) continue;
			// A suggestion made from this event keeps its own copy of what it says (title, time), so the event can go.
			db.run("DELETE FROM inbox_event WHERE id = ?", row.id);
			removed += 1;
		}
		return { kept: events.length, removed };
	});
}

export function getEvent(db: AppDb, id: number): EventRow | undefined {
	const row = db.get<EventDbRow>(`SELECT ${EVENT_COLUMNS} FROM inbox_event WHERE id = ?`, id);
	return row === undefined ? undefined : eventFrom(row);
}

/** Events that overlap `[from, to)`, soonest first. */
export function eventsBetween(
	db: AppDb,
	range: { from: number; to: number; account?: string | undefined; limit: number },
): { rows: EventRow[]; total: number } {
	const account = range.account === undefined ? "" : " AND account = ?";
	const params: Array<string | number> = [
		range.to,
		range.from,
		...(range.account === undefined ? [] : [range.account]),
	];
	const where = `start_at < ? AND end_at > ?${account}`;
	const rows = db
		.all<EventDbRow>(
			`SELECT ${EVENT_COLUMNS} FROM inbox_event WHERE ${where} ORDER BY start_at, id LIMIT ?`,
			...params,
			range.limit,
		)
		.map(eventFrom);
	const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox_event WHERE ${where}`, ...params)?.n ?? 0;
	return { rows, total };
}

// ----- rules ---------------------------------------------------------------------------------------------------------

export type RuleRow = { kind: "sender" | "domain"; value: string; category: TriageCategory };

export function listRules(db: AppDb): RuleRow[] {
	return db
		.all<{ kind: "sender" | "domain"; value: string; category: TriageCategory }>(
			"SELECT kind, value, category FROM inbox_rule ORDER BY id",
		)
		.map((row) => ({ kind: row.kind, value: row.value, category: row.category }));
}

export function saveRule(db: AppDb, rule: RuleRow, now: number): void {
	db.run(
		`INSERT INTO inbox_rule (kind, value, category, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (kind, value) DO UPDATE SET category = excluded.category`,
		rule.kind,
		rule.value,
		rule.category,
		now,
	);
}

// ----- call ledger ---------------------------------------------------------------------------------------------------

export function findCall(db: AppDb, callId: string): { tool: string; subject?: string } | undefined {
	const row = db.get<{ tool: string; subject: string | null }>(
		"SELECT tool, subject FROM inbox_call WHERE source_call_id = ?",
		callId,
	);
	return row === undefined ? undefined : { tool: row.tool, ...(row.subject === null ? {} : { subject: row.subject }) };
}

/**
 * Re-mark one message by the owner, in one transaction with the call ledger entry (rule 8): a call that Durable replays after
 * a crash is recognised and changes nothing, and a later marking is not undone by it. Only this message changes. A lasting
 * rule for a sender is a different thing (`saveRule`), and it needs the owner's approval.
 */
export function markByOwner(
	db: AppDb,
	input: { callId: string; messageId: number; result: TriageResult; now: number },
): boolean {
	return db.transaction(() => {
		const recorded = db.run(
			"INSERT INTO inbox_call (source_call_id, tool, subject, applied_at) VALUES (?, 'mark_triage', ?, ?) ON CONFLICT DO NOTHING",
			input.callId,
			String(input.messageId),
			input.now,
		);
		if (recorded.changes === 0) return false;
		setTriage(db, input.messageId, input.result, input.now);
		return true;
	});
}

// ----- suggestions ---------------------------------------------------------------------------------------------------

export type SuggestionRow = {
	id: string;
	kind: SuggestionKind;
	title: string;
	counterpart: string;
	context: string;
	at: number;
	endsAt?: number;
	sourceType: "mail" | "event";
	sourceId: number;
	sourceLabel: string;
	sourceUrl?: string;
	status: SuggestionStatus;
	postedAt?: number;
	decidedAt?: number;
	createdAt: number;
};

type SuggestionDbRow = {
	id: string;
	kind: SuggestionKind;
	title: string;
	counterpart: string;
	context: string;
	at: number;
	ends_at: number | null;
	source_type: "mail" | "event";
	source_id: number;
	source_label: string;
	source_url: string | null;
	status: SuggestionStatus;
	posted_at: number | null;
	decided_at: number | null;
	created_at: number;
};

const SUGGESTION_COLUMNS =
	"id, kind, title, counterpart, context, at, ends_at, source_type, source_id, source_label, source_url, status, posted_at, decided_at, created_at";

function suggestionFrom(row: SuggestionDbRow): SuggestionRow {
	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		counterpart: row.counterpart,
		context: row.context,
		at: row.at,
		sourceType: row.source_type,
		sourceId: row.source_id,
		sourceLabel: row.source_label,
		status: row.status,
		createdAt: row.created_at,
		...(row.ends_at === null ? {} : { endsAt: row.ends_at }),
		...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
		...(row.posted_at === null ? {} : { postedAt: row.posted_at }),
		...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
	};
}

export function getSuggestion(db: AppDb, id: string): SuggestionRow | undefined {
	const row = db.get<SuggestionDbRow>(`SELECT ${SUGGESTION_COLUMNS} FROM inbox_suggestion WHERE id = ?`, id);
	return row === undefined ? undefined : suggestionFrom(row);
}

export function suggestionByCall(db: AppDb, callId: string): SuggestionRow | undefined {
	const row = db.get<SuggestionDbRow>(
		`SELECT ${SUGGESTION_COLUMNS} FROM inbox_suggestion WHERE source_call_id = ?`,
		callId,
	);
	return row === undefined ? undefined : suggestionFrom(row);
}

/** The same follow-up suggested twice (another call, the same thing) is one suggestion while it waits. */
export function pendingDuplicate(
	db: AppDb,
	input: { sourceType: "mail" | "event"; sourceId: number; title: string; at: number },
): SuggestionRow | undefined {
	const row = db.get<SuggestionDbRow>(
		`SELECT ${SUGGESTION_COLUMNS} FROM inbox_suggestion
		 WHERE status = 'pending' AND source_type = ? AND source_id = ? AND title = ? AND at = ?`,
		input.sourceType,
		input.sourceId,
		input.title,
		input.at,
	);
	return row === undefined ? undefined : suggestionFrom(row);
}

export type NewSuggestion = {
	id: string;
	kind: SuggestionKind;
	title: string;
	counterpart: string;
	context: string;
	at: number;
	endsAt?: number | undefined;
	sourceType: "mail" | "event";
	sourceId: number;
	sourceLabel: string;
	sourceUrl?: string | undefined;
	callId: string;
	now: number;
};

export function insertSuggestion(db: AppDb, input: NewSuggestion): SuggestionRow {
	db.run(
		`INSERT INTO inbox_suggestion (id, kind, title, counterpart, context, at, ends_at, source_type, source_id, source_label,
		                               source_url, status, source_call_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (source_call_id) DO NOTHING`,
		input.id,
		input.kind,
		input.title,
		input.counterpart,
		input.context,
		input.at,
		input.endsAt ?? null,
		input.sourceType,
		input.sourceId,
		input.sourceLabel,
		input.sourceUrl ?? null,
		input.callId,
		input.now,
	);
	const row = suggestionByCall(db, input.callId);
	if (row === undefined) throw new Error("A suggestion was not saved. This should be impossible.");
	return row;
}

export function markSuggestionPosted(db: AppDb, id: string, now: number): void {
	db.run("UPDATE inbox_suggestion SET posted_at = COALESCE(posted_at, ?) WHERE id = ?", now, id);
}

/** Suggestions whose card is not in the PA's thread yet, oldest first. */
export function unpostedSuggestions(db: AppDb): SuggestionRow[] {
	return db
		.all<SuggestionDbRow>(
			`SELECT ${SUGGESTION_COLUMNS} FROM inbox_suggestion WHERE posted_at IS NULL AND status = 'pending' ORDER BY created_at`,
		)
		.map(suggestionFrom);
}

export function pendingSuggestions(db: AppDb): SuggestionRow[] {
	return db
		.all<SuggestionDbRow>(
			`SELECT ${SUGGESTION_COLUMNS} FROM inbox_suggestion WHERE status = 'pending' ORDER BY created_at`,
		)
		.map(suggestionFrom);
}

/** Suggestions that waited since before `before` (epoch ms) for an answer are over: `expired`. Returns how many. */
export function expireSuggestions(db: AppDb, before: number, now: number): number {
	return db.run(
		"UPDATE inbox_suggestion SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at <= ?",
		now,
		before,
	).changes;
}

/** Record the owner's answer. False when it was already answered: the first answer stands. */
export function decideSuggestion(db: AppDb, id: string, status: "added" | "dismissed", now: number): boolean {
	return (
		db.run(
			"UPDATE inbox_suggestion SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
			status,
			now,
			id,
		).changes > 0
	);
}

// ----- digest windows and small state --------------------------------------------------------------------------------

export type DigestWindow = { since: number; cutoff: number };

export function getDigestWindow(db: AppDb, job: string, date: string): DigestWindow | undefined {
	const row = db.get<{ since_at: number; cutoff_at: number }>(
		"SELECT since_at, cutoff_at FROM inbox_digest WHERE job = ? AND date = ?",
		job,
		date,
	);
	return row === undefined ? undefined : { since: row.since_at, cutoff: row.cutoff_at };
}

/** The window a digest first looked at stays: the first writer wins, so a rerun shows the same mails. */
export function saveDigestWindow(db: AppDb, job: string, date: string, window: DigestWindow): DigestWindow {
	db.run(
		"INSERT INTO inbox_digest (job, date, since_at, cutoff_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
		job,
		date,
		window.since,
		window.cutoff,
	);
	return getDigestWindow(db, job, date) ?? window;
}

/** Where the last digest stopped looking: the next one starts there. */
export function lastDigestCutoff(db: AppDb): number | undefined {
	return db.get<{ cutoff: number | null }>("SELECT MAX(cutoff_at) AS cutoff FROM inbox_digest")?.cutoff ?? undefined;
}

export function getState(db: AppDb, key: string): { value: string; updatedAt: number } | undefined {
	const row = db.get<{ value: string; updated_at: number }>(
		"SELECT value, updated_at FROM inbox_state WHERE key = ?",
		key,
	);
	return row === undefined ? undefined : { value: row.value, updatedAt: row.updated_at };
}

export function setState(db: AppDb, key: string, value: string, now: number): void {
	db.run(
		`INSERT INTO inbox_state (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key,
		value,
		now,
	);
}

export function clearState(db: AppDb, key: string): void {
	db.run("DELETE FROM inbox_state WHERE key = ?", key);
}
