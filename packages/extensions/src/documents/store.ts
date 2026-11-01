import type { AppDb } from "@assistant/db";
import { checkPattern, DEFAULT_NUMBER_PATTERN, formatNumber, patternProblem } from "./numbering.ts";
import { DocumentError } from "./render.ts";

export type SeriesRow = { series: string; pattern: string; nextSeq: number };
export type TakenNumber = { number: string; series: string; seq: number; label: string };

const SERIES = /^[a-z][a-z0-9-]{0,39}$/;

export function checkSeries(series: string): string {
	if (!SERIES.test(series)) {
		throw new DocumentError(
			`'${series.slice(0, 40)}' is not a series name: use lowercase letters, digits and dashes, such as invoice or quote.`,
		);
	}
	return series;
}

export function listSeries(db: AppDb): SeriesRow[] {
	return db.all<SeriesRow>("SELECT series, pattern, next_seq AS nextSeq FROM document_series ORDER BY series");
}

export function getSeries(db: AppDb, series: string): SeriesRow | undefined {
	return db.get<SeriesRow>("SELECT series, pattern, next_seq AS nextSeq FROM document_series WHERE series = ?", series);
}

/** Create a series or change its pattern and next number. The next number may not go back to one already taken. */
export function setSeries(
	db: AppDb,
	input: { series: string; pattern?: string; next?: number; now: number },
): SeriesRow {
	return db.transaction(() => {
		const existing = getSeries(db, input.series);
		const pattern =
			input.pattern === undefined ? (existing?.pattern ?? DEFAULT_NUMBER_PATTERN) : checkPattern(input.pattern);
		const next = input.next ?? existing?.nextSeq ?? 1;
		if (!Number.isInteger(next) || next < 1) throw new DocumentError("The next number must be a whole number from 1.");
		const highest = db.get<{ seq: number | null }>(
			"SELECT max(seq) AS seq FROM document_numbers WHERE series = ?",
			input.series,
		)?.seq;
		if (highest !== null && highest !== undefined && next <= highest) {
			throw new DocumentError(
				`Number ${highest} of ${input.series} is already taken; the next one must be ${highest + 1} or more.`,
			);
		}
		db.run(
			`INSERT INTO document_series (series, pattern, next_seq, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (series) DO UPDATE SET pattern = excluded.pattern, next_seq = excluded.next_seq, updated_at = excluded.updated_at`,
			input.series,
			pattern,
			next,
			input.now,
		);
		return { series: input.series, pattern, nextSeq: next };
	});
}

/** Take the next number of a series for good. A replayed call (same `callId`) gets the number it took the first time. */
export function takeNumber(
	db: AppDb,
	input: { series: string; date: string; label: string; callId: string; now: number },
): { taken: TakenNumber; replayed: boolean } {
	return db.transaction(() => {
		const earlier = db.get<TakenNumber>(
			"SELECT number, series, seq, label FROM document_numbers WHERE source_call_id = ?",
			input.callId,
		);
		if (earlier !== undefined) return { taken: earlier, replayed: true };
		const series = getSeries(db, input.series) ?? setSeries(db, { series: input.series, now: input.now });
		const problem = patternProblem(series.pattern);
		if (problem !== undefined) throw new DocumentError(`The ${input.series} pattern is unusable: ${problem}`);
		const number = formatNumber(series.pattern, series.nextSeq, input.date);
		db.run(
			"INSERT INTO document_numbers (number, series, seq, label, source_call_id, taken_at) VALUES (?, ?, ?, ?, ?, ?)",
			number,
			input.series,
			series.nextSeq,
			input.label,
			input.callId,
			input.now,
		);
		db.run(
			"UPDATE document_series SET next_seq = ?, updated_at = ? WHERE series = ?",
			series.nextSeq + 1,
			input.now,
			input.series,
		);
		return { taken: { number, series: input.series, seq: series.nextSeq, label: input.label }, replayed: false };
	});
}

export function recentNumbers(db: AppDb, series: string, limit: number): TakenNumber[] {
	return db.all<TakenNumber>(
		"SELECT number, series, seq, label FROM document_numbers WHERE series = ? ORDER BY seq DESC LIMIT ?",
		series,
		limit,
	);
}

export function madeByCall(db: AppDb, callId: string): string | undefined {
	return db.get<{ fileId: string }>("SELECT file_id AS fileId FROM documents_made WHERE source_call_id = ?", callId)
		?.fileId;
}

export function recordMade(db: AppDb, callId: string, fileId: string, now: number): void {
	db.run(
		"INSERT OR IGNORE INTO documents_made (source_call_id, file_id, created_at) VALUES (?, ?, ?)",
		callId,
		fileId,
		now,
	);
}
