import type { DomainDeps } from "../module.ts";
import { createTimerScheduler, TIMER_TASK_OPTIONS, type TimerScheduler } from "../timers.ts";
import * as store from "./store.ts";
import { FOLLOWUP_TASK_NAME, type FollowupInput, type FollowupTask } from "./task.ts";

type Deps = Pick<DomainDeps, "db" | "harness">;

/** The follow-up timers: `followups_item` is the truth, and a follow-up that wants a timer is one still `waiting`. */
export function createFollowupScheduler(deps: Deps, followup: FollowupTask): TimerScheduler {
	const { db } = deps;
	return createTimerScheduler(deps, {
		label: "Follow-up",
		taskName: FOLLOWUP_TASK_NAME,
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
			const input: FollowupInput = { itemId: id, gen: claim.gen, ...(claim.asked ? { asked: true } : {}) };
			return tx.createTask(followup, input, TIMER_TASK_OPTIONS);
		},
		identify: (input) => {
			const stored = input as Partial<FollowupInput> | null;
			return typeof stored?.itemId === "string" && typeof stored.gen === "number"
				? { id: stored.itemId, gen: stored.gen }
				: undefined;
		},
	});
}
