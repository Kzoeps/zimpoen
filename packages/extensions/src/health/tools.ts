import type { WorkoutExercise } from "@assistant/shared";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ApprovalAction } from "../approvals/service.ts";
import type { DomainDeps } from "../module.ts";
import { addDays, isoLocal, localDate, parseWhen, weekdayName } from "../time.ts";
import { asDetails, oneLine, text } from "../tool-support.ts";
import { bodyweightNameOf, exerciseKey, findInCatalog, tidyExerciseName } from "./catalog.ts";
import { RANGE_HELP, resolveRange } from "./range.ts";
import {
	dayLabel,
	exerciseProgress,
	spanText,
	weightLogged,
	weightTrend,
	withRecords,
	workoutHeading,
	workoutLines,
	workoutSummaries,
} from "./reports.ts";
import * as store from "./store.ts";
import { formatKg, formatVolume, toKg, type WeightUnit } from "./units.ts";

type Deps = Pick<DomainDeps, "db" | "timezone" | "approvals" | "health">;

/** What a plausible body weight is, kg. Anything outside is a typo or the wrong unit, and is refused with that hint. */
const BODY_KG = { min: 20, max: 500 } as const;
/** The heaviest set a log accepts, kg. */
const MAX_LIFT_KG = 1000;
const MAX_SETS_PER_CALL = 100;
const MAX_LISTED = 50;
const DEFAULT_LISTED = 10;

const unitSchema = Type.Union([Type.Literal("kg"), Type.Literal("lb")], {
	description: "kg unless the owner gave pounds (lb): the tool converts and stores kilograms.",
});

const DAY_HELP = "The local day, YYYY-MM-DD, or today / yesterday. Never in the future.";
const DATE_HELP = `${DAY_HELP} Default today.`;

/**
 * The tools of the Health agent. Every tool that writes is replay-safe because it is idempotent by its call id (rule 8):
 * `log_weight` through the row's `source_call_id` (a replacement through the call ledger), `log_workout` because the
 * whole session is written in one transaction under the call's id, `rename_exercise` through the same ledger; each
 * looks for its own earlier result before it checks anything that reads the clock. The `propose_*` tools do not: they
 * resolve `today` or `yesterday` first, so a proposal replayed after midnight may meet another day. The approval
 * service still hands back the request the call id made, so nothing is proposed twice and nothing else is deleted; at
 * worst the replay says there is no weight for that day.
 */
export function createHealthTools(deps: Deps): ToolRegistration[] {
	const { db, timezone, approvals } = deps;
	const heightCm = deps.health?.heightCm;
	const conversationOf = (api: ToolExecutionApi): number => Number(api.conversationId);
	const ctx = { db, timezone, heightCm };

	/** The local day a call is about. Words and dates are accepted; a day that has not happened is not. */
	function resolveDay(value: string | undefined, today: string, name = "date"): string {
		if (value === undefined) return today;
		const word = value.trim().toLowerCase();
		if (word === "today") return today;
		if (word === "yesterday") return addDays(today, -1);
		const parsed = parseWhen(value, timezone);
		if (!parsed.ok || !parsed.dateOnly || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
			throw new Error(
				`${name} must be a day written YYYY-MM-DD, or today or yesterday; got '${value.slice(0, 40)}'. Call current_time if you need today's date.`,
			);
		}
		const day = value.trim();
		if (day > today) throw new Error(`${name} ${day} is in the future; today is ${today}.`);
		if (day < "2000-01-01") throw new Error(`${name} ${day} is too long ago to be right. Check the year.`);
		return day;
	}

	const currentTime = defineTool({
		name: "current_time",
		description:
			"The current date, time and weekday in the owner's time zone. Call it before turning 'last Friday' or 'three days ago' into a date.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			const now = api.now();
			return {
				output: text(`Now: ${isoLocal(now, timezone)} (${weekdayName(now, timezone)}), time zone ${timezone}.`),
			};
		},
	});

	// ----- weight -----------------------------------------------------------------------------------------------------

	const weightResult = (
		row: store.WeightRow,
		event: "logged" | "updated",
		extra: { fromLb?: number; replacedKg?: number } = {},
	) => {
		const report = weightLogged(ctx, row, event, extra);
		return { output: text(report.text), details: asDetails(report.card) };
	};

	const logWeight = defineTool({
		name: "log_weight",
		description:
			"Log the owner's body weight for a day. One weighing a day: if the day already has one this refuses and says so; " +
			"call it again with replace: true only when the owner wants the old one overwritten. Pounds are converted to kg. " +
			"Returns the 7-day average and the change from the previous entry, computed in code.",
		parameters: Type.Object({
			weight: Type.Number({ minimum: 0, description: "The number on the scale, in `unit`." }),
			unit: Type.Optional(unitSchema),
			date: Type.Optional(Type.String({ description: DATE_HELP })),
			note: Type.Optional(
				Type.String({ maxLength: 200, description: "Anything worth keeping with it: after a meal, sick." }),
			),
			replace: Type.Optional(
				Type.Boolean({ description: "true: overwrite the weighing the day already has. Default false." }),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			// Rule 8: a replay finds what its first run did before it checks anything. The checks read the clock ("today"),
			// and a call Durable replays after a crash runs later than the first run did, maybe on the next day.
			const call = store.findCall(db, api.callId);
			if (call?.tool === "log_weight") {
				const replaced = store.getWeight(db, call.subject);
				if (replaced !== undefined) return weightResult(replaced, "updated");
			}
			const earlier = store.weightByCallId(db, api.callId);
			if (earlier !== undefined) return weightResult(earlier, "logged");

			const now = api.now();
			const day = resolveDay(args.date, localDate(now, timezone));
			const unit: WeightUnit = args.unit ?? "kg";
			const kg = toKg(args.weight, unit);
			if (kg < BODY_KG.min || kg > BODY_KG.max) {
				throw new Error(
					`${args.weight} ${unit} (${formatKg(kg)} kg) is not a plausible body weight (${BODY_KG.min} to ${BODY_KG.max} kg). Check the number and the unit with the owner.`,
				);
			}
			const extra = unit === "lb" ? { fromLb: args.weight } : {};
			const note = args.note === undefined ? undefined : oneLine(args.note);
			const existing = store.getWeight(db, day);
			if (existing === undefined) {
				const { row } = store.insertWeight(db, { date: day, kg, note: note ?? "", now }, api.callId);
				return weightResult(row, "logged", extra);
			}
			if (args.replace !== true) {
				throw new Error(
					`A weight is already logged for ${dayLabel(day, timezone)}: ${formatKg(existing.kg)} kg. ` +
						"There is one weighing a day. If the owner wants to replace it, call log_weight again with replace: true; otherwise leave it as it is.",
				);
			}
			const { row } = store.replaceWeight(db, day, { kg, ...(note === undefined ? {} : { note }) }, api.callId, now);
			return weightResult(row, "updated", { ...extra, replacedKg: existing.kg });
		},
	});

	const weightTrendTool = defineTool({
		name: "weight_trend",
		description:
			"The owner's weight over a stretch of time: the 7-day moving average, the change over the range, the lowest and the " +
			"highest, BMI when the height is known, and a chart. All computed in code: quote these numbers, never work them out yourself.",
		parameters: Type.Object({
			range: Type.Optional(Type.String({ description: `${RANGE_HELP} Default 30d.` })),
			from: Type.Optional(Type.String({ description: "First day, YYYY-MM-DD. Use instead of range." })),
			to: Type.Optional(Type.String({ description: "Last day, YYYY-MM-DD. Default today." })),
		}),
		replay: "safe",
		async execute(args, api) {
			const range = resolveRange(args, localDate(api.now(), timezone), "30d");
			const report = weightTrend(ctx, range);
			return { output: text(report.text), ...(report.card === undefined ? {} : { details: asDetails(report.card) }) };
		},
	});

	// ----- workouts ---------------------------------------------------------------------------------------------------

	const setSchema = Type.Object({
		reps: Type.Integer({ minimum: 1, maximum: 100, description: "Repetitions in the set." }),
		weight: Type.Optional(
			Type.Number({
				minimum: 0,
				description:
					"The load in `unit` (kg unless the call says lb). Every set of a weighted exercise needs it. Leave it out for a bodyweight exercise " +
					"(pull-up, dip, push-up); when a belt, vest or dumbbell added weight, give that: progress then follows the added weight.",
			}),
		),
		rpe: Type.Optional(
			Type.Number({ minimum: 1, maximum: 10, description: "Rate of perceived exertion, 1 to 10, if the owner said." }),
		),
		count: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 20,
				description:
					"How many identical sets this stands for. 5 x 5 at 100 kg is reps 5, weight 100, count 5. Default 1.",
			}),
		),
	});

	/** The sets of one exercise as stored rows: weights in kg, `count` expanded. Throws what to fix. */
	function expandSets(
		name: string,
		sets: ReadonlyArray<{
			reps: number;
			weight?: number | undefined;
			rpe?: number | undefined;
			count?: number | undefined;
		}>,
		unit: WeightUnit,
	): Array<{ reps: number; kg: number; rpe?: number }> {
		return sets.flatMap((set) => {
			const kg = set.weight === undefined ? 0 : toKg(set.weight, unit);
			if (kg > MAX_LIFT_KG) {
				throw new Error(
					`${name}: ${set.weight} ${unit} is not a plausible weight for one set. Check the number and the unit.`,
				);
			}
			return Array.from({ length: set.count ?? 1 }, () => ({
				reps: set.reps,
				kg,
				...(set.rpe === undefined ? {} : { rpe: set.rpe }),
			}));
		});
	}

	/**
	 * A weighted exercise whose sets carry no weight is most likely a weight the model forgot, so it is refused; a bodyweight
	 * one needs none. The refusal names the way out for a movement that really was done unloaded: its bodyweight twin.
	 */
	function checkLoads(name: string, sets: ReadonlyArray<{ kg: number }>): void {
		const known = store.findExercise(db, name) ?? findInCatalog(name);
		if (known?.kind === "weighted" && sets.some((set) => set.kg === 0)) {
			throw new Error(
				`${name} is a weighted exercise: every set needs a weight. If the owner did not say what it was, ask. ` +
					`If it really was done with no weight, log it as '${bodyweightNameOf(known.name)}' instead: that is its bodyweight version.`,
			);
		}
	}

	/** The exercise a name stands for, or an error that says which exercises there are. */
	function requireExercise(name: string, whenNone = "No exercise has been logged yet."): store.ExerciseRow {
		const found = store.findExercise(db, name);
		if (found !== undefined) return found;
		const known = store.listExercises(db).map((exercise) => exercise.name);
		throw new Error(
			known.length === 0
				? whenNone
				: `No exercise called '${oneLine(name).slice(0, 40)}'. Logged exercises: ${known.join(", ")}.`,
		);
	}

	/** What the model is told about an exercise this workout named for the first time: how it will be measured, and the way back from a slip. */
	const newExerciseNote = (exercise: WorkoutExercise): string => {
		const how =
			exercise.kind === "weighted"
				? "Its sets had weights, so its progress is the estimated 1RM."
				: "No weight was given, so its progress is repetitions; if it has a load, give the weight when you log it next time and its progress follows the load.";
		return (
			`New exercise created: "${exercise.name}" was not among the owner's exercises or the built-in names. ${how} Tell the owner; ` +
			"if the name was a slip for one they already have, merge them (propose_merge_exercises); if it only needs another name, rename_exercise keeps this one as an alias."
		);
	};

	const workoutResult = (session: store.SessionRow, options: { converted?: boolean } = {}) => {
		const [summary] = workoutSummaries(db, [session], timezone);
		if (summary === undefined) throw new Error(`Workout ${session.id} has disappeared; check health_session.`);
		const workout = withRecords(summary, store.writtenOfSession(db, session));
		const lines = [`Logged workout ${workoutHeading(workout)}.`, ...workoutLines(workout)];
		for (const exercise of workout.exercises) if (exercise.created === true) lines.push(newExerciseNote(exercise));
		if (options.converted === true) lines.push("Weights were converted from lb to kg.");
		return { output: text(lines.join("\n")), details: asDetails({ type: "workout", event: "logged", workout }) };
	};

	const logWorkout = defineTool({
		name: "log_workout",
		description:
			"Log one gym session: any number of exercises, each with its sets, in one call. Exercise names are matched to the " +
			"owner's own list and to common aliases ('bench' is Bench press); a name that is not known is created and the " +
			"result says so. Say 5 x 5 at 100 kg as one set entry with count 5. The result flags new personal records, computed in code.",
		parameters: Type.Object({
			exercises: Type.Array(
				Type.Object({
					name: Type.String({
						minLength: 1,
						maxLength: 80,
						description: "As the owner said it, or the name from the prompt's list of exercises.",
					}),
					sets: Type.Array(setSchema, { minItems: 1, maxItems: 40 }),
				}),
				{ minItems: 1, maxItems: 20 },
			),
			unit: Type.Optional(unitSchema),
			date: Type.Optional(Type.String({ description: DATE_HELP })),
			note: Type.Optional(
				Type.String({ maxLength: 300, description: "How it felt, where: anything the owner added about the session." }),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.sessionByCallId(db, api.callId);
			if (earlier !== undefined) return workoutResult(earlier, { converted: args.unit === "lb" });

			const now = api.now();
			const day = resolveDay(args.date, localDate(now, timezone));
			const unit: WeightUnit = args.unit ?? "kg";
			const exercises = args.exercises.map((item) => {
				const typed = oneLine(item.name);
				if (typed === "") throw new Error("An exercise needs a name.");
				const sets = expandSets(typed, item.sets, unit);
				checkLoads(typed, sets);
				return { typed, sets };
			});
			if (exercises.reduce((total, item) => total + item.sets.length, 0) > MAX_SETS_PER_CALL) {
				throw new Error(`That is more than ${MAX_SETS_PER_CALL} sets in one call. Log the session in parts.`);
			}
			const { session } = store.insertWorkout(
				db,
				{ date: day, note: args.note === undefined ? "" : oneLine(args.note), now, exercises },
				api.callId,
			);
			return workoutResult(session, { converted: unit === "lb" });
		},
	});

	const progressTool = defineTool({
		name: "exercise_progress",
		description:
			"How one exercise has progressed: per day the top set (highest estimated 1RM by Epley), the volume, and the personal " +
			"records, with a chart. For a bodyweight exercise the measure is reps, or the estimated 1RM of the added weight once a set had any. " +
			"All computed in code: quote these numbers.",
		parameters: Type.Object({
			exercise: Type.String({ minLength: 1, description: "The exercise, by name or alias: 'bench', 'Squat'." }),
			range: Type.Optional(Type.String({ description: `${RANGE_HELP} Default 90d.` })),
			from: Type.Optional(Type.String({ description: "First day, YYYY-MM-DD. Use instead of range." })),
			to: Type.Optional(Type.String({ description: "Last day, YYYY-MM-DD. Default today." })),
		}),
		replay: "safe",
		async execute(args, api) {
			const found = requireExercise(args.exercise, "No exercise has been logged yet, so there is no progress to show.");
			const range = resolveRange(args, localDate(api.now(), timezone), "90d");
			const report = exerciseProgress(db, found, range, timezone);
			return { output: text(report.text), ...(report.card === undefined ? {} : { details: asDetails(report.card) }) };
		},
	});

	const listWorkouts = defineTool({
		name: "list_workouts",
		description:
			"List logged workouts, newest first, with their exercises and sets. The ids it shows are what propose_delete_workout takes.",
		parameters: Type.Object({
			range: Type.Optional(Type.String({ description: `${RANGE_HELP} Default 30d.` })),
			from: Type.Optional(Type.String({ description: "First day, YYYY-MM-DD. Use instead of range." })),
			to: Type.Optional(Type.String({ description: "Last day, YYYY-MM-DD. Default today." })),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_LISTED, description: `At most this many. Default ${DEFAULT_LISTED}.` }),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const range = resolveRange(args, localDate(api.now(), timezone), "30d");
			const { sessions, total } = store.sessionsBetween(db, range.from, range.to, args.limit ?? DEFAULT_LISTED);
			if (sessions.length === 0) {
				return { output: text(`No workouts are logged ${spanText(range.from, range.to, timezone)}.`) };
			}
			const workouts = workoutSummaries(db, sessions, timezone);
			const cut = workouts.length < total ? ` (showing ${workouts.length} of ${total})` : "";
			const heading = `Workouts, ${range.label}`;
			const lines = [`${heading}: ${total}${cut}`];
			for (const workout of workouts) {
				lines.push(workoutHeading(workout), ...workoutLines(workout));
				if (workout.note !== undefined) lines.push(`  note: ${workout.note}`);
			}
			return {
				output: text(lines.join("\n")),
				details: asDetails({ type: "workout_list", heading, workouts, total }),
			};
		},
	});

	// ----- exercises: renaming is free, merging asks first -----------------------------------------------------------------

	const renameExerciseTool = defineTool({
		name: "rename_exercise",
		description:
			"Give an exercise another name, for example when a new exercise was named wrongly or the owner wants a clearer name. " +
			"The old name still works afterwards (it is kept as an alias) and every set stays with the exercise. " +
			"To combine two exercises that are really one, use propose_merge_exercises instead.",
		parameters: Type.Object({
			exercise: Type.String({
				minLength: 1,
				description: "The exercise as it is called now, by its name or an alias.",
			}),
			new_name: Type.String({ minLength: 1, maxLength: 80, description: "The name it should have." }),
		}),
		replay: "safe",
		async execute(args, api) {
			// Rule 8: a replay finds the rename its first run made before it looks at anything else.
			const call = store.findCall(db, api.callId);
			const done = call?.tool === "rename_exercise" ? store.getExercise(db, Number(call.subject)) : undefined;
			if (done !== undefined) return { output: text(`This exercise is called "${done.name}" (already renamed).`) };

			const found = requireExercise(args.exercise);
			const name = tidyExerciseName(oneLine(args.new_name));
			if (exerciseKey(name) === "") {
				throw new Error(`'${name.slice(0, 40)}' is not an exercise name: it has no letters or digits.`);
			}
			const taken = store.otherExerciseNamed(db, found.id, name);
			if (taken !== undefined) {
				throw new Error(
					`'${name}' already means ${taken.name}. If ${found.name} and ${taken.name} are one exercise, merge them with propose_merge_exercises; ` +
						"otherwise pick a name that is not taken.",
				);
			}
			if (found.name === name) return { output: text(`The exercise is already called "${name}". Nothing changed.`) };
			const { exercise } = store.renameExercise(db, found.id, name, api.callId, api.now());
			return { output: text(`Renamed "${found.name}" to "${exercise.name}". "${found.name}" still finds it.`) };
		},
	});

	// ----- deleting (rule 3: only with the owner's approval) -----------------------------------------------------------

	/** What the model is told after it asks: nothing has happened yet, and what to say to the owner meanwhile. */
	const approvalResult = (state: ReturnType<typeof approvals.propose>, look: string, done = "deleted") => ({
		output: text(
			`Approval requested (${state.id}): ${state.summary}. ` +
				(state.status === "pending"
					? `Nothing is ${done} yet. Tell the owner to tap Approve on the card. Do not say it is ${done} until they have answered; ${look} shows whether it went through.`
					: `That request is already ${state.status}.`),
		),
		details: asDetails({ type: "approval", actionId: state.id, summary: state.summary, expiresAt: state.expiresAt }),
	});

	const proposeDeleteWeight = defineTool({
		name: "propose_delete_weight",
		deferred: true,
		description:
			"Ask the owner to approve deleting the weighing of one day for good. Nothing is deleted until they tap Approve or reply YES; " +
			"never say it is deleted before they have. To correct a weight, use log_weight with replace: true instead.",
		parameters: Type.Object({ date: Type.String({ description: DAY_HELP }) }),
		replay: "safe",
		async execute(args, api) {
			const day = resolveDay(args.date, localDate(api.now(), timezone));
			const row = store.getWeight(db, day);
			if (row === undefined)
				throw new Error(`No weight is logged for ${dayLabel(day, timezone)}. weight_trend shows what there is.`);
			const state = approvals.propose({
				conversationId: conversationOf(api),
				tool: "delete_weight",
				args: { date: day },
				summary: `Delete the weight logged for ${dayLabel(day, timezone)} (${formatKg(row.kg)} kg)`,
				callId: api.callId,
			});
			return approvalResult(state, "weight_trend");
		},
	});

	const deleteWeight = defineTool({
		name: "delete_weight",
		deferred: true,
		description:
			"Permanently delete the weighing of a day. Blocked unless the owner has approved exactly this deletion: do not call it " +
			"yourself, use propose_delete_weight and wait for their answer. (The assistant normally carries out an approved deletion by itself.)",
		parameters: Type.Object({ date: Type.String({ description: "The day, YYYY-MM-DD, exactly as proposed." }) }),
		replay: "safe",
		async execute(args, api) {
			return { output: text(await approvals.runApproved(conversationOf(api), "delete_weight", { date: args.date })) };
		},
	});

	const proposeDeleteWorkout = defineTool({
		name: "propose_delete_workout",
		deferred: true,
		description:
			"Ask the owner to approve deleting one logged workout, with all its sets, for good. Nothing is deleted until they tap " +
			"Approve or reply YES; never say it is deleted before they have. The id is the one list_workouts shows (w_...).",
		parameters: Type.Object({
			session_id: Type.String({ minLength: 1, description: "The workout's id, as list_workouts shows it (w_...)." }),
		}),
		replay: "safe",
		async execute(args, api) {
			const session = store.getSession(db, args.session_id);
			if (session === undefined)
				throw new Error(
					`No workout '${oneLine(args.session_id).slice(0, 30)}'. list_workouts shows the ids that exist.`,
				);
			const [workout] = workoutSummaries(db, [session], timezone);
			const what =
				workout === undefined
					? ""
					: ` (${workout.exercises.length} ${workout.exercises.length === 1 ? "exercise" : "exercises"}, ${workout.totalSets} sets${workout.volumeKg > 0 ? `, volume ${formatVolume(workout.volumeKg)} kg` : ""})`;
			const state = approvals.propose({
				conversationId: conversationOf(api),
				tool: "delete_workout",
				args: { session_id: session.id },
				summary: `Delete the workout of ${dayLabel(session.date, timezone)}${what}`,
				callId: api.callId,
			});
			return approvalResult(state, "list_workouts");
		},
	});

	const deleteWorkout = defineTool({
		name: "delete_workout",
		deferred: true,
		description:
			"Permanently delete a logged workout and its sets. Blocked unless the owner has approved exactly this deletion: do not call it " +
			"yourself, use propose_delete_workout and wait for their answer. (The assistant normally carries out an approved deletion by itself.)",
		parameters: Type.Object({ session_id: Type.String({ minLength: 1 }) }),
		replay: "safe",
		async execute(args, api) {
			return {
				output: text(
					await approvals.runApproved(conversationOf(api), "delete_workout", { session_id: args.session_id }),
				),
			};
		},
	});

	const proposeMergeExercises = defineTool({
		name: "propose_merge_exercises",
		deferred: true,
		description:
			"Ask the owner to approve merging two exercises that are really one (a misspelt name, a duplicate): every set of `from` moves to " +
			"`into`, and `from` is removed but stays as another name for `into`. Nothing changes until they tap Approve or reply YES; " +
			"never say it is merged before they have. To only change a name, use rename_exercise.",
		parameters: Type.Object({
			from: Type.String({ minLength: 1, description: "The exercise to remove, by name or alias: the wrong one." }),
			into: Type.String({ minLength: 1, description: "The exercise that keeps the sets: the right one." }),
		}),
		replay: "safe",
		async execute(args, api) {
			const from = requireExercise(args.from);
			const into = requireExercise(args.into);
			const plan = store.planMerge(db, from, into);
			const sets = `${plan.sets} ${plan.sets === 1 ? "set" : "sets"}`;
			const workouts = `${plan.sessions} ${plan.sessions === 1 ? "workout" : "workouts"}`;
			const state = approvals.propose({
				conversationId: conversationOf(api),
				tool: "merge_exercises",
				args: { from_id: from.id, into_id: into.id },
				summary: `Merge ${from.name} into ${into.name} (${sets} in ${workouts} move; "${from.name}" stays as another name for it)`,
				callId: api.callId,
			});
			return approvalResult(state, "list_workouts", "merged");
		},
	});

	const mergeExercisesTool = defineTool({
		name: "merge_exercises",
		deferred: true,
		description:
			"Permanently merge one exercise into another. Blocked unless the owner has approved exactly this merge: do not call it " +
			"yourself, use propose_merge_exercises and wait for their answer. (The assistant normally carries out an approved merge by itself.)",
		parameters: Type.Object({ from_id: Type.Integer(), into_id: Type.Integer() }),
		replay: "safe",
		async execute(args, api) {
			return {
				output: text(
					await approvals.runApproved(conversationOf(api), "merge_exercises", {
						from_id: args.from_id,
						into_id: args.into_id,
					}),
				),
			};
		},
	});

	return [
		currentTime,
		logWeight,
		weightTrendTool,
		logWorkout,
		progressTool,
		listWorkouts,
		renameExerciseTool,
		proposeDeleteWeight,
		deleteWeight,
		proposeDeleteWorkout,
		deleteWorkout,
		proposeMergeExercises,
		mergeExercisesTool,
	];
}

/**
 * Deleting a weighing or a workout, and merging two exercises (which removes one), are what the Health agent can do to
 * its log that cannot be undone (rule 3).
 */
export function createApprovalActions(deps: Pick<DomainDeps, "db" | "timezone">): ApprovalAction[] {
	const { db, timezone } = deps;
	return [
		{
			tool: "delete_weight",
			proposeTool: "propose_delete_weight",
			target: (args) => `weight:${String(args.date)}`,
			run: (args) => {
				const date = String(args.date);
				const before = store.getWeight(db, date);
				const deleted = store.deleteWeight(db, date);
				return deleted && before !== undefined
					? `Deleted the weight of ${dayLabel(date, timezone)} (${formatKg(before.kg)} kg).`
					: `The weight of ${dayLabel(date, timezone)} was already gone.`;
			},
		},
		{
			tool: "delete_workout",
			proposeTool: "propose_delete_workout",
			target: (args) => `workout:${String(args.session_id)}`,
			run: (args) => {
				const id = String(args.session_id);
				const session = store.getSession(db, id);
				const deleted = store.deleteSession(db, id);
				return deleted && session !== undefined
					? `Deleted the workout of ${dayLabel(session.date, timezone)}.`
					: `Workout ${id} was already gone.`;
			},
		},
		{
			tool: "merge_exercises",
			proposeTool: "propose_merge_exercises",
			target: (args) => `exercise:${String(args.from_id)}>${String(args.into_id)}`,
			run: (args) => {
				const from = store.getExercise(db, Number(args.from_id));
				const into = store.getExercise(db, Number(args.into_id));
				if (from === undefined) return "That merge was already done: the exercise is gone.";
				if (into === undefined)
					throw new Error(`${from.name} was to be merged into an exercise that is gone. Nothing was changed.`);
				const { sets } = store.mergeExercises(db, from.id, into.id);
				return `Merged ${from.name} into ${into.name}: ${sets} ${sets === 1 ? "set" : "sets"} moved. "${from.name}" still finds it.`;
			},
		},
	];
}
