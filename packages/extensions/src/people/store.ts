import { randomBytes } from "node:crypto";
import type { AppDb } from "@assistant/db";

/** One row of `people_person`, in the shapes the rest of the code uses (camelCase, absent instead of NULL). */
export type PersonRow = {
	id: string;
	name: string;
	relation: string;
	birthdayMd: string;
	birthdayYear?: number;
	notes: string;
	/** The yearly cycle waiting to run. */
	cycleYear: number;
	/** When to remind; absent when that moment had already passed as the cycle began. */
	remindAt?: number;
	checkAt: number;
	/** The latest morning card: the year of its birthday and when it was posted. Like the question, it outlives the cycle. */
	remindedYear?: number;
	remindedAt?: number;
	/** The latest evening question: the year of its birthday and when it was posted. It outlives the cycle. */
	askedYear?: number;
	askedAt?: number;
	gen: number;
	durableTaskId?: number;
	conversationId: number;
	createdAt: number;
	updatedAt: number;
};

type DbRow = {
	id: string;
	name: string;
	relation: string;
	birthday_md: string;
	birthday_year: number | null;
	notes: string;
	cycle_year: number;
	remind_at: number | null;
	check_at: number;
	reminded_year: number | null;
	reminded_at: number | null;
	asked_year: number | null;
	asked_at: number | null;
	gen: number;
	durable_task_id: number | null;
	conversation_id: number;
	created_at: number;
	updated_at: number;
};

const COLUMNS =
	"id, name, relation, birthday_md, birthday_year, notes, cycle_year, remind_at, check_at, reminded_year, reminded_at, asked_year, asked_at, gen, durable_task_id, conversation_id, created_at, updated_at";

const optional = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } =>
	(value === null ? {} : { [key]: value }) as { [P in K]?: V };

function fromRecord(record: DbRow): PersonRow {
	return {
		id: record.id,
		name: record.name,
		relation: record.relation,
		birthdayMd: record.birthday_md,
		notes: record.notes,
		cycleYear: record.cycle_year,
		checkAt: record.check_at,
		gen: record.gen,
		conversationId: record.conversation_id,
		createdAt: record.created_at,
		updatedAt: record.updated_at,
		...optional("birthdayYear", record.birthday_year),
		...optional("remindAt", record.remind_at),
		...optional("remindedYear", record.reminded_year),
		...optional("remindedAt", record.reminded_at),
		...optional("askedYear", record.asked_year),
		...optional("askedAt", record.asked_at),
		...optional("durableTaskId", record.durable_task_id),
	};
}

/** Short enough for a model to copy back correctly, long enough that a personal list never collides (retried on PK). */
export function newPersonId(): string {
	return `p_${randomBytes(4).toString("hex")}`;
}

/** The cycle a row waits to run, as stored. */
export type CycleRow = { year: number; remindAt?: number; checkAt: number };

export type NewPerson = {
	name: string;
	relation: string;
	birthdayMd: string;
	birthdayYear?: number;
	notes: string;
	cycle: CycleRow;
	conversationId: number;
	createdAt: number;
};

/**
 * Insert a person for tool call `callId`, or return the one that call already inserted. `created` says which happened:
 * Durable may run a replay-safe tool again after a crash, and the second run must find its own row.
 */
export function insertPerson(db: AppDb, input: NewPerson, callId: string): { row: PersonRow; created: boolean } {
	return db.transaction(() => {
		for (let attempt = 0; attempt < 5; attempt++) {
			const id = newPersonId();
			const result = db.run(
				`INSERT INTO people_person (id, name, relation, birthday_md, birthday_year, notes, cycle_year, remind_at, check_at,
				                            conversation_id, source_call_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT DO NOTHING`,
				id,
				input.name,
				input.relation,
				input.birthdayMd,
				input.birthdayYear ?? null,
				input.notes,
				input.cycle.year,
				input.cycle.remindAt ?? null,
				input.cycle.checkAt,
				input.conversationId,
				callId,
				input.createdAt,
				input.createdAt,
			);
			if (result.changes > 0) return { row: requirePerson(db, id), created: true };
			// A conflict is either this call's earlier insert (its unique source_call_id) or, very rarely, an id collision.
			const earlier = findByCallId(db, callId);
			if (earlier !== undefined) return { row: earlier, created: false };
		}
		throw new Error("Could not find a free person id after 5 tries. This should be impossible; check people_person.");
	});
}

export function getPerson(db: AppDb, id: string): PersonRow | undefined {
	const record = db.get<DbRow>(`SELECT ${COLUMNS} FROM people_person WHERE id = ?`, id);
	return record === undefined ? undefined : fromRecord(record);
}

export function requirePerson(db: AppDb, id: string): PersonRow {
	const row = getPerson(db, id);
	if (row === undefined) throw new Error(`No person '${id}'. list_people shows the ids that exist.`);
	return row;
}

/** The person that tool call `callId` already created (`add_person`), if any. */
export function findByCallId(db: AppDb, callId: string): PersonRow | undefined {
	const record = db.get<DbRow>(`SELECT ${COLUMNS} FROM people_person WHERE source_call_id = ?`, callId);
	return record === undefined ? undefined : fromRecord(record);
}

/** The person that tool call `callId` already changed (`update_person`, `record_wish`), if any. */
export function findChangedByCall(db: AppDb, callId: string): { tool: string; personId: string } | undefined {
	const record = db.get<{ tool: string; person_id: string | null }>(
		"SELECT tool, person_id FROM people_call WHERE source_call_id = ?",
		callId,
	);
	return record?.person_id == null ? undefined : { tool: record.tool, personId: record.person_id };
}

/** First write wins: false when this call id was already recorded. */
function recordCall(db: AppDb, callId: string, tool: string, personId: string, now: number): boolean {
	return (
		db.run(
			"INSERT INTO people_call (source_call_id, tool, person_id, applied_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
			callId,
			tool,
			personId,
			now,
		).changes > 0
	);
}

/** Someone with this name (any letter case) and this birthday: the same person, saved twice. */
export function findDuplicate(db: AppDb, name: string, birthdayMd: string): PersonRow | undefined {
	const record = db.get<DbRow>(
		`SELECT ${COLUMNS} FROM people_person WHERE lower(name) = lower(?) AND birthday_md = ? ORDER BY created_at, id LIMIT 1`,
		name,
		birthdayMd,
	);
	return record === undefined ? undefined : fromRecord(record);
}

/** Everyone, by name; `query` keeps those whose name or relation contains it (any letter case). */
export function listPeople(db: AppDb, query?: string): PersonRow[] {
	const needle = query?.trim().toLowerCase();
	const rows = db.all<DbRow>(`SELECT ${COLUMNS} FROM people_person ORDER BY lower(name), id`).map(fromRecord);
	if (needle === undefined || needle === "") return rows;
	return rows.filter((row) => `${row.name} ${row.relation}`.toLowerCase().includes(needle));
}

export type PersonChange = {
	name?: string;
	relation?: string;
	notes?: string;
	/** A different birthday. It starts the yearly cycle over, so it brings the cycle to run next. */
	birthday?: { md: string; year: number | null; cycle: CycleRow };
};

/**
 * Record that tool call `callId` applied `change` to the person, in one transaction, or report that it already had.
 * `applied` is false for a replay, in which case nothing changed. A changed `md` replaces the cycle and makes every timer
 * of the old one stale at once (the generation is bumped before any new timer exists); `replacedDurableTaskId` is the
 * timer to abort once this is committed.
 */
export function applyChange(
	db: AppDb,
	id: string,
	change: PersonChange,
	callId: string,
	now: number,
): { applied: boolean; row: PersonRow; replacedDurableTaskId?: number } {
	return db.transaction(() => {
		const before = requirePerson(db, id);
		if (!recordCall(db, callId, "update_person", id, now)) return { applied: false, row: before };

		const sets: string[] = ["updated_at = ?"];
		const params: Array<string | number | null> = [now];
		if (change.name !== undefined) {
			sets.push("name = ?");
			params.push(change.name);
		}
		if (change.relation !== undefined) {
			sets.push("relation = ?");
			params.push(change.relation);
		}
		if (change.notes !== undefined) {
			sets.push("notes = ?");
			params.push(change.notes);
		}
		let replacedDurableTaskId: number | undefined;
		if (change.birthday !== undefined) {
			const { md, year, cycle } = change.birthday;
			sets.push("birthday_md = ?", "birthday_year = ?", "cycle_year = ?", "remind_at = ?", "check_at = ?");
			params.push(md, year, cycle.year, cycle.remindAt ?? null, cycle.checkAt);
			if (md !== before.birthdayMd) {
				// The cards that were posted were about a day that is not their birthday after all: forget them, so that
				// neither the prompt nor start-up treats them as open.
				sets.push(
					"reminded_year = NULL",
					"reminded_at = NULL",
					"asked_year = NULL",
					"asked_at = NULL",
					"durable_task_id = NULL",
					"gen = gen + 1",
				);
				replacedDurableTaskId = before.durableTaskId;
			}
		}
		db.run(`UPDATE people_person SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
		return {
			applied: true,
			row: requirePerson(db, id),
			...optional("replacedDurableTaskId", replacedDurableTaskId ?? null),
		};
	});
}

/** What the owner said about one birthday: true for wished, false for not (yet). Undefined when nothing was recorded. */
export function wishOf(db: AppDb, personId: string, year: number): boolean | undefined {
	const record = db.get<{ wished: number }>(
		"SELECT wished FROM people_wish WHERE person_id = ? AND year = ?",
		personId,
		year,
	);
	return record === undefined ? undefined : record.wished === 1;
}

/** The wish recorded most recently for a person, whatever the year. */
export function latestWish(db: AppDb, personId: string): { year: number; wished: boolean } | undefined {
	const record = db.get<{ year: number; wished: number }>(
		"SELECT year, wished FROM people_wish WHERE person_id = ? ORDER BY recorded_at DESC, year DESC LIMIT 1",
		personId,
	);
	return record === undefined ? undefined : { year: record.year, wished: record.wished === 1 };
}

/** Record whether the owner wished the person well on the birthday of `year`. Same replay rule as {@link applyChange}. */
export function recordWish(
	db: AppDb,
	id: string,
	year: number,
	wished: boolean,
	callId: string,
	now: number,
): { applied: boolean; row: PersonRow } {
	return db.transaction(() => {
		const row = requirePerson(db, id);
		if (!recordCall(db, callId, "record_wish", id, now)) return { applied: false, row };
		db.run(
			`INSERT INTO people_wish (person_id, year, wished, recorded_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (person_id, year) DO UPDATE SET wished = excluded.wished, recorded_at = excluded.recorded_at`,
			id,
			year,
			wished ? 1 : 0,
			now,
		);
		return { applied: true, row };
	});
}

/** Remove a person and what was recorded about their birthdays, returning the Durable task to abort. A missing one is a no-op. */
export function deletePerson(db: AppDb, id: string): { deleted: boolean; durableTaskId?: number } {
	return db.transaction(() => {
		const row = getPerson(db, id);
		if (row === undefined) return { deleted: false };
		db.run("DELETE FROM people_person WHERE id = ?", id);
		return { deleted: true, ...optional("durableTaskId", row.durableTaskId ?? null) };
	});
}

/**
 * Evening questions that are still open: asked for a birthday the owner has said nothing about since. A "not yet" the
 * owner recorded earlier in the day does not answer the question that came after it (it is why the question is asked).
 */
export function unansweredQuestions(db: AppDb): PersonRow[] {
	return db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM people_person p
			 WHERE asked_year IS NOT NULL
			   AND NOT EXISTS (
			     SELECT 1 FROM people_wish w
			     WHERE w.person_id = p.id AND w.year = p.asked_year AND w.recorded_at >= p.asked_at
			   )
			 ORDER BY asked_at DESC, id`,
		)
		.map(fromRecord);
}

/** Every person: each one always has a cycle waiting, so each one wants a timer. */
export function pendingTimers(db: AppDb): PersonRow[] {
	return db.all<DbRow>(`SELECT ${COLUMNS} FROM people_person ORDER BY check_at, id`).map(fromRecord);
}

/** Take the next timer generation for a person who has none, or undefined when one already has a timer. */
export function takeGeneration(db: AppDb, id: string): { gen: number; conversationId: number } | undefined {
	return db.transaction(() => {
		const result = db.run("UPDATE people_person SET gen = gen + 1 WHERE id = ? AND durable_task_id IS NULL", id);
		if (result.changes === 0) return undefined;
		const row = requirePerson(db, id);
		return { gen: row.gen, conversationId: row.conversationId };
	});
}

/** Remember which Durable task serves generation `gen`. False when the row moved on meanwhile (the task is stale). */
export function attachDurableTask(db: AppDb, id: string, gen: number, durableTaskId: number): boolean {
	return (
		db.run(
			"UPDATE people_person SET durable_task_id = ? WHERE id = ? AND gen = ? AND durable_task_id IS NULL",
			durableTaskId,
			id,
			gen,
		).changes > 0
	);
}

/** Forget a Durable task that is gone (lost in a power cut), so a new one can be scheduled. */
export function detachDurableTask(db: AppDb, id: string, durableTaskId: number): void {
	db.run("UPDATE people_person SET durable_task_id = NULL WHERE id = ? AND durable_task_id = ?", id, durableTaskId);
}

/**
 * Is this the timer the row currently wants? A stale one (birthday changed, person deleted, cycle advanced) is not.
 * What the timer already did (`reminded_at`, `asked_at`) is deliberately not part of the question: see `isCurrentReminder`.
 */
export function isCurrent(row: PersonRow | undefined, input: { gen: number }): row is PersonRow {
	return row !== undefined && row.gen === input.gen;
}

/** Record that the morning card of generation `gen` was posted, for the birthday of `year`. Safe to repeat. */
export function markReminded(db: AppDb, id: string, gen: number, year: number, now: number): void {
	db.run(
		`UPDATE people_person SET reminded_at = CASE WHEN reminded_year IS ? THEN COALESCE(reminded_at, ?) ELSE ? END, reminded_year = ?
		 WHERE id = ? AND gen = ?`,
		year,
		now,
		now,
		year,
		id,
		gen,
	);
}

/** Record that the evening question of generation `gen` was posted, for the birthday of `year`. Safe to repeat. */
export function markAsked(db: AppDb, id: string, gen: number, year: number, now: number): void {
	db.run(
		`UPDATE people_person SET asked_at = CASE WHEN asked_year IS ? THEN COALESCE(asked_at, ?) ELSE ? END, asked_year = ?
		 WHERE id = ? AND gen = ?`,
		year,
		now,
		now,
		year,
		id,
		gen,
	);
}

/**
 * Move to the next year's cycle when this one is done: the new cycle, a new generation (which makes the finishing timer
 * stale) and no timer yet. False when the row moved on meanwhile; then the finishing timer must not schedule anything.
 */
export function advanceCycle(db: AppDb, id: string, gen: number, next: CycleRow, now: number): boolean {
	return (
		db.run(
			`UPDATE people_person SET cycle_year = ?, remind_at = ?, check_at = ?,
			                          durable_task_id = NULL, gen = gen + 1, updated_at = ?
			 WHERE id = ? AND gen = ?`,
			next.year,
			next.remindAt ?? null,
			next.checkAt,
			now,
			id,
			gen,
		).changes > 0
	);
}
