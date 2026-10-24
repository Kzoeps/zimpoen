import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { conversationIdOf, type DomainDeps } from "../module.ts";
import { REMINDER_TASK_NAME, type ReminderInput, type ReminderTask } from "./reminder.ts";
import * as store from "./store.ts";

const context = BACKGROUND_CONTEXT;

/** What {@link ReminderScheduler.reconcile} did. */
export type ReconcileReport = {
	/** The tasks that got a new timer. */
	rescheduled: string[];
	/** The tasks it could not repair, and why. It carries on with the others instead of stopping the server. */
	failures: Array<{ itemId: string; conversationId: number; message: string }>;
};

export type ReminderScheduler = {
	/**
	 * Make sure a task whose reminder is wanted has a live Durable timer, creating one if it has none. Does nothing for a
	 * task that does not want one (done, deleted, no reminder, already fired) or already has one, so it is safe to call
	 * after every change, and again after a crash.
	 */
	ensureScheduled(itemId: string): Promise<void>;
	/** Abort the timer of a reminder that was replaced, completed or deleted. Best effort: a stale timer ends itself. */
	cancel(durableTaskId: number | undefined): Promise<void>;
	/**
	 * Repair, at start and then every few minutes. `tasks_item` is in a database that syncs every commit and Durable's
	 * is not, so after a power cut a row can want a reminder whose timer was lost; a crash can leave a timer the row does
	 * not point at; and a timer that Durable ended (faulted, aborted) leaves the row pointing at a task that will never
	 * fire. Re-create the first and the last, re-link the second. Touches only rows that still want a reminder, one at a
	 * time: a row that cannot be repaired is reported and the rest are still done.
	 */
	reconcile(): Promise<ReconcileReport>;
};

type Deps = Pick<DomainDeps, "db" | "harness">;

export function createReminderScheduler(deps: Deps, reminder: ReminderTask): ReminderScheduler {
	const { db } = deps;

	async function ensureScheduled(itemId: string): Promise<void> {
		const claim = store.takeGeneration(db, itemId);
		if (claim === undefined) return;

		const conversation = await deps.harness().conversation(conversationIdOf(claim.conversationId), context);
		if (conversation === undefined) {
			throw new Error(
				`Task ${itemId} belongs to conversation ${claim.conversationId}, which durable.sqlite does not have. ` +
					"The two databases are out of sync.",
			);
		}
		const input: ReminderInput = { itemId, gen: claim.gen, at: claim.remindAt };
		// Conversation-owned and in the background: the user's Stop button (a conversation abort) must not kill a reminder
		// that is only waiting for its time, and it must not keep the conversation "busy" for days.
		const durableId = await conversation.commit(
			(tx) => tx.createTask(reminder, input, { ownership: { kind: "conversation" }, background: true }),
			context,
		);
		if (!store.attachDurableTask(db, itemId, claim.gen, Number(durableId))) {
			// The row moved on while the task was being created (rescheduled, completed, deleted): this timer is stale.
			await cancel(Number(durableId));
		}
	}

	async function cancel(durableTaskId: number | undefined): Promise<void> {
		if (durableTaskId === undefined) return;
		try {
			await deps.harness().abortTask(durableTaskId as TaskId, context);
		} catch {
			// Unknown or already finished. Either way nothing is waiting any more, and a stale timer ends itself when it wakes.
		}
	}

	async function liveTimers(): Promise<Array<{ id: number; input: ReminderInput }>> {
		const { tasks } = await deps.harness().inspect(context);
		const timers: Array<{ id: number; input: ReminderInput }> = [];
		for (const { record } of tasks) {
			if (record.kind !== REMINDER_TASK_NAME || record.abortRequested) continue;
			const input = record.input as Partial<ReminderInput> | null;
			if (typeof input?.itemId === "string" && typeof input.gen === "number" && typeof input.at === "number") {
				timers.push({ id: Number(record.id), input: { itemId: input.itemId, gen: input.gen, at: input.at } });
			}
		}
		return timers;
	}

	async function reconcile(): Promise<ReconcileReport> {
		const timers = await liveTimers();
		const report: ReconcileReport = { rescheduled: [], failures: [] };
		for (const row of store.pendingReminders(db)) {
			try {
				const timer = timers.find(
					(candidate) => candidate.input.itemId === row.id && candidate.input.gen === row.remindGen,
				);
				if (timer !== undefined) {
					// A crash between creating the timer and recording it leaves the row without the link; restore it.
					if (row.durableTaskId === undefined) store.attachDurableTask(db, row.id, row.remindGen, timer.id);
					continue;
				}
				// No live timer of this generation. If the row still points at one, Durable ended it (a power cut took it,
				// it faulted, it was aborted): forget it, so that a new one can be made.
				if (row.durableTaskId !== undefined) store.detachDurableTask(db, row.id, row.durableTaskId);
				await ensureScheduled(row.id);
				report.rescheduled.push(row.id);
			} catch (error) {
				report.failures.push({
					itemId: row.id,
					conversationId: row.conversationId,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return report;
	}

	return { ensureScheduled, cancel, reconcile };
}
