/**
 * The geometry of the small line charts of the Health cards: where each point, tick and line goes in a 360 x 176
 * drawing. Pure, so the layout is tested without a browser; `components/health-charts.tsx` only turns it into SVG.
 *
 * No chart library: a card shows one or two series of at most 90 points, which is a few dozen lines of arithmetic.
 * The drawing is scaled by the browser (`viewBox`), so one layout fits a 390 px phone and a desktop column.
 */

/** One point: `t` is a day number (days since 1970-01-01), `v` the value drawn at that day. */
export type ChartPoint = { t: number; v: number };

/** A series is drawn as a line through its points, or as dots (`marks[i]` makes dot `i` stand out: a record). */
export type ChartSeries = {
	id: string;
	kind: "line" | "dots";
	points: readonly ChartPoint[];
	marks?: readonly boolean[];
};

export type ChartSize = { width: number; height: number; left: number; right: number; top: number; bottom: number };

/** Room on the left for the value labels and at the bottom for the dates. */
export const CHART_SIZE: ChartSize = { width: 360, height: 176, left: 38, right: 12, top: 12, bottom: 24 };

export type ChartGeometry = {
	size: ChartSize;
	/** The drawing area inside the margins. */
	plot: { x0: number; x1: number; y0: number; y1: number };
	yTicks: Array<{ y: number; label: string }>;
	/** `anchor` keeps the first and the last label inside the drawing. */
	xTicks: Array<{ x: number; label: string; anchor: "start" | "middle" | "end" }>;
	series: Array<{
		id: string;
		kind: ChartSeries["kind"];
		/** SVG path data of a line; empty for dots. */
		path: string;
		dots: Array<{ x: number; y: number; mark: boolean }>;
	}>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The day number of a local calendar day, `2026-10-25`. */
export function dayNumber(date: string): number {
	return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `26 Sep` for a day number; `Sep 2026` when the chart spans more than ten months, where the day would mean nothing. */
export function dayLabel(t: number, spanDays: number): string {
	const date = new Date(t * DAY_MS);
	const month = MONTHS[date.getUTCMonth()];
	return spanDays > 300 ? `${month} ${date.getUTCFullYear()}` : `${date.getUTCDate()} ${month}`;
}

/** A function that maps the domain onto the range linearly. A domain of one value maps to the middle of the range. */
export function linearScale(
	domain: readonly [number, number],
	range: readonly [number, number],
): (value: number) => number {
	const [d0, d1] = domain;
	const [r0, r1] = range;
	if (d0 === d1) return () => (r0 + r1) / 2;
	return (value) => r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

/** Round off floating point noise: `0.30000000000000004` is `0.3`. */
const tidy = (value: number): number => Number(value.toPrecision(12));

/**
 * Round values inside `[min, max]`, about `count` of them: steps of 1, 2, 2.5, 5 or 10 times a power of ten, the way an
 * axis is labelled by hand.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
	if (!(max > min)) return [tidy(min)];
	const raw = (max - min) / count;
	const magnitude = 10 ** Math.floor(Math.log10(raw));
	const fraction = raw / magnitude;
	const step = magnitude * (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10);
	const ticks: number[] = [];
	for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-9; tick += step) ticks.push(tidy(tick));
	return ticks;
}

/** A value for an axis: whole numbers plain, otherwise one or two decimals. */
export const valueLabel = (value: number): string => String(tidy(value));

/** Coordinates to one decimal, without a trailing `.0`: the markup stays small. */
const coordinate = (value: number): number => Math.round(value * 10) / 10;

/**
 * Lay out series in a drawing. The value axis is padded so that points never sit on the edge and a flat line is not
 * drawn along the top; the day axis runs from the first day to the last (one day: that day, centred). Undefined when
 * there is nothing to draw.
 */
export function layoutChart(series: readonly ChartSeries[], size: ChartSize = CHART_SIZE): ChartGeometry | undefined {
	const all = series.flatMap((item) => item.points);
	if (all.length === 0) return undefined;
	const tMin = Math.min(...all.map((point) => point.t));
	const tMax = Math.max(...all.map((point) => point.t));
	const vMin = Math.min(...all.map((point) => point.v));
	const vMax = Math.max(...all.map((point) => point.v));
	const pad = Math.max((vMax - vMin) * 0.12, Math.abs(vMax) * 0.01, 0.5);
	const lo = vMin - pad;
	const hi = vMax + pad;

	const plot = { x0: size.left, x1: size.width - size.right, y0: size.top, y1: size.height - size.bottom };
	const x = linearScale([tMin, tMax], [plot.x0 + 6, plot.x1 - 6]);
	const y = linearScale([lo, hi], [plot.y1, plot.y0]);

	const spanDays = tMax - tMin;
	const xTickDays =
		spanDays === 0 ? [tMin] : [...new Set([0, 1, 2, 3].map((index) => Math.round(tMin + (spanDays * index) / 3)))];
	return {
		size,
		plot,
		yTicks: niceTicks(lo, hi).map((tick) => ({ y: coordinate(y(tick)), label: valueLabel(tick) })),
		xTicks: xTickDays.map((t, index) => ({
			x: coordinate(x(t)),
			label: dayLabel(t, spanDays),
			anchor:
				xTickDays.length === 1 ? "middle" : index === 0 ? "start" : index === xTickDays.length - 1 ? "end" : "middle",
		})),
		series: series.map((item) => {
			const dots = item.points.map((point, index) => ({
				x: coordinate(x(point.t)),
				y: coordinate(y(point.v)),
				mark: item.marks?.[index] === true,
			}));
			return {
				id: item.id,
				kind: item.kind,
				path:
					item.kind === "line" ? dots.map((dot, index) => `${index === 0 ? "M" : "L"}${dot.x} ${dot.y}`).join(" ") : "",
				dots: item.kind === "dots" ? dots : [],
			};
		}),
	};
}
