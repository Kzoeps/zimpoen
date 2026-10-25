/**
 * Invoice numbers. The pattern is a string such as `INV-{YYYY}-{seq:03}`: `{YYYY}`, `{YY}` and `{MM}` come from the issue
 * date, `{seq}` is the running number (`{seq:03}` pads it with zeros to three digits, `{seq:5}` to five). Everything else must be a letter,
 * a digit or one of `. _ # -`, because the number is also the file's name.
 */

export const DEFAULT_NUMBER_PATTERN = "INV-{YYYY}-{seq:03}";

const TOKEN = /\{(YYYY|YY|MM|seq)(?::0?([1-9]))?\}/g;
const LITERAL = /^[A-Za-z0-9._#-]*$/;

/** The pattern's problem in words, or undefined when it is usable. */
export function patternProblem(pattern: string): string | undefined {
	if (pattern.length === 0 || pattern.length > 40) return "The pattern must be 1 to 40 characters long.";
	const literals = pattern.replace(TOKEN, "");
	if (!LITERAL.test(literals)) {
		const bad = [...literals].find((char) => !/[A-Za-z0-9._#-]/.test(char)) ?? "{";
		return `'${bad}' cannot be in an invoice number pattern: use letters, digits, . _ # - and the fields {YYYY} {YY} {MM} {seq} {seq:03}.`;
	}
	if (![...pattern.matchAll(TOKEN)].some((match) => match[1] === "seq")) {
		return "The pattern needs {seq} (or {seq:03}), the running number, or every invoice would get the same number.";
	}
	if ([...pattern.matchAll(TOKEN)].filter((match) => match[1] === "seq").length > 1) return "{seq} can appear once.";
	return undefined;
}

/** Throws the pattern's problem, with an example, when it is not usable. */
export function checkPattern(pattern: string): string {
	const problem = patternProblem(pattern);
	if (problem !== undefined) throw new Error(`${problem} Example: ${DEFAULT_NUMBER_PATTERN}`);
	return pattern;
}

/** The number for running number `seq` on `issueDate` (`2026-10-25`). The pattern must have been checked. */
export function formatNumber(pattern: string, seq: number, issueDate: string): string {
	return pattern.replace(TOKEN, (_whole, field: string, width: string | undefined) => {
		switch (field) {
			case "YYYY":
				return issueDate.slice(0, 4);
			case "YY":
				return issueDate.slice(2, 4);
			case "MM":
				return issueDate.slice(5, 7);
			default:
				return String(seq).padStart(width === undefined ? 0 : Number(width), "0");
		}
	});
}
