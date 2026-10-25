import { getAgentRow } from "@assistant/db";
import type { DomainDeps } from "../module.ts";
import { createTimerScheduler, TIMER_TASK_OPTIONS, type TimerScheduler } from "../timers.ts";
import * as store from "./store.ts";
import { INBOX_SYNC_TASK_NAME, type InboxSyncInput, type InboxSyncTask } from "./task.ts";

/**
 * The timers of the accounts' syncs: `inbox_account` is the truth, and a connected account always wants one (its next sync is
 * waiting in the row). The same repair as reminders and daily jobs (`timers.ts`). The timers live in the Inbox agent's
 * conversation, as background tasks: the Stop button does not end them, and they never keep that conversation busy.
 */
export function createInboxScheduler(deps: Pick<DomainDeps, "db" | "harness">, sync: InboxSyncTask): TimerScheduler {
	const { db } = deps;
	const conversationOf = (): number | undefined => getAgentRow(db, "inbox")?.conversationId;

	return createTimerScheduler(deps, {
		label: "Account",
		taskName: INBOX_SYNC_TASK_NAME,
		pending: () =>
			store.pendingTimers(db).map((row) => ({
				id: row.email,
				gen: row.gen,
				// Only for the report of a row that cannot be repaired; `claim` is what refuses an account with no conversation.
				conversationId: conversationOf() ?? 0,
				...(row.durableTaskId === undefined ? {} : { durableTaskId: row.durableTaskId }),
			})),
		claim: (id) => {
			// The conversation first: an account that cannot be placed must not use up a generation on every attempt.
			const conversationId = conversationOf();
			if (conversationId === undefined) {
				throw new Error("The Inbox agent has no conversation yet, so the account's sync has nowhere to run.");
			}
			const taken = store.takeGeneration(db, id);
			return taken === undefined ? undefined : { gen: taken.gen, conversationId };
		},
		attach: (id, gen, durableTaskId) => store.attachDurableTask(db, id, gen, durableTaskId),
		detach: (id, durableTaskId) => store.detachDurableTask(db, id, durableTaskId),
		create: (tx, id, claim) => {
			const input: InboxSyncInput = { account: id, gen: claim.gen };
			return tx.createTask(sync, input, TIMER_TASK_OPTIONS);
		},
		identify: (input) => {
			const stored = input as Partial<InboxSyncInput> | null;
			return typeof stored?.account === "string" && typeof stored.gen === "number"
				? { id: stored.account, gen: stored.gen }
				: undefined;
		},
	});
}
