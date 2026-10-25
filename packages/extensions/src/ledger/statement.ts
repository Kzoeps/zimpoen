import { createHash } from "node:crypto";
import type { ImportColumnRole } from "@assistant/shared";
import { type DecimalSeparator, detectDecimalSeparator, parseAmountText } from "../money.ts";
import { type CsvRow, type DateOrder, detectDateOrder, parseDateCell } from "./csv.ts";
import { nameKey } from "./keys.ts";

/**
 * From the rows of a bank or app export to entries: which column is what (found from the headers, or from the cells when
 * there are none, or told by the caller), and the rows read through that mapping. Pure functions of the rows.
 */

export type Mapping = {
	/** Index into the rows of the header row; absent when the file has none. */
	headerRow?: number;
	/** Column indexes, 0-based. */
	date: number;
	description?: number;
	/** One signed column (negative is money out)... */
	amount?: number;
	/** ...or one column of money out and one of money in, each positive. */
	debit?: number;
	credit?: number;
	/** ...or one unsigned `amount` column and a column that says which way each row went (`DR`/`CR`, `Debit`/`Credit`). */
	direction?: number;
	category?: number;
	currency?: number;
	balance?: number;
	dateOrder: DateOrder;
	decimal: DecimalSeparator;
	/** The file counts money out as positive (a credit card statement): flip every sign. */
	invert: boolean;
};

/** A column named the way the owner or the model sees it: its header text, or its number counting from 1. */
export type ColumnRef = string | number;

/** What a caller may say about the mapping; anything left out is what was detected. */
export type MappingRequest = {
	date?: ColumnRef | undefined;
	description?: ColumnRef | undefined;
	amount?: ColumnRef | undefined;
	debit?: ColumnRef | undefined;
	credit?: ColumnRef | undefined;
	direction?: ColumnRef | undefined;
	category?: ColumnRef | undefined;
	currency?: ColumnRef | undefined;
	balance?: ColumnRef | undefined;
	date_order?: DateOrder | undefined;
	decimal?: DecimalSeparator | undefined;
	invert?: boolean | undefined;
	/** The line (1-based) the header is on; 0 says the file has no header. */
	header_line?: number | undefined;
};

type HeaderRole = Exclude<ImportColumnRole, "ignored">;

const HEADER_ROLES: ReadonlyArray<readonly [HeaderRole, RegExp]> = [
	["balance", /\b(balance|bal)\b/],
	["date", /\bdate\b|^dt$|\b(posted|posting|booking)\b/],
	// A header that names an amount and also says Dr/Cr ("Amount (Dr/Cr)") is one signed column, not a column of debits.
	["amount", /\b(amount|amt|value)\b.*\b(dr|cr)\b|\b(dr|cr)\b.*\b(amount|amt|value)\b/],
	["debit", /\b(debit|debits|withdrawal|withdrawals|withdrawn|dr|money out|paid out|outflow)\b/],
	["credit", /\b(credit|credits|deposit|deposits|cr|money in|paid in|inflow)\b/],
	["amount", /\b(amount|amt|value)\b/],
	["category", /\bcategory\b/],
	["currency", /\b(currency|ccy)\b/],
	[
		"description",
		/\b(description|details|narration|narrative|particulars|memo|payee|merchant|remarks?|reference|notes?|name|transaction)\b/,
	],
];

/**
 * The description columns that say what the row was. A bank prints a reference number or an account name beside the
 * narration: those describe the row only when nothing better is there, so the first of these wins over an earlier column.
 */
const NARRATION_HEADER =
	/\b(description|details|narration|narrative|particulars|memo|payee|merchant|remarks?|transaction)\b/;

/** What a cell of a Dr/Cr or Type column says: -1 for money out (a debit), 1 for money in (a credit), undefined for anything else. */
const DIRECTION_WORDS: Readonly<Record<string, -1 | 1>> = {
	dr: -1,
	d: -1,
	debit: -1,
	debited: -1,
	withdrawal: -1,
	cr: 1,
	c: 1,
	credit: 1,
	credited: 1,
	deposit: 1,
};

export function directionOf(cell: string): -1 | 1 | undefined {
	const word = cell
		.trim()
		.toLowerCase()
		.replace(/[\s.]+$/, "");
	return Object.hasOwn(DIRECTION_WORDS, word) ? DIRECTION_WORDS[word] : undefined;
}

/** A header that talks about the way money went: `Dr/Cr`, `Type`, `Debit/Credit`, `Indicator`. A hint only; the cells decide. */
const DIRECTION_HEADER = /\b(dr|cr|d|c|type|indicator|direction)\b/;

function roleOfHeader(header: string): ImportColumnRole {
	const key = nameKey(header);
	if (key === "") return "ignored";
	for (const [role, pattern] of HEADER_ROLES) if (pattern.test(key)) return role;
	return "ignored";
}

/** The header of a table among its first lines: a row that names a date and at least one more thing a statement has. */
function findHeaderRow(rows: readonly CsvRow[]): number | undefined {
	for (let index = 0; index < Math.min(rows.length, 30); index++) {
		const roles = (rows[index]?.cells ?? []).map(roleOfHeader);
		const known = roles.filter((role) => role !== "ignored");
		if (roles.includes("date") && known.length >= 2 && known.some((role) => role !== "date")) return index;
	}
	return undefined;
}

const SAMPLE_ROWS = 200;

const cellAt = (row: CsvRow, index: number | undefined): string =>
	index === undefined ? "" : (row.cells[index] ?? "").trim();

/** The most common number of cells among the rows that have two or more: the width of the table. */
function tableWidth(rows: readonly CsvRow[]): number {
	const widths = new Map<number, number>();
	for (const row of rows)
		if (row.cells.length >= 2) widths.set(row.cells.length, (widths.get(row.cells.length) ?? 0) + 1);
	return [...widths.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
}

export type Proposal = {
	mapping?: Mapping;
	/** One name per column: the header, or `Column 3`. */
	headers: string[];
	/** Why no mapping could be proposed, or what to check. */
	problems: string[];
	ambiguousDates: boolean;
};

/** The share of the cells of a column that satisfy a test, of the first rows of the table. */
const share = (rows: readonly CsvRow[], index: number, test: (cell: string) => boolean): number => {
	const cells = rows.slice(0, SAMPLE_ROWS).map((row) => cellAt(row, index));
	const filled = cells.filter((cell) => cell !== "");
	return filled.length === 0 ? 0 : filled.filter(test).length / filled.length;
};

/** A cell with a DR or CR in it (`1250.50 DR`, `CR 500`): the amount carries its own direction. */
const hasIndicatorWord = (cell: string): boolean => /(^|[^a-z])(dr|cr)\.?($|[^a-z])/i.test(cell) && /\d/.test(cell);

/**
 * The column of a table whose cells are all a direction word. A single letter (`D`, `C`) is weak evidence: it counts only
 * under a header that hints at a direction (`D/C`, `Type`); without a hint three filled cells of whole words (`DR`, `Credit`)
 * are needed, so that a column that means something else is not mistaken for one.
 */
function findDirectionColumn(
	data: readonly CsvRow[],
	headers: readonly string[],
	roles: readonly ImportColumnRole[],
): number | undefined {
	const found = headers.flatMap((header, index) => {
		if (roles[index] === "date" || roles[index] === "balance" || roles[index] === "amount") return [];
		const filled = data.slice(0, SAMPLE_ROWS).filter((row) => cellAt(row, index) !== "").length;
		const hinted = DIRECTION_HEADER.test(nameKey(header));
		const says = (cell: string): boolean =>
			directionOf(cell) !== undefined && (hinted || /^[a-z]{2,}\.?$/i.test(cell.trim()));
		if (filled < (hinted ? 1 : 3) || share(data, index, says) < 0.95) return [];
		return [index];
	});
	return found.length === 1 ? found[0] : undefined;
}

/**
 * Work out the mapping of a table. With a header row, the headers say what each column is; without one the cells do: a
 * column of dates, one column of amounts, the longest text for the description. When the file is not clear enough to be
 * sure (two columns that could be the amount, no dates at all), no mapping is proposed and the problems say why.
 */
export function proposeMapping(rows: readonly CsvRow[]): Proposal {
	const width = tableWidth(rows);
	const headerRow = findHeaderRow(rows);
	const header = headerRow === undefined ? undefined : rows[headerRow];
	const headers = Array.from({ length: width }, (_, index) => {
		const text = header === undefined ? "" : cellAt(header, index);
		return text === "" ? `Column ${index + 1}` : text;
	});
	const data = rows.slice(headerRow === undefined ? 0 : headerRow + 1).filter((row) => row.cells.length >= 2);
	const problems: string[] = [];
	if (width < 2 || data.length === 0) {
		return {
			headers,
			problems: ["The file has no table of at least two columns with rows under it."],
			ambiguousDates: false,
		};
	}

	const roles: ImportColumnRole[] = headers.map((_, index) =>
		header === undefined ? "ignored" : roleOfHeader(cellAt(header, index)),
	);
	// A column that is nothing but DR/CR (or Debit/Credit) says which way each row went, whatever its header is called;
	// "Dr/Cr" would otherwise be taken for the column of debits, and its cells ignored.
	const directionColumn = findDirectionColumn(data, headers, roles);
	if (directionColumn !== undefined) roles[directionColumn] = "direction";
	// A column the header calls Debit or Credit whose cells carry DR or CR themselves is one signed amount column.
	roles.forEach((role, index) => {
		if ((role === "debit" || role === "credit") && share(data, index, hasIndicatorWord) >= 0.5) roles[index] = "amount";
	});
	const pick = (role: ImportColumnRole, prefer?: RegExp): number | undefined => {
		const found = roles.flatMap((candidate, index) => (candidate === role ? [index] : []));
		return found.find((index) => prefer?.test(nameKey(headers[index] ?? "")) === true) ?? found[0];
	};

	let date = pick("date", /trans|txn|post|book/);
	let amount = pick("amount");
	const debit = pick("debit");
	const credit = pick("credit");
	const direction = pick("direction");
	let description = pick("description", NARRATION_HEADER);

	const isDate = (cell: string): boolean =>
		parseDateCell(cell, "DMY") !== undefined || parseDateCell(cell, "MDY") !== undefined;
	if (date === undefined) {
		const candidates = headers
			.map((_, index) => ({ index, found: share(data, index, isDate) }))
			.filter((entry) => entry.found >= 0.6);
		date = candidates.sort((a, b) => b.found - a.found || a.index - b.index)[0]?.index;
	}
	if (date === undefined) {
		return {
			headers,
			problems: ["No column looks like dates, so the rows cannot be placed on days."],
			ambiguousDates: false,
		};
	}
	if (header !== undefined && share(data, date, isDate) < 0.6) {
		problems.push(
			`The column "${headers[date]}" does not look like dates for most rows: check date_order and the column.`,
		);
	}

	const numeric = (cell: string): boolean => /\d/.test(cell) && parseAmountText(cell, "XXX", ".") !== undefined;
	const numericDecimal = (cell: string): boolean =>
		/\d/.test(cell) &&
		(parseAmountText(cell, "XXX", ".") !== undefined || parseAmountText(cell, "XXX", ",") !== undefined);
	if (amount === undefined && debit === undefined && credit === undefined) {
		const taken = new Set([date, pick("balance")].filter((index): index is number => index !== undefined));
		const candidates = headers
			.map((_, index) => index)
			.filter(
				(index) => !taken.has(index) && share(data, index, numericDecimal) >= 0.6 && share(data, index, isDate) < 0.5,
			);
		const signed = candidates.filter((index) => share(data, index, (cell) => /[.,]\d{1,2}$|^-|^\(/.test(cell)) >= 0.6);
		const chosen = signed.length === 1 ? signed : candidates.length === 1 ? candidates : [];
		if (chosen.length === 1) amount = chosen[0];
		else {
			return {
				headers,
				problems: [
					candidates.length === 0
						? "No column looks like an amount."
						: `Several columns could be the amount (${candidates.map((index) => headers[index]).join(", ")}): say which one.`,
				],
				ambiguousDates: false,
			};
		}
	}
	if (description === undefined) {
		const used = new Set([date, amount, debit, credit, direction, pick("balance"), pick("category"), pick("currency")]);
		const text = headers
			.map((_, index) => index)
			.filter((index) => !used.has(index))
			.map((index) => ({
				index,
				length: data.slice(0, SAMPLE_ROWS).reduce((sum, row) => sum + cellAt(row, index).length, 0),
				numeric: share(data, index, numeric),
			}))
			.filter((entry) => entry.numeric < 0.5 && entry.length > 0)
			.sort((a, b) => b.length - a.length || a.index - b.index);
		description = text[0]?.index;
	}

	const amountCells = [amount, debit, credit].flatMap((index) =>
		index === undefined ? [] : data.slice(0, SAMPLE_ROWS).map((row) => cellAt(row, index)),
	);
	const { order, ambiguous } = detectDateOrder(data.slice(0, SAMPLE_ROWS).map((row) => cellAt(row, date)));
	const mapping: Mapping = {
		...(headerRow === undefined ? {} : { headerRow }),
		date,
		...(description === undefined ? {} : { description }),
		...(amount === undefined ? {} : { amount }),
		...(amount === undefined && debit !== undefined ? { debit } : {}),
		...(amount === undefined && credit !== undefined ? { credit } : {}),
		...(amount !== undefined && direction !== undefined ? { direction } : {}),
		...optionalIndex("category", pick("category")),
		...optionalIndex("currency", pick("currency")),
		...optionalIndex("balance", pick("balance")),
		dateOrder: order,
		decimal: detectDecimalSeparator(amountCells),
		invert: false,
	};
	return { mapping, headers, problems, ambiguousDates: ambiguous };
}

const optionalIndex = <K extends string>(key: K, index: number | undefined): { [P in K]?: number } =>
	(index === undefined ? {} : { [key]: index }) as { [P in K]?: number };

/** The column a reference names, or what to say instead: the header equal to it, else one that contains it, or its number. */
function columnIndex(ref: ColumnRef, headers: readonly string[], name: string): number {
	if (typeof ref === "number") {
		if (ref < 1 || ref > headers.length)
			throw new Error(`mapping.${name}: there is no column ${ref}; the file has ${headers.length}.`);
		return ref - 1;
	}
	const wanted = nameKey(ref);
	const exact = headers.findIndex((header) => nameKey(header) === wanted);
	if (exact >= 0) return exact;
	const partial = headers.flatMap((header, index) =>
		wanted !== "" && nameKey(header).includes(wanted) ? [index] : [],
	);
	if (partial.length === 1) return partial[0] as number;
	throw new Error(
		`mapping.${name}: no single column is called "${ref.slice(0, 40)}". Columns: ${headers.map((header, index) => `${index + 1} ${header}`).join(", ")}.`,
	);
}

/** The proposal with what the caller said laid over it. Throws what to fix when a column cannot be found or nothing is left to go on. */
export function resolveMapping(
	rows: readonly CsvRow[],
	proposal: Proposal,
	request: MappingRequest | undefined,
): Mapping {
	if (request === undefined || Object.values(request).every((value) => value === undefined)) {
		if (proposal.mapping === undefined) throw new Error(needsMapping(proposal));
		return proposal.mapping;
	}
	const base = proposal.mapping;
	let headers = proposal.headers;
	let headerRow = base?.headerRow;
	if (request.header_line !== undefined) {
		// A header the caller points at replaces the detected one; 0 says there is none.
		const found = request.header_line === 0 ? undefined : rows.findIndex((row) => row.line === request.header_line);
		if (found === -1) throw new Error(`mapping.header_line: no row starts on line ${request.header_line}.`);
		headerRow = found;
		const row = found === undefined ? undefined : rows[found];
		headers = headers.map((_, index) =>
			row === undefined || cellAt(row, index) === "" ? `Column ${index + 1}` : cellAt(row, index),
		);
	}
	const at = (ref: ColumnRef | undefined, name: string): number | undefined =>
		ref === undefined ? undefined : columnIndex(ref, headers, name);
	const date = at(request.date, "date") ?? base?.date;
	if (date === undefined) throw new Error(needsMapping(proposal));
	const amount =
		at(request.amount, "amount") ??
		(request.debit !== undefined || request.credit !== undefined ? undefined : base?.amount);
	const debit = at(request.debit, "debit") ?? (request.amount !== undefined ? undefined : base?.debit);
	const credit = at(request.credit, "credit") ?? (request.amount !== undefined ? undefined : base?.credit);
	if (amount === undefined && debit === undefined && credit === undefined) throw new Error(needsMapping(proposal));
	// A direction column only means something next to one unsigned amount column.
	const direction = amount === undefined ? undefined : (at(request.direction, "direction") ?? base?.direction);
	const description = at(request.description, "description") ?? base?.description;
	const category = at(request.category, "category") ?? base?.category;
	const currency = at(request.currency, "currency") ?? base?.currency;
	const balance = at(request.balance, "balance") ?? base?.balance;
	return {
		...(headerRow === undefined ? {} : { headerRow }),
		date,
		...optionalIndex("description", description),
		...optionalIndex("amount", amount),
		...optionalIndex("debit", debit),
		...optionalIndex("credit", credit),
		...optionalIndex("direction", direction),
		...optionalIndex("category", category),
		...optionalIndex("currency", currency),
		...optionalIndex("balance", balance),
		dateOrder: request.date_order ?? base?.dateOrder ?? "DMY",
		decimal: request.decimal ?? base?.decimal ?? ".",
		invert: request.invert ?? base?.invert ?? false,
	};
}

/** What to tell the caller when the file could not be understood without help: why, the columns, and the shape of the answer. */
function needsMapping(proposal: Proposal): string {
	return (
		`Could not tell what the columns are. ${proposal.problems.join(" ")} Columns: ${proposal.headers
			.map((header, index) => `${index + 1} ${header}`)
			.join(", ")}. ` +
		'Call import_csv again with mapping, for example {"date":"Date","description":"Details","amount":"Amount"} ' +
		'(or "debit" and "credit" instead of "amount"; columns by header text or by number).'
	);
}

/** What each column stands for under a mapping, for the preview. */
export function columnRoles(
	mapping: Mapping,
	headers: readonly string[],
): Array<{ header: string; role: ImportColumnRole }> {
	const roleAt = new Map<number, ImportColumnRole>();
	const set = (index: number | undefined, role: ImportColumnRole): void =>
		void (index === undefined || roleAt.set(index, role));
	set(mapping.date, "date");
	set(mapping.description, "description");
	set(mapping.amount, "amount");
	set(mapping.debit, "debit");
	set(mapping.credit, "credit");
	set(mapping.direction, "direction");
	set(mapping.category, "category");
	set(mapping.currency, "currency");
	set(mapping.balance, "balance");
	return headers.map((header, index) => ({ header, role: roleAt.get(index) ?? "ignored" }));
}

/** One row of the file, read: what goes into the ledger if it is confirmed. */
export type StatementRow = {
	date: string;
	/** Signed: money out is negative. */
	amountMinor: number;
	description: string;
	/** The file's own category, when it has a column for it. */
	category?: string;
	line: number;
};

export type Normalized = { rows: StatementRow[]; skipped: number; problems: string[] };

const MAX_PROBLEMS = 5;
const MAX_DESCRIPTION = 120;

/** A cell as one short line of plain text: no line breaks, no angle brackets, at most 120 characters. */
const plainText = (value: string): string => {
	const text = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
	return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
};

/**
 * Read the rows below the header through a mapping. A row with no readable date or no amount is skipped and counted (a
 * title line, a total, a blank), with the first few reasons kept; a row whose own currency differs from the account's is
 * skipped too, because an account holds one currency, and so is one dated after `today`. Zero amounts are not entries.
 */
export function normalizeRows(
	rows: readonly CsvRow[],
	mapping: Mapping,
	currency: string,
	/** The owner's today: a row dated after it is left out, as the chat refuses a day that has not come. */
	today?: string,
): Normalized {
	const out: StatementRow[] = [];
	const problems: string[] = [];
	let skipped = 0;
	const skip = (row: CsvRow, why: string): void => {
		skipped++;
		if (problems.length < MAX_PROBLEMS) problems.push(`Line ${row.line}: ${why}`);
	};
	const start = mapping.headerRow === undefined ? 0 : mapping.headerRow + 1;
	for (const row of rows.slice(start)) {
		if (row.cells.length < 2) continue;
		const date = parseDateCell(cellAt(row, mapping.date), mapping.dateOrder);
		if (date === undefined) {
			// A line that is not a date at all (a total, a closing balance, a blank) is not worth a message.
			if (cellAt(row, mapping.date) !== "" && /\d/.test(cellAt(row, mapping.date)))
				skip(row, `"${plainText(cellAt(row, mapping.date))}" is not a date`);
			else skipped++;
			continue;
		}
		if (today !== undefined && date > today) {
			skip(row, `it is dated ${date}, after today (${today}), and a statement has no entries from the future`);
			continue;
		}
		const rowCurrency = cellAt(row, mapping.currency).toUpperCase();
		if (/^[A-Z]{3}$/.test(rowCurrency) && rowCurrency !== currency) {
			skip(row, `it is in ${rowCurrency} and the account holds ${currency}`);
			continue;
		}
		let amountMinor: number | undefined;
		if (mapping.amount !== undefined) {
			amountMinor = parseAmountText(cellAt(row, mapping.amount), currency, mapping.decimal);
			// An unsigned amount with a DR/CR (or Debit/Credit) next to it: the word gives the sign, whatever the amount shows.
			const way = directionOf(cellAt(row, mapping.direction));
			if (amountMinor !== undefined && way !== undefined) amountMinor = way * Math.abs(amountMinor);
		} else {
			const out = parseAmountText(cellAt(row, mapping.debit), currency, mapping.decimal);
			const into = parseAmountText(cellAt(row, mapping.credit), currency, mapping.decimal);
			const outAmount = out === undefined ? 0 : -Math.abs(out);
			const inAmount = into === undefined ? 0 : Math.abs(into);
			amountMinor = out === undefined && into === undefined ? undefined : outAmount + inAmount;
		}
		if (amountMinor === undefined) {
			skip(row, `"${plainText(cellAt(row, mapping.amount ?? mapping.debit ?? mapping.credit))}" is not an amount`);
			continue;
		}
		if (amountMinor === 0) {
			skipped++;
			continue;
		}
		const category = plainText(cellAt(row, mapping.category));
		out.push({
			date,
			amountMinor: mapping.invert ? -amountMinor : amountMinor,
			description: plainText(cellAt(row, mapping.description)),
			...(category === "" ? {} : { category }),
			line: row.line,
		});
	}
	return { rows: out, skipped, problems };
}

/**
 * A fingerprint for each row, so that the same statement imported twice, or two statements that overlap, add each entry once.
 * It holds the account, the day, the amount and the description, and a counter for rows that are the same in all of those
 * (two coffees at the same stall on one day are two entries, and a second export has the same two).
 */
export function fingerprints(rows: readonly StatementRow[], accountId: number): string[] {
	const seen = new Map<string, number>();
	return rows.map((row) => {
		const base = `${accountId}|${row.date}|${row.amountMinor}|${nameKey(row.description)}`;
		const occurrence = (seen.get(base) ?? 0) + 1;
		seen.set(base, occurrence);
		return createHash("sha256").update(`${base}|${occurrence}`).digest("hex").slice(0, 32);
	});
}

const DAY_MS = 86_400_000;
const daysApart = (a: string, b: string): number =>
	Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

/** How many days either way a statement may be from the day the owner typed an entry: the bank books a card payment a day or two late. */
export const MATCH_SLACK_DAYS = 2;

/**
 * Which statement rows probably are an entry the owner already has (typed in chat, or read from a receipt): the same amount
 * on the same day or within `MATCH_SLACK_DAYS` of it. An entry answers for one row only (two coffees of the same price in a
 * statement are not both the one typed). The closest pairs are made first, whichever rows they are, so that a row on the very
 * day gets the entry before a row two days off does; on a tie the earlier row and the earlier written entry go first. Returns
 * the entry by the row's index.
 */
export function matchToExisting<E extends { date: string; amountMinor: number; seq: number }>(
	rows: readonly { date: string; amountMinor: number }[],
	entries: readonly E[],
	slackDays = MATCH_SLACK_DAYS,
): Map<number, E> {
	const byAmount = new Map<number, E[]>();
	for (const entry of entries) {
		const list = byAmount.get(entry.amountMinor);
		if (list === undefined) byAmount.set(entry.amountMinor, [entry]);
		else list.push(entry);
	}
	const pairs: Array<{ row: number; entry: E; apart: number }> = [];
	rows.forEach((row, index) => {
		for (const entry of byAmount.get(row.amountMinor) ?? []) {
			const apart = daysApart(row.date, entry.date);
			if (apart <= slackDays) pairs.push({ row: index, entry, apart });
		}
	});
	pairs.sort((a, b) => a.apart - b.apart || a.row - b.row || a.entry.seq - b.entry.seq);
	const taken = new Set<E>();
	const matches = new Map<number, E>();
	for (const pair of pairs) {
		if (matches.has(pair.row) || taken.has(pair.entry)) continue;
		matches.set(pair.row, pair.entry);
		taken.add(pair.entry);
	}
	return matches;
}
