/**
 * What the assistant puts in the thread besides chat messages: cards the UI renders from typed payloads.
 *
 * Two sources, both plain JSON so they survive in Durable's transcript:
 * - tool results carry a {@link ToolCard} in their `details` (the model sees only the result's text);
 * - the server and the timers write `app.*` entries (a reminder, an agenda, a follow-up question, a birthday, a notice)
 *   without calling the model.
 */
import type { JournalCard } from "./daily.ts";
import type { FileCard, FileListCard } from "./files.ts";
import type { ExerciseChartCard, WeightCard, WeightChartCard, WorkoutCard, WorkoutListCard } from "./health.ts";

/** Entry kind of a reminder that fired. Its `data` is a {@link ReminderEntryData}. */
export const REMINDER_ENTRY_KIND = "app.reminder";

/** Entry kind of a system notice (an approval's outcome, for now). Its `data` is a {@link NoticeEntryData}. */
export const NOTICE_ENTRY_KIND = "app.notice";

/** Entry kind of the agenda for a meeting, posted shortly before it. Its `data` is an {@link AgendaEntryData}. */
export const AGENDA_ENTRY_KIND = "app.agenda";

/**
 * Entry kind of what a follow-up posts by itself besides its agenda: the nudge when a commitment is due, the question
 * after it (how did it go?), and that question once more the next morning. Its `data` is a {@link FollowupEntryData}.
 */
export const FOLLOWUP_ENTRY_KIND = "app.followup";

/** Entry kind of a birthday card: the morning reminder or the evening question. Its `data` is a {@link BirthdayEntryData}. */
export const BIRTHDAY_ENTRY_KIND = "app.birthday";

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

export type AgendaEntryData = {
	followupId: string;
	title: string;
	counterpart?: string;
	/** When the meeting starts, epoch ms and in the owner's time zone. */
	eventAt: number;
	eventAtText: string;
	/** The meeting is on the same day the card was posted: the card says "Today's agenda". */
	today: boolean;
	/** The points the owner added, in the order they added them. */
	points: string[];
	firedAt: number;
};

export type FollowupEntryData = {
	followupId: string;
	title: string;
	counterpart?: string;
	context?: string;
	kind: "meeting" | "commitment";
	/**
	 * `nudge`: a commitment is due now. `ask`: how did it go? `reask`: the same question, the morning after, because
	 * nobody answered it. The assistant asks twice at most.
	 */
	stage: "nudge" | "ask" | "reask";
	eventAt: number;
	eventAtText: string;
	/** This one came out of the outcome of an earlier follow-up. */
	chained: boolean;
	/** When the assistant posted the card, epoch ms. */
	firedAt: number;
};

export type BirthdayEntryData = {
	personId: string;
	name: string;
	relation?: string;
	/** `remind`: the morning card, wish them well. `check`: the evening question, did you? */
	stage: "remind" | "check";
	/** The year of the birthday this card is about; `record_wish` takes it. */
	year: number;
	/** The day, in the owner's time zone: "Mon 26 Oct 2026". */
	dateText: string;
	/** The age they turn, when their birth year is known. */
	turns?: number;
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

export type FollowupCardItem = {
	id: string;
	title: string;
	counterpart?: string;
	kind: "meeting" | "commitment";
	status: "waiting" | "asked" | "resolved";
	/** Epoch ms and the same moment formatted in the owner's time zone. */
	eventAt: number;
	eventText: string;
	/** What the owner told about how it went. */
	outcome?: string;
	/** Agenda points, in the order they were added. */
	agenda: string[];
};

/** One follow-up after `add_followup`, `add_agenda_point`, `record_outcome` or `resolve_followup`. */
export type FollowupCard = {
	type: "followup";
	event: "created" | "updated" | "agenda_added" | "outcome" | "resolved";
	followup: FollowupCardItem;
	/** The follow-up an outcome created. */
	next?: FollowupCardItem;
};

/** The answer to `list_followups`, or the meetings an agenda point could belong to (`heading` says which). */
export type FollowupListCard = {
	type: "followup_list";
	heading: string;
	followups: FollowupCardItem[];
	total: number;
};

export type PersonCardItem = {
	id: string;
	name: string;
	relation?: string;
	/** "5 Mar", or "5 Mar 1990" when the birth year is known. */
	birthdayText: string;
	/** The next one: "Fri 5 Mar 2027". */
	nextText: string;
	/** The age they turn then, when the birth year is known. */
	turns?: number;
	notes?: string;
};

/** One person after `add_person`, `update_person` or `record_wish`. */
export type PersonCard = {
	type: "person";
	event: "created" | "updated" | "wish";
	person: PersonCardItem;
	/** For `wish`: what the owner said, and which birthday. */
	wished?: boolean;
	year?: number;
};

export type PeopleListCard = {
	type: "people_list";
	heading: string;
	people: PersonCardItem[];
	total: number;
};

export type ToolCard =
	| TaskListCard
	| TaskCard
	| ApprovalCard
	| FollowupCard
	| FollowupListCard
	| PersonCard
	| PeopleListCard
	| JournalCard
	| FileCard
	| FileListCard
	| WeightCard
	| WeightChartCard
	| WorkoutCard
	| WorkoutListCard
	| ExerciseChartCard;

const CARD_TYPES: readonly string[] = [
	"task_list",
	"task",
	"approval",
	"followup",
	"followup_list",
	"person",
	"people_list",
	"journal",
	"file",
	"file_list",
	"weight",
	"weight_chart",
	"workout",
	"workout_list",
	"exercise_chart",
];

/**
 * The card in a tool result's `details`, or undefined when `details` is anything else (other tools, older entries).
 * Checks the discriminator only: the server is the one writing these, so a deeper check would only hide bugs.
 */
export function toolCardOf(details: unknown): ToolCard | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const type = (details as { type?: unknown }).type;
	return typeof type === "string" && CARD_TYPES.includes(type) ? (details as ToolCard) : undefined;
}
