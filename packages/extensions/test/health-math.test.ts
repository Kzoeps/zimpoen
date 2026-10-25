import { describe, expect, it } from "vitest";
import { bestMatch, bodyweightNameOf } from "../src/health/catalog.ts";
import { addMonths } from "../src/health/range.ts";
import {
	exerciseKey,
	findInCatalog,
	HEALTH_CATALOG,
	resolveHealthRange,
	healthStats as stats,
	tidyExerciseName,
	healthUnits as units,
} from "../src/index.ts";

describe("units", () => {
	it("converts pounds to kilograms once, to the precision of a scale", () => {
		expect(units.toKg(160, "lb")).toBe(72.57);
		expect(units.toKg(225, "lb")).toBe(102.06);
		expect(units.toKg(72.4, "kg")).toBe(72.4);
		expect(units.toKg(0.5, "lb")).toBe(0.23);
	});

	it("rounds half away from zero, without the surprises of binary fractions", () => {
		expect(units.round(1.005, 2)).toBe(1.01);
		expect(units.round(-1.005, 2)).toBe(-1.01);
		expect(units.round(2.5, 0)).toBe(3);
		expect(units.round1(72.45)).toBe(72.5);
		expect(units.round1(0.04)).toBe(0);
	});

	it("writes weights the way people do: no decimals for a whole number, two at most", () => {
		expect(units.formatKg(100)).toBe("100");
		expect(units.formatKg(62.5)).toBe("62.5");
		expect(units.formatKg(72.57)).toBe("72.57");
		expect(units.formatKg(72.4000001)).toBe("72.4");
		expect(units.signed(0.4)).toBe("+0.4");
		expect(units.signed(-1.3)).toBe("-1.3");
		expect(units.signed(0.04)).toBe("0");
		expect(units.formatVolume(4320)).toBe("4,320");
		expect(units.formatVolume(999)).toBe("999");
		expect(units.formatVolume(1234567)).toBe("1,234,567");
	});

	it("estimates a one-rep max with Epley, and takes one rep as the weight itself", () => {
		expect(units.epley(100, 5)).toBeCloseTo(116.667, 3);
		expect(units.epley(60, 8)).toBeCloseTo(76, 10);
		expect(units.epley(140, 1)).toBe(140);
		expect(stats.e1rmOf({ kg: 100, reps: 5 })).toBe(116.7);
		expect(stats.e1rmOf({ kg: 60, reps: 8 })).toBe(76);
	});

	it("computes BMI from kilograms and centimetres", () => {
		expect(units.bmi(72.4, 176)).toBe(23.4);
		expect(units.bmi(90, 180)).toBe(27.8);
	});
});

describe("exercise names", () => {
	it("treats case, spaces, punctuation and a plural ending as the same exercise", () => {
		for (const typed of ["bench", "Bench Press", "bench-press", "BENCHPRESS", "flat bench", "bench presses"]) {
			expect(findInCatalog(typed)?.name, typed).toBe("Bench press");
		}
		expect(findInCatalog("squats")?.name).toBe("Squat");
		expect(findInCatalog("OHP")?.name).toBe("Overhead press");
		expect(findInCatalog("pull ups")?.name).toBe("Pull-up");
		expect(findInCatalog("Pull-Ups")?.name).toBe("Pull-up");
		expect(findInCatalog("romanian deadlifts")?.name).toBe("Romanian deadlift");
		expect(findInCatalog("RDL")?.name).toBe("Romanian deadlift");
		expect(findInCatalog("lunges")?.name).toBe("Lunge");
		expect(findInCatalog("calf raises")?.name).toBe("Calf raise");
		expect(findInCatalog("dips")?.name).toBe("Dip");
	});

	it("matches a plural that ends in -ies to the singular: cable flies is cable fly", () => {
		expect(findInCatalog("cable flies")?.name).toBe("Chest fly");
		expect(findInCatalog("dumbbell flies")?.name).toBe("Chest fly");
		expect(findInCatalog("Flies")?.name).toBe("Chest fly");
	});

	it("keeps the letters of any script in a name's key, and drops accents, so a name is never 'no letters' when it has some", () => {
		expect(exerciseKey("Café curl")).toBe("cafecurl");
		expect(exerciseKey("Тяга блока")).toBe("тягаблока");
		expect(exerciseKey("深蹲")).toBe("深蹲");
		expect(exerciseKey("Тяга блока")).not.toBe(exerciseKey("блока"));
		expect(exerciseKey("!!! ---")).toBe("");
		expect(exerciseKey("Bench & Press")).toBe("benchandpress");
	});

	it("has a bodyweight twin for the weighted movements people do without a load, named the way the refusal names it", () => {
		for (const name of ["squat", "lunge", "calf raise", "hip thrust"]) {
			const weighted = findInCatalog(name);
			const twin = findInCatalog(bodyweightNameOf(weighted?.name ?? ""));
			expect(weighted?.kind, name).toBe("weighted");
			expect(twin?.kind, name).toBe("bodyweight");
			expect(twin?.name, name).toBe(bodyweightNameOf(weighted?.name ?? ""));
		}
		expect(findInCatalog("bodyweight lunges")?.name).toBe("Bodyweight lunge");
		expect(findInCatalog("air squats")?.name).toBe("Bodyweight squat");
		// "Lunge" itself is still the weighted one.
		expect(findInCatalog("lunges")?.name).toBe("Lunge");
	});

	it("writes the bodyweight name of an exercise: the first word lower case, an acronym left alone", () => {
		expect(bodyweightNameOf("Lunge")).toBe("Bodyweight lunge");
		expect(bodyweightNameOf("Bench press")).toBe("Bodyweight bench press");
		expect(bodyweightNameOf("EZ bar curl")).toBe("Bodyweight EZ bar curl");
	});

	it("knows the kind of each built-in exercise", () => {
		expect(findInCatalog("squat")?.kind).toBe("weighted");
		expect(findInCatalog("pull-up")?.kind).toBe("bodyweight");
		expect(findInCatalog("push ups")?.kind).toBe("bodyweight");
	});

	it("does not guess: a name that is nothing like a built-in one is unknown", () => {
		expect(findInCatalog("cable crossover")).toBeUndefined();
		expect(findInCatalog("press")).toBeUndefined();
		expect(findInCatalog("!!!")).toBeUndefined();
	});

	it("gives no two built-in exercises a name or alias in common, or a lookup could pick the wrong one", () => {
		const seen = new Map<string, string>();
		for (const entry of HEALTH_CATALOG) {
			for (const name of [entry.name, ...entry.aliases]) {
				const key = exerciseKey(name);
				expect(key, name).not.toBe("");
				const other = seen.get(key);
				expect(other === undefined || other === entry.name, `${name} is in ${entry.name} and ${other}`).toBe(true);
				seen.set(key, entry.name);
			}
		}
	});

	it("prefers the exact spelling over one that matches only without its plural", () => {
		const items = [{ names: ["Squats"] }, { names: ["Squat"] }];
		expect(bestMatch("squat", items, (item) => item.names)).toBe(items[1]);
		expect(bestMatch("squats", items, (item) => item.names)).toBe(items[0]);
		expect(bestMatch("plank", [{ names: ["Planks"] }], (item) => item.names)).toBeDefined();
	});

	it("writes the name of a new exercise tidily and keeps the letters in the middle as typed", () => {
		expect(tidyExerciseName("cable crossover")).toBe("Cable crossover");
		expect(tidyExerciseName("  smith   machine RDL ")).toBe("Smith machine RDL");
		expect(tidyExerciseName("CABLE CROSSOVER")).toBe("Cable crossover");
		expect(tidyExerciseName("t-bar row")).toBe("T-bar row");
		// Angle brackets could close a prompt section the name is listed in.
		expect(tidyExerciseName("cable <fly>")).toBe("Cable fly");
	});
});

describe("the moving average of weight", () => {
	const entries = [
		{ date: "2026-10-20", kg: 73 },
		{ date: "2026-10-21", kg: 72 },
		{ date: "2026-10-23", kg: 71 },
		{ date: "2026-10-27", kg: 70 },
	];

	it("averages the weighings of the seven days up to each one, and does not count days without one as zero", () => {
		expect(stats.withMovingAverage(entries).map((point) => [point.avg7, point.avg7Entries])).toStrictEqual([
			[73, 1],
			[72.5, 2],
			[72, 3],
			[71, 3], // 20 Oct is seven days before the 27th: outside
		]);
	});

	it("has a window of seven calendar days: six days back is in, seven is out", () => {
		const six = stats.withMovingAverage([
			{ date: "2026-10-01", kg: 80 },
			{ date: "2026-10-07", kg: 70 },
		]);
		expect(six[1]?.avg7Entries).toBe(2);
		const seven = stats.withMovingAverage([
			{ date: "2026-10-01", kg: 80 },
			{ date: "2026-10-08", kg: 70 },
		]);
		expect(seven[1]).toMatchObject({ avg7: 70, avg7Entries: 1 });
	});

	it("counts days, not hours, across a month and a year", () => {
		expect(stats.daysBetween("2026-12-30", "2027-01-05")).toBe(6);
		expect(stats.daysBetween("2026-02-27", "2026-03-01")).toBe(2);
		expect(stats.daysBetween("2026-10-25", "2026-10-25")).toBe(0);
	});
});

describe("what a stretch of weighings adds up to", () => {
	const week = (start: string, kgs: number[]) =>
		kgs.map((kg, index) => ({
			date: start.replace(/\d\d$/, String(Number(start.slice(-2)) + index).padStart(2, "0")),
			kg,
		}));

	it("gives the change, the extremes, the average and the trend, from the first to the latest entry", () => {
		const points = stats.withMovingAverage([
			{ date: "2026-10-01", kg: 74 },
			{ date: "2026-10-04", kg: 73.2 },
			{ date: "2026-10-09", kg: 73.8 },
			{ date: "2026-10-15", kg: 72.6 },
		]);

		const result = stats.weightStats(points);

		expect(result).toMatchObject({
			entries: 4,
			changeKg: -1.4,
			min: { date: "2026-10-15", kg: 72.6 },
			max: { date: "2026-10-01", kg: 74 },
			averageKg: 73.4,
		});
		expect(result?.latest.avg7).toBe(73.2); // 9 Oct and 15 Oct: (73.8 + 72.6) / 2
		expect(result?.trendChangeKg).toBe(-0.8); // 73.2 now, 74 at the start
		expect(result?.perWeekKg).toBe(-0.4); // -0.8 over 14 days
	});

	it("says nothing about a trend from a single entry, or a weekly rate from less than two weeks", () => {
		expect(stats.weightStats(stats.withMovingAverage(week("2026-10-01", [72])))).not.toHaveProperty("trendChangeKg");
		const short = stats.weightStats(stats.withMovingAverage(week("2026-10-01", [74, 73, 72])));
		expect(short?.trendChangeKg).toBe(-1);
		expect(short).not.toHaveProperty("perWeekKg");
		expect(stats.weightStats([])).toBeUndefined();
	});

	it("takes the earliest of equal extremes", () => {
		const result = stats.weightStats(stats.withMovingAverage(week("2026-10-01", [72, 71, 71, 72])));
		expect(result?.min.date).toBe("2026-10-02");
		expect(result?.max.date).toBe("2026-10-01");
	});
});

describe("lifting: the top set, the day and the records", () => {
	it("judges a weighted set by its estimated 1RM, then by the heavier weight; a bodyweight set by reps", () => {
		expect(
			stats.topSet("e1rm", [
				{ kg: 105, reps: 1 },
				{ kg: 100, reps: 5 },
			]),
		).toStrictEqual({ kg: 100, reps: 5 });
		// 100 kg x 6 and 120 kg x 1 are both 120: the heavier is the top set.
		expect(
			stats.topSet("e1rm", [
				{ kg: 100, reps: 6 },
				{ kg: 120, reps: 1 },
			]),
		).toStrictEqual({ kg: 120, reps: 1 });
		expect(
			stats.topSet("reps", [
				{ kg: 0, reps: 8 },
				{ kg: 10, reps: 6 },
			]),
		).toStrictEqual({ kg: 0, reps: 8 });
		expect(stats.topSet("e1rm", [])).toBeUndefined();
	});

	it("adds the sets of a day up, and a day that had two workouts is one point", () => {
		const days = stats.dayStats("e1rm", [
			{ date: "2026-10-23", reps: 5, kg: 100 },
			{ date: "2026-10-21", reps: 8, kg: 60 },
			{ date: "2026-10-23", reps: 5, kg: 100 },
			{ date: "2026-10-23", reps: 3, kg: 105 },
		]);

		expect(days).toStrictEqual([
			{ date: "2026-10-21", sets: 1, top: { kg: 60, reps: 8 }, e1rm: 76, volumeKg: 480, totalReps: 8 },
			{ date: "2026-10-23", sets: 3, top: { kg: 100, reps: 5 }, e1rm: 116.7, volumeKg: 1315, totalReps: 13 },
		]);
	});

	it("leaves the estimated 1RM out of a bodyweight day, and counts the added weight in its volume", () => {
		const [day] = stats.dayStats("reps", [
			{ date: "2026-10-23", reps: 8, kg: 0 },
			{ date: "2026-10-23", reps: 6, kg: 10 },
		]);
		expect(day).toStrictEqual({ date: "2026-10-23", sets: 2, top: { kg: 0, reps: 8 }, volumeKg: 60, totalReps: 14 });
	});

	it("calls a day a record only when it beats every day before it; the first day and an equal day are not", () => {
		const days = stats.dayStats("e1rm", [
			{ date: "2026-10-01", reps: 5, kg: 100 }, // 116.7: the baseline
			{ date: "2026-10-03", reps: 5, kg: 100 }, // equal
			{ date: "2026-10-05", reps: 5, kg: 102.5 }, // 119.6
			{ date: "2026-10-07", reps: 5, kg: 90 }, // lower
			{ date: "2026-10-09", reps: 5, kg: 105 }, // 122.5
		]);

		expect(
			stats.personalRecords("e1rm", days).map((record) => [record.date, record.e1rm, record.previous]),
		).toStrictEqual([
			["2026-10-05", 119.6, 116.7],
			["2026-10-09", 122.5, 119.6],
		]);
	});

	it("measures a bodyweight exercise by repetitions", () => {
		const days = stats.dayStats(
			"reps",
			[8, 8, 9, 7, 10].map((reps, index) => ({ date: `2026-10-0${index + 1}`, reps, kg: 0 })),
		);

		expect(
			stats.personalRecords("reps", days).map((record) => [record.date, record.top.reps, record.previous]),
		).toStrictEqual([
			["2026-10-03", 9, 8],
			["2026-10-05", 10, 9],
		]);
		expect(stats.bestDay("reps", days)?.date).toBe("2026-10-05");
	});

	it("finds the best day, the earliest of equals", () => {
		const days = stats.dayStats("e1rm", [
			{ date: "2026-10-01", reps: 5, kg: 100 },
			{ date: "2026-10-02", reps: 5, kg: 100 },
		]);
		expect(stats.bestDay("e1rm", days)?.date).toBe("2026-10-01");
		expect(stats.bestDay("e1rm", [])).toBeUndefined();
	});

	it("groups identical consecutive sets: 5 x 5 at 100 kg is one group, a heavier single is another", () => {
		const five = Array.from({ length: 5 }, () => ({ reps: 5, kg: 100 }));
		expect(stats.groupSets([...five, { reps: 3, kg: 105 }, { reps: 3, kg: 105, rpe: 9 }, ...five])).toStrictEqual([
			{ sets: 5, reps: 5, kg: 100 },
			{ sets: 1, reps: 3, kg: 105 },
			{ sets: 1, reps: 3, kg: 105, rpe: 9 },
			{ sets: 5, reps: 5, kg: 100 },
		]);
		expect(stats.volumeOf([...five, { reps: 3, kg: 105 }])).toBe(2815);
	});
});

describe("thinning a chart", () => {
	it("keeps the first and the last, spreads the rest, never repeats a point, and leaves a short list alone", () => {
		const items = Array.from({ length: 400 }, (_, index) => index);

		const thinned = stats.thin(items, 90);

		expect(thinned).toHaveLength(90);
		expect(thinned[0]).toBe(0);
		expect(thinned.at(-1)).toBe(399);
		expect(new Set(thinned).size).toBe(90);
		expect(thinned).toStrictEqual([...thinned].sort((a, b) => a - b));
		expect(stats.thin([1, 2, 3], 90)).toStrictEqual([1, 2, 3]);
	});
});

describe("ranges", () => {
	const today = "2026-10-25";
	const range = (args: Parameters<typeof resolveHealthRange>[0], fallback = "30d") =>
		resolveHealthRange(args, today, fallback);

	it("counts back from today, today included", () => {
		expect(range({ range: "7d" })).toStrictEqual({ from: "2026-10-19", to: today, label: "last 7 days" });
		expect(range({ range: "1d" })).toMatchObject({ from: today, label: "last day" });
		expect(range({ range: "2w" })).toMatchObject({ from: "2026-10-12", label: "last 2 weeks" });
		expect(range({ range: "1m" })).toMatchObject({ from: "2026-09-26", label: "last month" });
		expect(range({ range: "6m" })).toMatchObject({ from: "2026-04-26", label: "last 6 months" });
		expect(range({ range: "1y" })).toMatchObject({ from: "2025-10-26", label: "last year" });
		expect(range({ range: " 30D " })).toMatchObject({ from: "2026-09-26" });
	});

	it("means the whole history by all, and the default by nothing", () => {
		expect(range({ range: "all" })).toStrictEqual({ to: today, label: "all time" });
		expect(range({}, "90d")).toMatchObject({ from: "2026-07-28", label: "last 90 days" });
	});

	it("refuses a count that reaches back further than a log can, instead of answering for the wrong century", () => {
		expect(range({ range: "100y" })).toMatchObject({ from: "1926-10-26" });
		expect(range({ range: "1200m" })).toMatchObject({ label: "last 1200 months" });
		expect(range({ range: "5200w" })).toMatchObject({ label: "last 5200 weeks" });
		expect(range({ range: "9999d" })).toMatchObject({ label: "last 9999 days" });
		expect(() => range({ range: "10000d" })).toThrow(/not understood/); // the pattern takes four digits at most
		for (const text of ["101y", "5000y", "1201m", "5201w"]) {
			expect(() => range({ range: text }), text).toThrow(
				/reaches back further than a log can.*use all for everything/s,
			);
		}
	});

	it("takes explicit days, cuts a future end to today, and refuses a muddle with a message that says what to send", () => {
		expect(range({ from: "2026-10-01", to: "2026-10-10" })).toStrictEqual({
			from: "2026-10-01",
			to: "2026-10-10",
			label: "2026-10-01 to 2026-10-10",
		});
		expect(range({ from: "2026-10-01" })).toMatchObject({ from: "2026-10-01", to: today });
		expect(range({ from: "2026-10-01", to: "2027-01-01" }).to).toBe(today);
		expect(() => range({ range: "7d", from: "2026-10-01" })).toThrow(/either range or from\/to/);
		expect(() => range({ from: "2026-10-10", to: "2026-10-01" })).toThrow(/from 2026-10-10 is after to 2026-10-01/);
		expect(() => range({ from: "last week" })).toThrow(/from must be a date written YYYY-MM-DD/);
		expect(() => range({ from: "2026-10-01T09:00" })).toThrow(/from must be a date written YYYY-MM-DD/);
		expect(() => range({ range: "5 days" })).toThrow(/not understood.*7d, 12w, 6m, 1y/s);
		expect(() => range({ range: "0d" })).toThrow(/not understood/);
	});

	it("moves by calendar months and cuts the day to the end of a shorter month", () => {
		expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
		expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
		expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
		expect(addMonths("2026-10-25", -12)).toBe("2025-10-25");
		expect(addMonths("2026-01-15", -2)).toBe("2025-11-15");
	});
});

describe("what an exercise is measured in", () => {
	const dips = [
		{ date: "2026-10-19", reps: 8, kg: 0 },
		{ date: "2026-10-22", reps: 8, kg: 20 },
		{ date: "2026-10-25", reps: 5, kg: 30 },
	];

	it("measures a weighted exercise by its estimated 1RM always, and a bodyweight one by reps until a set carries added weight", () => {
		expect(stats.metricFor("weighted", false)).toBe("e1rm");
		expect(stats.metricFor("weighted", true)).toBe("e1rm");
		expect(stats.metricFor("bodyweight", false)).toBe("reps");
		expect(stats.metricFor("bodyweight", true)).toBe("e1rm");
		expect(stats.hasLoad([{ kg: 0 }, { kg: 0 }])).toBe(false);
		expect(stats.hasLoad([{ kg: 0 }, { kg: 2.5 }])).toBe(true);
		expect(stats.hasLoad([])).toBe(false);
	});

	it("sees progress in added weight that reps alone do not show (loaded dips: 8, then 8 with 20 kg, then 5 with 30 kg)", () => {
		// By reps the history goes nowhere: that was the bug.
		expect(stats.personalRecords("reps", stats.dayStats("reps", dips))).toStrictEqual([]);

		const metric = stats.metricFor("bodyweight", stats.hasLoad(dips));
		const days = stats.dayStats(metric, dips);

		expect(days.map((day) => day.e1rm)).toStrictEqual([0, 25.3, 35]);
		expect(
			stats.personalRecords(metric, days).map((record) => [record.date, record.e1rm, record.previous]),
		).toStrictEqual([
			["2026-10-22", 25.3, 0],
			["2026-10-25", 35, 25.3],
		]);
		expect(stats.bestDay(metric, days)?.date).toBe("2026-10-25");
	});

	it("puts a loaded set above an unloaded one, a heavier above a lighter, and among unloaded sets the one with more reps", () => {
		expect(stats.compareSets("e1rm", { kg: 5, reps: 1 }, { kg: 0, reps: 30 })).toBeGreaterThan(0);
		expect(stats.compareSets("e1rm", { kg: 30, reps: 5 }, { kg: 20, reps: 8 })).toBeGreaterThan(0);
		expect(stats.compareSets("e1rm", { kg: 0, reps: 12 }, { kg: 0, reps: 8 })).toBeGreaterThan(0);
		expect(stats.compareSets("e1rm", { kg: 0, reps: 8 }, { kg: 0, reps: 8 })).toBe(0);
		expect(
			stats.topSet("e1rm", [
				{ kg: 0, reps: 15 },
				{ kg: 10, reps: 6 },
				{ kg: 0, reps: 20 },
			]),
		).toStrictEqual({ kg: 10, reps: 6 });
		// By reps, as before: more reps first, then the heavier.
		expect(stats.compareSets("reps", { kg: 0, reps: 9 }, { kg: 10, reps: 8 })).toBeGreaterThan(0);
		expect(stats.compareSets("reps", { kg: 10, reps: 8 }, { kg: 0, reps: 8 })).toBeGreaterThan(0);
	});

	it("gives no estimated 1RM to a day measured by reps", () => {
		const [day] = stats.dayStats("reps", [{ date: "2026-10-23", reps: 8, kg: 0 }]);
		expect(day).not.toHaveProperty("e1rm");
	});
});

describe("weight arithmetic that is exact", () => {
	/** Round `numerator / denominator` hundredths of a kilogram to one decimal, half away from zero, in integers: the oracle. */
	function tenths(numerator: number, denominator: number): number {
		const n = BigInt(Math.abs(numerator));
		const d = BigInt(denominator) * 10n;
		return (numerator < 0 ? -1 : 1) * Number((2n * n + d) / (2n * d));
	}
	const asTenths = (kg: number): number => Math.round(kg * 10);
	const hundredths = (kg: number): number => Math.round(kg * 100);

	/** A reproducible stream of numbers in [0, 1). */
	function random(seed: number): () => number {
		let x = seed;
		return () => {
			x = (x * 1664525 + 1013904223) % 4294967296;
			return x / 4294967296;
		};
	}

	function history(seed: number, days: number): Array<{ date: string; kg: number }> {
		const next = random(seed);
		const entries: Array<{ date: string; kg: number }> = [];
		for (let day = 0; day < days; day++) {
			if (next() < 0.3) continue;
			const date = new Date(Date.UTC(2020, 0, 1 + day)).toISOString().slice(0, 10);
			entries.push({ date, kg: Math.round((60 + next() * 30) * 100) / 100 });
		}
		return entries;
	}

	it("rounds a mean that is exactly half-way up, once: 72.44 and 72.45 average 72.445, which is 72.4 and not 72.5", () => {
		const [, second] = stats.withMovingAverage([
			{ date: "2026-10-24", kg: 72.44 },
			{ date: "2026-10-25", kg: 72.45 },
		]);

		expect(second?.avg7Hundredths).toBe(14489);
		expect(units.round1(second?.avg7 ?? 0)).toBe(72.4);
		expect(units.round1((72.4 + 72.5) / 2)).toBe(72.5); // an exact half goes up
	});

	it("takes a difference of two weights in whole hundredths, so 0.15 is 0.2 and not 0.1", () => {
		expect(units.diffKg(72.57, 72.42)).toBe(0.2);
		expect(units.diffKg(71.35, 71.2)).toBe(0.2);
		expect(units.diffKg(72.5, 72.35)).toBe(0.2);
		expect(units.diffKg(72.4, 72.6)).toBe(-0.2);
		expect(units.diffKg(72.35, 72.5)).toBe(-0.2);
		expect(units.diffKg(72.4, 72.4)).toBe(0);
		expect(
			stats.weightStats(
				stats.withMovingAverage([
					{ date: "2026-10-01", kg: 71.2 },
					{ date: "2026-10-02", kg: 71.35 },
				]),
			)?.changeKg,
		).toBe(0.2);
	});

	it("takes the trend as the exact difference of two means: 71.35 against 71.2 is a trend of +0.2, not +0.1", () => {
		// Far enough apart that each weighing is its own 7-day mean, so the trend is 71.35 - 71.2 = 0.15 exactly.
		const result = stats.weightStats(
			stats.withMovingAverage([
				{ date: "2026-10-01", kg: 71.2 },
				{ date: "2026-10-20", kg: 71.35 },
			]),
		);

		expect(result).toMatchObject({ trendChangeKg: 0.2, changeKg: 0.2, perWeekKg: 0.1 });
		const down = stats.weightStats(
			stats.withMovingAverage([
				{ date: "2026-10-01", kg: 72.57 },
				{ date: "2026-10-20", kg: 72.42 },
			]),
		);
		expect(down).toMatchObject({ trendChangeKg: -0.2, changeKg: -0.2 });
	});

	it("sums every window afresh in whole hundredths, so nothing drifts over a history of years", () => {
		const entries = history(7, 4000);
		const points = stats.withMovingAverage(entries);

		expect(points).toHaveLength(entries.length);
		for (const [index, point] of points.entries()) {
			const window = entries.filter((entry) => {
				const ago = stats.daysBetween(entry.date, point.date);
				return ago >= 0 && ago < stats.AVERAGE_DAYS && entries.indexOf(entry) <= index;
			});
			const sum = window.reduce((total, entry) => total + hundredths(entry.kg), 0);
			expect(point.avg7Hundredths).toBe(sum);
			expect(point.avg7Entries).toBe(window.length);
			expect(asTenths(units.round1(point.avg7))).toBe(tenths(sum, window.length));
		}
	});

	it("agrees with an integer oracle on the average, the change, the trend and the weekly rate of 300 random histories", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const entries = history(seed, 60);
			if (entries.length < 3) continue;
			const points = stats.withMovingAverage(entries);
			const range = points.slice(Math.floor(entries.length / 3));
			const result = stats.weightStats(range);
			if (result === undefined) throw new Error(`no stats for seed ${seed}`);
			const first = range[0] as (typeof range)[number];
			const latest = range.at(-1) as (typeof range)[number];
			const label = `seed ${seed}`;

			expect(asTenths(result.changeKg), label).toBe(tenths(hundredths(latest.kg) - hundredths(first.kg), 1));
			expect(asTenths(result.averageKg), label).toBe(
				tenths(
					range.reduce((total, point) => total + hundredths(point.kg), 0),
					range.length,
				),
			);
			const numerator = latest.avg7Hundredths * first.avg7Entries - first.avg7Hundredths * latest.avg7Entries;
			const denominator = latest.avg7Entries * first.avg7Entries;
			expect(asTenths(result.trendChangeKg ?? Number.NaN), label).toBe(tenths(numerator, denominator));
			const span = stats.daysBetween(first.date, latest.date);
			if (span >= 14)
				expect(asTenths(result.perWeekKg ?? Number.NaN), label).toBe(tenths(numerator * 7, denominator * span));
			else expect(result, label).not.toHaveProperty("perWeekKg");
			expect(asTenths(units.round1(latest.avg7)), label).toBe(tenths(latest.avg7Hundredths, latest.avg7Entries));
		}
	});
});

describe("thinning an exercise chart", () => {
	const days = (count: number) =>
		Array.from({ length: count }, (_, index) => ({ date: `d${String(index).padStart(4, "0")}` }));
	const datesOf = (list: Array<{ date: string }>) => list.map((day) => day.date);

	it("leaves a history that fits whole", () => {
		const list = days(90);
		expect(stats.thinDays(list, new Set(datesOf(list)), 90, 5)).toStrictEqual(list);
		expect(stats.thinDays([], new Set(), 90, 5)).toStrictEqual([]);
	});

	it("keeps at most 90 days even when every day is a record: the first, the latest five, the newest records, the rest spread", () => {
		const list = days(300);

		const kept = stats.thinDays(list, new Set(datesOf(list)), 90, 5);

		expect(kept).toHaveLength(90);
		expect(kept[0]).toBe(list[0]);
		// The newest records come first: the latest five days and the 45 before them.
		expect(datesOf(kept.slice(-50))).toStrictEqual(datesOf(list.slice(-50)));
		expect(new Set(datesOf(kept)).size).toBe(90);
		expect(datesOf(kept)).toStrictEqual([...datesOf(kept)].sort());
		// The rest of the room is spread over the older days, not given to more records.
		const spread = kept.slice(1, -50);
		expect(spread).toHaveLength(39);
		expect(spread[0]?.date).toBe(list[1]?.date);
		expect((spread.at(-1)?.date ?? "") > (list[200]?.date ?? "")).toBe(true);
	});

	it("keeps every record when there are few, wherever they are", () => {
		const list = days(300);
		const records = new Set([list[40], list[120], list[200]].map((day) => day?.date ?? ""));

		const kept = datesOf(stats.thinDays(list, records, 90, 5));

		for (const date of records) expect(kept).toContain(date);
		expect(kept).toHaveLength(90);
		expect(kept.slice(-5)).toStrictEqual(datesOf(list.slice(-5)));
	});

	it("never gives more than the most, always the first day and the latest days, in order, whatever the records", () => {
		for (let count = 91; count <= 400; count += 13) {
			for (const every of [1, 2, 3, 7, 50]) {
				const list = days(count);
				const records = new Set(datesOf(list).filter((_, index) => index % every === 0));
				const kept = datesOf(stats.thinDays(list, records, 90, 5));
				const label = `${count} days, a record every ${every}`;
				expect(kept.length, label).toBeLessThanOrEqual(90);
				expect(kept[0], label).toBe("d0000");
				expect(kept.slice(-5), label).toStrictEqual(datesOf(list.slice(-5)));
				expect(new Set(kept).size, label).toBe(kept.length);
				expect(kept, label).toStrictEqual([...kept].sort());
			}
		}
	});
});
