import type { DomainDeps } from "../module.ts";
import { createTimerScheduler, TIMER_TASK_OPTIONS, type TimerScheduler } from "../timers.ts";
import { jobOf } from "./jobs.ts";
import * as store from "./store.ts";
import { type ConversationOf, DAILY_TASK_NAME, type DailyInput, type DailyTask } from "./task.ts";

type Deps = Pick<DomainDeps, "db" | "harness">;

/**
 * The timers of the daily jobs: `schedule_daily` is the truth, and a job that is on always wants one (its next run is
 * waiting in the row). The same repair as reminders, meetings and birthdays (`timers.ts`).
 */
export function createDailyScheduler(deps: Deps, daily: DailyTask, conversationOf: ConversationOf): TimerScheduler {
	const { db } = deps;

	/** Where a job's timer lives: the conversation of the agent the job writes to. */
	function conversationFor(job: string): number {
		const definition = jobOf(job);
		const conversationId = definition === undefined ? undefined : conversationOf(definition);
		if (conversationId === undefined) {
			throw new Error(
				`The daily job '${job}' posts into the conversation of agent '${definition?.agent ?? "?"}', which does not exist yet.`,
			);
		}
		return conversationId;
	}

	const knownConversation = (job: string): number | undefined => {
		const definition = jobOf(job);
		return definition === undefined ? undefined : conversationOf(definition);
	};

	return createTimerScheduler(deps, {
		label: "Daily job",
		taskName: DAILY_TASK_NAME,
		pending: () =>
			store.pendingTimers(db).map((row) => ({
				id: row.job,
				gen: row.gen,
				// Only for the report of a row that cannot be repaired; `claim` is what refuses a job with no conversation.
				conversationId: knownConversation(row.job) ?? 0,
				...(row.durableTaskId === undefined ? {} : { durableTaskId: row.durableTaskId }),
			})),
		claim: (id) => {
			// The conversation first: a job that cannot be placed must not use up a generation on every attempt.
			const conversationId = conversationFor(id);
			const taken = store.takeGeneration(db, id);
			return taken === undefined ? undefined : { gen: taken.gen, conversationId };
		},
		attach: (id, gen, durableTaskId) => store.attachDurableTask(db, id, gen, durableTaskId),
		detach: (id, durableTaskId) => store.detachDurableTask(db, id, durableTaskId),
		create: (tx, id, claim) => {
			const input: DailyInput = { job: id, gen: claim.gen };
			return tx.createTask(daily, input, TIMER_TASK_OPTIONS);
		},
		identify: (input) => {
			const stored = input as Partial<DailyInput> | null;
			return typeof stored?.job === "string" && typeof stored.gen === "number"
				? { id: stored.job, gen: stored.gen }
				: undefined;
		},
	});
}
