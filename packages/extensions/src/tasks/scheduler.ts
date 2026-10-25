import type { DomainDeps } from "../module.ts";
import { createTimerScheduler, TIMER_TASK_OPTIONS, type TimerScheduler } from "../timers.ts";
import { REMINDER_TASK_NAME, type ReminderInput, type ReminderTask } from "./reminder.ts";
import * as store from "./store.ts";

export type { ReconcileReport } from "../timers.ts";

/** Creates the timer of a task's reminder, aborts a replaced one and repairs the pairing at start. See {@link TimerScheduler}. */
export type ReminderScheduler = TimerScheduler;

type Deps = Pick<DomainDeps, "db" | "harness">;

/** The reminder timers: `tasks_item` is the truth, and a task that wants a reminder is one that is open and has not fired. */
export function createReminderScheduler(deps: Deps, reminder: ReminderTask): ReminderScheduler {
	const { db } = deps;
	return createTimerScheduler(deps, {
		label: "Task",
		taskName: REMINDER_TASK_NAME,
		pending: () =>
			store.pendingReminders(db).map((row) => ({
				id: row.id,
				gen: row.remindGen,
				conversationId: row.conversationId,
				...(row.durableTaskId === undefined ? {} : { durableTaskId: row.durableTaskId }),
			})),
		claim: (id) => store.takeGeneration(db, id),
		attach: (id, gen, durableTaskId) => store.attachDurableTask(db, id, gen, durableTaskId),
		detach: (id, durableTaskId) => store.detachDurableTask(db, id, durableTaskId),
		create: (tx, id, claim) => {
			const input: ReminderInput = { itemId: id, gen: claim.gen, at: claim.remindAt };
			return tx.createTask(reminder, input, TIMER_TASK_OPTIONS);
		},
		identify: (input) => {
			const stored = input as Partial<ReminderInput> | null;
			return typeof stored?.itemId === "string" && typeof stored.gen === "number" && typeof stored.at === "number"
				? { id: stored.itemId, gen: stored.gen }
				: undefined;
		},
	});
}
