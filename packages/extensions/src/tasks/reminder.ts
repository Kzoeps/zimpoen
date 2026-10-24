import { type PushPayload, REMINDER_ENTRY_KIND, type ReminderEntryData } from "@assistant/shared";
import type { Context } from "@earendil-works/chord";
import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { DomainDeps } from "../module.ts";
import { formatLocal } from "../time.ts";
import * as store from "./store.ts";

/** Durable task kind of a reminder. Stored in task records, so renaming it orphans reminders that are waiting. */
export const REMINDER_TASK_NAME = "app.reminder";

/** Where a tap on the reminder notification goes. Tasks belong to the PA, whose thread is `/chat/pa`. */
export const REMINDER_URL = "/chat/pa";

/** What the phone shows. Minimal on purpose: a push passes through Google's or Apple's servers. */
export const REMINDER_PUSH: PushPayload = { title: "Reminder", body: "1 reminder", url: REMINDER_URL, tag: "reminder" };

export type ReminderInput = {
	/** The `tasks_item` row to remind about. */
	itemId: string;
	/** The row's `remind_gen` when this task was created. The task fires only while the row still has this one. */
	gen: number;
	/** When to fire, epoch ms on the Harness clock. */
	at: number;
};

export type ReminderState = { phase: "wait" } | { phase: "fire" } | { phase: "notify" };

/** Whether the reminder fired, or why it ended without firing. */
export type ReminderResult = { fired: true } | { fired: false; reason: "superseded" };

type ReminderDeps = Pick<DomainDeps, "db" | "timezone" | "post" | "notify">;
type Runtime = TaskRuntime<ReminderInput, ReminderState, ReminderResult, object>;

/**
 * One reminder (PLAN §5.4): sleep until due, post a card into the conversation, notify the phone. It costs no model
 * tokens at any point: the card is a display-only write, and the model learns that the reminder was sent from the
 * `tasks` prompt section instead (see `renderTasksSection`).
 *
 * The task is a timer; `tasks_item` is the truth. The row says whether a reminder is still wanted and which one (its
 * `remind_gen`), so rescheduling, completing or deleting a task only has to change the row: a task created for an older
 * generation finds out when it wakes, and ends without posting. Aborting it is housekeeping, not correctness. That is
 * what makes two databases safe to keep consistent without a transaction across them.
 *
 * Effects, by phase (a phase reruns from its top after a crash, so each effect must tolerate that):
 * - `wait` sleeps. Nothing to repeat.
 * - `fire` posts the card (the same `requestId` on a rerun finds the same entry, and the `posted` memo makes the rerun
 *   skip even the call), marks the row, and checkpoints into `notify`.
 * - `notify` pushes. A crash between the push and the end of the task sends it again: a duplicate banner (one tag, so
 *   the phone replaces it) is better than a reminder that never reaches the phone.
 */
export function createReminderTask(deps: ReminderDeps) {
	const { db, timezone } = deps;

	return defineTask<ReminderInput, ReminderState, ReminderResult>({
		name: REMINDER_TASK_NAME,
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				if (!store.isCurrentReminder(store.getTask(db, task.input.itemId), task.input)) {
					return finish(runtime, { fired: false, reason: "superseded" }, context);
				}
				await runtime.sleepUntil(task.input.at, { phase: "fire" }, context);
			},

			fire: async (task, runtime, context) => {
				const { itemId, gen } = task.input;
				const alreadyPosted = await runtime.memo<number>("posted", context);
				if (alreadyPosted === undefined) {
					const row = store.getTask(db, itemId);
					if (!store.isCurrentReminder(row, task.input)) {
						return finish(runtime, { fired: false, reason: "superseded" }, context);
					}
					const data: ReminderEntryData = {
						taskId: row.id,
						title: row.title,
						...(row.notes === "" ? {} : { notes: row.notes }),
						remindAt: task.input.at,
						remindAtText: formatLocal(task.input.at, timezone),
						firedAt: runtime.now(),
					};
					const { submissionId } = await deps.post(runtime.conversationId, {
						kind: REMINDER_ENTRY_KIND,
						data,
						requestId: `reminder:${itemId}:${gen}`,
					});
					await runtime.memo("posted", submissionId, context);
				}
				store.markReminded(db, itemId, gen, runtime.now());
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "notify" } }), context);
			},

			notify: async (_task, runtime, context) => {
				try {
					await deps.notify(REMINDER_PUSH);
				} catch (error) {
					// The card is already in the thread; a failed push is reported, never a reason to fault the task.
					runtime.report(error);
				}
				await finish(runtime, { fired: true }, context);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

export type ReminderTask = ReturnType<typeof createReminderTask>;

function finish(runtime: Runtime, result: ReminderResult, context: Context): Promise<void> {
	return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
}
