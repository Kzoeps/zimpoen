import { describe, expect, it } from "vitest";
import {
	CHART_SIZE,
	type ChartSeries,
	dayLabel,
	dayNumber,
	layoutChart,
	linearScale,
	niceTicks,
} from "../src/lib/chart.ts";

const day = (date: string, v: number) => ({ t: dayNumber(date), v });

describe("days on an axis", () => {
	it("numbers local calendar days, so that a gap in dates is a gap on the axis", () => {
		expect(dayNumber("2026-10-26") - dayNumber("2026-10-25")).toBe(1);
		expect(dayNumber("2027-01-01") - dayNumber("2026-12-31")).toBe(1);
		expect(dayNumber("2026-03-01") - dayNumber("2026-02-27")).toBe(2);
	});

	it("labels a day with its date, and a long chart with months, where a day would mean nothing", () => {
		expect(dayLabel(dayNumber("2026-09-26"), 30)).toBe("26 Sep");
		expect(dayLabel(dayNumber("2026-09-26"), 400)).toBe("Sep 2026");
		expect(dayLabel(dayNumber("2026-10-05"), 0)).toBe("5 Oct");
	});
});

describe("axis values", () => {
	it("picks round numbers inside the range, about four of them", () => {
		expect(niceTicks(71.5, 74.5)).toStrictEqual([72, 73, 74]);
		expect(niceTicks(0, 1)).toStrictEqual([0, 0.25, 0.5, 0.75, 1]);
		expect(niceTicks(100, 125)).toStrictEqual([100, 110, 120]);
		expect(niceTicks(58.2, 61.9)).toStrictEqual([59, 60, 61]);
		expect(niceTicks(112, 130)).toStrictEqual([115, 120, 125, 130]);
	});

	it("gives one tick for a range of no width", () => {
		expect(niceTicks(72, 72)).toStrictEqual([72]);
	});

	it("maps a domain onto a range, upside down when the range is, and to the middle for one value", () => {
		const scale = linearScale([70, 80], [100, 0]);
		expect(scale(70)).toBe(100);
		expect(scale(80)).toBe(0);
		expect(scale(75)).toBe(50);
		expect(linearScale([5, 5], [0, 10])(5)).toBe(5);
	});
});

describe("laying out a chart", () => {
	const series: ChartSeries[] = [
		{ id: "raw", kind: "dots", points: [day("2026-10-12", 74), day("2026-10-18", 73), day("2026-10-25", 72.4)] },
		{ id: "avg", kind: "line", points: [day("2026-10-12", 74), day("2026-10-18", 73.4), day("2026-10-25", 72.5)] },
	];

	it("puts every point inside the drawing, later days to the right and higher values higher up", () => {
		const geometry = layoutChart(series);

		const [raw, avg] = geometry?.series ?? [];
		expect(raw?.dots).toHaveLength(3);
		expect(raw?.path).toBe("");
		expect(avg?.dots).toHaveLength(0);
		const { plot } = geometry ?? { plot: { x0: 0, x1: 0, y0: 0, y1: 0 } };
		for (const dot of raw?.dots ?? []) {
			expect(dot.x).toBeGreaterThan(plot.x0);
			expect(dot.x).toBeLessThan(plot.x1);
			expect(dot.y).toBeGreaterThan(plot.y0);
			expect(dot.y).toBeLessThan(plot.y1);
		}
		const [first, second, third] = raw?.dots ?? [];
		expect((first?.x ?? 0) < (second?.x ?? 0) && (second?.x ?? 0) < (third?.x ?? 0)).toBe(true);
		expect((first?.y ?? 0) < (second?.y ?? 0) && (second?.y ?? 0) < (third?.y ?? 0)).toBe(true); // 74 is above 73 above 72.4
		// 12 Oct to 25 Oct is 13 days; 18 Oct is 6 of them.
		const span = (third?.x ?? 0) - (first?.x ?? 0);
		expect(((second?.x ?? 0) - (first?.x ?? 0)) / span).toBeCloseTo(6 / 13, 1);
	});

	it("draws a line as one path through its points, in order", () => {
		const geometry = layoutChart(series);

		const path = geometry?.series[1]?.path ?? "";
		expect(path).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
		const [, y1, , y2, , y3] = path.match(/[\d.]+/g)?.map(Number) ?? [];
		expect(y1).toBeLessThan(y2 ?? 0);
		expect(y2).toBeLessThan(y3 ?? 0);
	});

	it("labels the value axis with round numbers inside the drawing and the day axis with its first and last day", () => {
		const geometry = layoutChart(series);

		expect(geometry?.yTicks.map((tick) => tick.label)).toStrictEqual(["72", "73", "74"]);
		for (const tick of geometry?.yTicks ?? []) {
			expect(tick.y).toBeGreaterThanOrEqual(geometry?.plot.y0 ?? 0);
			expect(tick.y).toBeLessThanOrEqual(geometry?.plot.y1 ?? 0);
		}
		const labels = geometry?.xTicks.map((tick) => tick.label) ?? [];
		expect(labels[0]).toBe("12 Oct");
		expect(labels.at(-1)).toBe("25 Oct");
		expect(geometry?.xTicks.map((tick) => tick.anchor)).toStrictEqual(["start", "middle", "middle", "end"]);
	});

	it("marks the points that are records", () => {
		const geometry = layoutChart([
			{
				id: "points",
				kind: "dots",
				points: [day("2026-10-19", 116.7), day("2026-10-22", 119.6)],
				marks: [false, true],
			},
		]);

		expect(geometry?.series[0]?.dots.map((dot) => dot.mark)).toStrictEqual([false, true]);
	});

	it("draws a single point in the middle, with room around it, and not at an edge", () => {
		const geometry = layoutChart([{ id: "raw", kind: "dots", points: [day("2026-10-25", 72.4)] }]);

		const [dot] = geometry?.series[0]?.dots ?? [];
		const { plot } = geometry ?? { plot: { x0: 0, x1: 0, y0: 0, y1: 0 } };
		expect(dot?.x).toBeCloseTo((plot.x0 + plot.x1) / 2, 0);
		expect(dot?.y).toBeCloseTo((plot.y0 + plot.y1) / 2, 0);
		expect(geometry?.xTicks).toHaveLength(1);
		expect(geometry?.xTicks[0]?.anchor).toBe("middle");
	});

	it("keeps a flat line off the edge of the drawing", () => {
		const geometry = layoutChart([
			{ id: "line", kind: "line", points: [day("2026-10-20", 72), day("2026-10-25", 72)] },
		]);

		const [a, b] =
			geometry?.series[0]?.path
				.match(/[\d.]+/g)
				?.map(Number)
				.filter((_, index) => index % 2 === 1) ?? [];
		expect(a).toBe(b);
		expect(a).toBeGreaterThan(geometry?.plot.y0 ?? 0);
		expect(a).toBeLessThan(geometry?.plot.y1 ?? 0);
	});

	it("has nothing to draw for no points, and never produces a number that is not one", () => {
		expect(layoutChart([])).toBeUndefined();
		expect(layoutChart([{ id: "raw", kind: "dots", points: [] }])).toBeUndefined();
		const text = JSON.stringify(layoutChart(series));
		expect(text).not.toMatch(/NaN|Infinity|null/);
	});

	it("gives the same drawing for the same data, and scales with the size it is given", () => {
		expect(layoutChart(series)).toStrictEqual(layoutChart(series));
		const wide = layoutChart(series, { ...CHART_SIZE, width: 720 });
		expect(wide?.plot.x1).toBe(720 - CHART_SIZE.right);
	});
});
