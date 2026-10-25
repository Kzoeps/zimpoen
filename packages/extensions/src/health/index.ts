import { defineExtension, section } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { createHealthFacts } from "./facts.ts";
import { healthMigrations } from "./migrations.ts";
import { dayLabel, estimateName, latestWithAverage } from "./reports.ts";
import { bestDay, dayStats, hasLoad, metricFor } from "./stats.ts";
import * as store from "./store.ts";
import { createApprovalActions, createHealthTools } from "./tools.ts";
import { bmi, formatKg, round1 } from "./units.ts";

export const HEALTH_EXTENSION_NAME = "health";

/** How many exercises the prompt section gives a record for. */
const RECORDS_LISTED = 5;

/** How many exercise names the prompt section lists, so the model names exercises the way the log does. */
const NAMES_LISTED = 30;

/**
 * The prompt section: the latest weight with its 7-day average, the day of the last workout, the current records of the
 * exercises trained most recently, and the names of the exercises there are. It holds no clock: the average is the one
 * at the latest weighing (not "today's"), dates are absolute, and "most recent" is by logged day, so it renders the same
 * bytes until something is logged and shares the provider's prompt cache.
 */
export function renderHealthSection(deps: Pick<DomainDeps, "db" | "timezone" | "health">): string {
	const { db, timezone } = deps;
	const lines: string[] = [];

	const weight = latestWithAverage(db);
	if (weight === undefined) lines.push("No weight logged yet.");
	else {
		const { latest, average } = weight;
		const height = deps.health?.heightCm;
		lines.push(
			`Latest weight: ${formatKg(latest.kg)} kg on ${dayLabel(latest.date, timezone)} (7-day average up to that day: ${round1(average.avg7)} kg from ${average.avg7Entries} ${average.avg7Entries === 1 ? "entry" : "entries"}).` +
				(height === undefined ? "" : ` BMI ${bmi(latest.kg, height)} (height ${height} cm).`),
		);
	}

	const last = store.lastSessionDate(db);
	lines.push(last === undefined ? "No workouts logged yet." : `Last workout: ${dayLabel(last, timezone)}.`);

	const recent = store.recentExercises(db, RECORDS_LISTED);
	if (recent.length > 0) {
		lines.push(
			"Current records of the exercises trained most recently (best estimated 1RM; for bodyweight exercises the most reps in a set, or the estimated 1RM of the added weight once a set had any):",
		);
		for (const { exercise } of recent) {
			const sets = store.setsOfExercise(db, exercise.id, undefined, "9999-12-31");
			const metric = metricFor(exercise.kind, hasLoad(sets));
			const best = bestDay(metric, dayStats(metric, sets));
			if (best === undefined) continue;
			const set =
				exercise.kind === "weighted"
					? `${formatKg(best.top.kg)} kg x ${best.top.reps}`
					: `${best.top.reps} reps${best.top.kg === 0 ? "" : ` +${formatKg(best.top.kg)} kg`}`;
			lines.push(
				metric === "e1rm"
					? `- ${exercise.name}: ${estimateName(exercise.kind, true)} ${best.e1rm} kg (${set}, ${dayLabel(best.date, timezone)})`
					: `- ${exercise.name}: ${set} (${dayLabel(best.date, timezone)})`,
			);
		}
	}

	const names = store.listExercises(db).map((exercise) => exercise.name);
	if (names.length > 0) {
		const shown = names.slice(0, NAMES_LISTED);
		lines.push(
			`Exercises logged: ${shown.join(", ")}${names.length > shown.length ? ` and ${names.length - shown.length} more` : ""}.`,
		);
	}
	return lines.join("\n");
}

export const healthModule: DomainModule = {
	name: "health",
	migrations: healthMigrations,
	extension: (deps) =>
		defineExtension({
			name: HEALTH_EXTENSION_NAME,
			tools: createHealthTools(deps),
			sections: [section("health", () => renderHealthSection(deps))],
		}),
	actions: (deps) => createApprovalActions(deps),
	facts: (deps) => [createHealthFacts(deps)],
};

export { CATALOG, exerciseKey, findInCatalog, tidyExerciseName } from "./catalog.ts";
export { NUDGE_WINDOW_DAYS } from "./facts.ts";
export { resolveRange } from "./range.ts";
export { dayLabel as healthDayLabel, describeExercise, describeGroup } from "./reports.ts";
export * as healthStats from "./stats.ts";
export * as healthStore from "./store.ts";
export * as healthUnits from "./units.ts";
