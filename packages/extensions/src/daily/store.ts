import type { AppDb } from "@assistant/db";
import type { Occurrence } from "./occurrence.ts";

/** One row of `schedule_daily`, in the shapes the rest of the code uses (camelCase, absent instead of NULL). */
export type ScheduleRow = {
	job: string;
	localTime: string;
	enabled: boolean;
	dueDate: string;
	dueAt: number;
	lastRunDate?: string;
	lastRunAt?: number;
	gen: number;
	durableTaskId?: number;
	updatedAt: number;
};

type ScheduleDbRow = {
	job: string;
	local_time: string;
	enabled: number;
	due_date: string;
	due_at: number;
	last_run_date: string | null;
	last_run_at: number | null;
	gen: number;
	durable_task_id: number | null;
	updated_at: number;
};

const COLUMNS =
	"job, local_time, enabled, due_date, due_at, last_run_date, last_run_at, gen, durable_task_id, updated_at";

function scheduleFrom(record: ScheduleDbRow): ScheduleRow {
	return {
		job: record.job,
		localTime: record.local_time,
		enabled: record.enabled === 1,
		dueDate: record.due_date,
		dueAt: record.due_at,
		gen: record.gen,
		updatedAt: record.updated_at,
		...(record.last_run_date === null ? {} : { lastRunDate: record.last_run_date }),
		...(record.last_run_at === null ? {} : { lastRunAt: record.last_run_at }),
		...(record.durable_task_id === null ? {} : { durableTaskId: record.durable_task_id }),
	};
}

export function getSchedule(db: AppDb, job: string): ScheduleRow | undefined {
	const record = db.get<ScheduleDbRow>(`SELECT ${COLUMNS} FROM schedule_daily WHERE job = ?`, job);
	return record === undefined ? undefined : scheduleFrom(record);
}

export function listSchedules(db: AppDb): ScheduleRow[] {
	return db.all<ScheduleDbRow>(`SELECT ${COLUMNS} FROM schedule_daily ORDER BY job`).map(scheduleFrom);
}

/** Create the row of a job that has none, with its first run. False when the row already existed (it is never replaced). */
export function insertSchedule(
	db: AppDb,
	input: { job: string; localTime: string; enabled: boolean; next: Occurrence; now: number },
): boolean {
	return (
		db.run(
			`INSERT INTO schedule_daily (job, local_time, enabled, due_date, due_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
			input.job,
			input.localTime,
			input.enabled ? 1 : 0,
			input.next.date,
			input.next.at,
			input.now,
		).changes > 0
	);
}

/**
 * Apply what the owner changed in the settings. A change of time or of on/off takes a new generation in the same
 * transaction, so the timer that waits for the old run is stale at once; `next` is the run it now waits for.
 * `replacedDurableTaskId` is that timer, to abort once this is committed.
 */
export function changeSchedule(
	db: AppDb,
	job: string,
	change: { localTime: string; enabled: boolean; next: Occurrence },
	now: number,
): { row: ScheduleRow; replacedDurableTaskId?: number } {
	return db.transaction(() => {
		const before = requireSchedule(db, job);
		db.run(
			`UPDATE schedule_daily SET local_time = ?, enabled = ?, due_date = ?, due_at = ?,
			                           durable_task_id = NULL, gen = gen + 1, updated_at = ?
			 WHERE job = ?`,
			change.localTime,
			change.enabled ? 1 : 0,
			change.next.date,
			change.next.at,
			now,
			job,
		);
		return {
			row: requireSchedule(db, job),
			...(before.durableTaskId === undefined ? {} : { replacedDurableTaskId: before.durableTaskId }),
		};
	});
}

export function requireSchedule(db: AppDb, job: string): ScheduleRow {
	const row = getSchedule(db, job);
	if (row === undefined) throw new Error(`No daily job '${job}' is scheduled.`);
	return row;
}

/** Every job that wants a timer: the ones that are on. */
export function pendingTimers(db: AppDb): ScheduleRow[] {
	return db
		.all<ScheduleDbRow>(`SELECT ${COLUMNS} FROM schedule_daily WHERE enabled = 1 ORDER BY job`)
		.map(scheduleFrom);
}

/** Take the next timer generation for a job that is on and has no timer, or undefined when it needs none. */
export function takeGeneration(db: AppDb, job: string): { gen: number } | undefined {
	return db.transaction(() => {
		const result = db.run(
			"UPDATE schedule_daily SET gen = gen + 1 WHERE job = ? AND enabled = 1 AND durable_task_id IS NULL",
			job,
		);
		return result.changes === 0 ? undefined : { gen: requireSchedule(db, job).gen };
	});
}

/** Remember which Durable task serves generation `gen`. False when the row moved on meanwhile (the task is stale). */
export function attachDurableTask(db: AppDb, job: string, gen: number, durableTaskId: number): boolean {
	return (
		db.run(
			"UPDATE schedule_daily SET durable_task_id = ? WHERE job = ? AND gen = ? AND durable_task_id IS NULL",
			durableTaskId,
			job,
			gen,
		).changes > 0
	);
}

/** Forget a Durable task that is gone (lost in a power cut), so a new one can be scheduled. */
export function detachDurableTask(db: AppDb, job: string, durableTaskId: number): void {
	db.run("UPDATE schedule_daily SET durable_task_id = NULL WHERE job = ? AND durable_task_id = ?", job, durableTaskId);
}

/** Is this the timer the row currently wants? A stale one (time changed, switched off, run done) is not. */
export function isCurrent(row: ScheduleRow | undefined, input: { gen: number }): row is ScheduleRow {
	return row?.enabled === true && row.gen === input.gen;
}

/**
 * Move on to the next run when this one is over: the run it waits for now, a new generation (which makes the finishing
 * timer stale) and no timer yet. `ran` records the day as done, so that it never runs twice. False when the row moved
 * on meanwhile; then the finishing timer must not schedule anything.
 */
export function advance(
	db: AppDb,
	job: string,
	gen: number,
	step: { next: Occurrence; ran?: { date: string; at: number }; now: number },
): boolean {
	return (
		db.run(
			`UPDATE schedule_daily SET due_date = ?, due_at = ?,
			                           last_run_date = COALESCE(?, last_run_date), last_run_at = COALESCE(?, last_run_at),
			                           durable_task_id = NULL, gen = gen + 1, updated_at = ?
			 WHERE job = ? AND gen = ?`,
			step.next.date,
			step.next.at,
			step.ran?.date ?? null,
			step.ran?.at ?? null,
			step.now,
			job,
			gen,
		).changes > 0
	);
}

/** One day of the journal, in the shapes the rest of the code uses. */
export type JournalRow = {
	date: string;
	/** Absent while the wrap-up of that day waits for the owner's answer. */
	userLog?: string;
	autoSummary: string;
	carriedOver: string[];
	askedAt?: number;
	savedAt?: number;
	updatedAt: number;
};

type JournalDbRow = {
	date: string;
	user_log: string | null;
	auto_summary: string;
	carried_over_json: string;
	asked_at: number | null;
	saved_at: number | null;
	updated_at: number;
};

const JOURNAL_COLUMNS = "date, user_log, auto_summary, carried_over_json, asked_at, saved_at, updated_at";

function journalFrom(record: JournalDbRow): JournalRow {
	return {
		date: record.date,
		autoSummary: record.auto_summary,
		carriedOver: parseCarriedOver(record.carried_over_json),
		updatedAt: record.updated_at,
		...(record.user_log === null ? {} : { userLog: record.user_log }),
		...(record.asked_at === null ? {} : { askedAt: record.asked_at }),
		...(record.saved_at === null ? {} : { savedAt: record.saved_at }),
	};
}

/** What the column holds is only ever written by this file; anything else reads as nothing carried over. */
function parseCarriedOver(json: string): string[] {
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

export function getJournal(db: AppDb, date: string): JournalRow | undefined {
	const record = db.get<JournalDbRow>(`SELECT ${JOURNAL_COLUMNS} FROM pa_journal WHERE date = ?`, date);
	return record === undefined ? undefined : journalFrom(record);
}

/** The days from `from` to `to` (both included) that have a journal row, oldest first. */
export function journalBetween(db: AppDb, from: string, to: string): JournalRow[] {
	return db
		.all<JournalDbRow>(
			`SELECT ${JOURNAL_COLUMNS} FROM pa_journal WHERE date >= ? AND date <= ? ORDER BY date`,
			from,
			to,
		)
		.map(journalFrom);
}

/**
 * The last journal day from `from` to `to` (both included) that the owner answered, when it carries something over:
 * what the next morning's briefing brings forward. It is the last *answered* day, not the last day with items: a later
 * answer that carries nothing ("sent the invoice, everything is done") clears the list, and older items must not return.
 */
export function latestCarryOver(db: AppDb, from: string, to: string): JournalRow | undefined {
	const last = journalBetween(db, from, to)
		.filter((row) => row.userLog !== undefined)
		.at(-1);
	return last !== undefined && last.carriedOver.length > 0 ? last : undefined;
}

/**
 * Wrap-up days that were asked and that the owner has not answered, newest first, from `since` on. The prompt section
 * tells the model which day "I got the report done" belongs to.
 */
export function unansweredWrapups(db: AppDb, since: string): JournalRow[] {
	return db
		.all<JournalDbRow>(
			`SELECT ${JOURNAL_COLUMNS} FROM pa_journal WHERE user_log IS NULL AND asked_at IS NOT NULL AND date >= ? ORDER BY date DESC`,
			since,
		)
		.map(journalFrom);
}

/**
 * Remember that the wrap-up of `date` was asked, with the facts it was asked with. The owner's answer (and with it what
 * carries over) is never touched: a wrap-up that is asked again, after a repair, only refreshes the summary.
 */
export function recordWrapupAsked(db: AppDb, date: string, autoSummary: string, now: number): void {
	db.run(
		`INSERT INTO pa_journal (date, auto_summary, asked_at, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (date) DO UPDATE SET asked_at = COALESCE(asked_at, excluded.asked_at),
		                                  auto_summary = excluded.auto_summary, updated_at = excluded.updated_at`,
		date,
		autoSummary,
		now,
		now,
	);
}

export type JournalSave = { date: string; userLog: string; carriedOver: readonly string[] };

/** The journal day that tool call `callId` already saved, if any. */
export function findSavedByCall(db: AppDb, callId: string): string | undefined {
	return (
		db.get<{ subject: string | null }>(
			"SELECT subject FROM daily_call WHERE source_call_id = ? AND tool = 'save_journal'",
			callId,
		)?.subject ?? undefined
	);
}

/**
 * Save what the owner said about `date`, in one transaction with the call ledger entry: a call that Durable replays
 * after a crash is recognised and changes nothing (`applied` false). A later call for the same day replaces the earlier
 * answer (`replaced`): the owner added something, or corrected it.
 */
export function saveJournal(
	db: AppDb,
	save: JournalSave,
	callId: string,
	now: number,
): { applied: boolean; replaced: boolean; row: JournalRow } {
	return db.transaction(() => {
		const before = getJournal(db, save.date);
		const recorded = db.run(
			"INSERT INTO daily_call (source_call_id, tool, subject, applied_at) VALUES (?, 'save_journal', ?, ?) ON CONFLICT DO NOTHING",
			callId,
			save.date,
			now,
		);
		if (recorded.changes === 0 && before !== undefined) return { applied: false, replaced: false, row: before };
		db.run(
			`INSERT INTO pa_journal (date, user_log, carried_over_json, saved_at, updated_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (date) DO UPDATE SET user_log = excluded.user_log, carried_over_json = excluded.carried_over_json,
			                                  saved_at = excluded.saved_at, updated_at = excluded.updated_at`,
			save.date,
			save.userLog,
			JSON.stringify(save.carriedOver),
			now,
			now,
		);
		const row = getJournal(db, save.date);
		if (row === undefined) throw new Error(`The journal of ${save.date} was not saved. This should be impossible.`);
		return { applied: true, replaced: before?.userLog !== undefined, row };
	});
}
