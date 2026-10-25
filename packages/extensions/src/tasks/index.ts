import { defineExtension, section } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { formatLocal } from "../time.ts";
import { createTaskFacts } from "./facts.ts";
import { tasksMigrations } from "./migrations.ts";
import { createReminderTask, type ReminderTask } from "./reminder.ts";
import { createReminderScheduler, type ReminderScheduler } from "./scheduler.ts";
import * as store from "./store.ts";
import { createDeleteTaskAction, createTaskTools } from "./tools.ts";

export const TASKS_EXTENSION_NAME = "tasks";

/** How many upcoming due dates the prompt section lists. */
const NEXT_DUE_LISTED = 3;

/** How many reminders that were already sent the prompt section lists. */
const SENT_LISTED = 5;

/**
 * The prompt section: how many tasks are open, the next few that are due, and the reminders that were sent for tasks
 * that are still open. It is rebuilt before every request but only costs anything when its text changes, so it holds
 * nothing that changes by itself, no clock and no "overdue": two requests with the same task list render the same
 * bytes and share the provider's prompt cache. The model gets the current time from the `current_time` tool when it
 * needs it.
 *
 * The sent reminders are here because the reminder card itself is display-only (a write that carries model text can
 * start a run, see `post.ts`): this is how "snooze it" or "done" finds out what "it" is. It comes from the database, so it
 * is the same after a restart and needs no entry in the conversation.
 */
export function renderTasksSection(deps: Pick<DomainDeps, "db" | "timezone">): string {
	const { open, next } = store.openSummary(deps.db, NEXT_DUE_LISTED);
	if (open === 0) return "No open tasks.";
	const lines = [`Open tasks: ${open}.`];
	if (next.length === 0) lines.push("None of them has a due date.");
	else {
		lines.push("Next due:");
		for (const row of next) {
			const due =
				row.dueAt === undefined
					? ""
					: row.dueAllDay
						? formatLocal(row.dueAt, deps.timezone).replace(/, \d{2}:\d{2}$/, "")
						: formatLocal(row.dueAt, deps.timezone);
			lines.push(`- ${row.id} “${row.title}”, due ${due}`);
		}
	}
	const { total, recent } = store.sentReminders(deps.db, SENT_LISTED);
	if (total > 0) {
		lines.push(
			"Reminders already sent to the owner for tasks that are still open (if they answer one, snooze_reminder moves it, complete_task finishes the task):",
		);
		for (const row of recent) {
			const at = row.remindAt === undefined ? "" : `, reminder was set for ${formatLocal(row.remindAt, deps.timezone)}`;
			lines.push(`- ${row.id} “${row.title}”${at}`);
		}
		if (total > recent.length) lines.push(`(${total - recent.length} older ones not listed; list_tasks shows them.)`);
	}
	return lines.join("\n");
}

export type TasksModule = DomainModule & {
	/** The reminder machinery, for the server's startup repair and for tests. Built from the same deps as the extension. */
	scheduler: (deps: DomainDeps) => ReminderScheduler;
	reminderTask: (deps: DomainDeps) => ReminderTask;
};

/**
 * Per-deps instances. A module's tools, task and scheduler must share one reminder task definition and one scheduler;
 * the server builds a module's pieces once per process, so a small cache keyed by the deps object is all it takes.
 */
const built = new WeakMap<DomainDeps, { reminder: ReminderTask; scheduler: ReminderScheduler }>();

function piecesFor(deps: DomainDeps): { reminder: ReminderTask; scheduler: ReminderScheduler } {
	let pieces = built.get(deps);
	if (pieces === undefined) {
		const reminder = createReminderTask(deps);
		pieces = { reminder, scheduler: createReminderScheduler(deps, reminder) };
		built.set(deps, pieces);
	}
	return pieces;
}

export const tasksModule: TasksModule = {
	name: "tasks",
	migrations: tasksMigrations,
	scheduler: (deps) => piecesFor(deps).scheduler,
	reminderTask: (deps) => piecesFor(deps).reminder,
	extension: (deps) => {
		const { reminder, scheduler } = piecesFor(deps);
		return defineExtension({
			name: TASKS_EXTENSION_NAME,
			tools: createTaskTools(deps, scheduler),
			sections: [section("tasks", () => renderTasksSection(deps))],
			tasks: [reminder],
		});
	},
	actions: (deps) => [createDeleteTaskAction(deps, piecesFor(deps).scheduler)],
	facts: (deps) => [createTaskFacts(deps)],
};

export { REMINDER_PUSH, REMINDER_TASK_NAME, REMINDER_URL, type ReminderInput } from "./reminder.ts";
export type { ReconcileReport, ReminderScheduler } from "./scheduler.ts";
export * as taskStore from "./store.ts";
export { describeTask, toCardItem } from "./tools.ts";
