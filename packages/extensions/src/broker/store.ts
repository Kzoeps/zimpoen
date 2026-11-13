import type { AppDb } from "@assistant/db";

export type CallRow = {
	callId: string;
	conversationId: number;
	project: string;
	credId: string;
	action: string;
	params: Record<string, string>;
	decision: "allow" | "ask" | "deny";
	status: "running" | "done" | "asked" | "refused";
	approvalId?: string;
	exitCode?: number;
	output?: string;
	redacted?: boolean;
	reason?: string;
	createdAt: number;
};

type DbRow = {
	call_id: string;
	conversation_id: number;
	project: string;
	cred_id: string;
	action: string;
	params: string;
	decision: CallRow["decision"];
	status: CallRow["status"];
	approval_id: string | null;
	exit_code: number | null;
	output: string | null;
	redacted: number | null;
	reason: string | null;
	created_at: number;
};

const fromDb = (row: DbRow): CallRow => ({
	callId: row.call_id,
	conversationId: row.conversation_id,
	project: row.project,
	credId: row.cred_id,
	action: row.action,
	params: JSON.parse(row.params) as Record<string, string>,
	decision: row.decision,
	status: row.status,
	createdAt: row.created_at,
	...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
	...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
	...(row.output === null ? {} : { output: row.output }),
	...(row.redacted === null ? {} : { redacted: row.redacted === 1 }),
	...(row.reason === null ? {} : { reason: row.reason }),
});

export function getCall(db: AppDb, callId: string): CallRow | undefined {
	const row = db.get<DbRow>("SELECT * FROM broker_call WHERE call_id = ?", callId);
	return row === undefined ? undefined : fromDb(row);
}

export type NewCall = Omit<CallRow, "exitCode" | "output" | "redacted">;

/** Insert the call's row; false when this call id already has one (a replay that raced the first run). */
export function insertCall(db: AppDb, call: NewCall): boolean {
	return (
		db.run(
			`INSERT INTO broker_call (call_id, conversation_id, project, cred_id, action, params, decision, status, approval_id, reason, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (call_id) DO NOTHING`,
			call.callId,
			call.conversationId,
			call.project,
			call.credId,
			call.action,
			JSON.stringify(call.params),
			call.decision,
			call.status,
			call.approvalId ?? null,
			call.reason ?? null,
			call.createdAt,
		).changes > 0
	);
}

export function finishCall(
	db: AppDb,
	callId: string,
	result: { exitCode: number; output: string; redacted: boolean },
	now: number,
): void {
	db.run(
		"UPDATE broker_call SET status = 'done', exit_code = ?, output = ?, redacted = ?, finished_at = ? WHERE call_id = ?",
		result.exitCode,
		result.output,
		result.redacted ? 1 : 0,
		now,
		callId,
	);
}

export function failCall(db: AppDb, callId: string, reason: string, now: number): void {
	db.run(
		"UPDATE broker_call SET status = 'refused', reason = ?, finished_at = ? WHERE call_id = ?",
		reason,
		now,
		callId,
	);
}
