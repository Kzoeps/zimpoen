import type { DomainDeps } from "../module.ts";
import { createTimerScheduler, TIMER_TASK_OPTIONS, type TimerScheduler } from "../timers.ts";
import * as store from "./store.ts";
import { BIRTHDAY_TASK_NAME, type BirthdayInput, type BirthdayTask } from "./task.ts";

type Deps = Pick<DomainDeps, "db" | "harness">;

/** The birthday timers: `people_person` is the truth, and every person always wants one (their next cycle is waiting). */
export function createBirthdayScheduler(deps: Deps, birthday: BirthdayTask): TimerScheduler {
	const { db } = deps;
	return createTimerScheduler(deps, {
		label: "Person",
		taskName: BIRTHDAY_TASK_NAME,
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
			const input: BirthdayInput = { personId: id, gen: claim.gen };
			return tx.createTask(birthday, input, TIMER_TASK_OPTIONS);
		},
		identify: (input) => {
			const stored = input as Partial<BirthdayInput> | null;
			return typeof stored?.personId === "string" && typeof stored.gen === "number"
				? { id: stored.personId, gen: stored.gen }
				: undefined;
		},
	});
}
