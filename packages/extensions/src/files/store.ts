import { randomBytes } from "node:crypto";
import type { AppDb } from "@assistant/db";
import type { FileKind, FileSummary } from "@assistant/shared";

/** One row of `files_index`, in the shapes the rest of the code uses. */
export type FileRow = {
	id: string;
	path: string;
	name: string;
	mime: string;
	kind: FileKind;
	size: number;
	source: "upload" | "path" | "generated";
	description: string;
	tags: string[];
	addedAt: number;
	updatedAt: number;
};

type DbRow = {
	id: string;
	path: string;
	name: string;
	mime: string;
	kind: FileKind;
	size: number;
	source: "upload" | "path" | "generated";
	description: string;
	tags: string;
	added_at: number;
	updated_at: number;
};

const COLUMNS = "id, path, name, mime, kind, size, source, description, tags, added_at, updated_at";

const fromRecord = (record: DbRow): FileRow => ({
	id: record.id,
	path: record.path,
	name: record.name,
	mime: record.mime,
	kind: record.kind,
	size: record.size,
	source: record.source,
	description: record.description,
	tags: record.tags === "" ? [] : record.tags.split(" "),
	addedAt: record.added_at,
	updatedAt: record.updated_at,
});

/** `fi_` and eight hex digits: short enough for a model to copy back, and it goes in the stored file's name. */
export const newFileId = (): string => `fi_${randomBytes(4).toString("hex")}`;

/** An id nothing uses yet. The file is written under it before its row exists, so it is taken here first. */
export function freshFileId(db: AppDb): string {
	for (let attempt = 0; attempt < 5; attempt++) {
		const id = newFileId();
		if (getFile(db, id) === undefined) return id;
	}
	throw new Error("Could not find a free file id after 5 tries. This should be impossible; check files_index.");
}

export type NewFile = {
	id?: string;
	path: string;
	name: string;
	mime: string;
	kind: FileKind;
	size: number;
	source: "upload" | "path" | "generated";
	now: number;
};

/**
 * Add a file to the index. A path is in the index once: registering it again (the PA read the same file twice) returns
 * the row it already has, with the size and type the file has now. `created` says which happened.
 */
export function registerFile(db: AppDb, input: NewFile): { row: FileRow; created: boolean } {
	return db.transaction(() => {
		const id = input.id ?? freshFileId(db);
		const inserted = db.run(
			`INSERT INTO files_index (id, path, name, mime, kind, size, source, added_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (path) DO NOTHING`,
			id,
			input.path,
			input.name,
			input.mime,
			input.kind,
			input.size,
			input.source,
			input.now,
			input.now,
		);
		if (inserted.changes === 0) {
			db.run(
				"UPDATE files_index SET mime = ?, kind = ?, size = ? WHERE path = ?",
				input.mime,
				input.kind,
				input.size,
				input.path,
			);
		}
		const row = db.get<DbRow>(`SELECT ${COLUMNS} FROM files_index WHERE path = ?`, input.path);
		if (row === undefined) throw new Error(`The file ${input.path} was not indexed. This should be impossible.`);
		return { row: fromRecord(row), created: inserted.changes > 0 };
	});
}

export function getFile(db: AppDb, id: string): FileRow | undefined {
	const record = db.get<DbRow>(`SELECT ${COLUMNS} FROM files_index WHERE id = ?`, id);
	return record === undefined ? undefined : fromRecord(record);
}

export function requireFile(db: AppDb, id: string): FileRow {
	const row = getFile(db, id);
	if (row === undefined) {
		throw new Error(
			`No file '${id}'. search_files finds files by what they are called or what they were described as.`,
		);
	}
	return row;
}

/** How many files the index holds, and the newest few. */
export function recentFiles(db: AppDb, limit: number): { total: number; recent: FileRow[] } {
	const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files_index")?.n ?? 0;
	const recent = db
		.all<DbRow>(`SELECT ${COLUMNS} FROM files_index ORDER BY updated_at DESC, added_at DESC, id LIMIT ?`, limit)
		.map(fromRecord);
	return { total, recent };
}

const words = (query: string): string[] =>
	query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word !== "");

/**
 * Files whose name, description or tags contain every word of the query (any letter case, in any script), the most
 * recently described or added first. An empty query lists the newest. The words are compared in JavaScript: SQLite's
 * `lower()` knows only ASCII, so "école" would never find "École.csv". The index is the files of one person, so reading
 * it whole for a search is cheap.
 */
export function searchFiles(db: AppDb, query: string, limit: number): { files: FileRow[]; total: number } {
	const terms = words(query);
	if (terms.length === 0) {
		const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files_index")?.n ?? 0;
		const files = db
			.all<DbRow>(`SELECT ${COLUMNS} FROM files_index ORDER BY updated_at DESC, added_at DESC, id LIMIT ?`, limit)
			.map(fromRecord);
		return { files, total };
	}
	const matching = db
		.all<DbRow>(`SELECT ${COLUMNS} FROM files_index ORDER BY updated_at DESC, added_at DESC, id`)
		.map(fromRecord)
		.filter((row) => {
			const haystack = `${row.name} ${row.description} ${row.tags.join(" ")}`.toLowerCase();
			return terms.every((term) => haystack.includes(term));
		});
	return { files: matching.slice(0, limit), total: matching.length };
}

/** The file that tool call `callId` already described, if any. */
export function findDescribedByCall(db: AppDb, callId: string): FileRow | undefined {
	const record = db.get<{ file_id: string | null }>(
		"SELECT file_id FROM files_call WHERE source_call_id = ? AND tool = 'describe_file'",
		callId,
	);
	return record?.file_id == null ? undefined : getFile(db, record.file_id);
}

/**
 * Write down what a file is. The call id is recorded in the same transaction (rule 8), so a call Durable replays after a
 * crash changes nothing the second time. `applied` is false for a replay.
 */
export function describeFile(
	db: AppDb,
	id: string,
	change: { description: string; tags?: readonly string[] },
	callId: string,
	now: number,
): { applied: boolean; row: FileRow } {
	return db.transaction(() => {
		const before = requireFile(db, id);
		const recorded = db.run(
			"INSERT INTO files_call (source_call_id, tool, file_id, applied_at) VALUES (?, 'describe_file', ?, ?) ON CONFLICT DO NOTHING",
			callId,
			id,
			now,
		);
		if (recorded.changes === 0) return { applied: false, row: before };
		db.run(
			"UPDATE files_index SET description = ?, tags = ?, updated_at = ? WHERE id = ?",
			change.description,
			change.tags === undefined ? before.tags.join(" ") : change.tags.join(" "),
			now,
			id,
		);
		return { applied: true, row: requireFile(db, id) };
	});
}

export function toSummary(row: FileRow): FileSummary {
	return {
		id: row.id,
		name: row.name,
		mime: row.mime,
		kind: row.kind,
		size: row.size,
		source: row.source,
		addedAt: row.addedAt,
		...(row.description === "" ? {} : { description: row.description }),
		...(row.tags.length === 0 ? {} : { tags: row.tags }),
	};
}
