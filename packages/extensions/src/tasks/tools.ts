import type { TaskCard, TaskCardItem } from "@assistant/shared";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ApprovalAction } from "../approvals/service.ts";
import type { DomainDeps } from "../module.ts";
import { formatLocal, formatLocalDate, isoLocal, parseWhen, weekdayName } from "../time.ts";
import { asDetails, TIME_HELP, text } from "../tool-support.ts";
import type { ReminderScheduler } from "./scheduler.ts";
import * as store from "./store.ts";

type Deps = Pick<DomainDeps, "db" | "timezone" | "approvals">;

const MAX_LISTED = 50;
const DEFAULT_LISTED = 20;
const MAX_SNOOZE_MINUTES = 525_600;

export function toCardItem(row: store.TaskRow, timezone: string): TaskCardItem {
	return {
		id: row.id,
		title: row.title,
		...(row.notes === "" ? {} : { notes: row.notes }),
		status: row.status,
		...(row.dueAt === undefined
			? {}
			: {
					dueAt: row.dueAt,
					dueText: row.dueAllDay ? formatLocalDate(row.dueAt, timezone) : formatLocal(row.dueAt, timezone),
				}),
		...(row.remindAt === undefined ? {} : { remindAt: row.remindAt, remindText: formatLocal(row.remindAt, timezone) }),
		...(row.remindedAt === undefined ? {} : { remindedAt: row.remindedAt }),
		...(row.doneAt === undefined ? {} : { doneAt: row.doneAt }),
	};
}

/** One task as the model reads it: ISO times it can pass straight back to the tools. */
export function describeTask(row: store.TaskRow, timezone: string): string {
	const parts: string[] = [row.status];
	if (row.dueAt !== undefined) {
		parts.push(
			row.dueAllDay
				? `due ${isoLocal(row.dueAt, timezone).slice(0, 10)} (any time that day)`
				: `due ${isoLocal(row.dueAt, timezone)}`,
		);
	}
	if (row.remindAt !== undefined) {
		parts.push(`reminder ${isoLocal(row.remindAt, timezone)}${row.remindedAt === undefined ? "" : " (already sent)"}`);
	}
	if (row.notes !== "") parts.push(`notes: ${row.notes}`);
	return `${row.id} “${row.title}” — ${parts.join("; ")}`;
}

const taskId = Type.String({ minLength: 1, description: "The task's id, as list_tasks shows it (t_...)." });

/**
 * The tools of the PA's task list. Every tool that changes `tasks_item` is replay-safe because it is idempotent by its
 * call id (rule 8): `add_task` through the row's `source_call_id`, the others through the call ledger.
 */
export function createTaskTools(deps: Deps, scheduler: ReminderScheduler): ToolRegistration[] {
	const { db, timezone, approvals } = deps;
	const conversationOf = (api: ToolExecutionApi): number => Number(api.conversationId);

	/** The reminder an `add_task` / `update_task` call asks for, as UTC ms, or undefined for none. Throws what to fix. */
	function resolveReminder(args: { remind_at?: string; remind_in_minutes?: number }, now: number): number | undefined {
		if (args.remind_at !== undefined && args.remind_in_minutes !== undefined) {
			throw new Error("Give either remind_at or remind_in_minutes, not both.");
		}
		if (args.remind_in_minutes !== undefined) return now + args.remind_in_minutes * 60_000;
		if (args.remind_at === undefined) return undefined;
		const parsed = parseWhen(args.remind_at, timezone);
		if (!parsed.ok) throw new Error(`remind_at: ${parsed.error}`);
		if (parsed.dateOnly) {
			throw new Error(
				`remind_at needs a time of day, not only a date. Use for example ${args.remind_at.trim()}T09:00 (the time the owner wants to be reminded).`,
			);
		}
		if (parsed.ms <= now) {
			throw new Error(
				`remind_at ${isoLocal(parsed.ms, timezone)} is in the past; it is ${isoLocal(now, timezone)} now. Pick a time after that, or use remind_in_minutes.`,
			);
		}
		return parsed.ms;
	}

	function resolveDue(value: string): { at: number; allDay: boolean } {
		const parsed = parseWhen(value, timezone);
		if (!parsed.ok) throw new Error(`due: ${parsed.error}`);
		return { at: parsed.ms, allDay: parsed.dateOnly };
	}

	const card = (event: TaskCard["event"], row: store.TaskRow): JsonValue =>
		asDetails({ type: "task", event, task: toCardItem(row, timezone) });

	const addTask = defineTool({
		name: "add_task",
		description:
			"Save a task, optionally with a due date and a reminder. A reminder posts a card in this chat and a notification " +
			"to the owner's phone at that time. Use remind_in_minutes for 'in 10 minutes'; use remind_at for a clock time.",
		parameters: Type.Object({
			title: Type.String({ minLength: 1, maxLength: 200, description: "What has to be done, in a few words." }),
			notes: Type.Optional(Type.String({ maxLength: 2000, description: "Extra detail worth keeping." })),
			due: Type.Optional(
				Type.String({ description: `When it is due. A date alone (2026-10-27) means any time that day. ${TIME_HELP}` }),
			),
			remind_at: Type.Optional(
				Type.String({ description: `When to remind the owner. Needs a time of day. ${TIME_HELP}` }),
			),
			remind_in_minutes: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_SNOOZE_MINUTES,
					description: "Remind the owner this many minutes from now.",
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			// Rule 8: a replay finds what its first run saved before it checks anything. The checks read the clock ("remind_at
			// is in the past"), and a call Durable replays after a crash runs later than the first run did.
			const earlier = store.findByCallId(db, api.callId);
			if (earlier !== undefined) return await created(earlier.id);

			const title = args.title.trim();
			if (title === "") throw new Error("title must not be empty.");
			const now = api.now();
			const remindAt = resolveReminder(args, now);
			const due = args.due === undefined ? undefined : resolveDue(args.due);

			const { row } = store.insertTask(
				db,
				{
					title,
					notes: args.notes?.trim() ?? "",
					...(due === undefined ? {} : { dueAt: due.at }),
					dueAllDay: due?.allDay ?? false,
					...(remindAt === undefined ? {} : { remindAt }),
					conversationId: conversationOf(api),
					createdAt: now,
				},
				api.callId,
			);
			return await created(row.id);
		},
	});

	/** The result of `add_task` for a saved task. Also after a replay: a crash may have come between saving the row and starting its timer. */
	async function created(id: string) {
		await scheduler.ensureScheduled(id);
		const saved = store.requireTask(db, id);
		return { output: text(`Saved ${describeTask(saved, timezone)}`), details: card("created", saved) };
	}

	const listTasks = defineTool({
		name: "list_tasks",
		description: "List the owner's tasks, soonest due first. Shows open tasks unless told otherwise.",
		parameters: Type.Object({
			status: Type.Optional(
				Type.Union([Type.Literal("open"), Type.Literal("done"), Type.Literal("all")], {
					description: "Which tasks. Default open.",
				}),
			),
			due_before: Type.Optional(Type.String({ description: `Only tasks due at or before this. ${TIME_HELP}` })),
			due_after: Type.Optional(Type.String({ description: `Only tasks due at or after this. ${TIME_HELP}` })),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_LISTED, description: `At most this many. Default ${DEFAULT_LISTED}.` }),
			),
		}),
		replay: "safe",
		async execute(args) {
			const status = args.status ?? "open";
			const dueBefore = args.due_before === undefined ? undefined : resolveDue(args.due_before).at;
			const dueAfter = args.due_after === undefined ? undefined : startOfRange(args.due_after);
			const { tasks, total } = store.listTasks(db, {
				status,
				...(dueBefore === undefined ? {} : { dueBefore }),
				...(dueAfter === undefined ? {} : { dueAfter }),
				limit: args.limit ?? DEFAULT_LISTED,
			});
			const heading = `${status === "all" ? "All" : status === "open" ? "Open" : "Done"} tasks`;
			const lines = tasks.map((row) => `- ${describeTask(row, timezone)}`);
			const shown = tasks.length < total ? ` (showing ${tasks.length} of ${total})` : "";
			return {
				output: text(tasks.length === 0 ? "No matching tasks." : `${heading}: ${total}${shown}\n${lines.join("\n")}`),
				details: asDetails({ type: "task_list", heading, tasks: tasks.map((row) => toCardItem(row, timezone)), total }),
			};
		},
	});

	/** `due_after` of a bare date means from the start of that day, whereas `due` means its end. */
	function startOfRange(value: string): number {
		const parsed = parseWhen(value, timezone);
		if (!parsed.ok) throw new Error(`due_after: ${parsed.error}`);
		return parsed.dateOnly ? parsed.dayStartMs : parsed.ms;
	}

	const updateTask = defineTool({
		name: "update_task",
		deferred: true,
		description:
			"Change a task's title, notes, due date or reminder. Send null for due or remind_at to clear it. Changing the reminder replaces the old one.",
		parameters: Type.Object({
			task_id: taskId,
			title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
			notes: Type.Optional(
				Type.String({ maxLength: 2000, description: "Replaces the notes. An empty string clears them." }),
			),
			due: Type.Optional(
				Type.Union([Type.String(), Type.Null()], { description: `New due date, or null to clear. ${TIME_HELP}` }),
			),
			remind_at: Type.Optional(
				Type.Union([Type.String(), Type.Null()], { description: `New reminder time, or null to clear. ${TIME_HELP}` }),
			),
			remind_in_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SNOOZE_MINUTES })),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findChangedByCall(db, api.callId);
			if (earlier?.tool === "update_task") return await updated(earlier.taskId);

			const row = store.requireTask(db, args.task_id);
			const now = api.now();
			const change = changeFrom(args, now);
			if (change.remindAt !== undefined && change.remindAt !== null && row.status !== "open") {
				throw new Error(`Task ${row.id} is ${row.status}, so it cannot get a reminder.`);
			}

			const applied = store.applyChange(db, row.id, change, api.callId, "update_task", now);
			await scheduler.cancel(applied.replacedDurableTaskId);
			return await updated(row.id);
		},
	});

	/** What an `update_task` call asks to change, checked. Throws what to fix. */
	function changeFrom(
		args: {
			title?: string | undefined;
			notes?: string | undefined;
			due?: string | null | undefined;
			remind_at?: string | null | undefined;
			remind_in_minutes?: number | undefined;
		},
		now: number,
	): store.TaskChange {
		const change: store.TaskChange = {};
		if (args.title !== undefined) change.title = args.title.trim();
		if (args.notes !== undefined) change.notes = args.notes.trim();
		if (args.due !== undefined) change.due = args.due === null ? null : resolveDue(args.due);
		if (args.remind_at === null) {
			if (args.remind_in_minutes !== undefined) {
				throw new Error(
					"remind_at is null, which clears the reminder, but remind_in_minutes asks for a new one. Send only one of them.",
				);
			}
			change.remindAt = null;
		} else {
			const remindAt = resolveReminder(
				{
					...(args.remind_at === undefined ? {} : { remind_at: args.remind_at }),
					...(args.remind_in_minutes === undefined ? {} : { remind_in_minutes: args.remind_in_minutes }),
				},
				now,
			);
			if (remindAt !== undefined) change.remindAt = remindAt;
		}
		if (Object.keys(change).length === 0) throw new Error("Nothing to change: give at least one field to update.");
		return change;
	}

	/** The result of `update_task`; a replay lands here too, and starts the timer a crash may have kept from starting. */
	async function updated(id: string) {
		await scheduler.ensureScheduled(id);
		const saved = store.requireTask(db, id);
		return { output: text(`Updated ${describeTask(saved, timezone)}`), details: card("updated", saved) };
	}

	const completeTask = defineTool({
		name: "complete_task",
		description: "Mark a task done. Any reminder it still had is cancelled.",
		parameters: Type.Object({ task_id: taskId }),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findChangedByCall(db, api.callId);
			if (earlier?.tool === "complete_task") return completed(earlier.taskId);

			const row = store.requireTask(db, args.task_id);
			const applied = store.completeTask(db, row.id, api.callId, api.now());
			await scheduler.cancel(applied.replacedDurableTaskId);
			return completed(row.id);
		},
	});

	/** The result of `complete_task`; a replay lands here too. */
	function completed(id: string) {
		const saved = store.requireTask(db, id);
		return { output: text(`Marked done: ${describeTask(saved, timezone)}`), details: card("completed", saved) };
	}

	const snoozeReminder = defineTool({
		name: "snooze_reminder",
		description:
			"Move a task's reminder to a later time, for example after it fired and the owner says 'remind me again in an hour'. " +
			"Give minutes from now, or an exact time.",
		parameters: Type.Object({
			task_id: taskId,
			minutes: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_SNOOZE_MINUTES, description: "Minutes from now." }),
			),
			until: Type.Optional(Type.String({ description: `An exact time to remind. ${TIME_HELP}` })),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findChangedByCall(db, api.callId);
			if (earlier?.tool === "snooze_reminder") return await snoozed(earlier.taskId);

			if ((args.minutes === undefined) === (args.until === undefined)) {
				throw new Error("Give exactly one of minutes or until.");
			}
			const row = store.requireTask(db, args.task_id);
			if (row.status !== "open") throw new Error(`Task ${row.id} is ${row.status}, so there is nothing to snooze.`);
			const now = api.now();
			const remindAt = resolveReminder(
				args.minutes === undefined ? { remind_at: args.until as string } : { remind_in_minutes: args.minutes },
				now,
			);
			// Rule 8: a relative snooze replayed after a crash would move the reminder a second time; the ledger prevents that.
			const applied = store.applyChange(
				db,
				row.id,
				{ remindAt: remindAt as number },
				api.callId,
				"snooze_reminder",
				now,
			);
			await scheduler.cancel(applied.replacedDurableTaskId);
			return await snoozed(row.id);
		},
	});

	/** The result of `snooze_reminder`; a replay lands here too, and starts the timer a crash may have kept from starting. */
	async function snoozed(id: string) {
		await scheduler.ensureScheduled(id);
		const saved = store.requireTask(db, id);
		return { output: text(`Snoozed: ${describeTask(saved, timezone)}`), details: card("snoozed", saved) };
	}

	const proposeDelete = defineTool({
		name: "propose_delete_task",
		deferred: true,
		description:
			"Ask the owner to approve deleting a task for good. Nothing is deleted until they tap Approve or reply YES; " +
			"never say a task is deleted before they have. To merely finish a task use complete_task instead.",
		parameters: Type.Object({ task_id: taskId }),
		replay: "safe",
		async execute(args, api) {
			const row = store.requireTask(db, args.task_id);
			const state = approvals.propose({
				conversationId: conversationOf(api),
				tool: "delete_task",
				args: { task_id: row.id },
				summary: `Delete task “${row.title}”`,
				callId: api.callId,
			});
			const outcome =
				state.status === "pending"
					? "Nothing is deleted yet. Tell the owner to tap Approve on the card. Do not say it is deleted until they have answered; list_tasks shows whether it went through."
					: `That request is already ${state.status}.`;
			return {
				output: text(`Approval requested (${state.id}): ${state.summary}. ${outcome}`),
				details: asDetails({
					type: "approval",
					actionId: state.id,
					summary: state.summary,
					expiresAt: state.expiresAt,
				}),
			};
		},
	});

	const deleteTask = defineTool({
		name: "delete_task",
		deferred: true,
		description:
			"Permanently delete a task. This is blocked unless the owner has approved exactly this deletion: do not call it " +
			"yourself, use propose_delete_task and wait for their answer. (The assistant normally carries out an approved deletion by itself.)",
		parameters: Type.Object({ task_id: taskId }),
		replay: "safe",
		async execute(args, api) {
			const result = await approvals.runApproved(conversationOf(api), "delete_task", { task_id: args.task_id });
			return { output: text(result) };
		},
	});

	const currentTime = defineTool({
		name: "current_time",
		description:
			"The current date, time and weekday in the owner's time zone. Call it before turning 'tomorrow' or 'in two hours' into a date.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			const now = api.now();
			return {
				output: text(`Now: ${isoLocal(now, timezone)} (${weekdayName(now, timezone)}), time zone ${timezone}.`),
			};
		},
	});

	return [currentTime, addTask, listTasks, updateTask, completeTask, snoozeReminder, proposeDelete, deleteTask];
}

/** Deleting a task is the one destructive thing the PA can do to its list (rule 3). */
export function createDeleteTaskAction(deps: Pick<DomainDeps, "db">, scheduler: ReminderScheduler): ApprovalAction {
	return {
		tool: "delete_task",
		proposeTool: "propose_delete_task",
		target: (args) => `task:${String(args.task_id)}`,
		run: async (args) => {
			const id = String(args.task_id);
			const before = store.getTask(deps.db, id);
			const { deleted, durableTaskId } = store.deleteTask(deps.db, id);
			await scheduler.cancel(durableTaskId);
			return deleted && before !== undefined ? `Deleted task “${before.title}”.` : `Task ${id} was already gone.`;
		},
	};
}
