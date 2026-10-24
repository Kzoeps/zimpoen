import { randomBytes } from "node:crypto";
import type { AppDb } from "@assistant/db";
import type { ApprovalStatus } from "@assistant/shared";

/** The arguments of a destructive tool call: JSON, as the model wrote them and the database keeps them. */
export type ActionArgs = Readonly<Record<string, unknown>>;

export type PendingAction = {
	id: string;
	conversationId: number;
	tool: string;
	target: string;
	args: ActionArgs;
	summary: string;
	status: ApprovalStatus;
	resultText?: string;
	createdAt: number;
	expiresAt: number;
	decidedAt?: number;
	decidedVia?: "button" | "yes";
	decidedRequestId?: string;
	executedAt?: number;
	notifiedAt?: number;
	noticeSubmissionId?: number;
	/**
	 * Whether a reply of YES may still answer this request. It starts true and ends, for good, with the next message the
	 * owner sends that is not that answer: after it, a "yes" can be an answer to anything.
	 */
	yesOk: boolean;
};

type DbRow = {
	id: string;
	conversation_id: number;
	tool: string;
	target: string;
	args_json: string;
	summary: string;
	status: ApprovalStatus;
	result_text: string | null;
	created_at: number;
	expires_at: number;
	decided_at: number | null;
	decided_via: "button" | "yes" | null;
	decided_request_id: string | null;
	executed_at: number | null;
	notified_at: number | null;
	notice_submission_id: number | null;
	yes_ok: number;
};

const COLUMNS =
	"id, conversation_id, tool, target, args_json, summary, status, result_text, created_at, expires_at, decided_at, decided_via, decided_request_id, executed_at, notified_at, notice_submission_id, yes_ok";

const optional = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } =>
	(value === null ? {} : { [key]: value }) as { [P in K]?: V };

function fromRecord(record: DbRow): PendingAction {
	return {
		id: record.id,
		conversationId: record.conversation_id,
		tool: record.tool,
		target: record.target,
		args: JSON.parse(record.args_json) as ActionArgs,
		summary: record.summary,
		status: record.status,
		createdAt: record.created_at,
		expiresAt: record.expires_at,
		yesOk: record.yes_ok === 1,
		...optional("resultText", record.result_text),
		...optional("decidedAt", record.decided_at),
		...optional("decidedVia", record.decided_via),
		...optional("decidedRequestId", record.decided_request_id),
		...optional("executedAt", record.executed_at),
		...optional("notifiedAt", record.notified_at),
		...optional("noticeSubmissionId", record.notice_submission_id),
	};
}

export const newActionId = (): string => `ap_${randomBytes(4).toString("hex")}`;

/** Canonical JSON (sorted keys), so equal arguments are equal text whatever order a model wrote them in. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, child) =>
		child !== null && typeof child === "object" && !Array.isArray(child)
			? Object.fromEntries(Object.entries(child).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: child,
	);
}

export type NewAction = {
	conversationId: number;
	tool: string;
	target: string;
	args: ActionArgs;
	summary: string;
	callId: string;
	now: number;
	expiresAt: number;
};

/**
 * Record a request for tool call `callId`, or return what that call already recorded (Durable may rerun a replay-safe
 * tool). A request for something that is already waiting for an answer is the same request: the owner is asked once.
 */
export function insertAction(db: AppDb, input: NewAction): PendingAction {
	return db.transaction(() => {
		const earlier = db.get<DbRow>(`SELECT ${COLUMNS} FROM pending_actions WHERE source_call_id = ?`, input.callId);
		if (earlier !== undefined) return fromRecord(earlier);
		const waiting = db.get<DbRow>(
			`SELECT ${COLUMNS} FROM pending_actions
			 WHERE conversation_id = ? AND tool = ? AND target = ? AND status = 'pending' AND expires_at > ?`,
			input.conversationId,
			input.tool,
			input.target,
			input.now,
		);
		if (waiting !== undefined) return fromRecord(waiting);
		const id = newActionId();
		db.run(
			`INSERT INTO pending_actions (id, conversation_id, tool, target, args_json, summary, status, source_call_id, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
			id,
			input.conversationId,
			input.tool,
			input.target,
			canonicalJson(input.args),
			input.summary,
			input.callId,
			input.now,
			input.expiresAt,
		);
		return requireAction(db, id);
	});
}

export function getAction(db: AppDb, id: string): PendingAction | undefined {
	const record = db.get<DbRow>(`SELECT ${COLUMNS} FROM pending_actions WHERE id = ?`, id);
	return record === undefined ? undefined : fromRecord(record);
}

export function requireAction(db: AppDb, id: string): PendingAction {
	const action = getAction(db, id);
	if (action === undefined) throw new Error(`No approval request '${id}'.`);
	return action;
}

/** Every request of a conversation that is still waiting and not past its deadline, newest first. */
export function waitingIn(db: AppDb, conversationId: number, now: number): PendingAction[] {
	return db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM pending_actions
			 WHERE conversation_id = ? AND status = 'pending' AND expires_at > ?
			 ORDER BY created_at DESC, rowid DESC`,
			conversationId,
			now,
		)
		.map(fromRecord);
}

/** The owner wrote something that is not a YES answer: from now on a "yes" may mean anything but these requests. */
export function closeYesWindow(db: AppDb, conversationId: number): void {
	db.run(
		"UPDATE pending_actions SET yes_ok = 0 WHERE conversation_id = ? AND status = 'pending' AND yes_ok = 1",
		conversationId,
	);
}

/** A "YES" message that was already turned into a decision, found by the client's request id. */
export function decidedByRequest(db: AppDb, conversationId: number, requestId: string): PendingAction | undefined {
	const record = db.get<DbRow>(
		`SELECT ${COLUMNS} FROM pending_actions WHERE conversation_id = ? AND decided_request_id = ?`,
		conversationId,
		requestId,
	);
	return record === undefined ? undefined : fromRecord(record);
}

/** Is there an approved request, not yet carried out, for exactly this tool and target? The hook's question. */
export function hasApproved(db: AppDb, conversationId: number, tool: string, target: string): boolean {
	return (
		db.get(
			"SELECT 1 AS one FROM pending_actions WHERE conversation_id = ? AND tool = ? AND target = ? AND status = 'approved'",
			conversationId,
			tool,
			target,
		) !== undefined
	);
}

export function findApproved(
	db: AppDb,
	conversationId: number,
	tool: string,
	target: string,
): PendingAction | undefined {
	const record = db.get<DbRow>(
		`SELECT ${COLUMNS} FROM pending_actions
		 WHERE conversation_id = ? AND tool = ? AND target = ? AND status = 'approved' ORDER BY created_at, rowid LIMIT 1`,
		conversationId,
		tool,
		target,
	);
	return record === undefined ? undefined : fromRecord(record);
}

/** Move a waiting request to `status`. False when it was no longer waiting: exactly one decision wins a race. */
export function decide(
	db: AppDb,
	id: string,
	status: "approved" | "denied",
	via: "button" | "yes",
	requestId: string | undefined,
	now: number,
): boolean {
	return (
		db.run(
			`UPDATE pending_actions SET status = ?, decided_at = ?, decided_via = ?, decided_request_id = ?
			 WHERE id = ? AND status = 'pending' AND expires_at > ?`,
			status,
			now,
			via,
			requestId ?? null,
			id,
			now,
		).changes > 0
	);
}

export function markExecuted(db: AppDb, id: string, result: { ok: boolean; text: string }, now: number): void {
	db.run(
		"UPDATE pending_actions SET status = ?, result_text = ?, executed_at = ? WHERE id = ? AND status = 'approved'",
		result.ok ? "executed" : "failed",
		result.text,
		now,
		id,
	);
}

/**
 * Record that the outcome notice is in the thread. The first time is kept as `notified_at`; the submission id is always
 * the latest one, because posting again after Durable's database came back older may hand out a different id.
 */
export function markNotified(db: AppDb, id: string, submissionId: number, now: number): void {
	db.run(
		"UPDATE pending_actions SET notified_at = COALESCE(notified_at, ?), notice_submission_id = ? WHERE id = ?",
		now,
		submissionId,
		id,
	);
}

/** Close every waiting request whose deadline passed. Returns how many. */
export function expirePending(db: AppDb, now: number): number {
	return db.run(
		"UPDATE pending_actions SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at <= ?",
		now,
		now,
	).changes;
}

/** Approved and not yet carried out: a crash, or a failure that left the request open for a retry. */
export function approvedUnexecuted(db: AppDb): PendingAction[] {
	return db
		.all<DbRow>(`SELECT ${COLUMNS} FROM pending_actions WHERE status = 'approved' ORDER BY created_at, rowid`)
		.map(fromRecord);
}

/**
 * Decided requests whose notice was posted at or after `since`. A power cut can take the notice from Durable's database
 * while this one still says it was posted, so recovery asks again for the recent ones (idempotent by request id).
 */
export function recentlyNotified(db: AppDb, since: number): PendingAction[] {
	return db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM pending_actions
			 WHERE status IN ('executed', 'failed', 'denied') AND notified_at IS NOT NULL AND notified_at >= ?
			 ORDER BY created_at, rowid`,
			since,
		)
		.map(fromRecord);
}

/** Decided (carried out, failed or denied) whose outcome notice was never posted. */
export function unnotified(db: AppDb): PendingAction[] {
	return db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM pending_actions
			 WHERE status IN ('executed', 'failed', 'denied') AND notified_at IS NULL ORDER BY created_at, rowid`,
		)
		.map(fromRecord);
}
