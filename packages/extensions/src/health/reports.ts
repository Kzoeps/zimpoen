import type { AppDb } from "@assistant/db";
import {
	describeSetGroup,
	type ExerciseChartCard,
	type ExerciseChartPoint,
	type ExerciseKind,
	type ExerciseMetric,
	type ExerciseSummary,
	type HealthDay,
	LATEST_DAYS_LISTED,
	MAX_CHART_POINTS,
	type SetGroup,
	type WeightCard,
	type WeightChartCard,
	type WeightFigure,
	type WorkoutExercise,
	type WorkoutSummary,
} from "@assistant/shared";
import { addDays, atLocalTime, formatLocalDate } from "../time.ts";
import type { DayRange } from "./range.ts";
import {
	bestDay,
	type DayStat,
	dayStats,
	daysBetween,
	e1rmOf,
	groupSets,
	hasLoad,
	metricFor,
	metricOf,
	type PersonalRecord,
	personalRecords,
	thin,
	thinDays,
	topSet,
	volumeOf,
	type WeightPointStat,
	type WeightStats,
	weightStats,
	withMovingAverage,
} from "./stats.ts";
import * as store from "./store.ts";
import { bmi, diffKg, formatKg, formatVolume, round1, round2, signed } from "./units.ts";

/**
 * What the Health tools say: a text for the model and a typed card for the thread, built from the same numbers in one
 * place so the two never disagree. Everything here reads the database and computes; nothing writes.
 */

/** `Mon 26 Oct 2026` for a local calendar day. */
export const dayLabel = (date: string, timezone: string): string =>
	formatLocalDate(atLocalTime(date, "12:00", timezone), timezone);

export const healthDay = (date: string, timezone: string): HealthDay => ({ date, dateText: dayLabel(date, timezone) });

const figure = (date: string, kg: number, timezone: string): WeightFigure => ({ ...healthDay(date, timezone), kg });

/** A stretch of days for a card: `Sat 26 Sep 2026 to Sun 25 Oct 2026`. */
function rangeText(from: string | undefined, to: string, timezone: string): string {
	return from === undefined
		? `up to ${dayLabel(to, timezone)}`
		: `${dayLabel(from, timezone)} to ${dayLabel(to, timezone)}`;
}

/** The same in a sentence: `between Sat 26 Sep 2026 and Sun 25 Oct 2026`, or `up to ...` for a range with no start. */
export function spanText(from: string | undefined, to: string, timezone: string): string {
	return from === undefined
		? `up to ${dayLabel(to, timezone)}`
		: `between ${dayLabel(from, timezone)} and ${dayLabel(to, timezone)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Weight
// ---------------------------------------------------------------------------------------------------------------------

/** A change between two weighings in one line of text: `-0.2 kg`. */
const delta = (kg: number): string => `${signed(kg)} kg`;

type WeightContext = { db: AppDb; timezone: string; heightCm?: number | undefined };

/** The weight just logged (or replaced) as the model reads it and as the thread shows it. */
export function weightLogged(
	ctx: WeightContext,
	row: store.WeightRow,
	event: WeightCard["event"],
	options: { fromLb?: number; replacedKg?: number } = {},
): { text: string; card: WeightCard } {
	const { db, timezone, heightCm } = ctx;
	const before = store.weightBefore(db, row.date);
	const average = withMovingAverage(store.weightsBetween(db, addDays(row.date, -6), row.date)).at(-1);
	const bmiValue = heightCm === undefined ? undefined : bmi(row.kg, heightCm);
	const previous =
		before === undefined
			? undefined
			: { ...figure(before.date, before.kg, timezone), deltaKg: diffKg(row.kg, before.kg) };

	const day = healthDay(row.date, timezone);
	const lines = [
		event === "logged"
			? `Logged ${formatKg(row.kg)} kg for ${day.dateText}${options.fromLb === undefined ? "" : ` (${options.fromLb} lb, converted)`}.`
			: `Updated the weight of ${day.dateText} to ${formatKg(row.kg)} kg${options.replacedKg === undefined ? "" : ` (it was ${formatKg(options.replacedKg)} kg)`}.`,
	];
	if (average !== undefined) {
		lines.push(
			`7-day average: ${round1(average.avg7)} kg (${average.avg7Entries} ${average.avg7Entries === 1 ? "entry" : "entries"}).`,
		);
	}
	if (previous !== undefined) {
		lines.push(`Previous entry: ${formatKg(previous.kg)} kg on ${previous.dateText} (${delta(previous.deltaKg)}).`);
		if (daysBetween(previous.date, row.date) <= 14 && Math.abs(previous.deltaKg) >= 4) {
			lines.push(
				`That is ${Math.abs(previous.deltaKg)} kg ${previous.deltaKg > 0 ? "more" : "less"} than the previous entry. ` +
					"Check with the owner that it is right (and in kg); if not, call log_weight again with replace: true.",
			);
		}
	}
	if (bmiValue !== undefined) lines.push(`BMI: ${bmiValue} (height ${heightCm} cm).`);

	return {
		text: lines.join("\n"),
		card: {
			type: "weight",
			event,
			day,
			kg: row.kg,
			...(options.fromLb === undefined ? {} : { fromLb: options.fromLb }),
			...(row.note === "" ? {} : { note: row.note }),
			...(previous === undefined ? {} : { previous }),
			...(average === undefined ? {} : { avg7Kg: round1(average.avg7), avg7Entries: average.avg7Entries }),
			...(bmiValue === undefined ? {} : { bmi: bmiValue }),
		},
	};
}

/** The 7-day average at the latest weighing on or before `date`, with the weighing itself. */
export function latestWithAverage(
	db: AppDb,
	onOrBefore?: string,
): { latest: store.WeightRow; average: WeightPointStat } | undefined {
	const latest = store.latestWeight(db, onOrBefore);
	if (latest === undefined) return undefined;
	const average = withMovingAverage(store.weightsBetween(db, addDays(latest.date, -6), latest.date)).at(-1);
	return average === undefined ? undefined : { latest, average };
}

/** What a range of weighings comes to, as the card carries it. */
function trendSummary(stats: WeightStats, bmiValue: number | undefined, timezone: string): WeightChartCard["summary"] {
	return {
		entries: stats.entries,
		first: figure(stats.first.date, stats.first.kg, timezone),
		latest: figure(stats.latest.date, stats.latest.kg, timezone),
		changeKg: stats.changeKg,
		min: figure(stats.min.date, stats.min.kg, timezone),
		max: figure(stats.max.date, stats.max.kg, timezone),
		averageKg: stats.averageKg,
		avg7Kg: round1(stats.latest.avg7),
		avg7Entries: stats.latest.avg7Entries,
		...(stats.trendChangeKg === undefined ? {} : { trendChangeKg: stats.trendChangeKg }),
		...(stats.perWeekKg === undefined ? {} : { perWeekKg: stats.perWeekKg }),
		...(bmiValue === undefined ? {} : { bmi: bmiValue }),
	};
}

/** The lines the model reads about a range of weighings: the latest, the change, the trend, the extremes and the BMI. */
function trendLines(
	range: DayRange,
	summary: WeightChartCard["summary"],
	ctx: { timezone: string; heightCm?: number | undefined },
): string[] {
	const { timezone, heightCm } = ctx;
	const lines = [
		`Weight, ${range.label} (${rangeText(range.from, range.to, timezone)}): ${summary.entries} ${summary.entries === 1 ? "entry" : "entries"}.`,
		`Latest: ${formatKg(summary.latest.kg)} kg (${summary.latest.dateText}). 7-day average: ${summary.avg7Kg} kg (${summary.avg7Entries} ${summary.avg7Entries === 1 ? "entry" : "entries"}).`,
	];
	if (summary.entries > 1) {
		lines.push(
			`Change over the range: ${delta(summary.changeKg)} (${formatKg(summary.first.kg)} kg on ${summary.first.dateText} to ${formatKg(summary.latest.kg)} kg).`,
		);
		if (summary.trendChangeKg !== undefined) {
			lines.push(
				`Trend (7-day average, first to latest): ${delta(summary.trendChangeKg)}${summary.perWeekKg === undefined ? "" : `, about ${delta(summary.perWeekKg)} a week`}.`,
			);
		}
		lines.push(
			`Lowest ${formatKg(summary.min.kg)} kg (${summary.min.dateText}), highest ${formatKg(summary.max.kg)} kg (${summary.max.dateText}), average ${summary.averageKg} kg.`,
		);
	}
	if (summary.bmi !== undefined) lines.push(`BMI at the latest weight: ${summary.bmi} (height ${heightCm} cm).`);
	return lines;
}

/** The line chart of a range: every weighing and its 7-day average, thinned to `MAX_CHART_POINTS` for a long history. */
function trendCard(
	points: readonly WeightPointStat[],
	range: DayRange,
	summary: WeightChartCard["summary"],
	timezone: string,
): WeightChartCard {
	const chart = points.map((point) => ({ date: point.date, kg: point.kg, avg7: round2(point.avg7) }));
	const shown = thin(chart, MAX_CHART_POINTS);
	return {
		type: "weight_chart",
		heading: `Weight, ${range.label}`,
		rangeText: rangeText(range.from, range.to, timezone),
		points: shown,
		summary,
		...(shown.length < chart.length ? { thinned: true as const } : {}),
	};
}

/** The answer to `weight_trend`: numbers for the model and the line chart for the thread. No card when there is nothing to draw. */
export function weightTrend(ctx: WeightContext, range: DayRange): { text: string; card?: WeightChartCard } {
	const { db, timezone, heightCm } = ctx;
	// The average of the first days of the range needs the six days before it, or the line would start in the wrong place.
	const all = withMovingAverage(
		store.weightsBetween(db, range.from === undefined ? undefined : addDays(range.from, -6), range.to),
	);
	const { from } = range;
	const points = from === undefined ? all : all.filter((point) => point.date >= from);
	const stats = weightStats(points);
	if (stats === undefined) return { text: `No weight is logged ${spanText(range.from, range.to, timezone)}.` };

	const summary = trendSummary(stats, heightCm === undefined ? undefined : bmi(stats.latest.kg, heightCm), timezone);
	return { text: trendLines(range, summary, ctx).join("\n"), card: trendCard(points, range, summary, timezone) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------------------------------------------------

/** One group of sets as people write it: `5x5 100 kg`, `3x8` (bodyweight), `3x8 +10 kg`, `1x3 105 kg (RPE 9)`. */
export const describeGroup = (group: SetGroup, kind: ExerciseKind): string => describeSetGroup(group, kind);

export const describeGroups = (groups: readonly SetGroup[], kind: ExerciseKind): string =>
	groups.map((group) => describeGroup(group, kind)).join(", ");

/** An exercise's sets in a workout, as `Squat 5x5 100 kg, 1x3 105 kg`. */
export const describeExercise = (exercise: WorkoutExercise): string =>
	`${exercise.name} ${describeGroups(exercise.groups, exercise.kind)}`;

/** The workouts of some sessions as cards do: sets grouped per exercise, in the order the exercises were logged. */
export function workoutSummaries(db: AppDb, sessions: readonly store.SessionRow[], timezone: string): WorkoutSummary[] {
	const sets = store.setsOfSessions(
		db,
		sessions.map((session) => session.id),
	);
	const exercises = new Map(store.listExercises(db).map((exercise) => [exercise.id, exercise]));
	const loaded = store.loadedExerciseIds(db);
	return sessions.map((session) => {
		const mine = sets.filter((set) => set.sessionId === session.id);
		const order = [...new Set(mine.map((set) => set.exerciseId))];
		const items = order.map((exerciseId): WorkoutExercise => {
			const exercise = exercises.get(exerciseId) as store.ExerciseRow;
			const metric = metricFor(exercise.kind, loaded.has(exerciseId));
			const own = mine.filter((set) => set.exerciseId === exerciseId);
			const top = topSet(metric, own) as store.SetRow;
			return {
				name: exercise.name,
				kind: exercise.kind,
				metric,
				groups: groupSets(own),
				volumeKg: volumeOf(own),
				totalReps: own.reduce((sum, set) => sum + set.reps, 0),
				top: { kg: top.kg, reps: top.reps, ...(metric === "e1rm" ? { e1rm: e1rmOf(top) } : {}) },
			};
		});
		return {
			...healthDay(session.date, timezone),
			id: session.id,
			...(session.note === "" ? {} : { note: session.note }),
			exercises: items,
			totalSets: mine.length,
			volumeKg: volumeOf(mine),
		};
	});
}

/** `estimated 1RM`, or `est. 1RM` when short; for a bodyweight exercise the 1RM is of the added weight, not of the body. */
export const estimateName = (kind: ExerciseKind, short = false): string =>
	`${short ? "est." : "estimated"} 1RM${kind === "weighted" ? "" : " of the added weight"}`;

/** A record line: `new PR: estimated 1RM 116.7 kg (was 113.3 kg)` or `new PR: 12 reps in a set (was 10)`. */
function describeRecord(exercise: WorkoutExercise, previous: number): string {
	return exercise.metric === "reps"
		? `new PR: ${exercise.top.reps} reps in a set (was ${previous})`
		: `new PR: ${estimateName(exercise.kind)} ${exercise.top.e1rm} kg (was ${previous} kg)`;
}

/** One workout as lines for the model: the exercises with their sets, and a record where the workout set one. */
export function workoutLines(workout: WorkoutSummary): string[] {
	return workout.exercises.map(
		(exercise) =>
			`- ${describeExercise(exercise)}${exercise.pr === undefined ? "" : ` — ${describeRecord(exercise, exercise.pr.previous)}`}`,
	);
}

/** `Fri 23 Oct 2026 (w_ab12cd34): 3 exercises, 11 sets, volume 4,320 kg`. */
export function workoutHeading(workout: WorkoutSummary): string {
	const volume = workout.volumeKg > 0 ? `, volume ${formatVolume(workout.volumeKg)} kg` : "";
	return `${workout.dateText} (${workout.id}): ${workout.exercises.length} ${workout.exercises.length === 1 ? "exercise" : "exercises"}, ${workout.totalSets} ${workout.totalSets === 1 ? "set" : "sets"}${volume}`;
}

/**
 * Mark what a workout just logged did to its exercises: a record where it beat every set logged before it (see
 * `writtenOfSession`: per session), and an exercise that did not exist before.
 */
export function withRecords(workout: WorkoutSummary, written: readonly store.WrittenExercise[]): WorkoutSummary {
	return {
		...workout,
		exercises: workout.exercises.map((exercise) => {
			const source = written.find((item) => item.exercise.name === exercise.name);
			if (source === undefined) return exercise;
			const { metric } = exercise;
			const best = bestDay(metric, dayStats(metric, source.earlier));
			const previous = best === undefined ? undefined : metricOf(metric, best.top);
			return {
				...exercise,
				...(previous !== undefined && metricOf(metric, exercise.top) > previous ? { pr: { previous } } : {}),
				...(source.created ? { created: true as const } : {}),
			};
		}),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Exercise progress
// ---------------------------------------------------------------------------------------------------------------------

type DayView = { day: HealthDay; top: { kg: number; reps: number }; e1rm?: number };

const viewOf = (day: DayStat, timezone: string): DayView => ({
	day: healthDay(day.date, timezone),
	top: { kg: day.top.kg, reps: day.top.reps },
	...(day.e1rm === undefined ? {} : { e1rm: day.e1rm }),
});

/** `60 kg x 8` or `12 reps` (`+10 kg` when weight was added). */
function describeTop(top: { kg: number; reps: number }, kind: ExerciseKind): string {
	if (kind === "weighted") return `${formatKg(top.kg)} kg x ${top.reps}`;
	return `${top.reps} reps${top.kg === 0 ? "" : ` +${formatKg(top.kg)} kg`}`;
}

/** How many of the latest days the text lists. The chart carries them all; the model needs the shape, not every day. */
const DAYS_LISTED = 8;

/** How many records the text names. */
const RECORDS_LISTED = 5;

/** What one exercise's range comes to: its days, the records among them, and the summary the card carries. */
type Progress = {
	kind: ExerciseKind;
	/** What the days are judged by, from the exercise's whole history up to the end of the range. */
	metric: ExerciseMetric;
	/** The days of the range, oldest first. */
	days: DayStat[];
	best: DayStat;
	allTime: DayStat;
	first: DayStat;
	last: DayStat;
	/** The records that fall inside the range, judged against the whole history. */
	records: PersonalRecord[];
	summary: ExerciseSummary;
};

function progressOf(db: AppDb, exercise: store.ExerciseRow, range: DayRange, timezone: string): Progress | undefined {
	const { kind } = exercise;
	const inside = (date: string): boolean => range.from === undefined || date >= range.from;
	// Records are judged against the whole history, so the sets before the range are read too.
	const logged = store.setsOfExercise(db, exercise.id, undefined, range.to);
	const metric = metricFor(kind, hasLoad(logged));
	const history = dayStats(metric, logged);
	const days = history.filter((day) => inside(day.date));
	const first = days[0];
	const last = days.at(-1);
	const best = bestDay(metric, days);
	const allTime = bestDay(metric, history);
	if (first === undefined || last === undefined || best === undefined || allTime === undefined) return undefined;

	const records = personalRecords(metric, history).filter((record) => inside(record.date));
	const setsInRange = logged.filter((set) => inside(set.date));
	return {
		kind,
		metric,
		days,
		best,
		allTime,
		first,
		last,
		records,
		summary: {
			sessions: days.length,
			sets: days.reduce((sum, day) => sum + day.sets, 0),
			best: viewOf(best, timezone),
			allTimeBest: viewOf(allTime, timezone),
			first: viewOf(first, timezone),
			last: viewOf(last, timezone),
			...(days.length > 1 ? { change: round1(metricOf(metric, last.top) - metricOf(metric, first.top)) } : {}),
			// The heaviest weight of any set, which is not always the weight of the day's top set (110 x 3 against 105 x 5).
			heaviestKg: Math.max(0, ...setsInRange.map((set) => set.kg)),
			// Summed over the sets, not over the rounded volumes of the days: rounding twice can be 0.2 kg off.
			totalVolumeKg: volumeOf(setsInRange),
			prs: records.length,
		},
	};
}

/** The records line: how many, and the latest few with the value each one beat. */
function recordsLine(metric: ExerciseMetric, records: readonly PersonalRecord[], timezone: string): string {
	if (records.length === 0) return "No new personal record in the range.";
	const shown = records.slice(-RECORDS_LISTED);
	const named = shown
		.map(
			(record) =>
				`${dayLabel(record.date, timezone)} ${metric === "e1rm" ? `${record.e1rm} kg` : `${record.top.reps} reps`} (was ${record.previous})`,
		)
		.join("; ");
	return `Personal records in the range: ${records.length}${records.length > shown.length ? ` (latest ${shown.length})` : ""}: ${named}.`;
}

/** One day of the list in the text: its top set, the measure it is judged by, set count, and whether it set a record. */
function dayLine(day: DayStat, progress: Progress, isRecord: boolean, timezone: string): string {
	const { kind, metric } = progress;
	const measure =
		metric === "reps"
			? `, total reps ${day.totalReps}`
			: kind === "weighted"
				? `, est. 1RM ${day.e1rm} kg, volume ${formatVolume(day.volumeKg)} kg`
				: `, ${estimateName(kind, true)} ${day.e1rm} kg, total reps ${day.totalReps}`;
	return `- ${dayLabel(day.date, timezone)}: top ${describeTop(day.top, kind)}${measure}, ${day.sets} ${day.sets === 1 ? "set" : "sets"}${isRecord ? " — PR" : ""}`;
}

/** The totals line: what the sets of the range add up to, in the words of the exercise's kind. */
function totalsLine(progress: Progress): string {
	const { kind, metric, summary, days } = progress;
	const totalReps = days.reduce((sum, day) => sum + day.totalReps, 0);
	if (kind === "weighted") {
		return `Heaviest weight: ${formatKg(summary.heaviestKg)} kg. Total volume: ${formatVolume(summary.totalVolumeKg)} kg.`;
	}
	return metric === "e1rm"
		? `Heaviest added weight: ${formatKg(summary.heaviestKg)} kg. Total reps: ${totalReps}.`
		: `Total reps: ${totalReps}.`;
}

/** The lines the model reads: the headline numbers, the change, the records and the latest days. */
function progressLines(exercise: store.ExerciseRow, range: DayRange, timezone: string, progress: Progress): string[] {
	const { kind, metric, summary, best, allTime, first, last, days, records } = progress;
	const byLoad = metric === "e1rm";
	const unit = byLoad ? " kg" : " reps";
	const value = (day: DayStat): string => `${metricOf(metric, day.top)}${unit}`;
	const estimate = (day: DayStat): string => (byLoad ? ` = ${estimateName(kind, true)} ${day.e1rm} kg` : "");
	const bestName = byLoad ? `highest ${estimateName(kind)}, Epley` : "most reps in a set";
	const lines = [
		`${exercise.name}, ${range.label} (${rangeText(range.from, range.to, timezone)}): ${summary.sessions} ${summary.sessions === 1 ? "day" : "days"}, ${summary.sets} ${summary.sets === 1 ? "set" : "sets"}.`,
		`Best day (${bestName}): ${describeTop(summary.best.top, kind)}${estimate(best)} on ${summary.best.day.dateText}.`,
	];
	if (allTime.date !== best.date) {
		lines.push(
			`Best ever: ${describeTop(summary.allTimeBest.top, kind)}${estimate(allTime)} on ${summary.allTimeBest.day.dateText}.`,
		);
	}
	if (summary.change !== undefined) {
		lines.push(
			`Change from the first to the latest day of the range: ${signed(summary.change)}${unit} (${value(first)} on ${summary.first.day.dateText} to ${value(last)} on ${summary.last.day.dateText}).`,
		);
	}
	lines.push(
		totalsLine(progress),
		recordsLine(metric, records, timezone),
		`Latest ${Math.min(DAYS_LISTED, days.length)} days:`,
	);
	const recordDates = new Set(records.map((record) => record.date));
	for (const day of days.slice(-DAYS_LISTED)) lines.push(dayLine(day, progress, recordDates.has(day.date), timezone));
	return lines;
}

/**
 * The chart card: one point a day, with the summary. A long history is thinned to `MAX_CHART_POINTS`: the first day, the
 * latest days the card lists, the newest records (ringed on the chart), and the rest spread evenly.
 */
function progressCard(
	exercise: store.ExerciseRow,
	range: DayRange,
	timezone: string,
	progress: Progress,
): ExerciseChartCard {
	const { kind, metric, days, records, summary } = progress;
	const recordDates = new Set(records.map((record) => record.date));
	const kept = thinDays(days, recordDates, MAX_CHART_POINTS, LATEST_DAYS_LISTED);
	const toPoint = (day: DayStat): ExerciseChartPoint => ({
		date: day.date,
		top: { kg: day.top.kg, reps: day.top.reps },
		...(day.e1rm === undefined ? {} : { e1rm: day.e1rm }),
		volumeKg: day.volumeKg,
		totalReps: day.totalReps,
		...(recordDates.has(day.date) ? { pr: true as const } : {}),
	});
	return {
		type: "exercise_chart",
		exercise: exercise.name,
		kind,
		metric,
		heading: `${exercise.name}, ${range.label}`,
		rangeText: rangeText(range.from, range.to, timezone),
		points: kept.map(toPoint),
		summary,
		...(kept.length < days.length ? { thinned: true as const } : {}),
	};
}

/** The answer to `exercise_progress`: the days of the range with their top set, estimated 1RM and volume, and the records. */
export function exerciseProgress(
	db: AppDb,
	exercise: store.ExerciseRow,
	range: DayRange,
	timezone: string,
): { text: string; card?: ExerciseChartCard } {
	const progress = progressOf(db, exercise, range, timezone);
	if (progress === undefined) {
		return { text: `No sets of ${exercise.name} are logged ${spanText(range.from, range.to, timezone)}.` };
	}
	return {
		text: progressLines(exercise, range, timezone, progress).join("\n"),
		card: progressCard(exercise, range, timezone, progress),
	};
}
