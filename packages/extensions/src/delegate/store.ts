import type { AppDb } from "@assistant/db";

export type AskedAgent = "inbox" | "health" | "accountant";

export type AskRow = {
	id: string;
	callId: string;
	conversationId: number;
	agent: AskedAgent;
	question: string;
	requestId: string;
	status: "waiting" | "answered" | "failed";
	answer?: string;
	late: boolean;
	postedAt?: number;
	createdAt: number;
	settledAt?: number;
};

type AskDbRow = {
	id: string;
	source_call_id: string;
	conversation_id: number;
	agent: AskedAgent;
	question: string;
	request_id: string;
	status: "waiting" | "answered" | "failed";
	answer: string | null;
	late: number;
	posted_at: number | null;
	created_at: number;
	settled_at: number | null;
};

const COLUMNS =
	"id, source_call_id, conversation_id, agent, question, request_id, status, answer, late, posted_at, created_at, settled_at";

function askFrom(row: AskDbRow): AskRow {
	return {
		id: row.id,
		callId: row.source_call_id,
		conversationId: row.conversation_id,
		agent: row.agent,
		question: row.question,
		requestId: row.request_id,
		status: row.status,
		late: row.late === 1,
		createdAt: row.created_at,
		...(row.answer === null ? {} : { answer: row.answer }),
		...(row.posted_at === null ? {} : { postedAt: row.posted_at }),
		...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
	};
}

export function findByCall(db: AppDb, callId: string): AskRow | undefined {
	const row = db.get<AskDbRow>(`SELECT ${COLUMNS} FROM delegate_ask WHERE source_call_id = ?`, callId);
	return row === undefined ? undefined : askFrom(row);
}

export function getAsk(db: AppDb, id: string): AskRow | undefined {
	const row = db.get<AskDbRow>(`SELECT ${COLUMNS} FROM delegate_ask WHERE id = ?`, id);
	return row === undefined ? undefined : askFrom(row);
}

/** The row this call makes, or the one an earlier run of the same call made. */
export function insertAsk(
	db: AppDb,
	input: {
		id: string;
		callId: string;
		conversationId: number;
		agent: AskedAgent;
		question: string;
		requestId: string;
		now: number;
	},
): AskRow {
	db.run(
		`INSERT INTO delegate_ask (id, source_call_id, conversation_id, agent, question, request_id, status, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?) ON CONFLICT (source_call_id) DO NOTHING`,
		input.id,
		input.callId,
		input.conversationId,
		input.agent,
		input.question,
		input.requestId,
		input.now,
	);
	const row = findByCall(db, input.callId);
	if (row === undefined) throw new Error("An ask was not saved. This should be impossible.");
	return row;
}

/** Record how the other agent's run ended. The first outcome stands: a repeat changes nothing. */
export function settle(
	db: AppDb,
	id: string,
	outcome: { status: "answered" | "failed"; text: string },
	now: number,
): AskRow {
	db.run(
		"UPDATE delegate_ask SET status = ?, answer = ?, settled_at = ? WHERE id = ? AND status = 'waiting'",
		outcome.status,
		outcome.text,
		now,
		id,
	);
	const row = getAsk(db, id);
	if (row === undefined) throw new Error(`There is no ask ${id}. This should be impossible.`);
	return row;
}

/** The PA stopped waiting: whatever comes now is posted to its thread. */
export function markLate(db: AppDb, id: string): void {
	db.run("UPDATE delegate_ask SET late = 1 WHERE id = ?", id);
}

export function markPosted(db: AppDb, id: string, now: number): void {
	db.run("UPDATE delegate_ask SET posted_at = COALESCE(posted_at, ?) WHERE id = ?", now, id);
}

/** Asks nobody is waiting for any more whose outcome is not in the PA's thread: still running, or answered and not yet posted. */
export function openLateAsks(db: AppDb): AskRow[] {
	return db
		.all<AskDbRow>(
			`SELECT ${COLUMNS} FROM delegate_ask
			 WHERE late = 1 AND posted_at IS NULL ORDER BY created_at`,
		)
		.map(askFrom);
}

/** Asks still waiting, whoever waits: after a restart these are what a replayed tool or the repair has to settle. */
export function waitingAsks(db: AppDb): AskRow[] {
	return db
		.all<AskDbRow>(`SELECT ${COLUMNS} FROM delegate_ask WHERE status = 'waiting' ORDER BY created_at`)
		.map(askFrom);
}
