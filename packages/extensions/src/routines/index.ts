import { defineExtension } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { createTimerScheduler, TIMER_TASK_OPTIONS, type TimerScheduler } from "../timers.ts";
import { routinesMigrations } from "./migrations.ts";
import * as store from "./store.ts";
import { createRoutineTask, ROUTINE_TASK_NAME, type RoutineInput, type RoutineTask } from "./task.ts";
import { createRoutineAction, createRoutineTools } from "./tools.ts";

export const ROUTINES_EXTENSION_NAME = "routines";

export type RoutinesModule = DomainModule & {
	/** The timer machinery, for the server's startup repair and periodic sweep. */
	scheduler: (deps: DomainDeps) => TimerScheduler;
	routineTask: (deps: DomainDeps) => RoutineTask;
};

const built = new WeakMap<DomainDeps, { task: RoutineTask; scheduler: TimerScheduler }>();

function piecesFor(deps: DomainDeps): { task: RoutineTask; scheduler: TimerScheduler } {
	let pieces = built.get(deps);
	if (pieces === undefined) {
		// The task starts the next slot's timer, and the scheduler needs the task: the task looks the scheduler up when it runs.
		let scheduler: TimerScheduler | undefined;
		const task = createRoutineTask(deps, () => scheduler);
		scheduler = createRoutineScheduler(deps, task);
		pieces = { task, scheduler };
		built.set(deps, pieces);
	}
	return pieces;
}

/** `routines_routine` is the truth; an active routine always wants a timer (PLAN §5.4). */
function createRoutineScheduler(deps: Pick<DomainDeps, "db" | "harness">, task: RoutineTask): TimerScheduler {
	const { db } = deps;
	return createTimerScheduler(deps, {
		label: "Routine",
		taskName: ROUTINE_TASK_NAME,
		pending: () =>
			store.pendingTimers(db).map((row) => ({
				id: row.id,
				gen: row.gen,
				conversationId: row.conversationId,
				...(row.durableTaskId === undefined ? {} : { durableTaskId: row.durableTaskId }),
			})),
		claim: (id) => store.takeGeneration(db, id),
		attach: (id, gen, durableTaskId) => store.attachDurableTask(db, id, gen, durableTaskId),
		detach: (id, durableTaskId) => store.detachDurableTask(db, id, durableTaskId),
		create: (tx, id, claim) => {
			const input: RoutineInput = { routine: id, gen: claim.gen };
			return tx.createTask(task, input, TIMER_TASK_OPTIONS);
		},
		identify: (input) => {
			const stored = input as Partial<RoutineInput> | null;
			return typeof stored?.routine === "string" && typeof stored.gen === "number"
				? { id: stored.routine, gen: stored.gen }
				: undefined;
		},
	});
}

/**
 * Agent-created recurring routines (upgrade plan §5, phase 1c). Exported as a module so spawned bots can be given it
 * later; today only the PA has it.
 */
export const routinesModule: RoutinesModule = {
	name: "routines",
	migrations: routinesMigrations,
	scheduler: (deps) => piecesFor(deps).scheduler,
	routineTask: (deps) => piecesFor(deps).task,
	actions: (deps) => [createRoutineAction(deps, () => piecesFor(deps).scheduler)],
	extension: (deps) => {
		const { task } = piecesFor(deps);
		return defineExtension({
			name: ROUTINES_EXTENSION_NAME,
			tools: createRoutineTools(deps, () => piecesFor(deps).scheduler),
			tasks: [task],
		});
	},
};

export {
	decideSlot,
	describeSchedule,
	isoWeekday,
	LATE_LIMIT_MS,
	latestSlotAtOrBefore,
	nextSlotAfter,
	parseDays,
	type RoutineSchedule,
	type SlotDecision,
} from "./slots.ts";
export * as routineStore from "./store.ts";
export { ROUTINE_TASK_NAME, type RoutineInput, routineContent, routineRequestId } from "./task.ts";
export { describeRoutine, MAX_ACTIVE_ROUTINES } from "./tools.ts";
