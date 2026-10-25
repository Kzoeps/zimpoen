import { randomBytes } from "node:crypto";
import type { AppDb } from "@assistant/db";

export type FollowupKind = "meeting" | "commitment";
export type FollowupStatus = "waiting" | "asked" | "resolved";

/** One row of `followups_item`, in the shapes the rest of the code uses (camelCase, absent instead of NULL). */
export type FollowupRow = {
	id: string;
	title: string;
	counterpart: string;
	context: string;
	kind: FollowupKind;
	eventAt: number;
	endsAt?: number;
	askAt: number;
	agendaLeadMinutes: number;
	/** The owner gave a date and no time: `eventAt` is the configured default time of that day, not something they said. */
	timeAssumed: boolean;
	status: FollowupStatus;
	outcome?: string;
	parentId?: string;
	nextFollowupId?: string;
	gen: number;
	durableTaskId?: number;
	agendaPingedAt?: number;
	askedAt?: number;
	/** When the question nobody answered was asked a second time, the morning after. */
	reaskedAt?: number;
	resolvedAt?: number;
	conversationId: number;
	createdAt: number;
	updatedAt: number;
};

type DbRow = {
	id: string;
	title: string;
	counterpart: string;
	context: string;
	kind: FollowupKind;
	event_at: number;
	ends_at: number | null;
	ask_at: number;
	agenda_lead_minutes: number;
	time_assumed: number;
	status: FollowupStatus;
	outcome: string | null;
	parent_id: string | null;
	next_followup_id: string | null;
	gen: number;
	durable_task_id: number | null;
	agenda_pinged_at: number | null;
	asked_at: number | null;
	reasked_at: number | null;
	resolved_at: number | null;
	conversation_id: number;
	created_at: number;
	updated_at: number;
};

const COLUMNS =
	"id, title, counterpart, context, kind, event_at, ends_at, ask_at, agenda_lead_minutes, time_assumed, status, outcome, parent_id, next_followup_id, gen, durable_task_id, agenda_pinged_at, asked_at, reasked_at, resolved_at, conversation_id, created_at, updated_at";

const optional = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } =>
	(value === null ? {} : { [key]: value }) as { [P in K]?: V };

function fromRecord(record: DbRow): FollowupRow {
	return {
		id: record.id,
		title: record.title,
		counterpart: record.counterpart,
		context: record.context,
		kind: record.kind,
		eventAt: record.event_at,
		askAt: record.ask_at,
		agendaLeadMinutes: record.agenda_lead_minutes,
		timeAssumed: record.time_assumed === 1,
		status: record.status,
		gen: record.gen,
		conversationId: record.conversation_id,
		createdAt: record.created_at,
		updatedAt: record.updated_at,
		...optional("endsAt", record.ends_at),
		...optional("outcome", record.outcome),
		...optional("parentId", record.parent_id),
		...optional("nextFollowupId", record.next_followup_id),
		...optional("durableTaskId", record.durable_task_id),
		...optional("agendaPingedAt", record.agenda_pinged_at),
		...optional("askedAt", record.asked_at),
		...optional("reaskedAt", record.reasked_at),
		...optional("resolvedAt", record.resolved_at),
	};
}

/** Short enough for a model to copy back correctly, long enough that a personal list never collides (retried on PK). */
export function newFollowupId(): string {
	return `f_${randomBytes(4).toString("hex")}`;
}

export type NewFollowup = {
	title: string;
	counterpart: string;
	context: string;
	kind: FollowupKind;
	eventAt: number;
	endsAt?: number;
	askAt: number;
	agendaLeadMinutes: number;
	/** The time of day was not given (only a date) and `eventAt` uses the default. */
	timeAssumed?: boolean;
	parentId?: string;
	conversationId: number;
	createdAt: number;
};

/**
 * Insert a follow-up for tool call `callId`, or return the one that call already inserted. `created` says which
 * happened: Durable may run a replay-safe tool again after a crash, and the second run must find its own row.
 */
export function insertFollowup(db: AppDb, input: NewFollowup, callId: string): { row: FollowupRow; created: boolean } {
	return db.transaction(() => {
		for (let attempt = 0; attempt < 5; attempt++) {
			const id = newFollowupId();
			const result = db.run(
				`INSERT INTO followups_item (id, title, counterpart, context, kind, event_at, ends_at, ask_at, agenda_lead_minutes,
				                             time_assumed, status, parent_id, conversation_id, source_call_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?)
				 ON CONFLICT DO NOTHING`,
				id,
				input.title,
				input.counterpart,
				input.context,
				input.kind,
				input.eventAt,
				input.endsAt ?? null,
				input.askAt,
				input.agendaLeadMinutes,
				input.timeAssumed === true ? 1 : 0,
				input.parentId ?? null,
				input.conversationId,
				callId,
				input.createdAt,
				input.createdAt,
			);
			if (result.changes > 0) return { row: requireFollowup(db, id), created: true };
			// A conflict is either this call's earlier insert (its unique source_call_id) or, very rarely, an id collision.
			const earlier = findByCallId(db, callId);
			if (earlier !== undefined) return { row: earlier, created: false };
		}
		throw new Error(
			"Could not find a free follow-up id after 5 tries. This should be impossible; check followups_item.",
		);
	});
}

export function getFollowup(db: AppDb, id: string): FollowupRow | undefined {
	const record = db.get<DbRow>(`SELECT ${COLUMNS} FROM followups_item WHERE id = ?`, id);
	return record === undefined ? undefined : fromRecord(record);
}

export function requireFollowup(db: AppDb, id: string): FollowupRow {
	const row = getFollowup(db, id);
	if (row === undefined) throw new Error(`No follow-up '${id}'. list_followups shows the ids that exist.`);
	return row;
}

/** The follow-up that tool call `callId` already created (`add_followup`), if any. */
export function findByCallId(db: AppDb, callId: string): FollowupRow | undefined {
	const record = db.get<DbRow>(`SELECT ${COLUMNS} FROM followups_item WHERE source_call_id = ?`, callId);
	return record === undefined ? undefined : fromRecord(record);
}

/** An open follow-up with this title (any letter case) at this moment: the same one, saved twice (a model retrying a call). */
export function findDuplicate(db: AppDb, title: string, eventAt: number): FollowupRow | undefined {
	const record = db.get<DbRow>(
		`SELECT ${COLUMNS} FROM followups_item
		 WHERE lower(title) = lower(?) AND event_at = ? AND status != 'resolved' ORDER BY created_at, id LIMIT 1`,
		title,
		eventAt,
	);
	return record === undefined ? undefined : fromRecord(record);
}

/** The follow-up that tool call `callId` already changed (`record_outcome`, `resolve_followup`), if any. */
export function findChangedByCall(db: AppDb, callId: string): { tool: string; followupId: string } | undefined {
	const record = db.get<{ tool: string; followup_id: string | null }>(
		"SELECT tool, followup_id FROM followups_call WHERE source_call_id = ?",
		callId,
	);
	return record?.followup_id == null ? undefined : { tool: record.tool, followupId: record.followup_id };
}

/** First write wins: false when this call id was already recorded. */
function recordCall(db: AppDb, callId: string, tool: string, followupId: string, now: number): boolean {
	return (
		db.run(
			"INSERT INTO followups_call (source_call_id, tool, followup_id, applied_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
			callId,
			tool,
			followupId,
			now,
		).changes > 0
	);
}

export type FollowupFilter = {
	/** `active` is waiting and asked: what is still open. */
	status: "active" | FollowupStatus | "all";
	limit: number;
};

/** Matching follow-ups and how many matched before the limit. Open ones soonest first; resolved ones most recent first. */
export function listFollowups(db: AppDb, filter: FollowupFilter): { followups: FollowupRow[]; total: number } {
	const [where, params]: [string, string[]] =
		filter.status === "all"
			? ["", []]
			: filter.status === "active"
				? ["WHERE status IN ('waiting', 'asked')", []]
				: ["WHERE status = ?", [filter.status]];
	const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM followups_item ${where}`, ...params)?.n ?? 0;
	const order = filter.status === "resolved" ? "resolved_at DESC, id" : "status = 'resolved', event_at, id";
	const followups = db
		.all<DbRow>(`SELECT ${COLUMNS} FROM followups_item ${where} ORDER BY ${order} LIMIT ?`, ...params, filter.limit)
		.map(fromRecord);
	return { followups, total };
}

/** What an agenda point may be added to: waiting and not yet started, soonest first. */
export function upcomingFollowups(db: AppDb, now: number): FollowupRow[] {
	return db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM followups_item WHERE status = 'waiting' AND event_at > ? ORDER BY event_at, id`,
			now,
		)
		.map(fromRecord);
}

export type AgendaRow = { id: number; followupId: string; text: string; createdAt: number };

type AgendaDbRow = { id: number; followup_id: string; text: string; created_at: number };

const fromAgenda = (record: AgendaDbRow): AgendaRow => ({
	id: record.id,
	followupId: record.followup_id,
	text: record.text,
	createdAt: record.created_at,
});

/** The points of one meeting, in the order they were added. */
export function agendaOf(db: AppDb, followupId: string): AgendaRow[] {
	return db
		.all<AgendaDbRow>(
			"SELECT id, followup_id, text, created_at FROM followups_agenda WHERE followup_id = ? ORDER BY id",
			followupId,
		)
		.map(fromAgenda);
}

/** The points of several meetings at once, by meeting id. */
export function agendaOfMany(db: AppDb, ids: readonly string[]): Map<string, string[]> {
	const byId = new Map<string, string[]>();
	for (const id of ids) byId.set(id, []);
	if (ids.length === 0) return byId;
	const marks = ids.map(() => "?").join(", ");
	for (const record of db.all<AgendaDbRow>(
		`SELECT id, followup_id, text, created_at FROM followups_agenda WHERE followup_id IN (${marks}) ORDER BY id`,
		...ids,
	)) {
		byId.get(record.followup_id)?.push(record.text);
	}
	return byId;
}

/** The point that tool call `callId` already added (`add_agenda_point`), if any. */
export function findAgendaPointByCall(db: AppDb, callId: string): AgendaRow | undefined {
	const record = db.get<AgendaDbRow>(
		"SELECT id, followup_id, text, created_at FROM followups_agenda WHERE source_call_id = ?",
		callId,
	);
	return record === undefined ? undefined : fromAgenda(record);
}

/** Add a point for tool call `callId`, or return the one that call already added. */
export function addAgendaPoint(
	db: AppDb,
	followupId: string,
	text: string,
	callId: string,
	now: number,
): { point: AgendaRow; created: boolean } {
	return db.transaction(() => {
		const result = db.run(
			"INSERT INTO followups_agenda (followup_id, text, source_call_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
			followupId,
			text,
			callId,
			now,
		);
		const point = findAgendaPointByCall(db, callId);
		if (point === undefined) throw new Error(`Could not save the agenda point for ${followupId}.`);
		return { point, created: result.changes > 0 };
	});
}

/** What the prompt section needs: how many follow-ups wait for their time, the next few, and the ones asked about. */
export function openSummary(
	db: AppDb,
	nextCount: number,
	awaitingCount: number,
): { waiting: number; next: Array<FollowupRow & { agendaCount: number }>; awaiting: number; asked: FollowupRow[] } {
	const count = (status: FollowupStatus): number =>
		db.get<{ n: number }>("SELECT COUNT(*) AS n FROM followups_item WHERE status = ?", status)?.n ?? 0;
	const next = db
		.all<DbRow & { agenda_count: number }>(
			`SELECT ${COLUMNS}, (SELECT COUNT(*) FROM followups_agenda a WHERE a.followup_id = followups_item.id) AS agenda_count
			 FROM followups_item WHERE status = 'waiting' ORDER BY event_at, id LIMIT ?`,
			nextCount,
		)
		.map((record) => ({ ...fromRecord(record), agendaCount: record.agenda_count }));
	const asked = db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM followups_item WHERE status = 'asked' ORDER BY asked_at DESC, id LIMIT ?`,
			awaitingCount,
		)
		.map(fromRecord);
	return { waiting: count("waiting"), next, awaiting: count("asked"), asked };
}

/**
 * Does a row in this state want a timer? One that is still waiting for its time, and one that was asked about and has
 * not been asked the second time yet (the morning after). A resolved one, or one asked twice, has nothing left to do.
 */
const WANTS_TIMER = "(status = 'waiting' OR (status = 'asked' AND reasked_at IS NULL))";

/** Every follow-up that still wants a timer: what startup must make sure has one. */
export function pendingTimers(db: AppDb): FollowupRow[] {
	return db
		.all<DbRow>(`SELECT ${COLUMNS} FROM followups_item WHERE ${WANTS_TIMER} ORDER BY event_at, id`)
		.map(fromRecord);
}

/**
 * Take the next timer generation for a follow-up that wants one, or undefined when it does not (resolved, asked twice,
 * already has a timer). Called right before a Durable task is created for the row.
 */
export function takeGeneration(
	db: AppDb,
	id: string,
): { gen: number; conversationId: number; asked: boolean } | undefined {
	return db.transaction(() => {
		const result = db.run(
			`UPDATE followups_item SET gen = gen + 1 WHERE id = ? AND ${WANTS_TIMER} AND durable_task_id IS NULL`,
			id,
		);
		if (result.changes === 0) return undefined;
		const row = requireFollowup(db, id);
		return { gen: row.gen, conversationId: row.conversationId, asked: row.status === "asked" };
	});
}

/** Remember which Durable task serves generation `gen`. False when the row moved on meanwhile (the task is stale). */
export function attachDurableTask(db: AppDb, id: string, gen: number, durableTaskId: number): boolean {
	return (
		db.run(
			"UPDATE followups_item SET durable_task_id = ? WHERE id = ? AND gen = ? AND durable_task_id IS NULL",
			durableTaskId,
			id,
			gen,
		).changes > 0
	);
}

/** Forget a Durable task that is gone (lost in a power cut), so a new one can be scheduled. */
export function detachDurableTask(db: AppDb, id: string, durableTaskId: number): void {
	db.run("UPDATE followups_item SET durable_task_id = NULL WHERE id = ? AND durable_task_id = ?", id, durableTaskId);
}

/**
 * Is this the timer the row currently wants? A stale one (rescheduled, resolved, deleted) is not.
 *
 * What the timer already did (`agenda_pinged_at`, `asked_at`, `reasked_at`) is deliberately not part of the question, for the reason
 * given at `isCurrentReminder`: the flags live in the database that survives a power cut, and Durable's may come back
 * from before the card was written. A timer that runs again posts again, which is idempotent by `requestId`.
 */
export function isCurrent(row: FollowupRow | undefined, input: { gen: number }): boolean {
	return row !== undefined && row.status !== "resolved" && row.gen === input.gen;
}

/** Record that the agenda card of generation `gen` was posted. Safe to repeat. */
export function markAgendaPinged(db: AppDb, id: string, gen: number, now: number): void {
	db.run(
		"UPDATE followups_item SET agenda_pinged_at = COALESCE(agenda_pinged_at, ?) WHERE id = ? AND gen = ?",
		now,
		id,
		gen,
	);
}

/** Record that the owner was asked about generation `gen`: the follow-up now waits for an outcome. Safe to repeat. */
export function markAsked(db: AppDb, id: string, gen: number, now: number): void {
	db.run(
		`UPDATE followups_item SET status = 'asked', asked_at = COALESCE(asked_at, ?), updated_at = ?
		 WHERE id = ? AND gen = ? AND status IN ('waiting', 'asked')`,
		now,
		now,
		id,
		gen,
	);
}

/** Record that the question of generation `gen` was asked a second time. Safe to repeat. */
export function markReasked(db: AppDb, id: string, gen: number, now: number): void {
	db.run(
		"UPDATE followups_item SET reasked_at = COALESCE(reasked_at, ?), updated_at = ? WHERE id = ? AND gen = ?",
		now,
		now,
		id,
		gen,
	);
}

type Applied = { applied: boolean; row: FollowupRow; replacedDurableTaskId?: number };

/** Close a follow-up in place and make its timer stale at once. Throws when it is already resolved. */
function close(db: AppDb, before: FollowupRow, outcome: string | undefined, now: number): void {
	if (before.status === "resolved") {
		throw new Error(
			`Follow-up ${before.id} “${before.title}” is already resolved${before.outcome === undefined ? "" : ` (outcome: ${before.outcome})`}.`,
		);
	}
	db.run(
		`UPDATE followups_item SET status = 'resolved', outcome = COALESCE(?, outcome), resolved_at = ?, updated_at = ?,
		                           durable_task_id = NULL, gen = gen + 1
		 WHERE id = ?`,
		outcome ?? null,
		now,
		now,
		before.id,
	);
}

/**
 * Record how it went and resolve the follow-up, creating the next link of the chain when the outcome asks for one, in
 * one transaction with the call ledger: a call Durable replays after a crash is recognised and not applied twice.
 * `next` is the chained follow-up. Returns the row as it stands afterwards.
 */
export function recordOutcome(
	db: AppDb,
	id: string,
	change: { outcome: string; next?: NewFollowup },
	callId: string,
	now: number,
): Applied & { next?: FollowupRow } {
	return db.transaction(() => {
		const before = requireFollowup(db, id);
		if (!recordCall(db, callId, "record_outcome", id, now)) {
			const earlierNext = before.nextFollowupId === undefined ? undefined : getFollowup(db, before.nextFollowupId);
			return { applied: false, row: before, ...(earlierNext === undefined ? {} : { next: earlierNext }) };
		}
		close(db, before, change.outcome, now);
		let next: FollowupRow | undefined;
		if (change.next !== undefined) {
			next = insertFollowup(db, { ...change.next, parentId: id }, callId).row;
			db.run("UPDATE followups_item SET next_followup_id = ? WHERE id = ?", next.id, id);
		}
		return {
			applied: true,
			row: requireFollowup(db, id),
			...(next === undefined ? {} : { next }),
			...optional("replacedDurableTaskId", before.durableTaskId ?? null),
		};
	});
}

/** Resolve a follow-up without an outcome of its own (cancelled, no longer needed). Same replay rule as {@link recordOutcome}. */
export function resolveFollowup(db: AppDb, id: string, note: string | undefined, callId: string, now: number): Applied {
	return db.transaction(() => {
		const before = requireFollowup(db, id);
		if (!recordCall(db, callId, "resolve_followup", id, now)) return { applied: false, row: before };
		close(db, before, note, now);
		return {
			applied: true,
			row: requireFollowup(db, id),
			...optional("replacedDurableTaskId", before.durableTaskId ?? null),
		};
	});
}

/** What `update_followup` changes. A new `timing` starts the follow-up over: the owner is asked after the new time. */
export type FollowupChange = {
	title?: string;
	counterpart?: string;
	timing?: { eventAt: number; endsAt: number | null; askAt: number; assumed: boolean };
};

/**
 * Apply `change` for tool call `callId`, in one transaction with the call ledger, or report that it already was
 * (`applied` false, nothing changed). Moving the follow-up makes its timer stale at once (a new generation, before any new
 * timer exists) and puts it back to waiting, also when the owner had been asked: the question was about a time that is
 * no longer the time. The agenda points stay; a card posted for the old time stays in the thread. `replacedDurableTaskId`
 * is the timer to abort once this is committed.
 */
export function updateFollowup(db: AppDb, id: string, change: FollowupChange, callId: string, now: number): Applied {
	return db.transaction(() => {
		const before = requireFollowup(db, id);
		if (!recordCall(db, callId, "update_followup", id, now)) return { applied: false, row: before };
		if (before.status === "resolved") {
			throw new Error(
				`Follow-up ${before.id} “${before.title}” is already resolved, so it cannot be changed. Create a new one with add_followup.`,
			);
		}
		const sets: string[] = ["updated_at = ?"];
		const params: Array<string | number | null> = [now];
		if (change.title !== undefined) {
			sets.push("title = ?");
			params.push(change.title);
		}
		if (change.counterpart !== undefined) {
			sets.push("counterpart = ?");
			params.push(change.counterpart);
		}
		let replacedDurableTaskId: number | undefined;
		const { timing } = change;
		if (timing !== undefined) {
			sets.push("event_at = ?", "ends_at = ?", "ask_at = ?", "time_assumed = ?");
			params.push(timing.eventAt, timing.endsAt, timing.askAt, timing.assumed ? 1 : 0);
			if (
				timing.eventAt !== before.eventAt ||
				timing.endsAt !== (before.endsAt ?? null) ||
				timing.askAt !== before.askAt
			) {
				sets.push(
					"status = 'waiting'",
					"asked_at = NULL",
					"reasked_at = NULL",
					"agenda_pinged_at = NULL",
					"durable_task_id = NULL",
					"gen = gen + 1",
				);
				replacedDurableTaskId = before.durableTaskId;
			}
		}
		db.run(`UPDATE followups_item SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
		return {
			applied: true,
			row: requireFollowup(db, id),
			...optional("replacedDurableTaskId", replacedDurableTaskId ?? null),
		};
	});
}

/**
 * Remove a follow-up and its agenda for good, returning the Durable task to abort. Deleting a missing one is a no-op.
 * The follow-up that pointed at it as its next link stops pointing (`parent_id` of a deleted parent is cleared by the
 * foreign key; this column has none).
 */
export function deleteFollowup(db: AppDb, id: string): { deleted: boolean; durableTaskId?: number } {
	return db.transaction(() => {
		const row = getFollowup(db, id);
		if (row === undefined) return { deleted: false };
		db.run("UPDATE followups_item SET next_followup_id = NULL WHERE next_followup_id = ?", id);
		db.run("DELETE FROM followups_item WHERE id = ?", id);
		return { deleted: true, ...optional("durableTaskId", row.durableTaskId ?? null) };
	});
}

/** Meetings and commitments that are not resolved and start in `[from, to)`, soonest first. */
export function openBetween(db: AppDb, from: number, to: number): FollowupRow[] {
	return db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM followups_item
			 WHERE status IN ('waiting', 'asked') AND event_at >= ? AND event_at < ? ORDER BY event_at, id`,
			from,
			to,
		)
		.map(fromRecord);
}

/** Follow-ups the owner was asked about and has not answered: the open loops, the one asked longest ago first. */
export function askedUnanswered(db: AppDb): FollowupRow[] {
	return db
		.all<DbRow>(`SELECT ${COLUMNS} FROM followups_item WHERE status = 'asked' ORDER BY asked_at, id`)
		.map(fromRecord);
}

/** Follow-ups resolved in `[from, to)`, in the order they were resolved. */
export function resolvedBetween(db: AppDb, from: number, to: number): FollowupRow[] {
	return db
		.all<DbRow>(
			`SELECT ${COLUMNS} FROM followups_item WHERE status = 'resolved' AND resolved_at >= ? AND resolved_at < ? ORDER BY resolved_at, id`,
			from,
			to,
		)
		.map(fromRecord);
}
