/**
 * Reading a bank or app export: the bytes into text (whatever the encoding), the text into rows (whatever the separator
 * and quoting), and the cells into dates. Pure functions: no file, no database, so each rule is cheap to test.
 */

export type CsvEncoding = "UTF-8" | "UTF-16LE" | "UTF-16BE" | "Windows-1252";

/**
 * The text of a file whose encoding nobody told us. A byte order mark settles it (UTF-8, UTF-16); UTF-16 without one shows
 * as a NUL next to every ASCII letter; otherwise UTF-8 if the bytes are valid UTF-8, and Windows-1252 (what bank exports
 * in Europe and South Asia usually are) when they are not.
 */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: CsvEncoding } {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "UTF-8" };
	}
	if (bytes[0] === 0xff && bytes[1] === 0xfe) {
		return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "UTF-16LE" };
	}
	if (bytes[0] === 0xfe && bytes[1] === 0xff) {
		return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "UTF-16BE" };
	}
	if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0 && bytes[0] !== 0) {
		return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "UTF-16LE" };
	}
	if (bytes.length >= 4 && bytes[0] === 0 && bytes[2] === 0 && bytes[1] !== 0) {
		return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "UTF-16BE" };
	}
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
	} catch {
		return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "Windows-1252" };
	}
}

export type Delimiter = "," | ";" | "\t" | "|";

const DELIMITERS: readonly Delimiter[] = [",", ";", "\t", "|"];

/** How many times `delimiter` appears in a line outside double quotes. */
function countOutsideQuotes(line: string, delimiter: string): number {
	let quoted = false;
	let count = 0;
	for (const char of line) {
		if (char === '"') quoted = !quoted;
		else if (!quoted && char === delimiter) count++;
	}
	return count;
}

/**
 * The separator of a table: the one that splits most of the first lines into the same number of cells. A title or a
 * summary line before the table does not matter, because the most common count wins, and a comma inside a quoted
 * description is not counted.
 */
export function detectDelimiter(text: string): Delimiter {
	const lines = text
		.split(/\r\n|\r|\n/)
		.filter((line) => line.trim() !== "")
		.slice(0, 25);
	let best: { delimiter: Delimiter; score: number } = { delimiter: ",", score: 0 };
	for (const delimiter of DELIMITERS) {
		const counts = lines.map((line) => countOutsideQuotes(line, delimiter)).filter((count) => count > 0);
		const frequency = new Map<number, number>();
		for (const count of counts) frequency.set(count, (frequency.get(count) ?? 0) + 1);
		for (const [count, occurrences] of frequency) {
			const score = occurrences * 1000 + count;
			if (score > best.score) best = { delimiter, score };
		}
	}
	return best.delimiter;
}

/** One record of the file: its cells, and the number of the line it starts on (1-based) for messages. */
export type CsvRow = { cells: string[]; line: number };

/** The most rows and columns a file may have. A statement of a few years is thousands of rows, never a million. */
export const MAX_CSV_ROWS = 20_000;
export const MAX_CSV_COLUMNS = 60;

/**
 * Split CSV text into records (RFC 4180): quoted cells may hold the separator, doubled quotes and line breaks; a line
 * ends with `\r\n`, `\n` or `\r`. Records with no text in any cell are dropped. Throws when the file is too big to be one
 * statement, so that a wrong file is refused instead of read for minutes.
 */
export function parseCsv(text: string, delimiter: string): CsvRow[] {
	const rows: CsvRow[] = [];
	let cells: string[] = [];
	let cell = "";
	let quoted = false;
	let line = 1;
	let startLine = 1;
	let touched = false;

	const endCell = (): void => {
		cells.push(cell);
		cell = "";
	};
	const endRow = (): void => {
		endCell();
		if (cells.some((value) => value.trim() !== "")) {
			if (cells.length > MAX_CSV_COLUMNS) {
				throw new Error(
					`Line ${startLine} has ${cells.length} columns. A statement has far fewer: is this the right file and separator?`,
				);
			}
			rows.push({ cells, line: startLine });
			if (rows.length > MAX_CSV_ROWS) {
				throw new Error(
					`The file has more than ${MAX_CSV_ROWS} rows. Split it by period and import the parts one at a time.`,
				);
			}
		}
		cells = [];
		touched = false;
	};

	for (let index = 0; index < text.length; index++) {
		const char = text[index] as string;
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					cell += '"';
					index++;
				} else quoted = false;
			} else {
				if (char === "\n") line++;
				cell += char;
			}
			continue;
		}
		if (char === '"' && cell === "") {
			quoted = true;
			touched = true;
		} else if (char === delimiter) {
			endCell();
			touched = true;
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index++;
			endRow();
			line++;
			startLine = line;
		} else {
			cell += char;
			touched = true;
		}
	}
	if (touched || cell !== "" || cells.length > 0) endRow();
	return rows;
}

// ----- dates ---------------------------------------------------------------------------------------------------------

export type DateOrder = "DMY" | "MDY" | "YMD";

const MONTH_NUMBER: Readonly<Record<string, number>> = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
};

/**
 * What follows `hh:` in a clock time at the end of a cell: `mm`, then seconds and a fraction, an am/pm and a zone. Anchored at
 * both ends and with one unbounded run at most (the fraction), so it cannot take longer than the text is long.
 */
const TIME_TAIL = /^\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AaPp][Mm])?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?$/;

/** No date with a time written out is longer than this ("25 September 2026 11:59:59.123456 PM +05:30" is 42): anything longer is not one. */
const MAX_DATE_CELL = 64;

const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const isBreak = (char: string): boolean => char === "T" || /\s/.test(char);

/**
 * `text` without a clock time at its end (` 14:30`, `T14:30:00Z`, ` 9:05 pm +05:30`), found in one pass over the text.
 *
 * A time is a run of `T` or white space, one or two digits and a colon, then {@link TIME_TAIL}. Each colon is tried once, and
 * the run is measured backwards from the digits, so no stretch of the text is read more than a few times, whatever the cell
 * holds. (A single regular expression for the whole suffix is not anchored at its start: on a long run of spaces it reads
 * the rest of the cell from every space, which is quadratic, and a statement is text from outside.)
 */
export function withoutTime(text: string): string {
	for (let colon = text.indexOf(":"); colon !== -1; colon = text.indexOf(":", colon + 1)) {
		let digits = colon;
		while (colon - digits < 2 && digits > 0 && isDigit(text.charCodeAt(digits - 1))) digits--;
		if (digits === colon) continue;
		let start = digits;
		while (start > 0 && isBreak(text[start - 1] as string)) start--;
		if (start === digits) continue;
		if (TIME_TAIL.test(text.slice(colon + 1))) return text.slice(0, start);
	}
	return text;
}

/** A cell trimmed, without its time, or undefined when it is too long to be a date at all. */
function dateText(raw: string): string | undefined {
	const trimmed = raw.trim();
	return trimmed.length > MAX_DATE_CELL ? undefined : withoutTime(trimmed).trim();
}

function calendarDay(year: number, month: number, day: number): string | undefined {
	if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
	const check = new Date(Date.UTC(year, month - 1, day));
	if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
		return undefined;
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const fullYear = (text: string): number =>
	text.length === 4 ? Number(text) : Number(text) < 70 ? 2000 + Number(text) : 1900 + Number(text);

/**
 * One cell as a local day `YYYY-MM-DD`, or undefined when it is not a date. Reads `2026-10-25`, `25/10/2026`, `25-10-26`,
 * `25.10.2026`, `25 Oct 2026`, `25-Oct-26`, `Oct 25, 2026`, with a time after it ignored. A numeric date with the day and
 * month both under 13 is read in `order`; `YMD` means "the year comes first or is not numeric", so a day-first file is `DMY`.
 */
export function parseDateCell(raw: string, order: DateOrder): string | undefined {
	const text = dateText(raw);
	if (text === undefined) return undefined;
	let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
	if (match !== null) return calendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
	match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(text);
	if (match !== null) {
		const [first, second] = [Number(match[1]), Number(match[2])];
		const year = fullYear(match[3] as string);
		return order === "MDY" ? calendarDay(year, first, second) : calendarDay(year, second, first);
	}
	match = /^(\d{1,2})[\s./-]+([A-Za-z]{3,9})\.?[\s./,-]+(\d{2}|\d{4})$/.exec(text);
	if (match !== null) {
		const month = MONTH_NUMBER[(match[2] as string).toLowerCase()];
		return month === undefined ? undefined : calendarDay(fullYear(match[3] as string), month, Number(match[1]));
	}
	match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
	if (match !== null) {
		const month = MONTH_NUMBER[(match[1] as string).toLowerCase()];
		return month === undefined ? undefined : calendarDay(Number(match[3]), month, Number(match[2]));
	}
	return undefined;
}

/**
 * How the dates of a column are ordered. A year first means `YMD`; otherwise a first number above 12 can only be a day
 * (`DMY`) and a second one above 12 only a day too (`MDY`). When every date has both numbers under 13 the file does not say:
 * day first is assumed (the owner is not in the US) and `ambiguous` tells the tool to say so in the preview.
 */
export function detectDateOrder(cells: readonly string[]): { order: DateOrder; ambiguous: boolean } {
	let yearFirst = 0;
	let numeric = 0;
	let firstOver12 = false;
	let secondOver12 = false;
	for (const raw of cells) {
		const text = dateText(raw);
		if (text === undefined) continue;
		if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(text)) {
			yearFirst++;
			continue;
		}
		const match = /^(\d{1,2})[-/.](\d{1,2})[-/.](?:\d{2}|\d{4})$/.exec(text);
		if (match === null) continue;
		numeric++;
		if (Number(match[1]) > 12) firstOver12 = true;
		if (Number(match[2]) > 12) secondOver12 = true;
	}
	if (yearFirst > 0 && yearFirst >= numeric) return { order: "YMD", ambiguous: false };
	if (firstOver12 && !secondOver12) return { order: "DMY", ambiguous: false };
	if (secondOver12 && !firstOver12) return { order: "MDY", ambiguous: false };
	return { order: "DMY", ambiguous: numeric > 0 && !firstOver12 && !secondOver12 };
}
