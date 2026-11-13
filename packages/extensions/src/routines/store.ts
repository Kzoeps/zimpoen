import { randomBytes } from "node:crypto";
import type { AppDb } from "@assistant/db";
import type { RoutineSchedule } from "./slots.ts";

export type RoutineRow = {
	id: string;
	conversationId: number;
	agent: string;
	title: string;
	message: string;
	schedule: RoutineSchedule;
	status: "active" | "cancelled";
	dueAt: number;
	lastSlotAt?: number;
	lastRunAt?: number;
	runs: number;
	skipped: number;
	gen: number;
	durableTaskId?: number;
	createdAt: number;
	cancelledAt?: number;
};

type DbRow = {
	id: string;
	conversation_id: number;
	agent: string;
	title: string;
	message: string;
	kind: "daily" | "weekly" | "hourly";
	local_time: string | null;
	days: string | null;
	every_hours: number | null;
	anchor_at: number;
	status: "active" | "cancelled";
	due_at: number;
	last_slot_at: number | null;
	last_run_at: number | null;
	runs: number;
	skipped: number;
	gen: number;
	durable_task_id: number | null;
	created_at: number;
	cancelled_at: number | null;
};

const COLUMNS =
	"id, conversation_id, agent, title, message, kind, local_time, days, every_hours, anchor_at, status, due_at, " +
	"last_slot_at, last_run_at, runs, skipped, gen, durable_task_id, created_at, cancelled_at";

function scheduleFrom(row: DbRow): RoutineSchedule {
	if (row.kind === "hourly") return { kind: "hourly", everyHours: row.every_hours ?? 1, anchorAt: row.anchor_at };
	const time = row.local_time ?? "00:00";
	if (row.kind === "daily") return { kind: "daily", time };
	return { kind: "weekly", time, days: (row.days ?? "").split(",").filter(Boolean).map(Number) };
}

function rowFrom(row: DbRow): RoutineRow {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		agent: row.agent,
		title: row.title,
		message: row.message,
		schedule: scheduleFrom(row),
		status: row.status,
		dueAt: row.due_at,
		runs: row.runs,
		skipped: row.skipped,
		gen: row.gen,
		createdAt: row.created_at,
		...(row.last_slot_at === null ? {} : { lastSlotAt: row.last_slot_at }),
		...(row.last_run_at === null ? {} : { lastRunAt: row.last_run_at }),
		...(row.durable_task_id === null ? {} : { durableTaskId: row.durable_task_id }),
		...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
	};
}

export function getRoutine(db: AppDb, id: string): RoutineRow | undefined {
	const row = db.get<DbRow>(`SELECT ${COLUMNS} FROM routines_routine WHERE id = ?`, id);
	return row === undefined ? undefined : rowFrom(row);
}

export function findByCall(db: AppDb, callId: string): RoutineRow | undefined {
	const row = db.get<DbRow>(`SELECT ${COLUMNS} FROM routines_routine WHERE source_call_id = ?`, callId);
	return row === undefined ? undefined : rowFrom(row);
}

export function listRoutines(
	db: AppDb,
	options: { conversationId?: number; includeCancelled?: boolean },
): RoutineRow[] {
	const where: string[] = [];
	const params: Array<string | number> = [];
	if (options.conversationId !== undefined) {
		where.push("conversation_id = ?");
		params.push(options.conversationId);
	}
	if (options.includeCancelled !== true) where.push("status = 'active'");
	const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
	return db
		.all<DbRow>(`SELECT ${COLUMNS} FROM routines_routine ${clause} ORDER BY created_at, id`, ...params)
		.map(rowFrom);
}

export function countActive(db: AppDb): number {
	return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM routines_routine WHERE status = 'active'")?.n ?? 0;
}

export type NewRoutine = {
	conversationId: number;
	agent: string;
	title: string;
	message: string;
	schedule: RoutineSchedule;
	dueAt: number;
};

/**
 * Insert a routine for call `callId`, unless one already exists for it (rule 8) or `limit` active ones exist. The count
 * and the insert share a transaction, so two calls cannot both take the last place.
 */
export function insertRoutine(
	db: AppDb,
	input: NewRoutine,
	callId: string,
	now: number,
	limit: number,
): { row: RoutineRow; created: boolean } | { full: true } {
	return db.transaction(() => {
		const earlier = findByCall(db, callId);
		if (earlier !== undefined) return { row: earlier, created: false };
		if (countActive(db) >= limit) return { full: true as const };
		const id = `r_${randomBytes(4).toString("hex")}`;
		const { schedule } = input;
		db.run(
			`INSERT INTO routines_routine (id, conversation_id, agent, title, message, kind, local_time, days, every_hours,
			                              anchor_at, status, due_at, source_call_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
			id,
			input.conversationId,
			input.agent,
			input.title,
			input.message,
			schedule.kind,
			schedule.kind === "hourly" ? null : schedule.time,
			schedule.kind === "weekly" ? schedule.days.join(",") : null,
			schedule.kind === "hourly" ? schedule.everyHours : null,
			schedule.kind === "hourly" ? schedule.anchorAt : now,
			input.dueAt,
			callId,
			now,
			now,
		);
		const row = getRoutine(db, id);
		if (row === undefined) throw new Error(`Routine ${id} was inserted and then not found.`);
		return { row, created: true };
	});
}

/**
 * Cancel a routine for call `callId` (rule 8: a replay finds the call and changes nothing). Takes a new generation, so
 * the waiting timer is stale at once; `replacedDurableTaskId` is that timer, to abort after the commit.
 */
export function cancelRoutine(
	db: AppDb,
	id: string,
	callId: string,
	now: number,
): { row: RoutineRow; cancelled: boolean; replacedDurableTaskId?: number } | undefined {
	return db.transaction(() => {
		const before = getRoutine(db, id);
		if (before === undefined) return undefined;
		const replay = db.get<{ subject: string | null }>(
			"SELECT subject FROM routines_call WHERE source_call_id = ?",
			callId,
		);
		if (replay !== undefined || before.status === "cancelled") return { row: before, cancelled: false };
		db.run(
			`UPDATE routines_routine SET status = 'cancelled', cancelled_at = ?, updated_at = ?, gen = gen + 1,
			                            durable_task_id = NULL
			 WHERE id = ?`,
			now,
			now,
			id,
		);
		db.run(
			"INSERT INTO routines_call (source_call_id, tool, subject, applied_at) VALUES (?, 'cancel_routine', ?, ?)",
			callId,
			id,
			now,
		);
		const row = getRoutine(db, id);
		if (row === undefined) throw new Error(`Routine ${id} vanished while it was cancelled.`);
		return {
			row,
			cancelled: true,
			...(before.durableTaskId === undefined ? {} : { replacedDurableTaskId: before.durableTaskId }),
		};
	});
}

/** Rows that want a timer: the active ones. */
export function pendingTimers(db: AppDb): RoutineRow[] {
	return listRoutines(db, {});
}

export function takeGeneration(db: AppDb, id: string): { gen: number; conversationId: number } | undefined {
	return db.transaction(() => {
		const result = db.run(
			"UPDATE routines_routine SET gen = gen + 1 WHERE id = ? AND status = 'active' AND durable_task_id IS NULL",
			id,
		);
		const row = result.changes === 0 ? undefined : getRoutine(db, id);
		return row === undefined ? undefined : { gen: row.gen, conversationId: row.conversationId };
	});
}

export function attachDurableTask(db: AppDb, id: string, gen: number, durableTaskId: number): boolean {
	return (
		db.run(
			"UPDATE routines_routine SET durable_task_id = ? WHERE id = ? AND gen = ? AND durable_task_id IS NULL",
			durableTaskId,
			id,
			gen,
		).changes > 0
	);
}

export function detachDurableTask(db: AppDb, id: string, durableTaskId: number): void {
	db.run("UPDATE routines_routine SET durable_task_id = NULL WHERE id = ? AND durable_task_id = ?", id, durableTaskId);
}

/** Whether a timer of generation `gen` still serves this row. */
export const isCurrent = (row: RoutineRow | undefined, input: { gen: number }): row is RoutineRow =>
	row !== undefined && row.status === "active" && row.gen === input.gen;

/**
 * Record what the timer of generation `gen` did with `slot` and move to `next`, with a new generation and no timer, so
 * the successor can be created. False when the row moved on meanwhile.
 */
export function advance(
	db: AppDb,
	id: string,
	gen: number,
	change: { slot: number; ran: boolean; next: number; now: number },
): boolean {
	return (
		db.run(
			`UPDATE routines_routine
			 SET due_at = ?, last_slot_at = ?, last_run_at = CASE WHEN ? THEN ? ELSE last_run_at END,
			     runs = runs + ?, skipped = skipped + ?, gen = gen + 1, durable_task_id = NULL, updated_at = ?
			 WHERE id = ? AND gen = ? AND status = 'active'`,
			change.next,
			change.slot,
			change.ran ? 1 : 0,
			change.now,
			change.ran ? 1 : 0,
			change.ran ? 0 : 1,
			change.now,
			id,
			gen,
		).changes > 0
	);
}
