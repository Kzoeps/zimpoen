import type { AppDb } from "@assistant/db";

export type CardRow = {
	callId: string;
	conversationId: number;
	repo: string;
	goal: string;
	doneWhen: string;
	outOfScope: string;
	status: "creating" | "created" | "notified" | "refused";
	cardId?: string;
	reason?: string;
	createdAt: number;
};

type DbRow = {
	call_id: string;
	conversation_id: number;
	repo: string;
	goal: string;
	done_when: string;
	out_of_scope: string;
	status: CardRow["status"];
	card_id: string | null;
	reason: string | null;
	created_at: number;
};

const fromDb = (row: DbRow): CardRow => ({
	callId: row.call_id,
	conversationId: row.conversation_id,
	repo: row.repo,
	goal: row.goal,
	doneWhen: row.done_when,
	outOfScope: row.out_of_scope,
	status: row.status,
	createdAt: row.created_at,
	...(row.card_id === null ? {} : { cardId: row.card_id }),
	...(row.reason === null ? {} : { reason: row.reason }),
});

export function getByCall(db: AppDb, callId: string): CardRow | undefined {
	const row = db.get<DbRow>("SELECT * FROM cto_card WHERE call_id = ?", callId);
	return row === undefined ? undefined : fromDb(row);
}

export function getByCard(db: AppDb, cardId: string): CardRow | undefined {
	const row = db.get<DbRow>("SELECT * FROM cto_card WHERE card_id = ?", cardId);
	return row === undefined ? undefined : fromDb(row);
}

/** The newest cards opened, newest first. */
export function recentCards(db: AppDb, limit: number): CardRow[] {
	return db
		.all<DbRow>("SELECT * FROM cto_card WHERE card_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?", limit)
		.map(fromDb);
}

/** False when this call already has a row (a replay). */
export function insert(db: AppDb, row: Omit<CardRow, "cardId">): boolean {
	return (
		db.run(
			`INSERT INTO cto_card (call_id, conversation_id, repo, goal, done_when, out_of_scope, status, reason, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (call_id) DO NOTHING`,
			row.callId,
			row.conversationId,
			row.repo,
			row.goal,
			row.doneWhen,
			row.outOfScope,
			row.status,
			row.reason ?? null,
			row.createdAt,
			row.createdAt,
		).changes > 0
	);
}

export function markCreated(db: AppDb, callId: string, cardId: string, now: number): void {
	db.run(
		"UPDATE cto_card SET status = 'created', card_id = ?, updated_at = ? WHERE call_id = ? AND status = 'creating'",
		cardId,
		now,
		callId,
	);
}

export function markNotified(db: AppDb, callId: string, now: number): void {
	db.run(
		"UPDATE cto_card SET status = 'notified', updated_at = ? WHERE call_id = ? AND status = 'created'",
		now,
		callId,
	);
}
