import { type DailyFactsProvider, sectionOf } from "../daily/facts.ts";
import type { DomainDeps } from "../module.ts";
import { addDays } from "../time.ts";
import { dayLabel, describeExercise, estimateName, latestWithAverage, workoutSummaries } from "./reports.ts";
import { dayStats, hasLoad, metricFor, personalRecords } from "./stats.ts";
import * as store from "./store.ts";
import { formatKg, round1 } from "./units.ts";

type Deps = Pick<DomainDeps, "db" | "timezone">;

/**
 * How many days before yesterday the owner must have weighed in at least once for the briefing to notice a missed
 * day. Someone who has not weighed in for two weeks has stopped logging, and a line about it every morning would be
 * nagging; someone who logged all week and skipped yesterday is reminded once.
 */
export const NUDGE_WINDOW_DAYS = 14;

/**
 * What the health log can say for the daily jobs. The briefing: a nudge when yesterday's weight is missing (code decides,
 * the PA only words it). The wrap-up: the weight logged today and what was trained, with the records it set.
 */
export function createHealthFacts(deps: Deps): DailyFactsProvider {
	const { db, timezone } = deps;

	return {
		id: "health",
		briefing: (day) => {
			const yesterday = addDays(day.date, -1);
			// Today's weight already in means the owner is on it; a missed yesterday is no longer worth a line.
			if (store.getWeight(db, yesterday) !== undefined || store.getWeight(db, day.date) !== undefined) return [];
			const recent = store.weightsBetween(db, addDays(yesterday, -NUDGE_WINDOW_DAYS), yesterday);
			const last = recent.at(-1);
			if (last === undefined) return [];
			return sectionOf("Health", [
				`No weight was logged yesterday (${dayLabel(yesterday, timezone)}); the last one was ${formatKg(last.kg)} kg on ${dayLabel(last.date, timezone)}. The owner logs it with the Health agent.`,
			]);
		},
		wrapup: (day) => {
			const lines: string[] = [];
			const weight = store.getWeight(db, day.date);
			if (weight !== undefined) {
				const average = latestWithAverage(db, day.date)?.average;
				lines.push(
					`Weighed ${formatKg(weight.kg)} kg${average === undefined ? "" : ` (7-day average ${round1(average.avg7)} kg)`}`,
				);
			}
			const sessions = store.sessionsOn(db, day.date);
			for (const workout of workoutSummaries(db, sessions, timezone)) {
				lines.push(`Trained: ${workout.exercises.map(describeExercise).join("; ")}`);
			}
			const records = recordsOn(day.date, sessions);
			if (records.length > 0) lines.push(`New personal records: ${records.join("; ")}`);
			return sectionOf("Health today", lines);
		},
	};

	/** The exercises trained on `date` that set a record that day, in the order they were trained, each with the new best. */
	function recordsOn(date: string, sessions: readonly store.SessionRow[]): string[] {
		const sets = store.setsOfSessions(
			db,
			sessions.map((session) => session.id),
		);
		const exercises = new Map(store.listExercises(db).map((exercise) => [exercise.id, exercise]));
		return [...new Set(sets.map((set) => set.exerciseId))].flatMap((id) => {
			const exercise = exercises.get(id);
			if (exercise === undefined) return [];
			const sets = store.setsOfExercise(db, exercise.id, undefined, date);
			const metric = metricFor(exercise.kind, hasLoad(sets));
			const record = personalRecords(metric, dayStats(metric, sets)).find((candidate) => candidate.date === date);
			if (record === undefined) return [];
			return [
				metric === "e1rm"
					? `${exercise.name} (${estimateName(exercise.kind)} ${record.e1rm} kg, was ${record.previous} kg)`
					: `${exercise.name} (${record.top.reps} reps in a set, was ${record.previous})`,
			];
		});
	}
}
