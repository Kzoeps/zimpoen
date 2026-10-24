import { randomBytes } from "node:crypto";
import type { AppDb } from "@assistant/db";

/** One row of `tasks_item`, in the shapes the rest of the code uses (camelCase, absent instead of NULL). */
export type TaskRow = {
	id: string;
	title: string;
	notes: string;
	status: "open" | "done" | "dropped";
	dueAt?: number;
	dueAllDay: boolean;
	remindAt?: number;
	remindGen: number;
	durableTaskId?: number;
	remindedAt?: number;
	conversationId: number;
	createdAt: number;
	updatedAt: number;
	doneAt?: number;
};

type DbRow = {
	id: string;
	title: string;
	notes: string;
	status: TaskRow["status"];
	due_at: number | null;
	due_all_day: number;
	remind_at: number | null;
	remind_gen: number;
	durable_task_id: number | null;
	reminded_at: number | null;
	conversation_id: number;
	created_at: number;
	updated_at: number;
	done_at: number | null;
};

const COLUMNS =
	"id, title, notes, status, due_at, due_all_day, remind_at, remind_gen, durable_task_id, reminded_at, conversation_id, created_at, updated_at, done_at";

const optional = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } =>
	(value === null ? {} : { [key]: value }) as { [P in K]?: V };

function fromRecord(record: DbRow): TaskRow {
	return {
		id: record.id,
		title: record.title,
		notes: record.notes,
		status: record.status,
		dueAllDay: record.due_all_day === 1,
		remindGen: record.remind_gen,
		conversationId: record.conversation_id,
		createdAt: record.created_at,
		updatedAt: record.updated_at,
		...optional("dueAt", record.due_at),
		...optional("remindAt", record.remind_at),
		...optional("durableTaskId", record.durable_task_id),
		...optional("remindedAt", record.reminded_at),
		...optional("doneAt", record.done_at),
	};
}

/** Short enough for a model to copy back correctly, long enough that a personal list never collides (retried on PK). */
export function newTaskId(): string {
	return `t_${randomBytes(4).toString("hex")}`;
}

export type NewTask = {
	title: string;
	notes: string;
	dueAt?: number;
	dueAllDay: boolean;
	remindAt?: number;
	conversationId: number;
	createdAt: number;
};

/**
 * Insert a task for tool call `callId`, or return the one that call already inserted. `created` says which happened:
 * Durable may run a replay-safe tool again after a crash, and the second run must find its own row, not make another.
 */
export function insertTask(db: AppDb, input: NewTask, callId: string): { row: TaskRow; created: boolean } {
	return db.transaction(() => {
		for (let attempt = 0; attempt < 5; attempt++) {
			const id = newTaskId();
			const result = db.run(
				`INSERT INTO tasks_item (id, title, notes, status, due_at, due_all_day, remind_at, conversation_id, source_call_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT DO NOTHING`,
				id,
				input.title,
				input.notes,
				input.dueAt ?? null,
				input.dueAllDay ? 1 : 0,
				input.remindAt ?? null,
				input.conversationId,
				callId,
				input.createdAt,
				input.createdAt,
			);
			if (result.changes > 0) return { row: requireTask(db, id), created: true };
			// A conflict is either this call's earlier insert (its unique source_call_id) or, very rarely, an id collision.
			const earlier = findByCallId(db, callId);
			if (earlier !== undefined) return { row: earlier, created: false };
		}
		throw new Error("Could not find a free task id after 5 tries. This should be impossible; check tasks_item.");
	});
}

export function getTask(db: AppDb, id: string): TaskRow | undefined {
	const record = db.get<DbRow>(`SELECT ${COLUMNS} FROM tasks_item WHERE id = ?`, id);
	return record === undefined ? undefined : fromRecord(record);
}

export function requireTask(db: AppDb, id: string): TaskRow {
	const row = getTask(db, id);
	if (row === undefined) throw new Error(`No task '${id}'. list_tasks shows the ids that exist.`);
	return row;
}

export type TaskFilter = {
	status: "open" | "done" | "all";
	dueBefore?: number;
	dueAfter?: number;
	limit: number;
};

/** Matching tasks, soonest due first (no due date last), and how many matched before the limit. */
export function listTasks(db: AppDb, filter: TaskFilter): { tasks: TaskRow[]; total: number } {
	const where: string[] = [];
	const params: Array<string | number> = [];
	if (filter.status !== "all") {
		where.push("status = ?");
		params.push(filter.status);
	}
	if (filter.dueBefore !== undefined) {
		where.push("due_at IS NOT NULL AND due_at <= ?");
		params.push(filter.dueBefore);
	}
	if (filter.dueAfter !== undefined) {
		where.push("due_at IS NOT NULL AND due_at >= ?");
		params.push(filter.dueAfter);
	}
	const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
	const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks_item ${clause}`, ...params)?.n ?? 0;
	const tasks = db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM tasks_item ${clause} ORDER BY due_at IS NULL, due_at, created_at, id LIMIT ?`,
			...params,
			filter.limit,
		)
		.map(fromRecord);
	return { tasks, total };
}

/** What the prompt section needs: how many tasks are open and the next few that have a due date. */
export function openSummary(db: AppDb, nextCount: number): { open: number; next: TaskRow[] } {
	const open = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks_item WHERE status = 'open'")?.n ?? 0;
	const next = db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM tasks_item WHERE status = 'open' AND due_at IS NOT NULL ORDER BY due_at, id LIMIT ?`,
			nextCount,
		)
		.map(fromRecord);
	return { open, next };
}

/**
 * Open tasks whose reminder has already been sent, most recent first, and how many there are in all. The prompt section
 * lists the latest few, so that "snooze it" or "done" has something to refer to without the reminder card being in the
 * model's context (the card is display-only: a write that carries model text can start a run).
 */
export function sentReminders(db: AppDb, limit: number): { total: number; recent: TaskRow[] } {
	const total =
		db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks_item WHERE status = 'open' AND reminded_at IS NOT NULL")
			?.n ?? 0;
	const recent = db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM tasks_item WHERE status = 'open' AND reminded_at IS NOT NULL
			 ORDER BY reminded_at DESC, id LIMIT ?`,
			limit,
		)
		.map(fromRecord);
	return { total, recent };
}

/** Every open task whose reminder has not fired: what startup must make sure has a live timer. */
export function pendingReminders(db: AppDb): TaskRow[] {
	return db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM tasks_item WHERE status = 'open' AND remind_at IS NOT NULL AND reminded_at IS NULL ORDER BY remind_at, id`,
		)
		.map(fromRecord);
}

export type TaskChange = {
	title?: string;
	notes?: string;
	/** `null` clears it. */
	due?: { at: number; allDay: boolean } | null;
	/** `null` clears the reminder; a number replaces it and makes it due to fire again. */
	remindAt?: number | null;
};

/**
 * Record that tool call `callId` applied `change` to the task, in one transaction, or report that it already had.
 * `applied` is false for a replay, in which case nothing changed. Returns the row as it stands afterwards, and the
 * Durable task that had been scheduled for the old reminder (to abort once this is committed).
 */
export function applyChange(
	db: AppDb,
	taskId: string,
	change: TaskChange,
	callId: string,
	tool: string,
	now: number,
): { applied: boolean; row: TaskRow; replacedDurableTaskId?: number } {
	return db.transaction(() => {
		const before = requireTask(db, taskId);
		if (!recordCall(db, callId, tool, taskId, now)) return { applied: false, row: before };

		const sets: string[] = ["updated_at = ?"];
		const params: Array<string | number | null> = [now];
		if (change.title !== undefined) {
			sets.push("title = ?");
			params.push(change.title);
		}
		if (change.notes !== undefined) {
			sets.push("notes = ?");
			params.push(change.notes);
		}
		if (change.due !== undefined) {
			sets.push("due_at = ?", "due_all_day = ?");
			params.push(change.due === null ? null : change.due.at, change.due?.allDay ? 1 : 0);
		}
		let replacedDurableTaskId: number | undefined;
		if (change.remindAt !== undefined) {
			// The bump makes every reminder task created so far stale at once, before any new one exists.
			sets.push("remind_at = ?", "reminded_at = NULL", "durable_task_id = NULL", "remind_gen = remind_gen + 1");
			params.push(change.remindAt);
			replacedDurableTaskId = before.durableTaskId;
		}
		db.run(`UPDATE tasks_item SET ${sets.join(", ")} WHERE id = ?`, ...params, taskId);
		return {
			applied: true,
			row: requireTask(db, taskId),
			...optional("replacedDurableTaskId", replacedDurableTaskId ?? null),
		};
	});
}

/** Mark a task done (keeping the first completion time). Same replay rule as {@link applyChange}. */
export function completeTask(
	db: AppDb,
	taskId: string,
	callId: string,
	now: number,
): { applied: boolean; row: TaskRow; replacedDurableTaskId?: number } {
	return db.transaction(() => {
		const before = requireTask(db, taskId);
		if (!recordCall(db, callId, "complete_task", taskId, now)) return { applied: false, row: before };
		db.run(
			"UPDATE tasks_item SET status = 'done', done_at = COALESCE(done_at, ?), updated_at = ?, durable_task_id = NULL, remind_gen = remind_gen + 1 WHERE id = ? AND status = 'open'",
			now,
			now,
			taskId,
		);
		return {
			applied: true,
			row: requireTask(db, taskId),
			...optional("replacedDurableTaskId", before.status === "open" ? (before.durableTaskId ?? null) : null),
		};
	});
}

/** Remove a task for good, returning the Durable task to abort. Idempotent: deleting a missing task is a no-op. */
export function deleteTask(db: AppDb, taskId: string): { deleted: boolean; durableTaskId?: number } {
	return db.transaction(() => {
		const row = getTask(db, taskId);
		if (row === undefined) return { deleted: false };
		db.run("DELETE FROM tasks_item WHERE id = ?", taskId);
		return { deleted: true, ...optional("durableTaskId", row.durableTaskId ?? null) };
	});
}

/** The task that tool call `callId` already created (`add_task`), if any. */
export function findByCallId(db: AppDb, callId: string): TaskRow | undefined {
	const record = db.get<DbRow>(`SELECT ${COLUMNS} FROM tasks_item WHERE source_call_id = ?`, callId);
	return record === undefined ? undefined : fromRecord(record);
}

/** The task that tool call `callId` already changed (`update_task`, `snooze_reminder`, `complete_task`), if any. */
export function findChangedByCall(db: AppDb, callId: string): { tool: string; taskId: string } | undefined {
	const record = db.get<{ tool: string; task_id: string | null }>(
		"SELECT tool, task_id FROM tasks_call WHERE source_call_id = ?",
		callId,
	);
	return record?.task_id == null ? undefined : { tool: record.tool, taskId: record.task_id };
}

/** First write wins: false when this call id was already recorded. */
function recordCall(db: AppDb, callId: string, tool: string, taskId: string, now: number): boolean {
	return (
		db.run(
			"INSERT INTO tasks_call (source_call_id, tool, task_id, applied_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
			callId,
			tool,
			taskId,
			now,
		).changes > 0
	);
}

/**
 * Take the next reminder generation for a task that wants a timer, or undefined when it does not (done, deleted, no
 * reminder, already has a timer, already fired). Called right before a Durable task is created for the row.
 */
export function takeGeneration(
	db: AppDb,
	taskId: string,
): { gen: number; remindAt: number; conversationId: number } | undefined {
	return db.transaction(() => {
		const result = db.run(
			`UPDATE tasks_item SET remind_gen = remind_gen + 1
			 WHERE id = ? AND status = 'open' AND remind_at IS NOT NULL AND reminded_at IS NULL AND durable_task_id IS NULL`,
			taskId,
		);
		if (result.changes === 0) return undefined;
		const row = requireTask(db, taskId);
		return { gen: row.remindGen, remindAt: row.remindAt as number, conversationId: row.conversationId };
	});
}

/** Remember which Durable task fires generation `gen`. False when the row moved on meanwhile (the task is stale). */
export function attachDurableTask(db: AppDb, taskId: string, gen: number, durableTaskId: number): boolean {
	return (
		db.run(
			"UPDATE tasks_item SET durable_task_id = ? WHERE id = ? AND remind_gen = ? AND durable_task_id IS NULL",
			durableTaskId,
			taskId,
			gen,
		).changes > 0
	);
}

/** Forget a Durable task that is gone (lost in a power cut), so a new one can be scheduled. */
export function detachDurableTask(db: AppDb, taskId: string, durableTaskId: number): void {
	db.run("UPDATE tasks_item SET durable_task_id = NULL WHERE id = ? AND durable_task_id = ?", taskId, durableTaskId);
}

/** Record that the reminder of generation `gen` has been posted. Safe to repeat. */
export function markReminded(db: AppDb, taskId: string, gen: number, now: number): void {
	db.run(
		"UPDATE tasks_item SET reminded_at = COALESCE(reminded_at, ?) WHERE id = ? AND remind_gen = ?",
		now,
		taskId,
		gen,
	);
}

/**
 * Is this the reminder the task row currently wants? A stale Durable task (rescheduled, completed, deleted) is not.
 *
 * Whether the reminder was already sent (`reminded_at`) is deliberately not part of the question. A generation belongs
 * to exactly one timer, so "this timer is running" already means "this reminder has not been delivered by anyone else".
 * The flag lives in `app.sqlite` (synchronous=FULL), and Durable's database (synchronous=NORMAL) can come back from a
 * power cut older than it: the same timer is then back before its card was written while the row already says "sent".
 * Treating that timer as superseded would lose the reminder from the thread; letting it run posts the card again, which
 * is idempotent by `requestId`, and sends the push again, which the design accepts (a duplicate beats a lost reminder).
 */
export function isCurrentReminder(row: TaskRow | undefined, input: { gen: number; at: number }): row is TaskRow {
	return row !== undefined && row.status === "open" && row.remindGen === input.gen && row.remindAt === input.at;
}
