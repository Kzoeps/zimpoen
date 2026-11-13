import type { Context } from "@earendil-works/chord";
import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { DomainDeps } from "../module.ts";
import { ROUTINE_REQUEST_PREFIX } from "../scheduled-run.ts";
import type { TimerScheduler } from "../timers.ts";
import { decideSlot } from "./slots.ts";
import * as store from "./store.ts";

/** Durable task kind of a routine's timer. Stored in task records, so renaming it orphans timers that are waiting. */
export const ROUTINE_TASK_NAME = "app.routine";

export type RoutineInput = { routine: string; gen: number };
export type RoutineState = { phase: "wait" } | { phase: "run" };
export type RoutineResult =
	| { done: true; slot: number }
	| { done: false; reason: "superseded" }
	| { done: false; reason: "late" | "over_budget"; slot: number };

/** What the run phase decided for the slot it woke for. */
type SlotChoice = { slot: number; next: number; action: "run" | "skip" | "over_budget" };

type Deps = Pick<DomainDeps, "db" | "timezone" | "ask" | "budget" | "warn">;
type Runtime = TaskRuntime<RoutineInput, RoutineState, RoutineResult, object>;

/** The request id of one slot of a routine: what makes a slot run at most once, across restarts. */
export const routineRequestId = (id: string, slot: number): string =>
	`${ROUTINE_REQUEST_PREFIX}${id}:${new Date(slot).toISOString()}`;

/** What the model reads when a routine runs. The prefix also tells the owner, in the thread, that no one typed it. */
export const routineContent = (row: Pick<store.RoutineRow, "id" | "title" | "message">): string =>
	`⏱ Routine "${row.title}" (${row.id}), a scheduled run; the owner did not type this.\n\n${row.message}`;

/**
 * One routine, slot after slot (PLAN §5.4 pattern): sleep until the row's `due_at`, then run the newest due slot as an
 * `ask` whose request id names the routine and the slot. Durable admits a request id once per conversation, so a rerun
 * after a crash asks nothing new. After downtime only the newest due slot counts, and one more than 6 h late is skipped.
 * A routine whose agent is over its weekly token limit skips the slot (a soft limit that only background work obeys).
 */
export function createRoutineTask(deps: Deps, scheduler: () => TimerScheduler | undefined) {
	const { db, timezone } = deps;

	async function current(task: { input: RoutineInput }, runtime: Runtime, context: Context) {
		const row = store.getRoutine(db, task.input.routine);
		if (store.isCurrent(row, task.input)) return row;
		await finish(runtime, { done: false, reason: "superseded" }, context);
		return undefined;
	}

	async function overBudget(agent: string, runtime: Runtime): Promise<boolean> {
		if (deps.budget === undefined) return false;
		try {
			return (await deps.budget.check(agent))?.over === true;
		} catch (error) {
			// A limit that cannot be read must not silence the routine.
			runtime.report(error);
			return false;
		}
	}

	async function choose(row: store.RoutineRow, now: number, runtime: Runtime): Promise<SlotChoice> {
		const decided = decideSlot(row.schedule, row.dueAt, now, timezone);
		if (decided.action === "run" && (await overBudget(row.agent, runtime))) {
			return { slot: decided.slot, next: decided.next, action: "over_budget" };
		}
		return { slot: decided.slot, next: decided.next, action: decided.action };
	}

	return defineTask<RoutineInput, RoutineState, RoutineResult>({
		name: ROUTINE_TASK_NAME,
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				await runtime.sleepUntil(row.dueAt, { phase: "run" }, context);
			},
			run: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				const now = runtime.now();
				// Decided once and kept: a rerun after a crash must handle the same slot the first attempt chose.
				const memoKey = `slot:${row.dueAt}`;
				// Read first, so a rerun does not ask the budget again: only the first attempt decides.
				const decision =
					(await runtime.memo<SlotChoice>(memoKey, context)) ??
					(await runtime.memo<SlotChoice>(memoKey, await choose(row, now, runtime), context));
				const ran = decision.action === "run";
				if (ran) {
					await deps.ask(row.conversationId, {
						content: routineContent(row),
						requestId: routineRequestId(row.id, decision.slot),
					});
				} else {
					deps.warn?.(
						`Routine ${row.id} skipped its slot ${new Date(decision.slot).toISOString()}: ${decision.action}.`,
					);
				}
				if (store.advance(db, row.id, task.input.gen, { slot: decision.slot, ran, next: decision.next, now })) {
					try {
						await scheduler()?.ensureScheduled(row.id);
					} catch (error) {
						// The periodic repair creates it: an active routine always wants a timer.
						runtime.report(error);
					}
				}
				await finish(
					runtime,
					ran
						? { done: true, slot: decision.slot }
						: { done: false, reason: decision.action === "skip" ? "late" : "over_budget", slot: decision.slot },
					context,
				);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

export type RoutineTask = ReturnType<typeof createRoutineTask>;

function finish(runtime: Runtime, result: RoutineResult, context: Context): Promise<void> {
	return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
}
