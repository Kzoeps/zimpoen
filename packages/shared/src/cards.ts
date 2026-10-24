/**
 * What the assistant puts in the thread besides chat messages: cards the UI renders from typed payloads.
 *
 * Two sources, both plain JSON so they survive in Durable's transcript:
 * - tool results carry a {@link ToolCard} in their `details` (the model sees only the result's text);
 * - the server and the reminder task write `app.reminder` and `app.notice` entries without calling the model.
 */

/** Entry kind of a reminder that fired. Its `data` is a {@link ReminderEntryData}. */
export const REMINDER_ENTRY_KIND = "app.reminder";

/** Entry kind of a system notice (an approval's outcome, for now). Its `data` is a {@link NoticeEntryData}. */
export const NOTICE_ENTRY_KIND = "app.notice";

export type ReminderEntryData = {
	/** The task the reminder is about. The card is display-only: the model learns of it from the `tasks` prompt section. */
	taskId: string;
	title: string;
	notes?: string;
	/** When it was due, epoch ms. */
	remindAt: number;
	/** `remindAt` in the owner's time zone, formatted for display. */
	remindAtText: string;
	/** When the assistant posted it, epoch ms. */
	firedAt: number;
};

/** How an approval request ended. A card that has no outcome yet is waiting (or, past `expiresAt`, expired). */
export type ApprovalOutcome = "executed" | "failed" | "denied" | "expired";

export type NoticeEntryData = {
	text: string;
	level: "info" | "error";
	/** Present when the notice reports how an approval request ended: the approval card with this id shows it. */
	approval?: { actionId: string; outcome: ApprovalOutcome; via: "button" | "yes" | "timeout" };
};

export type TaskCardItem = {
	id: string;
	title: string;
	notes?: string;
	status: "open" | "done" | "dropped";
	/** Epoch ms and the same moment formatted in the owner's time zone. */
	dueAt?: number;
	dueText?: string;
	remindAt?: number;
	remindText?: string;
	/** The reminder already fired. */
	remindedAt?: number;
	doneAt?: number;
};

/** The answer to `list_tasks`. `total` counts every match; `tasks` holds at most the page the tool returned. */
export type TaskListCard = {
	type: "task_list";
	heading: string;
	tasks: TaskCardItem[];
	total: number;
};

/** One task after `add_task`, `update_task`, `complete_task` or `snooze_reminder`. */
export type TaskCard = {
	type: "task";
	event: "created" | "updated" | "completed" | "snoozed";
	task: TaskCardItem;
};

/** A destructive action waiting for the owner's answer: Approve, Deny, or a reply of YES (when it is the only one waiting). */
export type ApprovalCard = {
	type: "approval";
	actionId: string;
	/** What would happen, in words: "Delete task “Pay rent”". */
	summary: string;
	/** After this (epoch ms) the request can no longer be approved. */
	expiresAt: number;
};

export type ToolCard = TaskListCard | TaskCard | ApprovalCard;

const CARD_TYPES: readonly string[] = ["task_list", "task", "approval"];

/**
 * The card in a tool result's `details`, or undefined when `details` is anything else (other tools, older entries).
 * Checks the discriminator only: the server is the one writing these, so a deeper check would only hide bugs.
 */
export function toolCardOf(details: unknown): ToolCard | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const type = (details as { type?: unknown }).type;
	return typeof type === "string" && CARD_TYPES.includes(type) ? (details as ToolCard) : undefined;
}
