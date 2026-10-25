/**
 * The Health agent's cards: what its tools put in a tool result's `details` for the thread to draw. Every number in
 * them was computed by the server (PLAN rule 7), and every date is a local calendar day (`2026-10-26`) with its
 * wording for people next to it, so the client never does date or unit arithmetic.
 *
 * Weights are kilograms everywhere: the owner may type pounds, the tools convert once, on the way in.
 */

/** A day with its wording for people. */
export type HealthDay = {
	/** `2026-10-26`, the owner's local day. */
	date: string;
	/** `Mon 26 Oct 2026`. */
	dateText: string;
};

export type WeightFigure = HealthDay & { kg: number };

/** One logged weight and the trailing average at that day: the mean of every entry of the 7 days up to and including it. */
export type WeightChartPoint = {
	date: string;
	kg: number;
	/** Mean of the entries in `[date - 6 days, date]`; days without an entry do not count as zero. */
	avg7: number;
};

export type WeightSummary = {
	/** How many entries the range holds. */
	entries: number;
	first: WeightFigure;
	latest: WeightFigure;
	/** `latest - first`, kg. */
	changeKg: number;
	min: WeightFigure;
	max: WeightFigure;
	/** Mean of the entries in the range, kg. */
	averageKg: number;
	/** The 7-day average at the latest entry, and how many entries it is made of. */
	avg7Kg: number;
	avg7Entries: number;
	/** The 7-day average at the latest entry minus the one at the first: the trend without day-to-day noise. */
	trendChangeKg?: number;
	/** `trendChangeKg` per week, only when the range spans at least two weeks. */
	perWeekKg?: number;
	/** Body mass index at the latest weight; only when the owner's height is configured. */
	bmi?: number;
};

/** The answer to `weight_trend`: the line of weights and their 7-day average. */
export type WeightChartCard = {
	type: "weight_chart";
	heading: string;
	/** `26 Sep – 25 Oct 2026`. */
	rangeText: string;
	points: WeightChartPoint[];
	summary: WeightSummary;
	/** `points` was thinned to keep the card small; `summary` still covers every entry. */
	thinned?: true;
};

/** The answer to `log_weight`. */
export type WeightCard = {
	type: "weight";
	event: "logged" | "updated";
	day: HealthDay;
	kg: number;
	/** The pounds the owner gave, when they gave pounds. */
	fromLb?: number;
	note?: string;
	/** The entry before this one, with how far this one is from it. */
	previous?: WeightFigure & { deltaKg: number };
	avg7Kg?: number;
	avg7Entries?: number;
	bmi?: number;
};

/**
 * `weighted`: every set has a load (bench press, squat). `bodyweight`: a set needs none (pull-up, dip, push-up), and a
 * belt, a vest or a dumbbell is the added weight.
 */
export type ExerciseKind = "weighted" | "bodyweight";

/**
 * What a line of progress is measured in: the estimated one-rep max in kg (Epley), or repetitions. A weighted exercise
 * is always measured by its estimated 1RM. A bodyweight one is measured by repetitions until a set of it carries added
 * weight; from then on by the estimated 1RM of that added weight, because 12 pull-ups with 20 kg on the belt is progress
 * that repetitions alone do not show. Unloaded sets then count as 0 kg added.
 */
export type ExerciseMetric = "e1rm" | "reps";

/** Consecutive identical sets: `5 x 5 at 100 kg` is `{ sets: 5, reps: 5, kg: 100 }`. `kg` is 0 for a bodyweight set with no added weight. */
export type SetGroup = { sets: number; reps: number; kg: number; rpe?: number };

export type WorkoutExercise = {
	name: string;
	kind: ExerciseKind;
	/** What this exercise's progress is measured in: it decides which numbers below mean what. */
	metric: ExerciseMetric;
	groups: SetGroup[];
	/** Sum of reps x kg, kg. 0 for a bodyweight exercise with no added weight. */
	volumeKg: number;
	totalReps: number;
	/** The best set of this workout by `metric`. `e1rm` is there when the metric is `e1rm`. */
	top: { kg: number; reps: number; e1rm?: number };
	/** This workout beat every earlier set of this exercise. `previous` is the earlier best, in the unit of `metric`. */
	pr?: { previous: number };
	/** The exercise did not exist before this workout. */
	created?: true;
};

export type WorkoutSummary = HealthDay & {
	id: string;
	note?: string;
	exercises: WorkoutExercise[];
	totalSets: number;
	volumeKg: number;
};

/** The answer to `log_workout`. */
export type WorkoutCard = { type: "workout"; event: "logged"; workout: WorkoutSummary };

/** The answer to `list_workouts`, newest first. */
export type WorkoutListCard = { type: "workout_list"; heading: string; workouts: WorkoutSummary[]; total: number };

/** One day of one exercise: the best set of the day and what the day added up to. */
export type ExerciseChartPoint = {
	date: string;
	top: { kg: number; reps: number };
	/** Estimated 1RM of the top set, when the metric is `e1rm`. */
	e1rm?: number;
	volumeKg: number;
	totalReps: number;
	/** The day beat every earlier day. */
	pr?: true;
};

export type ExerciseSummary = {
	/** Days with at least one set in the range. */
	sessions: number;
	sets: number;
	/** The best day of the range, and the best day ever (a PR may be older than the range). */
	best: { day: HealthDay; top: { kg: number; reps: number }; e1rm?: number };
	allTimeBest: { day: HealthDay; top: { kg: number; reps: number }; e1rm?: number };
	/** The first and the last day of the range, for the change between them. */
	first: { day: HealthDay; top: { kg: number; reps: number }; e1rm?: number };
	last: { day: HealthDay; top: { kg: number; reps: number }; e1rm?: number };
	/** Change of the metric between `first` and `last`: est. 1RM in kg, or reps. Absent with one session. */
	change?: number;
	/** The heaviest weight lifted in the range, kg. */
	heaviestKg: number;
	totalVolumeKg: number;
	/** How many times the range beat every earlier day. */
	prs: number;
};

/** The answer to `exercise_progress`. `metric` says what the line is: estimated 1RM in kg, or repetitions. */
export type ExerciseChartCard = {
	type: "exercise_chart";
	exercise: string;
	kind: ExerciseKind;
	metric: ExerciseMetric;
	heading: string;
	rangeText: string;
	/** At most {@link MAX_CHART_POINTS}, oldest first. A thinned chart still ends with the {@link LATEST_DAYS_LISTED} latest days. */
	points: ExerciseChartPoint[];
	summary: ExerciseSummary;
	/** `points` was thinned to keep the card small; `summary` still covers every day. */
	thinned?: true;
};

/** The most points a chart card carries: a phone is 360 px wide, and the card is stored in the thread for good. */
export const MAX_CHART_POINTS = 90;

/** How many of the latest days an exercise card lists under its chart. A thinned chart keeps all of them. */
export const LATEST_DAYS_LISTED = 5;

// ---------------------------------------------------------------------------------------------------------------------
// Wording: one place, so that the text a tool tells the model and the card the thread draws say a number the same way.
// ---------------------------------------------------------------------------------------------------------------------

/** Round to `digits` decimals, half away from zero, without the `1.005 * 100` surprises of a bare `Math.round`. */
export function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	const scaled = Number((Math.abs(value) * factor).toPrecision(15));
	return (Math.sign(value) * Math.round(scaled)) / factor;
}

/**
 * A weight for people: `72.4`, `100`, `62.5`, `2.25`. Whole numbers carry no decimals and the rest as many as they need
 * (two at most), so a plate of 62.5 kg is not written 62.50.
 */
export function formatKg(kg: number): string {
	return String(round(kg, 2));
}

/** `+0.4` or `-1.3`; zero is `0`. For a change that has a direction. */
export function signed(value: number, digits = 1): string {
	const rounded = round(value, digits);
	return rounded === 0 ? "0" : `${rounded > 0 ? "+" : "-"}${Math.abs(rounded)}`;
}

/** `4,320`: thousands grouped, for a volume. */
export function formatVolume(kg: number): string {
	return Math.round(kg)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * One group of sets as people write it: `5x5 100 kg`, `3x8` (bodyweight), `3x8 +10 kg`, `1x3 105 kg (RPE 9)`. The
 * server's text uses a plain `x`; the thread passes the multiplication sign.
 */
export function describeSetGroup(group: SetGroup, kind: ExerciseKind, times = "x"): string {
	const load = group.kg === 0 ? "" : kind === "bodyweight" ? ` +${formatKg(group.kg)} kg` : ` ${formatKg(group.kg)} kg`;
	return `${group.sets}${times}${group.reps}${load}${group.rpe === undefined ? "" : ` (RPE ${group.rpe})`}`;
}
