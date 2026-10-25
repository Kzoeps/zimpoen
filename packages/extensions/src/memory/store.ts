import { randomBytes } from "node:crypto";
import type { AppDb } from "@assistant/db";
import {
	canPin,
	isAgentId,
	isMemoryScope,
	MAX_MEMORY_CHARS,
	type MemoryFactView,
	type MemoryKind,
	type MemoryOrigin,
	type MemoryScope,
	PROFILE_SLOT_LABEL,
	PROFILE_SLOTS,
	type ProfileSlot,
} from "@assistant/shared";
import { ftsQuery } from "../inbox/store.ts";
import { safeLine } from "../inbox/text.ts";

/** Facts one scope may hold: a runaway loop of `remember` calls must not grow the prompt's source without end. */
export const MAX_FACTS_PER_SCOPE = 400;

export type FactRow = {
	seq: number;
	id: string;
	scope: MemoryScope;
	kind: MemoryKind;
	text: string;
	pinned: boolean;
	slot?: ProfileSlot;
	source: "agent" | "owner";
	/** What an agent wrote or proposed: who, in which conversation, when. */
	origin?: MemoryOrigin;
	createdAt: number;
	updatedAt: number;
};

type DbRow = {
	seq: number;
	id: string;
	scope: string;
	kind: MemoryKind;
	text: string;
	pinned: number;
	slot: string | null;
	source: "agent" | "owner";
	origin_agent: string | null;
	origin_conversation: number | null;
	origin_at: number | null;
	created_at: number;
	updated_at: number;
};

const COLUMNS =
	"seq, id, scope, kind, text, pinned, slot, source, origin_agent, origin_conversation, origin_at, created_at, updated_at";

function factFrom(row: DbRow): FactRow {
	return {
		seq: row.seq,
		id: row.id,
		// Written only through this module, which checks it; a scope that no longer exists is still shown rather than hidden.
		scope: row.scope as MemoryScope,
		kind: row.kind,
		text: row.text,
		pinned: row.pinned === 1,
		...(row.slot !== null && (PROFILE_SLOTS as readonly string[]).includes(row.slot)
			? { slot: row.slot as ProfileSlot }
			: {}),
		source: row.source,
		...(row.origin_agent !== null &&
		isAgentId(row.origin_agent) &&
		row.origin_conversation !== null &&
		row.origin_at !== null
			? { origin: { agent: row.origin_agent, conversationId: row.origin_conversation, at: row.origin_at } }
			: {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export const toView = (row: FactRow): MemoryFactView => ({
	id: row.id,
	scope: row.scope,
	kind: row.kind,
	text: row.text,
	pinned: row.pinned,
	...(row.slot === undefined ? {} : { slot: row.slot }),
	source: row.source,
	...(row.origin === undefined ? {} : { origin: row.origin }),
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

/** Short enough for a model to copy back correctly, long enough that a personal list never collides (retried on PK). */
export const newFactId = (): string => `m_${randomBytes(4).toString("hex")}`;

/** A refusal that says what to do: the tool shows it to the model, the page to the owner. */
export class MemoryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryError";
	}
}

/**
 * A remembered line: one line of plain text, no angle brackets (a prompt section's closing tag could not be written),
 * at most {@link MAX_MEMORY_CHARS} characters. Longer is refused, not cut: half a fact can say something else.
 */
export function cleanText(raw: string): string {
	const line = safeLine(raw, MAX_MEMORY_CHARS * 20);
	if (line === "") throw new MemoryError("There is nothing to remember: the text is empty.");
	if (line.length > MAX_MEMORY_CHARS) {
		throw new MemoryError(
			`That is ${line.length} characters; a remembered line is at most ${MAX_MEMORY_CHARS}. Say it in one short sentence.`,
		);
	}
	return line;
}

export function getFact(db: AppDb, id: string): FactRow | undefined {
	const row = db.get<DbRow>(`SELECT ${COLUMNS} FROM memory_fact WHERE id = ?`, id);
	return row === undefined ? undefined : factFrom(row);
}

export function findByCallId(db: AppDb, callId: string): FactRow | undefined {
	const row = db.get<DbRow>(`SELECT ${COLUMNS} FROM memory_fact WHERE source_call_id = ?`, callId);
	return row === undefined ? undefined : factFrom(row);
}

export type NewFact = {
	scope: MemoryScope;
	kind: MemoryKind;
	text: string;
	pinned?: boolean;
	source: "agent" | "owner";
	/** Who wrote or proposed it, when an agent did. */
	origin?: MemoryOrigin;
	createdAt: number;
};

/** The line this scope already holds in this kind, whatever its case: a sentence is kept once. */
export function findSame(db: AppDb, scope: MemoryScope, kind: MemoryKind, text: string): FactRow | undefined {
	const row = db.get<DbRow>(
		`SELECT ${COLUMNS} FROM memory_fact WHERE scope = ? AND kind = ? AND lower(text) = lower(?) AND slot IS NULL`,
		scope,
		kind,
		text,
	);
	return row === undefined ? undefined : factFrom(row);
}

/** A refusal, with what to do, when `scope` holds as many lines as it may. */
export function assertRoom(db: AppDb, scope: MemoryScope): void {
	const held = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_fact WHERE scope = ?", scope)?.n ?? 0;
	if (held >= MAX_FACTS_PER_SCOPE) {
		throw new MemoryError(
			`The ${scope === "shared" ? "shared" : "agent's"} memory already holds ${MAX_FACTS_PER_SCOPE} lines. Ask the owner what to forget, or forget one that is no longer true, before remembering more.`,
		);
	}
}

/**
 * Keep a line for tool call `callId`, or return what that call (or an identical line in the same scope and kind) already
 * kept. `created` is false then. Durable may run a replay-safe tool again after a crash: the second run finds its own row.
 */
export function insertFact(db: AppDb, input: NewFact, callId: string): { row: FactRow; created: boolean } {
	const text = cleanText(input.text);
	return db.transaction(() => {
		const earlier = findByCallId(db, callId);
		if (earlier !== undefined) return { row: earlier, created: false };
		const same = findSame(db, input.scope, input.kind, text);
		if (same !== undefined) return { row: same, created: false };
		assertRoom(db, input.scope);
		for (let attempt = 0; attempt < 5; attempt++) {
			const id = newFactId();
			const result = db.run(
				`INSERT INTO memory_fact (id, scope, kind, text, pinned, source, source_call_id, origin_agent, origin_conversation, origin_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT DO NOTHING`,
				id,
				input.scope,
				input.kind,
				text,
				input.pinned === true ? 1 : 0,
				input.source,
				callId,
				input.origin?.agent ?? null,
				input.origin?.conversationId ?? null,
				input.origin?.at ?? null,
				input.createdAt,
				input.createdAt,
			);
			if (result.changes > 0) return { row: requireFact(db, id), created: true };
		}
		throw new Error("Could not find a free memory id after 5 tries. This should be impossible; check memory_fact.");
	});
}

export function requireFact(db: AppDb, id: string): FactRow {
	const row = getFact(db, id);
	if (row === undefined) {
		throw new MemoryError(`There is no remembered line '${id}'. recall(query) finds ids; never invent one.`);
	}
	return row;
}

export type ListFilter = {
	scopes?: readonly MemoryScope[];
	kind?: MemoryKind;
	/** An FTS5 expression made safe by {@link ftsQuery}; absent: no text filter. */
	match?: string;
	limit: number;
	offset?: number;
};

/** The lines that match, best first (pinned and newest first when there is no text), and how many matched in all. */
export function listFacts(db: AppDb, filter: ListFilter): { rows: FactRow[]; total: number } {
	const where: string[] = [];
	const params: Array<string | number> = [];
	if (filter.scopes !== undefined) {
		where.push(`f.scope IN (${filter.scopes.map(() => "?").join(", ")})`);
		params.push(...filter.scopes);
	}
	if (filter.kind !== undefined) {
		where.push("f.kind = ?");
		params.push(filter.kind);
	}
	const columns = COLUMNS.split(", ")
		.map((column) => `f.${column}`)
		.join(", ");
	const clause = (extra: string[]): string => (extra.length === 0 ? "" : `WHERE ${extra.join(" AND ")}`);
	if (filter.match === undefined) {
		const rows = db
			.all<DbRow>(
				`SELECT ${columns} FROM memory_fact f ${clause(where)} ORDER BY f.pinned DESC, f.updated_at DESC, f.seq DESC LIMIT ? OFFSET ?`,
				...params,
				filter.limit,
				filter.offset ?? 0,
			)
			.map(factFrom);
		const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_fact f ${clause(where)}`, ...params)?.n ?? 0;
		return { rows, total };
	}
	const matched = [...where, "memory_fact_fts MATCH ?"];
	const from = "FROM memory_fact_fts JOIN memory_fact f ON f.seq = memory_fact_fts.rowid";
	const rows = db
		.all<DbRow>(
			`SELECT ${columns} ${from} ${clause(matched)} ORDER BY bm25(memory_fact_fts), f.updated_at DESC LIMIT ? OFFSET ?`,
			...params,
			filter.match,
			filter.limit,
			filter.offset ?? 0,
		)
		.map(factFrom);
	const total =
		db.get<{ n: number }>(`SELECT COUNT(*) AS n ${from} ${clause(matched)}`, ...params, filter.match)?.n ?? 0;
	return { rows, total };
}

export { ftsQuery };

/**
 * What the owner changed on the profile page: the text, the pin, or the scope (the line moves to another agent's memory,
 * or to every agent's: how a fact becomes shared, since an agent keeps its facts for itself). A line's kind never changes:
 * forget it and say it again instead. Throws {@link MemoryError} for what cannot be done, saying what to do.
 */
export function updateFact(
	db: AppDb,
	id: string,
	change: { text?: string; pinned?: boolean; scope?: MemoryScope },
	now: number,
): FactRow | undefined {
	return db.transaction(() => {
		const before = getFact(db, id);
		if (before === undefined) return undefined;
		const text = change.text === undefined ? before.text : cleanText(change.text);
		const scope = change.scope ?? before.scope;
		if (scope !== before.scope) assertCanMove(db, before, scope, text);
		const pinnable = canPin({ kind: before.kind, scope });
		if (change.pinned === true && !pinnable) {
			throw new MemoryError(
				"Only a fact kept for one agent can be pinned: preferences are always in the prompt, and a shared fact is in no prompt (agents find it with recall).",
			);
		}
		// A line that moved to where nothing is pinned is no longer pinned.
		const pinned = pinnable && (change.pinned ?? before.pinned);
		if (text === before.text && pinned === before.pinned && scope === before.scope) return before;
		db.run(
			"UPDATE memory_fact SET text = ?, pinned = ?, scope = ?, updated_at = ? WHERE id = ?",
			text,
			pinned ? 1 : 0,
			scope,
			now,
			id,
		);
		return getFact(db, id);
	});
}

/** The line may go to `scope`: it is not one the profile page owns, the scope has no such line yet, and has room. */
function assertCanMove(db: AppDb, row: FactRow, scope: MemoryScope, text: string): void {
	if (row.slot !== undefined) {
		throw new MemoryError(
			`“${PROFILE_SLOT_LABEL[row.slot]}” is told to every agent and cannot move: change it under “How you like it”.`,
		);
	}
	if (findSame(db, scope, row.kind, text) !== undefined) {
		throw new MemoryError(
			`${scope === "shared" ? "Every agent" : `The ${scope} agent`} already has that line. Delete one of the two instead of moving it.`,
		);
	}
	assertRoom(db, scope);
}

/** Delete a line. False when it was already gone (the owner pressed twice, or the approved deletion ran twice). */
export function deleteFact(db: AppDb, id: string): boolean {
	return db.run("DELETE FROM memory_fact WHERE id = ?", id).changes > 0;
}

/**
 * Set (a string) or clear (`null`) one of the preferences the profile page owns: a shared preference with a slot, one
 * row per slot, written by the owner. Returns the row, or undefined once cleared.
 */
export function setSlot(db: AppDb, slot: ProfileSlot, text: string | null, now: number): FactRow | undefined {
	return db.transaction(() => {
		const current = db.get<DbRow>(`SELECT ${COLUMNS} FROM memory_fact WHERE slot = ?`, slot);
		if (text === null || text.trim() === "") {
			if (current !== undefined) deleteFact(db, current.id);
			return undefined;
		}
		const clean = cleanText(text);
		if (current === undefined) {
			const id = newFactId();
			db.run(
				`INSERT INTO memory_fact (id, scope, kind, text, pinned, slot, source, created_at, updated_at)
				 VALUES (?, 'shared', 'preference', ?, 0, ?, 'owner', ?, ?)`,
				id,
				clean,
				slot,
				now,
				now,
			);
			return requireFact(db, id);
		}
		if (current.text !== clean)
			db.run("UPDATE memory_fact SET text = ?, updated_at = ? WHERE id = ?", clean, now, current.id);
		return requireFact(db, current.id);
	});
}

/** The profile page's preferences, by slot. */
export function slotTexts(db: AppDb): Partial<Record<ProfileSlot, string>> {
	const texts: Partial<Record<ProfileSlot, string>> = {};
	for (const row of db.all<DbRow>(`SELECT ${COLUMNS} FROM memory_fact WHERE slot IS NOT NULL`).map(factFrom)) {
		if (row.slot !== undefined) texts[row.slot] = row.text;
	}
	return texts;
}

/** How many lines each scope holds, scopes with none included. */
export function countsByScope(db: AppDb, scopes: readonly MemoryScope[]): Record<MemoryScope, number> {
	const counts = Object.fromEntries(scopes.map((scope) => [scope, 0])) as Record<MemoryScope, number>;
	for (const row of db.all<{ scope: string; n: number }>(
		"SELECT scope, COUNT(*) AS n FROM memory_fact GROUP BY scope",
	)) {
		if (isMemoryScope(row.scope)) counts[row.scope] = row.n;
	}
	return counts;
}

/** What an agent's prompt is built from, each group in the order it is shown. */
export type PromptFacts = {
	sharedPreferences: FactRow[];
	ownPreferences: FactRow[];
	/** Pinned first, then the most recently written. */
	ownFacts: FactRow[];
};

/** Rows read for the prompt: far more than the section's budget holds, so that the budget, not the query, decides what fits. */
const PROMPT_ROWS = 200;

export function promptFacts(db: AppDb, agent: MemoryScope): PromptFacts {
	const read = (scope: MemoryScope, kind: MemoryKind, order: string): FactRow[] =>
		db
			.all<DbRow>(
				`SELECT ${COLUMNS} FROM memory_fact WHERE scope = ? AND kind = ? ORDER BY ${order} LIMIT ${PROMPT_ROWS}`,
				scope,
				kind,
			)
			.map(factFrom);
	return {
		// The profile page's own preferences first (tone, then explanations), then the rest in the order they were said.
		sharedPreferences: read(
			"shared",
			"preference",
			"CASE slot WHEN 'tone' THEN 0 WHEN 'explanations' THEN 1 ELSE 2 END, seq",
		),
		ownPreferences: agent === "shared" ? [] : read(agent, "preference", "seq"),
		ownFacts: agent === "shared" ? [] : read(agent, "fact", "pinned DESC, updated_at DESC, seq DESC"),
	};
}
