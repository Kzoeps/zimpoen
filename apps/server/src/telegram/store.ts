import type { AppDb, Migration } from "@assistant/db";

/**
 * The bridge's own rows in `app.sqlite`: where the long poll stands, the one bound chat, the one-time start code, and the
 * replies owed to Telegram. Not a domain module: no agent has a Telegram tool (PLAN rule 1, exception (a) of the upgrade
 * plan), so these tables are only ever written by the server.
 */
export const telegramMigrations: readonly Migration[] = [
	{
		id: "telegram/001_bridge",
		up: (db) => {
			db.exec(`
				CREATE TABLE telegram_state (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				) STRICT;
				CREATE TABLE telegram_reply (
					update_id INTEGER PRIMARY KEY,
					chat_id INTEGER NOT NULL,
					submission_id INTEGER NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('waiting', 'sending', 'sent')),
					created_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
];

type StateKey = "offset" | "chat_id" | "start_code";

function getState(db: AppDb, key: StateKey): string | undefined {
	return db.get<{ value: string }>("SELECT value FROM telegram_state WHERE key = ?", key)?.value;
}

function setState(db: AppDb, key: StateKey, value: string): void {
	db.run(
		"INSERT INTO telegram_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
		key,
		value,
	);
}

export const getOffset = (db: AppDb): number => Number(getState(db, "offset") ?? 0);
export const setOffset = (db: AppDb, offset: number): void => setState(db, "offset", String(offset));

export function getBoundChat(db: AppDb): number | undefined {
	const value = getState(db, "chat_id");
	return value === undefined ? undefined : Number(value);
}

export const getStartCode = (db: AppDb): string | undefined => getState(db, "start_code");
export const setStartCode = (db: AppDb, code: string): void => setState(db, "start_code", code);

/** Bind `chatId` and burn the start code, in one transaction. False when a chat is already bound. */
export function bind(db: AppDb, chatId: number): boolean {
	return db.transaction(() => {
		if (getBoundChat(db) !== undefined) return false;
		setState(db, "chat_id", String(chatId));
		db.run("DELETE FROM telegram_state WHERE key = 'start_code'");
		return true;
	});
}

export type ReplyRow = {
	updateId: number;
	chatId: number;
	submissionId: number;
	status: "waiting" | "sending" | "sent";
};

/** Note that the run started by `updateId` owes a reply. A repeated update keeps the first row. */
export function addReply(db: AppDb, row: Omit<ReplyRow, "status">, now: number): void {
	db.run(
		"INSERT OR IGNORE INTO telegram_reply (update_id, chat_id, submission_id, status, created_at) VALUES (?, ?, ?, 'waiting', ?)",
		row.updateId,
		row.chatId,
		row.submissionId,
		now,
	);
}

export function waitingReplies(db: AppDb): ReplyRow[] {
	return db.all<ReplyRow>(
		"SELECT update_id AS updateId, chat_id AS chatId, submission_id AS submissionId, status FROM telegram_reply WHERE status = 'waiting' ORDER BY update_id",
	);
}

/**
 * Claim a waiting reply for sending. Marked before anything is sent, so a crash mid-send never sends twice (at most
 * once: a reply lost that way stays readable in the web thread).
 */
export function claimReply(db: AppDb, updateId: number): boolean {
	return (
		db.run("UPDATE telegram_reply SET status = 'sending' WHERE update_id = ? AND status = 'waiting'", updateId)
			.changes === 1
	);
}

/** Undo a claim whose send failed before any piece went out, so it can be tried again. */
export function releaseReply(db: AppDb, updateId: number): void {
	db.run("UPDATE telegram_reply SET status = 'waiting' WHERE update_id = ? AND status = 'sending'", updateId);
}

export function markSent(db: AppDb, updateId: number): void {
	db.run("UPDATE telegram_reply SET status = 'sent' WHERE update_id = ?", updateId);
}
