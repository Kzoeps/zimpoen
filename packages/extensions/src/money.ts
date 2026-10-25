import { currencyExponent, MAX_MINOR } from "@assistant/shared";

/**
 * Money arithmetic for the Accountant's modules (PLAN rule 7: arithmetic is code, never the model). Amounts are integers
 * of minor units everywhere; a float never reaches storage, a sum or a share. Conversions between text and minor units go
 * through the decimal digits of the number, not through multiplication, so `19.99` is 1999 and `0.1 + 0.2` is never asked.
 */

/** A JSON number as the plain decimal text of its shortest form: `19.99`, `-0.0000001`; never `1e-7`. */
function decimalText(value: number): string {
	const text = String(value);
	return /e/i.test(text) ? value.toFixed(20).replace(/\.?0+$/, "") : text;
}

/**
 * An amount in major units as a tool call carries it (a JSON number such as `1234.5`) turned into minor units. More decimals
 * than the currency has (`12.345` for BTN) is an error, not a rounding: it is a typo, or a figure the model worked out,
 * and silently rounding it would hide that. `name` is the tool's parameter, so the message names what the model sent.
 */
export function toMinor(amount: number, currency: string, name = "amount"): number {
	if (!Number.isFinite(amount)) throw new Error(`${name} must be a number.`);
	const exponent = currencyExponent(currency);
	const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimalText(amount));
	if (match === null) throw new Error(`${name} ${String(amount).slice(0, 30)} is not a plain decimal number.`);
	const [, sign = "", whole = "0", fraction = ""] = match;
	if (fraction.length > exponent) {
		throw new Error(
			`${name} ${amount} has more decimals than ${currency} has (${exponent}). Give the amount exactly as the owner or the bill states it.`,
		);
	}
	const minor = Number(`${whole}${fraction.padEnd(exponent, "0")}`);
	if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) {
		throw new Error(`${name} ${amount} is too large to be right. Check the number.`);
	}
	return sign === "-" ? -minor : minor;
}

/** A rate that is a number with at most six decimals, as millionths: `83.5` is 83_500_000. */
export function toRateMicro(rate: number, name = "rate"): number {
	const match = /^(\d+)(?:\.(\d+))?$/.exec(decimalText(rate));
	if (match === null) throw new Error(`${name} must be a positive number such as 83.5.`);
	const [, whole = "0", fraction = ""] = match;
	if (fraction.length > 6) throw new Error(`${name} ${rate} has more than six decimals. Round it to six.`);
	const micro = Number(`${whole}${fraction.padEnd(6, "0")}`);
	if (!Number.isSafeInteger(micro) || micro <= 0 || micro > 1_000_000_000_000) {
		throw new Error(`${name} ${rate} is not a plausible exchange rate. It must be above zero.`);
	}
	return micro;
}

/** Percent with at most two decimals, as basis points: `10` is 1000, `5.5` is 550. */
export function toBasisPoints(percent: number, name = "percent"): number {
	const match = /^(\d+)(?:\.(\d+))?$/.exec(decimalText(percent));
	if (match === null) throw new Error(`${name} must be a number such as 10 or 5.5.`);
	const [, whole = "0", fraction = ""] = match;
	if (fraction.length > 2) throw new Error(`${name} ${percent} has more than two decimals.`);
	const points = Number(`${whole}${fraction.padEnd(2, "0")}`);
	if (points > 100_000) throw new Error(`${name} ${percent} is not a plausible percentage.`);
	return points;
}

/** `amount x basis points`, rounded half away from zero to a whole minor unit: 10 % of 12,345 is 1,235 (1,234.5). */
export function percentOf(amountMinor: number, basisPoints: number): number {
	const product = BigInt(amountMinor) * BigInt(basisPoints);
	const negative = product < 0n;
	const abs = negative ? -product : product;
	let quotient = abs / 10_000n;
	if ((abs % 10_000n) * 2n >= 10_000n) quotient += 1n;
	return Number(negative ? -quotient : quotient);
}

/**
 * Share `total` (minor units) over `weights` so that the parts add up to it exactly: each part is its proportional share
 * rounded down, and the units left over go one each to the parts with the largest fractional remainder (the largest
 * remainder method). Ties go to the earlier weight, which makes the result deterministic. A weight of zero gets nothing.
 * Weights may be bigints for exact rational shares. A negative total is shared by its size and keeps its sign.
 */
export function allocate(total: number, weights: ReadonlyArray<number | bigint>): number[] {
	if (!Number.isSafeInteger(total)) throw new Error(`Cannot split ${total}: it is not a whole number of minor units.`);
	const parts = weights.map((weight) => BigInt(weight));
	if (parts.some((part) => part < 0n)) throw new Error("Cannot split by a negative share.");
	const sum = parts.reduce((left, right) => left + right, 0n);
	if (sum === 0n) throw new Error("Cannot split: nobody has a share.");
	const negative = total < 0;
	const size = BigInt(negative ? -total : total);
	const floors = parts.map((part) => (size * part) / sum);
	const remainders = parts.map((part, index) => size * part - (floors[index] ?? 0n) * sum);
	const left = Number(size - floors.reduce((left, right) => left + right, 0n));
	const order = remainders
		.map((remainder, index) => ({ remainder, index }))
		.sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
	const extra = new Set(order.slice(0, left).map((entry) => entry.index));
	return floors.map((floor, index) => {
		const part = floor + (extra.has(index) ? 1n : 0n);
		// Negated as a bigint: a part of zero stays 0 and never becomes -0.
		return Number(negative ? -part : part);
	});
}

/**
 * `amountMinor` of `from` in `to`, at a rate the owner gave (`rateMicro` millionths of a `to` for one `from`). With
 * `inverse` the stored rate is the other way round (`to` to `from`). Half away from zero, once, in exact integer arithmetic.
 */
export function convertMinor(
	amountMinor: number,
	from: string,
	to: string,
	rateMicro: number,
	inverse = false,
): number {
	const numerator =
		BigInt(amountMinor) * (inverse ? 1_000_000n : BigInt(rateMicro)) * 10n ** BigInt(currencyExponent(to));
	const denominator = (inverse ? BigInt(rateMicro) : 1_000_000n) * 10n ** BigInt(currencyExponent(from));
	const negative = numerator < 0n;
	const abs = negative ? -numerator : numerator;
	let quotient = abs / denominator;
	if ((abs % denominator) * 2n >= denominator) quotient += 1n;
	return Number(negative ? -quotient : quotient);
}

/** The digits of a decimal text as minor units, or undefined when it has more decimals than `exponent` (unless they are zeros). */
function digitsToMinor(negative: boolean, whole: string, fraction: string, exponent: number): number | undefined {
	const trimmed =
		fraction.length > exponent && /^0*$/.test(fraction.slice(exponent)) ? fraction.slice(0, exponent) : fraction;
	if (trimmed.length > exponent) return undefined;
	const minor = Number(`${whole === "" ? "0" : whole}${trimmed.padEnd(exponent, "0")}`);
	if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) return undefined;
	return negative ? -minor : minor;
}

/** Which character separates the decimals in the amounts of a bank export: a point or a comma. */
export type DecimalSeparator = "." | ",";

/**
 * Tell from a column's cells whether its decimals are written with a point (`1,234.50`) or a comma (`1.234,50`). Mixed
 * cells decide by the separator that comes last; a comma that is followed by one, two or four or more digits cannot be a
 * thousands separator. When every cell that has a separator has exactly three digits after it (`1.200`, `2.500`) it is
 * a thousands separator, because no amount has three decimals in a currency that has two: the other character is the
 * decimal one. Otherwise it is the point.
 */
export function detectDecimalSeparator(cells: readonly string[]): DecimalSeparator {
	let comma = 0;
	let point = 0;
	let groupedComma = 0;
	let groupedPoint = 0;
	for (const cell of cells) {
		const text = cell.replace(/[^\d.,]/g, "");
		const lastComma = text.lastIndexOf(",");
		const lastPoint = text.lastIndexOf(".");
		if (lastComma >= 0 && lastPoint >= 0) {
			if (lastComma > lastPoint) comma++;
			else point++;
		} else if (lastComma >= 0) {
			if (text.length - lastComma - 1 !== 3) comma++;
			else groupedComma++;
		} else if (lastPoint >= 0) {
			if (text.length - lastPoint - 1 !== 3) point++;
			else groupedPoint++;
		}
	}
	if (comma > point) return ",";
	if (comma === point && point === 0 && groupedPoint > 0 && groupedComma === 0) return ",";
	return ".";
}

/** The currency names and abbreviations that statements write around an amount, besides the account's own code. */
const CURRENCY_WORDS: ReadonlySet<string> = new Set([
	"nu",
	"nrs",
	"ngultrum",
	"rs",
	"rupee",
	"rupees",
	"inr",
	"btn",
	"usd",
	"eur",
	"gbp",
	"aud",
	"cad",
	"sgd",
	"cny",
	"jpy",
	"thb",
	"aed",
	"npr",
	"bdt",
	"lkr",
	"pkr",
	"dollar",
	"dollars",
]);

/**
 * One cell of a bank export as signed minor units: `1,234.50`, `(500.00)`, `-500`, `500.00-`, `Nu. 1.234,50`, `500 DR`,
 * `CR 500`. A leading minus, parentheses, a trailing minus or `DR` make it negative; `CR` and a plus leave it positive.
 * Undefined for a cell that is not an amount (or has more decimals than the currency has), never a guess.
 */
export function parseAmountText(raw: string, currency: string, decimal: DecimalSeparator): number | undefined {
	let text = raw.replace(/[\u00a0\u202f\s']/g, "").toLowerCase();
	if (text === "") return undefined;
	let negative = false;
	const debit = /(^|[^a-z])dr\.?$|^dr\.?/.test(text);
	const credit = /(^|[^a-z])cr\.?$|^cr\.?/.test(text);
	if (debit && credit) return undefined;
	if (debit) negative = true;
	text = text.replace(/^(dr|cr)\.?|(dr|cr)\.?$/g, "");
	if (/^\(.*\)$/.test(text)) {
		negative = true;
		text = text.slice(1, -1);
	}
	// A currency name or symbol around the number is noise (`Nu.`, `BTN`, `Rs.`, `$`, `₹`), with the point that follows letters,
	// also after a minus or an opening bracket (`-Nu. 45`). Any other letters mean the cell is not an amount ("Ref123456" is a
	// reference, "1e5" is not 15): never a number to read out of it.
	const known = (word: string): boolean => {
		const name = word.replace(/\.$/, "");
		return CURRENCY_WORDS.has(name) || name === currency.toLowerCase();
	};
	text = text
		.replace(/^([-+(]*)([a-z]+\.?)/, (found, sign: string, word: string) => (known(word) ? sign : found))
		.replace(/([a-z]+\.?)([)-]*)$/, (found, word: string, sign: string) => (known(word) ? sign : found))
		.replace(/\p{Sc}/gu, "");
	if (/[a-z]/.test(text)) return undefined;
	if (text.endsWith("-")) {
		negative = true;
		text = text.slice(0, -1);
	}
	if (text.startsWith("-")) {
		negative = !negative;
		text = text.slice(1);
	} else if (text.startsWith("+")) text = text.slice(1);
	text = decimal === "." ? text.replace(/,/g, "") : text.replace(/\./g, "").replace(",", ".");
	const match = /^(\d*)(?:\.(\d+))?$/.exec(text);
	if (match === null || (match[1] === "" && match[2] === undefined)) return undefined;
	return digitsToMinor(negative, match[1] ?? "", match[2] ?? "", currencyExponent(currency));
}
