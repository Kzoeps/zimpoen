import { randomBytes } from "node:crypto";
import type { AppDb } from "@assistant/db";
import type { ExerciseKind } from "@assistant/shared";
import { bestMatch, exerciseKey, findInCatalog, tidyExerciseName } from "./catalog.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Body weight
// ---------------------------------------------------------------------------------------------------------------------

/** One weighing: `date` is the owner's local calendar day, `kg` kilograms. */
export type WeightRow = { date: string; kg: number; note: string; createdAt: number; updatedAt: number };

type WeightRecord = { measured_on: string; kg: number; note: string; created_at: number; updated_at: number };

const WEIGHT_COLUMNS = "measured_on, kg, note, created_at, updated_at";

const weightOf = (record: WeightRecord): WeightRow => ({
	date: record.measured_on,
	kg: record.kg,
	note: record.note,
	createdAt: record.created_at,
	updatedAt: record.updated_at,
});

export function getWeight(db: AppDb, date: string): WeightRow | undefined {
	const record = db.get<WeightRecord>(`SELECT ${WEIGHT_COLUMNS} FROM health_weight WHERE measured_on = ?`, date);
	return record === undefined ? undefined : weightOf(record);
}

/** The weighing that tool call `callId` inserted, if any. */
export function weightByCallId(db: AppDb, callId: string): WeightRow | undefined {
	const record = db.get<WeightRecord>(`SELECT ${WEIGHT_COLUMNS} FROM health_weight WHERE source_call_id = ?`, callId);
	return record === undefined ? undefined : weightOf(record);
}

export type NewWeight = { date: string; kg: number; note: string; now: number };

/**
 * Insert the weighing of a day that has none, for tool call `callId`; or return what that call already inserted. The
 * caller has checked that the day is free, and this is one process, so a conflict on the day means the row is the
 * call's own earlier insert.
 */
export function insertWeight(db: AppDb, input: NewWeight, callId: string): { row: WeightRow; created: boolean } {
	const result = db.run(
		`INSERT INTO health_weight (measured_on, kg, note, source_call_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
		input.date,
		input.kg,
		input.note,
		callId,
		input.now,
		input.now,
	);
	const row = weightByCallId(db, callId) ?? getWeight(db, input.date);
	if (row === undefined) throw new Error(`Could not save the weight of ${input.date}. Check health_weight.`);
	return { row, created: result.changes > 0 };
}

/**
 * Replace the weighing of a day by tool call `callId`, once: the call id goes into the ledger in the same transaction,
 * so a replay of the call finds it there and changes nothing (`applied` is false), and a later correction is not undone
 * by it. A `note` of undefined keeps the note that is there.
 */
export function replaceWeight(
	db: AppDb,
	date: string,
	change: { kg: number; note?: string },
	callId: string,
	now: number,
): { applied: boolean; row: WeightRow } {
	return db.transaction(() => {
		const before = getWeight(db, date);
		if (before === undefined) throw new Error(`No weight is logged for ${date}, so there is nothing to replace.`);
		if (!recordCall(db, callId, "log_weight", date, now)) return { applied: false, row: before };
		db.run(
			"UPDATE health_weight SET kg = ?, note = ?, updated_at = ? WHERE measured_on = ?",
			change.kg,
			change.note ?? before.note,
			now,
			date,
		);
		return { applied: true, row: getWeight(db, date) as WeightRow };
	});
}

/** The day a ledger call touched, if the call is in the ledger. */
export function findCall(db: AppDb, callId: string): { tool: string; subject: string } | undefined {
	return db.get<{ tool: string; subject: string }>(
		"SELECT tool, subject FROM health_call WHERE source_call_id = ?",
		callId,
	);
}

/** First write wins: false when this call id was already recorded. */
function recordCall(db: AppDb, callId: string, tool: string, subject: string, now: number): boolean {
	return (
		db.run(
			"INSERT INTO health_call (source_call_id, tool, subject, applied_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
			callId,
			tool,
			subject,
			now,
		).changes > 0
	);
}

/** Weighings from `from` (or the beginning) to `to`, oldest first. */
export function weightsBetween(db: AppDb, from: string | undefined, to: string): WeightRow[] {
	return db
		.all<WeightRecord>(
			`SELECT ${WEIGHT_COLUMNS} FROM health_weight WHERE measured_on >= ? AND measured_on <= ? ORDER BY measured_on`,
			from ?? "0000-01-01",
			to,
		)
		.map(weightOf);
}

/** The latest weighing, or the latest on or before `date`. */
export function latestWeight(db: AppDb, onOrBefore = "9999-12-31"): WeightRow | undefined {
	const record = db.get<WeightRecord>(
		`SELECT ${WEIGHT_COLUMNS} FROM health_weight WHERE measured_on <= ? ORDER BY measured_on DESC LIMIT 1`,
		onOrBefore,
	);
	return record === undefined ? undefined : weightOf(record);
}

/** The weighing before `date`, whichever day it was. */
export function weightBefore(db: AppDb, date: string): WeightRow | undefined {
	const record = db.get<WeightRecord>(
		`SELECT ${WEIGHT_COLUMNS} FROM health_weight WHERE measured_on < ? ORDER BY measured_on DESC LIMIT 1`,
		date,
	);
	return record === undefined ? undefined : weightOf(record);
}

/** Remove the weighing of a day. Idempotent: false when there was none. */
export function deleteWeight(db: AppDb, date: string): boolean {
	return db.run("DELETE FROM health_weight WHERE measured_on = ?", date).changes > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------------------------------------------------

export type ExerciseRow = {
	id: number;
	name: string;
	key: string;
	aliases: string[];
	kind: ExerciseKind;
	createdAt: number;
};

type ExerciseRecord = {
	id: number;
	name: string;
	key: string;
	aliases: string;
	kind: ExerciseKind;
	created_at: number;
};

const EXERCISE_COLUMNS = "id, name, key, aliases, kind, created_at";

const exerciseOf = (record: ExerciseRecord): ExerciseRow => ({
	id: record.id,
	name: record.name,
	key: record.key,
	aliases: JSON.parse(record.aliases) as string[],
	kind: record.kind,
	createdAt: record.created_at,
});

/** Every exercise, by name. A personal log has tens of them. */
export function listExercises(db: AppDb): ExerciseRow[] {
	return db
		.all<ExerciseRecord>(`SELECT ${EXERCISE_COLUMNS} FROM health_exercise ORDER BY name COLLATE NOCASE, id`)
		.map(exerciseOf);
}

/** The exercise a typed name stands for: its name or one of its aliases, ignoring case, spacing, punctuation and plurals. */
export function findExercise(db: AppDb, typed: string): ExerciseRow | undefined {
	return bestMatch(typed, listExercises(db), (row) => [row.name, ...row.aliases]);
}

/** Exercises that have at least one set, most recently trained first (ties by name), with the day of their latest set. */
export function recentExercises(db: AppDb, limit?: number): Array<{ exercise: ExerciseRow; lastDate: string }> {
	const records = db.all<ExerciseRecord & { last_date: string }>(
		`SELECT e.id, e.name, e.key, e.aliases, e.kind, e.created_at, MAX(s.date) AS last_date
		 FROM health_exercise e
		 JOIN health_set t ON t.exercise_id = e.id
		 JOIN health_session s ON s.id = t.session_id
		 GROUP BY e.id
		 ORDER BY last_date DESC, e.name COLLATE NOCASE, e.id
		 ${limit === undefined ? "" : "LIMIT ?"}`,
		...(limit === undefined ? [] : [limit]),
	);
	return records.map((record) => ({ exercise: exerciseOf(record), lastDate: record.last_date }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Sessions and sets
// ---------------------------------------------------------------------------------------------------------------------

export type SessionRow = { id: string; date: string; note: string; createdAt: number };

type SessionRecord = { id: string; date: string; note: string; created_at: number };

const SESSION_COLUMNS = "id, date, note, created_at";

const sessionOf = (record: SessionRecord): SessionRow => ({
	id: record.id,
	date: record.date,
	note: record.note,
	createdAt: record.created_at,
});

/** Short enough for a model to copy back correctly, long enough that a personal log never collides (retried on PK). */
export const newSessionId = (): string => `w_${randomBytes(4).toString("hex")}`;

export function getSession(db: AppDb, id: string): SessionRow | undefined {
	const record = db.get<SessionRecord>(`SELECT ${SESSION_COLUMNS} FROM health_session WHERE id = ?`, id);
	return record === undefined ? undefined : sessionOf(record);
}

/** The session that tool call `callId` wrote, if any. */
export function sessionByCallId(db: AppDb, callId: string): SessionRow | undefined {
	const record = db.get<SessionRecord>(
		`SELECT ${SESSION_COLUMNS} FROM health_session WHERE source_call_id = ?`,
		callId,
	);
	return record === undefined ? undefined : sessionOf(record);
}

/** A set as stored, with the exercise it belongs to. */
export type SetRow = {
	sessionId: string;
	exerciseId: number;
	setNo: number;
	reps: number;
	kg: number;
	rpe?: number;
};

type SetRecord = {
	session_id: string;
	exercise_id: number;
	set_no: number;
	reps: number;
	kg: number;
	rpe: number | null;
};

const setOf = (record: SetRecord): SetRow => ({
	sessionId: record.session_id,
	exerciseId: record.exercise_id,
	setNo: record.set_no,
	reps: record.reps,
	kg: record.kg,
	...(record.rpe === null ? {} : { rpe: record.rpe }),
});

/** The sets of some sessions, in the order they were done: by session, exercise (first logged first) and set number. */
export function setsOfSessions(db: AppDb, sessionIds: readonly string[]): SetRow[] {
	if (sessionIds.length === 0) return [];
	const marks = sessionIds.map(() => "?").join(", ");
	return db
		.all<SetRecord>(
			`SELECT session_id, exercise_id, set_no, reps, kg, rpe FROM health_set
			 WHERE session_id IN (${marks}) ORDER BY session_id, MIN(id) OVER (PARTITION BY session_id, exercise_id), set_no`,
			...sessionIds,
		)
		.map(setOf);
}

/** Sessions of the days from `from` (or the beginning) to `to`, newest first, and how many there are in all. */
export function sessionsBetween(
	db: AppDb,
	from: string | undefined,
	to: string,
	limit: number,
): { sessions: SessionRow[]; total: number } {
	const params = [from ?? "0000-01-01", to];
	const total =
		db.get<{ n: number }>("SELECT COUNT(*) AS n FROM health_session WHERE date >= ? AND date <= ?", ...params)?.n ?? 0;
	const sessions = db
		.all<SessionRecord>(
			`SELECT ${SESSION_COLUMNS} FROM health_session WHERE date >= ? AND date <= ?
			 ORDER BY date DESC, created_at DESC, id LIMIT ?`,
			...params,
			limit,
		)
		.map(sessionOf);
	return { sessions, total };
}

/** Sessions that took place on one day, in the order they were logged. */
export function sessionsOn(db: AppDb, date: string): SessionRow[] {
	return db
		.all<SessionRecord>(`SELECT ${SESSION_COLUMNS} FROM health_session WHERE date = ? ORDER BY created_at, id`, date)
		.map(sessionOf);
}

/** The day of the latest session on or before `onOrBefore`, or undefined for none. */
export function lastSessionDate(db: AppDb, onOrBefore = "9999-12-31"): string | undefined {
	return (
		db.get<{ date: string | null }>("SELECT MAX(date) AS date FROM health_session WHERE date <= ?", onOrBefore)?.date ??
		undefined
	);
}

export type ExerciseSet = { date: string; reps: number; kg: number; rpe?: number };

type ExerciseSetRecord = { date: string; reps: number; kg: number; rpe: number | null };

const exerciseSetOf = (record: ExerciseSetRecord): ExerciseSet => ({
	date: record.date,
	reps: record.reps,
	kg: record.kg,
	...(record.rpe === null ? {} : { rpe: record.rpe }),
});

/** Every set of an exercise from `from` (or the beginning) to `to`, oldest day first, each with its day. */
export function setsOfExercise(db: AppDb, exerciseId: number, from: string | undefined, to: string): ExerciseSet[] {
	return db
		.all<ExerciseSetRecord>(
			`SELECT s.date, t.reps, t.kg, t.rpe FROM health_set t JOIN health_session s ON s.id = t.session_id
			 WHERE t.exercise_id = ? AND s.date >= ? AND s.date <= ?
			 ORDER BY s.date, s.created_at, t.set_no`,
			exerciseId,
			from ?? "0000-01-01",
			to,
		)
		.map(exerciseSetOf);
}

/**
 * The exercises with at least one set that carried added weight. It decides whether a bodyweight exercise is measured by
 * its repetitions or by its load (`metricFor`), so it looks at the whole history, not at a range.
 */
export function loadedExerciseIds(db: AppDb): Set<number> {
	return new Set(
		db
			.all<{ exercise_id: number }>("SELECT DISTINCT exercise_id FROM health_set WHERE kg > 0")
			.map((row) => row.exercise_id),
	);
}

/** What `insertWorkout` needs: sets are final (kg already converted, `count` already expanded). */
export type WorkoutInput = {
	date: string;
	note: string;
	now: number;
	exercises: Array<{ typed: string; sets: Array<{ reps: number; kg: number; rpe?: number }> }>;
};

/**
 * Write one workout for tool call `callId`: the session, any exercise it needs that does not exist yet, and every set,
 * in one transaction. All or nothing is what makes a rerun after a crash safe (rule 8): either the session is there,
 * complete, and the call returns it, or nothing is and the call writes it whole. Each set also carries its own key,
 * `<call id>:<n>`, so even a half-written session could not be written twice. `created` is false for a rerun.
 */
export function insertWorkout(
	db: AppDb,
	input: WorkoutInput,
	callId: string,
): { session: SessionRow; created: boolean } {
	return db.transaction(() => {
		const earlier = sessionByCallId(db, callId);
		if (earlier !== undefined) return { session: earlier, created: false };

		const session = insertSession(db, input, callId);
		let n = 0;
		for (const item of input.exercises) {
			const exercise = resolveExercise(db, item.typed, inferKind(item.sets), input.now);
			// An exercise typed twice in one call is one exercise: its sets go on from where the first ones stopped.
			let setNo =
				(db.get<{ n: number }>(
					"SELECT MAX(set_no) AS n FROM health_set WHERE session_id = ? AND exercise_id = ?",
					session.id,
					exercise.id,
				)?.n ?? 0) + 1;
			for (const set of item.sets) {
				n++;
				db.run(
					`INSERT INTO health_set (session_id, exercise_id, set_no, reps, kg, rpe, source_call_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
					session.id,
					exercise.id,
					setNo++,
					set.reps,
					set.kg,
					set.rpe ?? null,
					`${callId}:${n}`,
				);
			}
		}
		return { session, created: true };
	});
}

/** What a workout did to one exercise it touched: what to tell the owner besides the sets. */
export type WrittenExercise = {
	exercise: ExerciseRow;
	/** The workout is where the exercise was first named: it was not among the owner's exercises or the built-in names. */
	created: boolean;
	/** The sets of this exercise logged before the workout, on its day or earlier: what a record is judged against. */
	earlier: ExerciseSet[];
};

/**
 * What the sets on disk say a workout did to each exercise it touched, in the order it touched them. The same answer on
 * the first run and on a rerun after a crash (rule 8), because it is read from the database and not remembered: the
 * sets before a workout are those of the sessions written before it (by row order, so two sessions made in one
 * millisecond still have an order) and dated no later than it, and an exercise is new when nothing came before it and it
 * was made with the session. Judging against every set up to the workout's own day, earlier sessions of that day
 * included, is per session: a second session on a day can announce a record of its own, which the day as a whole
 * (`exercise_progress`, the wrap-up) counts once.
 */
export function writtenOfSession(db: AppDb, session: SessionRow): WrittenExercise[] {
	const position = db.get<{ rowid: number }>("SELECT rowid FROM health_session WHERE id = ?", session.id)?.rowid ?? 0;
	const ids = [...new Set(setsOfSessions(db, [session.id]).map((set) => set.exerciseId))];
	return ids.flatMap((id) => {
		const exercise = getExercise(db, id);
		if (exercise === undefined) return [];
		const earlier = db
			.all<ExerciseSetRecord>(
				`SELECT s.date, t.reps, t.kg, t.rpe FROM health_set t JOIN health_session s ON s.id = t.session_id
				 WHERE t.exercise_id = ? AND s.rowid < ? AND s.date <= ?
				 ORDER BY s.date, s.rowid, t.set_no`,
				id,
				position,
				session.date,
			)
			.map(exerciseSetOf);
		const created =
			earlier.length === 0 && exercise.createdAt === session.createdAt && findInCatalog(exercise.name) === undefined;
		return [{ exercise, created, earlier }];
	});
}

/**
 * A new exercise whose sets all carry no weight is a bodyweight one; anything else is weighted. A bodyweight exercise may
 * still be logged with added weight later (a belt, a vest): its progress then follows the load (`metricFor`).
 */
const inferKind = (sets: ReadonlyArray<{ kg: number }>): ExerciseKind =>
	sets.every((set) => set.kg === 0) ? "bodyweight" : "weighted";

function insertSession(db: AppDb, input: WorkoutInput, callId: string): SessionRow {
	for (let attempt = 0; attempt < 5; attempt++) {
		const id = newSessionId();
		const result = db.run(
			"INSERT INTO health_session (id, date, note, source_call_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
			id,
			input.date,
			input.note,
			callId,
			input.now,
		);
		if (result.changes > 0) return getSession(db, id) as SessionRow;
	}
	throw new Error("Could not find a free workout id after 5 tries. This should be impossible; check health_session.");
}

/**
 * The exercise a typed name stands for: one the owner already has (a built-in one they renamed included), else one from
 * the built-in list (created now, with the list's name, aliases and kind), else a new exercise under the name as typed.
 */
function resolveExercise(db: AppDb, typed: string, inferred: ExerciseKind, now: number): ExerciseRow {
	const existing = findExercise(db, typed);
	if (existing !== undefined) return existing;
	const known = findInCatalog(typed);
	const renamed = known === undefined ? undefined : findExercise(db, known.name);
	if (renamed !== undefined) return renamed;
	const name = known?.name ?? tidyExerciseName(typed);
	const key = exerciseKey(name);
	if (key === "") throw new Error(`'${typed.slice(0, 40)}' is not an exercise name: it has no letters or digits.`);
	db.run(
		"INSERT INTO health_exercise (name, key, aliases, kind, created_at) VALUES (?, ?, ?, ?, ?)",
		name,
		key,
		JSON.stringify(known?.aliases ?? []),
		known?.kind ?? inferred,
		now,
	);
	return findExercise(db, name) as ExerciseRow;
}

/**
 * Remove a session and its sets, and the exercises that were left with no set at all (a wrong name typed once should
 * not stay in the list). Idempotent: false when the session is gone.
 */
export function deleteSession(db: AppDb, id: string): boolean {
	return db.transaction(() => {
		const touched = db
			.all<{ exercise_id: number }>("SELECT DISTINCT exercise_id FROM health_set WHERE session_id = ?", id)
			.map((row) => row.exercise_id);
		const deleted = db.run("DELETE FROM health_session WHERE id = ?", id).changes > 0;
		for (const exerciseId of touched) {
			db.run(
				"DELETE FROM health_exercise WHERE id = ? AND NOT EXISTS (SELECT 1 FROM health_set WHERE exercise_id = ?)",
				exerciseId,
				exerciseId,
			);
		}
		return deleted;
	});
}

export function getExercise(db: AppDb, id: number): ExerciseRow | undefined {
	const record = db.get<ExerciseRecord>(`SELECT ${EXERCISE_COLUMNS} FROM health_exercise WHERE id = ?`, id);
	return record === undefined ? undefined : exerciseOf(record);
}

// ---------------------------------------------------------------------------------------------------------------------
// Renaming and merging exercises
// ---------------------------------------------------------------------------------------------------------------------

/** Another exercise (not `id`) that a typed name already stands for: its name or an alias, ignoring case, spacing and plurals. */
export function otherExerciseNamed(db: AppDb, id: number, typed: string): ExerciseRow | undefined {
	return bestMatch(
		typed,
		listExercises(db).filter((row) => row.id !== id),
		(row) => [row.name, ...row.aliases],
	);
}

/** Names without repeats (by `exerciseKey`), none of them the exercise's own name, and none empty. */
function aliasesWithout(names: readonly string[], ownName: string): string[] {
	const seen = new Set([exerciseKey(ownName)]);
	return names.filter((name) => {
		const key = exerciseKey(name);
		if (key === "" || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Give an exercise another name, for tool call `callId`, once. The old name stays an alias, so `bench` still finds an
 * exercise renamed "Barbell bench press". The call id goes into the ledger in the same transaction: a replay of the call
 * finds it there and changes nothing (`applied` is false), instead of undoing a rename made since. The caller has checked
 * that no other exercise answers to the new name.
 */
export function renameExercise(
	db: AppDb,
	id: number,
	name: string,
	callId: string,
	now: number,
): { applied: boolean; exercise: ExerciseRow } {
	return db.transaction(() => {
		const before = getExercise(db, id);
		if (before === undefined) throw new Error(`There is no exercise with id ${id} to rename.`);
		if (!recordCall(db, callId, "rename_exercise", String(id), now)) return { applied: false, exercise: before };
		db.run(
			"UPDATE health_exercise SET name = ?, key = ?, aliases = ? WHERE id = ?",
			name,
			exerciseKey(name),
			JSON.stringify(aliasesWithout([before.name, ...before.aliases], name)),
			id,
		);
		return { applied: true, exercise: getExercise(db, id) as ExerciseRow };
	});
}

/** How much a merge moves. */
export type MergePlan = { sets: number; sessions: number };

/**
 * What merging `from` into `to` would move, or why it cannot be done. Sets without a weight cannot join a weighted exercise:
 * its progress line is the estimated 1RM, and they would be zeros in it. The other way round is fine.
 */
export function planMerge(db: AppDb, from: ExerciseRow, into: ExerciseRow): MergePlan {
	if (from.id === into.id)
		throw new Error(`'${from.name}' and '${into.name}' are the same exercise: there is nothing to merge.`);
	const counts = db.get<{ sets: number; sessions: number; unloaded: number }>(
		`SELECT COUNT(*) AS sets, COUNT(DISTINCT session_id) AS sessions, COALESCE(SUM(kg = 0), 0) AS unloaded
		 FROM health_set WHERE exercise_id = ?`,
		from.id,
	) ?? { sets: 0, sessions: 0, unloaded: 0 };
	if (into.kind === "weighted" && counts.unloaded > 0) {
		throw new Error(
			`${from.name} has ${counts.unloaded} ${counts.unloaded === 1 ? "set" : "sets"} with no weight, and ${into.name} is a weighted exercise: ` +
				`they would be zeros in its progress. Merge them the other way round (${into.name} into ${from.name}), or leave them apart.`,
		);
	}
	return { sets: counts.sets, sessions: counts.sessions };
}

/**
 * Move every set of `from` to `into` and remove `from`, which stays as an alias of `into` together with its own aliases.
 * Where a session has sets of both, the moved ones are numbered on after the others. One transaction. Idempotent in the
 * sense the approval needs: a second run finds `from` gone and the caller says so.
 */
export function mergeExercises(db: AppDb, fromId: number, intoId: number): MergePlan {
	return db.transaction(() => {
		const from = getExercise(db, fromId);
		const into = getExercise(db, intoId);
		if (from === undefined || into === undefined)
			throw new Error("One of the two exercises is gone. Nothing was changed.");
		const plan = planMerge(db, from, into);
		const sessionIds = db
			.all<{ session_id: string }>("SELECT DISTINCT session_id FROM health_set WHERE exercise_id = ?", from.id)
			.map((row) => row.session_id);
		for (const sessionId of sessionIds) {
			const offset =
				db.get<{ n: number | null }>(
					"SELECT MAX(set_no) AS n FROM health_set WHERE session_id = ? AND exercise_id = ?",
					sessionId,
					into.id,
				)?.n ?? 0;
			db.run(
				"UPDATE health_set SET exercise_id = ?, set_no = set_no + ? WHERE session_id = ? AND exercise_id = ?",
				into.id,
				offset,
				sessionId,
				from.id,
			);
		}
		db.run("DELETE FROM health_exercise WHERE id = ?", from.id);
		db.run(
			"UPDATE health_exercise SET aliases = ? WHERE id = ?",
			JSON.stringify(aliasesWithout([...into.aliases, from.name, ...from.aliases], into.name)),
			into.id,
		);
		return plan;
	});
}
