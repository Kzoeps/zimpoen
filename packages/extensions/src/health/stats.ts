import type { ExerciseKind, ExerciseMetric, SetGroup } from "@assistant/shared";
import { diffKg, epley, hundredths, round1 } from "./units.ts";

/**
 * The arithmetic of the Health agent (PLAN rule 7): moving averages, trends, estimated one-rep maxes, personal records.
 * Pure functions over plain rows, with no database and no clock, so every number a card or a tool reports can be
 * checked here. Dates are local calendar days, `YYYY-MM-DD`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `a` to `b`: positive when `b` is later. Calendar arithmetic, so a change of the clock is not a day. */
export function daysBetween(a: string, b: string): number {
	return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

// ---------------------------------------------------------------------------------------------------------------------
// Body weight
// ---------------------------------------------------------------------------------------------------------------------

export type WeightEntry = { date: string; kg: number };

/** An entry with the trailing average at its day. */
export type WeightPointStat = WeightEntry & {
	/** The mean of the weighings of the 7 days up to this one. Exact, not rounded: round it once, where it is shown. */
	avg7: number;
	avg7Entries: number;
	/** The sum `avg7` is the mean of, in hundredths of a kilogram: a trend is worked out from two of these, exactly. */
	avg7Hundredths: number;
};

/** How many calendar days the moving average looks back, the day itself included. */
export const AVERAGE_DAYS = 7;

/**
 * Each entry with the mean of the entries of the `AVERAGE_DAYS` days up to and including its own day. Days without an
 * entry are not zeros and not filled in: the mean is over the weighings there are. `entries` must be oldest first, one
 * per day. Each window is summed afresh, in whole hundredths of a kilogram, so nothing drifts over a long history and a
 * mean that falls exactly half-way between two tenths is exactly that.
 */
export function withMovingAverage(entries: readonly WeightEntry[], days = AVERAGE_DAYS): WeightPointStat[] {
	const points: WeightPointStat[] = [];
	let start = 0;
	for (const [index, entry] of entries.entries()) {
		while (daysBetween((entries[start] as WeightEntry).date, entry.date) >= days) start++;
		const window = entries.slice(start, index + 1);
		const sum = window.reduce((total, item) => total + hundredths(item.kg), 0);
		points.push({ ...entry, avg7: sum / window.length / 100, avg7Entries: window.length, avg7Hundredths: sum });
	}
	return points;
}

export type WeightStats = {
	entries: number;
	first: WeightPointStat;
	latest: WeightPointStat;
	changeKg: number;
	min: WeightEntry;
	max: WeightEntry;
	averageKg: number;
	/** The average at the latest entry minus the one at the first. Absent with a single entry. */
	trendChangeKg?: number;
	/** The trend per week, when the entries span two weeks or more. */
	perWeekKg?: number;
};

/** The difference of two moving averages, in kilograms: `a.sum / a.n - b.sum / b.n`, with no rounding before the last one. */
function meanDifferenceKg(a: WeightPointStat, b: WeightPointStat): number {
	const numerator = a.avg7Hundredths * b.avg7Entries - b.avg7Hundredths * a.avg7Entries;
	return numerator / (a.avg7Entries * b.avg7Entries * 100);
}

/** What a stretch of weighings adds up to, or undefined for none. `points` is the range only, oldest first. */
export function weightStats(points: readonly WeightPointStat[]): WeightStats | undefined {
	const first = points[0];
	const latest = points.at(-1);
	if (first === undefined || latest === undefined) return undefined;
	let min = first;
	let max = first;
	let total = 0;
	for (const point of points) {
		if (point.kg < min.kg) min = point;
		if (point.kg > max.kg) max = point;
		total += hundredths(point.kg);
	}
	const span = daysBetween(first.date, latest.date);
	const trend = points.length > 1 ? meanDifferenceKg(latest, first) : undefined;
	return {
		entries: points.length,
		first,
		latest,
		changeKg: diffKg(latest.kg, first.kg),
		min: { date: min.date, kg: min.kg },
		max: { date: max.date, kg: max.kg },
		averageKg: round1(total / (points.length * 100)),
		...(trend === undefined ? {} : { trendChangeKg: round1(trend) }),
		...(trend !== undefined && span >= 14 ? { perWeekKg: round1((trend / span) * 7) } : {}),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Lifting
// ---------------------------------------------------------------------------------------------------------------------

/** One set as it was logged, with the day it belongs to. `kg` is 0 for a bodyweight set with nothing added. */
export type LoggedSet = { date: string; reps: number; kg: number; rpe?: number };

type Lift = { kg: number; reps: number };

/** Estimated 1RM of a set, kg, one decimal. */
export const e1rmOf = (set: Lift): number => round1(epley(set.kg, set.reps));

/** Did any of these sets carry a load? */
export const hasLoad = (sets: readonly { kg: number }[]): boolean => sets.some((set) => set.kg > 0);

/**
 * What an exercise's progress is measured in. A weighted exercise by estimated 1RM. A bodyweight one by repetitions, until
 * a set of it carries added weight (`loaded`): from then on by the estimated 1RM of the added weight, an unloaded set
 * counting as 0, so that 12 pull-ups with 20 kg on the belt beats 15 without. `loaded` is about the exercise's whole
 * history, so one line of progress is always measured in one thing.
 */
export const metricFor = (kind: ExerciseKind, loaded: boolean): ExerciseMetric =>
	kind === "weighted" || loaded ? "e1rm" : "reps";

/** The number a set is judged by under `metric`. Progress charts plot it, and a personal record is a day that beats every earlier one on it. */
export function metricOf(metric: ExerciseMetric, set: Lift): number {
	return metric === "e1rm" ? e1rmOf(set) : set.reps;
}

/**
 * Positive when `a` is the better set: higher metric, then the heavier, then the more reps (the last matters for unloaded
 * sets of an exercise measured by added weight, which all count 0).
 */
export function compareSets(metric: ExerciseMetric, a: Lift, b: Lift): number {
	return metricOf(metric, a) - metricOf(metric, b) || a.kg - b.kg || a.reps - b.reps;
}

/** The best set of a list, the first of equals, or undefined for an empty list. */
export function topSet<T extends Lift>(metric: ExerciseMetric, sets: readonly T[]): T | undefined {
	let best: T | undefined;
	for (const set of sets) if (best === undefined || compareSets(metric, set, best) > 0) best = set;
	return best;
}

/** One day of one exercise. */
export type DayStat = {
	date: string;
	sets: number;
	top: Lift;
	/** Estimated 1RM of the top set, when the metric is `e1rm`. */
	e1rm?: number;
	volumeKg: number;
	totalReps: number;
};

/** Sets grouped by day, oldest first. Two workouts on one day are one day: the line of a chart has one point a day. */
export function dayStats(metric: ExerciseMetric, sets: readonly LoggedSet[]): DayStat[] {
	const byDay = new Map<string, LoggedSet[]>();
	for (const set of sets) byDay.set(set.date, [...(byDay.get(set.date) ?? []), set]);
	return [...byDay.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, daySets]) => {
			const top = topSet(metric, daySets) as LoggedSet;
			return {
				date,
				sets: daySets.length,
				top: { kg: top.kg, reps: top.reps },
				...(metric === "e1rm" ? { e1rm: e1rmOf(top) } : {}),
				volumeKg: round1(daySets.reduce((sum, set) => sum + set.reps * set.kg, 0)),
				totalReps: daySets.reduce((sum, set) => sum + set.reps, 0),
			};
		});
}

/** A day that beat every earlier day. `previous` is the earlier best on the metric. */
export type PersonalRecord = { date: string; top: Lift; e1rm?: number; previous: number };

/**
 * The days that set a new record: strictly better than every day before on the metric (an equal day is not a record).
 * The first day is the baseline, not a record. `days` must be oldest first and cover the whole history, not only a range:
 * a day beats "every earlier day" only if the earlier ones are all there.
 */
export function personalRecords(metric: ExerciseMetric, days: readonly DayStat[]): PersonalRecord[] {
	const records: PersonalRecord[] = [];
	let best: number | undefined;
	for (const day of days) {
		const value = metricOf(metric, day.top);
		if (best !== undefined && value > best) {
			records.push({
				date: day.date,
				top: day.top,
				...(day.e1rm === undefined ? {} : { e1rm: day.e1rm }),
				previous: best,
			});
		}
		if (best === undefined || value > best) best = value;
	}
	return records;
}

/** The best day of a list on the metric (the earliest of equals), or undefined. */
export function bestDay(metric: ExerciseMetric, days: readonly DayStat[]): DayStat | undefined {
	let best: DayStat | undefined;
	for (const day of days) if (best === undefined || metricOf(metric, day.top) > metricOf(metric, best.top)) best = day;
	return best;
}

/** Consecutive identical sets as `{ sets, reps, kg }`: `5 x 5 at 100` is five sets of five reps. */
export function groupSets(sets: readonly { reps: number; kg: number; rpe?: number | undefined }[]): SetGroup[] {
	const groups: SetGroup[] = [];
	for (const set of sets) {
		const last = groups.at(-1);
		if (last !== undefined && last.reps === set.reps && last.kg === set.kg && last.rpe === set.rpe) last.sets++;
		else groups.push({ sets: 1, reps: set.reps, kg: set.kg, ...(set.rpe === undefined ? {} : { rpe: set.rpe }) });
	}
	return groups;
}

/** Sum of reps x kg over a list of sets, one decimal. */
export const volumeOf = (sets: readonly { reps: number; kg: number }[]): number =>
	round1(sets.reduce((sum, set) => sum + set.reps * set.kg, 0));

/**
 * At most `max` of `items`, evenly spread, always including the first and the last. A chart of two years of daily
 * weights does not need 700 points on a phone, and the card is stored in the thread for good.
 */
export function thin<T>(items: readonly T[], max: number): T[] {
	if (items.length <= max) return [...items];
	return Array.from({ length: max }, (_, index) => items[Math.round((index * (items.length - 1)) / (max - 1))] as T);
}

/**
 * At most `max` days for an exercise chart, oldest first: the first day, the `latest` newest days (the card lists them, so a
 * thinned chart still ends with them), the newest records, and the rest spread evenly. Records take at most half of
 * `max`, so the line between them keeps its shape. A list that is short enough comes back whole. `max` is at least
 * `latest + 1`: the first day and the latest ones are always kept.
 */
export function thinDays<T extends { date: string }>(
	days: readonly T[],
	records: ReadonlySet<string>,
	max: number,
	latest: number,
): T[] {
	if (days.length <= max) return [...days];
	const kept = new Set<number>([0]);
	for (let index = Math.max(0, days.length - latest); index < days.length; index++) kept.add(index);
	let recordRoom = Math.max(0, Math.min(Math.floor(max / 2), max - kept.size));
	for (let index = days.length - 1; index >= 0 && recordRoom > 0; index--) {
		if (records.has((days[index] as T).date) && !kept.has(index)) {
			kept.add(index);
			recordRoom--;
		}
	}
	const rest = days.map((_, index) => index).filter((index) => !kept.has(index));
	const room = max - kept.size;
	if (room > 1) for (const index of thin(rest, room)) kept.add(index);
	return [...kept].sort((a, b) => a - b).map((index) => days[index] as T);
}
