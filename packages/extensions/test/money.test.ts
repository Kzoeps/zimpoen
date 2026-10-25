import { currencyExponent, formatAmount, formatMoney, formatTenths } from "@assistant/shared";
import { describe, expect, it } from "vitest";
import {
	allocate,
	convertMinor,
	detectDecimalSeparator,
	parseAmountText,
	percentOf,
	toBasisPoints,
	toMinor,
	toRateMicro,
} from "../src/index.ts";

describe("money in minor units", () => {
	it("turns the number a tool call carries into whole minor units, by its digits and not by multiplying", () => {
		expect(toMinor(19.99, "BTN")).toBe(1999);
		expect(toMinor(1234.5, "BTN")).toBe(123_450);
		expect(toMinor(0.07, "USD")).toBe(7);
		expect(toMinor(1.1, "INR")).toBe(110);
		expect(toMinor(-80, "BTN")).toBe(-8000);
		// Amounts a float cannot hold exactly after multiplying: 4.35 * 100 is 434.99999999999994.
		for (const [amount, minor] of [
			[4.35, 435],
			[8.2, 820],
			[33.33, 3333],
			[1_234_567.89, 123_456_789],
		] as const) {
			expect(toMinor(amount, "BTN")).toBe(minor);
		}
		// A figure the model worked out in floating point is refused, not rounded into a different amount.
		expect(() => toMinor(1.005 * 1000, "BTN")).toThrow(/more decimals/);
		expect(toMinor(500, "JPY")).toBe(500); // no decimals
		expect(toMinor(1.234, "KWD")).toBe(1234); // three decimals
	});

	it("refuses more decimals than the currency has instead of rounding them away", () => {
		expect(() => toMinor(12.345, "BTN")).toThrow(/more decimals than BTN has \(2\)/);
		expect(() => toMinor(0.5, "JPY")).toThrow(/more decimals than JPY has \(0\)/);
		expect(() => toMinor(1e-7, "BTN")).toThrow(/more decimals/);
		expect(() => toMinor(Number.NaN, "BTN")).toThrow(/must be a number/);
		expect(() => toMinor(Number.POSITIVE_INFINITY, "BTN")).toThrow(/must be a number/);
	});

	it("refuses an amount too large to be right, and names the parameter that carried it", () => {
		expect(() => toMinor(1e12, "BTN", "balance")).toThrow(/balance 1000000000000 is too large/);
		expect(toMinor(99_999_999_999, "BTN")).toBe(9_999_999_999_900);
	});

	it("reads rates and percentages as exact integers", () => {
		expect(toRateMicro(83.5)).toBe(83_500_000);
		expect(toRateMicro(0.012)).toBe(12_000);
		expect(() => toRateMicro(0.1234567)).toThrow(/more than six decimals/);
		expect(() => toRateMicro(0)).toThrow(/not a plausible/);
		expect(toBasisPoints(10)).toBe(1000);
		expect(toBasisPoints(5.5)).toBe(550);
		expect(() => toBasisPoints(5.555)).toThrow(/more than two decimals/);
	});

	it("takes a percentage of an amount to a whole minor unit, half away from zero, once", () => {
		expect(percentOf(12_345, 1000)).toBe(1235); // 1234.5
		expect(percentOf(-12_345, 1000)).toBe(-1235);
		expect(percentOf(10_000, 550)).toBe(550);
		expect(percentOf(1, 4999)).toBe(0); // 0.4999
		expect(percentOf(1, 5000)).toBe(1); // 0.5
	});

	it("writes money the same way everywhere", () => {
		expect(formatMoney(123_450, "BTN")).toBe("Nu. 1,234.50");
		expect(formatMoney(-8000, "BTN")).toBe("-Nu. 80.00");
		expect(formatMoney(50_000, "USD")).toBe("USD 500.00");
		expect(formatMoney(5, "BTN")).toBe("Nu. 0.05");
		expect(formatMoney(0, "BTN")).toBe("Nu. 0.00");
		expect(formatMoney(1_234_567, "JPY")).toBe("JPY 1,234,567");
		expect(formatMoney(1234, "KWD")).toBe("KWD 1.234");
		expect(formatMoney(100, "BTN", { sign: "always" })).toBe("+Nu. 1.00");
		expect(formatMoney(-100, "BTN", { sign: "always" })).toBe("-Nu. 1.00");
		expect(formatAmount(99_999_999_999_999, "BTN")).toBe("999,999,999,999.99");
		expect(currencyExponent("BTN")).toBe(2);
		expect(formatTenths(125)).toBe("12.5%");
		expect(formatTenths(1000)).toBe("100.0%");
	});
});

describe("sharing an amount by the largest remainder", () => {
	it("gives the units left over to the largest remainders, the earlier one on a tie", () => {
		expect(allocate(100, [1, 1, 1])).toStrictEqual([34, 33, 33]);
		expect(allocate(1000, [1, 1, 1])).toStrictEqual([334, 333, 333]);
		expect(allocate(5, [1, 1])).toStrictEqual([3, 2]);
		expect(allocate(10, [3, 3, 4])).toStrictEqual([3, 3, 4]);
		// 100 over 1:2:2 is 20, 40, 40 exactly; over 1:1:3 is 20, 20, 60.
		expect(allocate(100, [1, 2, 2])).toStrictEqual([20, 40, 40]);
		// Remainders .67, .33, .0 (10 * 2/3, 10 * 1/3 ... ) the largest remainder gets the unit.
		expect(allocate(10, [1, 2])).toStrictEqual([3, 7]);
		expect(allocate(7, [1, 1, 5])).toStrictEqual([1, 1, 5]);
	});

	it("gives nothing to a share of zero, and keeps the sign of a negative total", () => {
		expect(allocate(100, [0, 1, 1])).toStrictEqual([0, 50, 50]);
		expect(allocate(101, [0, 1, 1])).toStrictEqual([0, 51, 50]);
		expect(allocate(-100, [1, 1, 1])).toStrictEqual([-34, -33, -33]);
		expect(allocate(0, [1, 2])).toStrictEqual([0, 0]);
	});

	it("takes exact rational shares as bigints", () => {
		expect(allocate(100, [10n ** 20n, 10n ** 20n, 10n ** 20n])).toStrictEqual([34, 33, 33]);
	});

	it("refuses what cannot be shared", () => {
		expect(() => allocate(100, [0, 0])).toThrow(/nobody has a share/);
		expect(() => allocate(100, [1, -1])).toThrow(/negative share/);
		expect(() => allocate(10.5, [1, 1])).toThrow(/not a whole number/);
	});

	it("always adds up to the total, within one unit of the exact share, over thousands of random cases", () => {
		let seed = 12345;
		const random = (max: number): number => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed % max;
		};
		for (let round = 0; round < 3000; round++) {
			const total = random(5_000_000) - 1_000_000;
			const weights = Array.from({ length: 1 + random(9) }, () => (random(4) === 0 ? 0 : 1 + random(1000)));
			if (weights.every((weight) => weight === 0)) continue;
			const parts = allocate(total, weights);
			expect(parts.reduce((sum, part) => sum + part, 0)).toBe(total);
			const sum = weights.reduce((left, right) => left + right, 0);
			parts.forEach((part, index) => {
				const exact = (total * (weights[index] ?? 0)) / sum;
				expect(Math.abs(part - exact)).toBeLessThan(1);
				if (weights[index] === 0) expect(part).toBe(0);
			});
		}
	});
});

describe("converting at a rate the owner gave", () => {
	it("converts with exact integer arithmetic, half away from zero, once", () => {
		// USD 10.00 at 83.5 BTN is Nu. 835.00.
		expect(convertMinor(1000, "USD", "BTN", 83_500_000)).toBe(83_500);
		// 1 cent at 83.5 is 0.835 chhertum x 100 = 83.5: rounds to 84.
		expect(convertMinor(1, "USD", "BTN", 83_500_000)).toBe(84);
		expect(convertMinor(-1, "USD", "BTN", 83_500_000)).toBe(-84);
		// A rate stored the other way round (1 BTN = 0.012 USD) turned back: USD 10.00 is Nu. 833.33.
		expect(convertMinor(1000, "USD", "BTN", 12_000, true)).toBe(83_333);
		// Between currencies with other minor units: JPY 1,000 at 0.55 BTN is Nu. 550.00.
		expect(convertMinor(1000, "JPY", "BTN", 550_000)).toBe(55_000);
		expect(convertMinor(55_000, "BTN", "JPY", 1_818_182)).toBe(1000);
	});
});

describe("reading an amount out of a bank export", () => {
	const point = (text: string, currency = "BTN") => parseAmountText(text, currency, ".");
	const comma = (text: string, currency = "BTN") => parseAmountText(text, currency, ",");

	it("reads plain, signed, grouped and bracketed amounts", () => {
		expect(point("1,234.50")).toBe(123_450);
		expect(point("-500")).toBe(-50_000);
		expect(point("+500")).toBe(50_000);
		expect(point("(500.00)")).toBe(-50_000);
		expect(point("500.00-")).toBe(-50_000);
		expect(point(" 1 234.50 ")).toBe(123_450);
		expect(point("0.5")).toBe(50);
		expect(point(".5")).toBe(50);
		expect(point("-.25")).toBe(-25);
		expect(point("1,234")).toBe(123_400);
		expect(point("1000", "JPY")).toBe(1000);
	});

	it("ignores a currency word or symbol, and reads DR and CR", () => {
		expect(point("Nu. 1,234.50")).toBe(123_450);
		expect(point("BTN 500")).toBe(50_000);
		expect(point("Rs.1,000.00")).toBe(100_000);
		expect(point("$20.00")).toBe(2000);
		expect(point("₹1,000")).toBe(100_000);
		expect(point("500.00 DR")).toBe(-50_000);
		expect(point("500.00 Dr.")).toBe(-50_000);
		expect(point("500.00 CR")).toBe(50_000);
		expect(point("CR 500")).toBe(50_000);
	});

	it("puts the currency before or after a minus or a bracket, and the account's own code anywhere a currency goes", () => {
		expect(point("-Nu. 45")).toBe(-4500);
		expect(point("(Nu. 45.00)")).toBe(-4500);
		expect(point("Nu. 45.00-")).toBe(-4500);
		expect(point("1250.50 BTN")).toBe(125_050);
		expect(point("500 CHF", "CHF")).toBe(50_000); // the account's code, though it is not a word the importer knows
		expect(point("USD 5")).toBe(500);
	});

	it("does not guess when a cell says both DR and CR", () => {
		for (const text of ["500 DR CR", "DR 500 CR", "CR 500 DR", "Dr500Cr"]) expect(point(text), text).toBeUndefined();
	});

	it("does not read a number out of a cell that has other letters in it", () => {
		// A reference column taken for the amount must not turn "Ref123456" into Nu. 123,456.00.
		for (const text of ["Ref123456", "1e5", "0x1F", "TX1234", "12abc34", "FT26274ABC", "Nu. 45 later", "per 45.00"])
			expect(point(text), text).toBeUndefined();
	});

	it("reads a decimal comma when told the file uses one", () => {
		expect(comma("1.234,50")).toBe(123_450);
		expect(comma("12,5")).toBe(1250);
		expect(comma("-1.000.000,01")).toBe(-100_000_001);
		expect(comma("1'234,50")).toBe(123_450);
	});

	it("says nothing for what is not an amount, or has more decimals than the currency", () => {
		for (const text of ["", "abc", "-", "1.2.3", "12.345", "1,2,3.4.5", "--5"])
			expect(point(text), text).toBeUndefined();
		expect(point("12.500")).toBe(1250); // zeros beyond the minor unit are only formatting
		expect(point("1.5", "JPY")).toBeUndefined();
	});

	it("tells a point from a comma by the cells of the column", () => {
		expect(detectDecimalSeparator(["1,234.50", "20.00", "-5.25"])).toBe(".");
		expect(detectDecimalSeparator(["1.234,50", "20,00", "-5,25"])).toBe(",");
		expect(detectDecimalSeparator(["12,5", "3,75"])).toBe(",");
		expect(detectDecimalSeparator(["1,234", "2,500"])).toBe("."); // thousands, not decimals
		expect(detectDecimalSeparator(["500", "1000"])).toBe(".");
		expect(detectDecimalSeparator([])).toBe(".");
	});

	it("takes a column of whole European amounts for thousands, since no amount has three decimals", () => {
		// "1.200" and "2.500" are Nu. 1,200 and Nu. 2,500, not Nu. 1.20 and Nu. 2.50.
		expect(detectDecimalSeparator(["1.200", "2.500"])).toBe(",");
		expect(parseAmountText("1.200", "BTN", ",")).toBe(120_000);
		expect(detectDecimalSeparator(["1.200", "1.25"])).toBe("."); // one cell with a real decimal point settles it
		expect(detectDecimalSeparator(["1.200", "2,5"])).toBe(",");
		expect(detectDecimalSeparator(["1.200", "1,200"])).toBe("."); // both ways round: nothing to go on
		expect(detectDecimalSeparator(["12.000", "1.200.000"])).toBe(",");
	});
});
