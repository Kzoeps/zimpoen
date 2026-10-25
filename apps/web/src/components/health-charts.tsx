import {
	describeSetGroup,
	type ExerciseChartCard,
	formatKg,
	formatVolume,
	LATEST_DAYS_LISTED,
	signed,
	type WeightCard,
	type WeightChartCard,
	type WorkoutCard,
	type WorkoutListCard,
	type WorkoutSummary,
} from "@assistant/shared";
import { type ChartGeometry, type ChartSeries, dayLabel, dayNumber, layoutChart } from "../lib/chart.ts";

/**
 * The Health agent's cards. Plain functions of their card with no state and no hooks, so a card renders the same on the
 * server, in the browser and in a test (`renderToStaticMarkup`). The charts are small SVGs drawn from `lib/chart.ts`;
 * their colours come from CSS variables, so dark mode needs nothing here.
 */

/** The drawing of a chart. `label` is what a screen reader hears instead of the picture. */
export function LineChart({ geometry, label }: { geometry: ChartGeometry; label: string }) {
	const { size, plot } = geometry;
	return (
		<svg
			className="chart"
			viewBox={`0 0 ${size.width} ${size.height}`}
			role="img"
			aria-label={label}
			preserveAspectRatio="xMidYMid meet"
		>
			<title>{label}</title>
			<g className="chart__grid">
				{geometry.yTicks.map((tick) => (
					<line key={tick.label} x1={plot.x0} x2={plot.x1} y1={tick.y} y2={tick.y} />
				))}
			</g>
			<g className="chart__axis">
				{geometry.yTicks.map((tick) => (
					<text key={tick.label} x={plot.x0 - 6} y={tick.y + 3.5} textAnchor="end">
						{tick.label}
					</text>
				))}
				{geometry.xTicks.map((tick) => (
					<text key={tick.x} x={tick.x} y={size.height - 7} textAnchor={tick.anchor}>
						{tick.label}
					</text>
				))}
			</g>
			{geometry.series.map((series) => (
				<g key={series.id} className={`chart__series chart__series--${series.id}`}>
					{series.kind === "line" ? <path d={series.path} fill="none" /> : null}
					{series.dots.map((dot) => (
						<circle
							key={`${dot.x}:${dot.y}`}
							className={dot.mark ? "chart__dot chart__dot--pr" : "chart__dot"}
							cx={dot.x}
							cy={dot.y}
							r={dot.mark ? 4.5 : 2.5}
						/>
					))}
				</g>
			))}
		</svg>
	);
}

function Stat({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
	return (
		<div className="stat">
			<dt className="stat__label">{label}</dt>
			<dd className="stat__value">
				{value}
				{note === undefined ? null : <span className="stat__note">{note}</span>}
			</dd>
		</div>
	);
}

const kgText = (kg: number): string => `${formatKg(kg)} kg`;
const shortDay = (dateText: string): string => dateText.replace(/^\w+ /, "").replace(/ \d{4}$/, "");

// ----- weight --------------------------------------------------------------------------------------------------------

/** The weight just logged: the number, how it differs from the last one, and the 7-day average. */
export function WeightLoggedView({ card }: { card: WeightCard }) {
	const label = card.event === "logged" ? "Weight logged" : "Weight updated";
	return (
		<section className="card card--health" aria-label={label}>
			<header className="card__head">
				<span aria-hidden="true">⚖️</span> {label} <span className="card__muted">· {card.day.dateText}</span>
			</header>
			<p className="card__big">{kgText(card.kg)}</p>
			<p className="card__muted">
				{card.fromLb === undefined ? null : `${card.fromLb} lb · `}
				{card.previous === undefined
					? "first entry"
					: `${signed(card.previous.deltaKg)} kg since ${shortDay(card.previous.dateText)}`}
				{card.avg7Kg === undefined ? null : ` · 7-day average ${formatKg(card.avg7Kg)} kg`}
				{card.bmi === undefined ? null : ` · BMI ${card.bmi}`}
			</p>
			{card.note === undefined ? null : <p className="card__muted">“{card.note}”</p>}
		</section>
	);
}

/** Every weighing of a range as dots, the 7-day average as a line through them, and the numbers under it. */
export function WeightChartView({ card }: { card: WeightChartCard }) {
	const { summary } = card;
	const geometry = layoutChart([
		{ id: "raw", kind: "dots", points: card.points.map((point) => ({ t: dayNumber(point.date), v: point.kg })) },
		{ id: "avg", kind: "line", points: card.points.map((point) => ({ t: dayNumber(point.date), v: point.avg7 })) },
	]);
	const label = `Weight in kilograms, ${card.rangeText}: ${summary.entries} entries, from ${formatKg(summary.first.kg)} to ${formatKg(summary.latest.kg)}`;
	return (
		<section className="card card--health card--chart" aria-label={card.heading}>
			<header className="card__head">
				<span aria-hidden="true">⚖️</span> {card.heading}
			</header>
			<p className="card__muted">
				{card.rangeText} · {summary.entries} {summary.entries === 1 ? "entry" : "entries"}
			</p>
			{geometry === undefined ? null : <LineChart geometry={geometry} label={label} />}
			<p className="chart__legend card__muted">
				<span className="chart__key chart__key--raw" aria-hidden="true" /> weighings
				<span className="chart__key chart__key--avg" aria-hidden="true" /> 7-day average
			</p>
			<dl className="stats">
				<Stat label="Latest" value={kgText(summary.latest.kg)} note={shortDay(summary.latest.dateText)} />
				<Stat label="7-day average" value={kgText(summary.avg7Kg)} />
				{summary.entries > 1 ? <Stat label="Change" value={`${signed(summary.changeKg)} kg`} /> : null}
				{summary.trendChangeKg === undefined ? null : (
					<Stat
						label="Trend"
						value={`${signed(summary.trendChangeKg)} kg`}
						note={summary.perWeekKg === undefined ? undefined : `${signed(summary.perWeekKg)} a week`}
					/>
				)}
				{summary.entries > 1 ? (
					<>
						<Stat label="Lowest" value={kgText(summary.min.kg)} note={shortDay(summary.min.dateText)} />
						<Stat label="Highest" value={kgText(summary.max.kg)} note={shortDay(summary.max.dateText)} />
					</>
				) : null}
				{summary.bmi === undefined ? null : <Stat label="BMI" value={String(summary.bmi)} />}
			</dl>
			{card.thinned === true ? <p className="card__muted">The chart shows a selection of the weighings.</p> : null}
		</section>
	);
}

// ----- lifting -------------------------------------------------------------------------------------------------------

/** One exercise over time: the metric as a line, records ringed, and the best set, the change and the volume. */
export function ExerciseChartView({ card }: { card: ExerciseChartCard }) {
	const { summary } = card;
	// `kind` decides how a set is written (a load, or an added load); `metric` what the line is: the estimated 1RM, or reps.
	const weighted = card.kind === "weighted";
	const byLoad = card.metric === "e1rm";
	const value = (point: ExerciseChartCard["points"][number]): number => (byLoad ? (point.e1rm ?? 0) : point.top.reps);
	const points = card.points.map((point) => ({ t: dayNumber(point.date), v: value(point) }));
	const series: ChartSeries[] = [
		{ id: "metric", kind: "line", points },
		{ id: "points", kind: "dots", points, marks: card.points.map((point) => point.pr === true) },
	];
	const geometry = layoutChart(series);
	const unit = byLoad ? "kg" : "reps";
	const set = (top: { kg: number; reps: number }): string =>
		weighted
			? `${formatKg(top.kg)} kg × ${top.reps}`
			: `${top.reps} reps${top.kg === 0 ? "" : ` +${formatKg(top.kg)} kg`}`;
	// The estimated 1RM of a bodyweight exercise is of the weight added to it, written with the plus the sets use.
	const estimate = (e1rm: number | undefined): string => `${weighted ? "" : "+"}${e1rm} kg`;
	const best = byLoad ? estimate(summary.best.e1rm) : `${summary.best.top.reps} reps`;
	const measure = !byLoad
		? "repetitions in the best set"
		: weighted
			? "estimated one-rep max in kilograms"
			: "estimated one-rep max of the added weight in kilograms";
	const label = `${card.exercise}, ${measure}, ${card.rangeText}: ${summary.sessions} days, best ${best}`;
	// A set of reps and nothing added is the number already shown as the best: only the day is left to say.
	const bestDay = shortDay(summary.best.day.dateText);
	const bestNote = !byLoad && summary.best.top.kg === 0 ? bestDay : `${set(summary.best.top)} · ${bestDay}`;
	const days = card.points.slice(-LATEST_DAYS_LISTED).reverse();
	return (
		<section className="card card--health card--chart" aria-label={card.heading}>
			<header className="card__head">
				<span aria-hidden="true">📈</span> {card.heading}
			</header>
			<p className="card__muted">
				{card.rangeText} · {summary.sessions} {summary.sessions === 1 ? "day" : "days"} · {summary.sets}{" "}
				{summary.sets === 1 ? "set" : "sets"}
			</p>
			{geometry === undefined ? null : <LineChart geometry={geometry} label={label} />}
			<p className="chart__legend card__muted">
				{!byLoad
					? "Repetitions in the best set of each day"
					: weighted
						? "Estimated one-rep max (Epley) of the best set of each day, in kg"
						: "Estimated one-rep max (Epley) of the added weight in the best set of each day, in kg"}
				{summary.prs > 0 ? (
					<span className="chart__note">
						· <span className="chart__key chart__key--pr" aria-hidden="true" /> record
					</span>
				) : null}
			</p>
			<dl className="stats">
				<Stat label="Best" value={best} note={bestNote} />
				{summary.change === undefined ? null : <Stat label="Change" value={`${signed(summary.change)} ${unit}`} />}
				<Stat label="Records" value={String(summary.prs)} />
				{weighted ? <Stat label="Volume" value={`${formatVolume(summary.totalVolumeKg)} kg`} /> : null}
			</dl>
			{summary.allTimeBest.day.date !== summary.best.day.date ? (
				<p className="card__muted">
					Best ever: {byLoad ? estimate(summary.allTimeBest.e1rm) : `${summary.allTimeBest.top.reps} reps`} on{" "}
					{shortDay(summary.allTimeBest.day.dateText)}
				</p>
			) : null}
			<ul className="days">
				{days.map((point) => (
					<li key={point.date}>
						<span className="days__date">{dayLabel(dayNumber(point.date), 0)}</span>
						<span>{set(point.top)}</span>
						{byLoad ? (
							<span className="card__muted">
								{" "}
								· {point.e1rm === 0 ? "no added weight" : `est. ${estimate(point.e1rm)}`}
							</span>
						) : null}
						{point.pr === true ? <span className="badge badge--pr">PR</span> : null}
					</li>
				))}
			</ul>
			{card.thinned === true ? <p className="card__muted">The chart shows a selection of the days.</p> : null}
		</section>
	);
}

/** One workout: each exercise with its sets, a record where it set one, and the totals. */
function WorkoutBody({ workout }: { workout: WorkoutSummary }) {
	return (
		<>
			<ul className="lifts">
				{workout.exercises.map((exercise) => (
					<li key={exercise.name} className="lift">
						<span className="lift__name">{exercise.name}</span>
						<span className="lift__sets">
							{exercise.groups.map((group) => describeSetGroup(group, exercise.kind, "×")).join(", ")}
						</span>
						{exercise.pr === undefined ? null : (
							<span className="badge badge--pr">
								PR{" "}
								{exercise.metric === "reps"
									? `${exercise.top.reps} reps`
									: `${exercise.kind === "weighted" ? "" : "+"}${exercise.top.e1rm} kg est. 1RM`}
							</span>
						)}
						{exercise.created === true ? <span className="badge">new exercise</span> : null}
					</li>
				))}
			</ul>
			<p className="card__muted">
				{workout.totalSets} {workout.totalSets === 1 ? "set" : "sets"}
				{workout.volumeKg > 0 ? ` · volume ${formatVolume(workout.volumeKg)} kg` : ""}
			</p>
			{workout.note === undefined ? null : <p className="card__muted">“{workout.note}”</p>}
		</>
	);
}

export function WorkoutLoggedView({ card }: { card: WorkoutCard }) {
	return (
		<section className="card card--health" aria-label="Workout logged">
			<header className="card__head">
				<span aria-hidden="true">🏋️</span> Workout logged <span className="card__muted">· {card.workout.dateText}</span>
			</header>
			<WorkoutBody workout={card.workout} />
		</section>
	);
}

export function WorkoutListView({ card }: { card: WorkoutListCard }) {
	return (
		<section className="card card--health" aria-label={card.heading}>
			<header className="card__head">
				<span aria-hidden="true">🏋️</span> {card.heading} <span className="card__muted">({card.total})</span>
			</header>
			{card.workouts.map((workout) => (
				<div key={workout.id} className="workout">
					<p className="card__title">
						{workout.dateText} <span className="card__muted">{workout.id}</span>
					</p>
					<WorkoutBody workout={workout} />
				</div>
			))}
			{card.total > card.workouts.length ? (
				<p className="card__muted">…and {card.total - card.workouts.length} more</p>
			) : null}
		</section>
	);
}
