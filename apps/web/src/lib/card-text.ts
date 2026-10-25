import {
	type FileCard,
	type FollowupCard,
	formatKg,
	type JournalCard,
	type PersonCard,
	type TaskCard,
	type WeightCard,
} from "@assistant/shared";
import type { UiCard } from "./ui-messages.ts";

/** Words for each kind of task event, as the card's heading says them. */
export const TASK_EVENT_LABEL: Record<TaskCard["event"], string> = {
	created: "Task saved",
	updated: "Task updated",
	completed: "Marked done",
	snoozed: "Reminder moved",
};

export const FOLLOWUP_EVENT_LABEL: Record<FollowupCard["event"], string> = {
	created: "Follow-up saved",
	updated: "Follow-up updated",
	agenda_added: "Added to the agenda",
	outcome: "Outcome saved",
	resolved: "Follow-up closed",
};

export const PERSON_EVENT_LABEL: Record<PersonCard["event"], string> = {
	created: "Birthday saved",
	updated: "Person updated",
	wish: "Noted",
};

export const JOURNAL_EVENT_LABEL: Record<JournalCard["event"], string> = {
	saved: "Journal saved",
	shown: "Journal",
};

export const WEIGHT_EVENT_LABEL: Record<WeightCard["event"], string> = {
	logged: "Weight logged",
	updated: "Weight updated",
};

export const FILE_EVENT_LABEL: Record<FileCard["event"], string> = {
	described: "File described",
	registered: "File found",
};

/**
 * One line that says what a card is, for places that cannot show the card itself (a screen reader's list of messages,
 * assistant-ui's own text part). The card component shows the real thing.
 */
export function cardSummary(card: UiCard): string {
	switch (card.type) {
		case "reminder":
			return `Reminder: ${card.data.title}`;
		case "notice":
			return card.data.text;
		case "agenda":
			return `Agenda: ${card.data.title}`;
		case "followup_question":
			return card.data.stage === "nudge"
				? `Due now: ${card.data.title}`
				: `${card.data.stage === "reask" ? "Still open: how" : "How"} did it go? ${card.data.title}`;
		case "birthday":
			return card.data.stage === "remind"
				? `Wish ${card.data.name} a happy birthday`
				: `Did you wish ${card.data.name} a happy birthday?`;
		case "followup":
			return `${FOLLOWUP_EVENT_LABEL[card.event]}: ${card.followup.title}`;
		case "followup_list":
			return `${card.heading}: ${card.total}`;
		case "person":
			return `${PERSON_EVENT_LABEL[card.event]}: ${card.person.name}`;
		case "people_list":
			return `${card.heading}: ${card.total}`;
		case "task":
			return `${TASK_EVENT_LABEL[card.event]}: ${card.task.title}`;
		case "task_list":
			return `${card.heading}: ${card.total}`;
		case "approval":
			return `Approval needed: ${card.summary}`;
		case "daily":
			return card.data.empty === true
				? `Morning briefing, ${card.data.dateText}: nothing today`
				: `${card.data.job === "briefing" ? "Morning briefing" : "Evening wrap-up"}, ${card.data.dateText}`;
		case "journal":
			return `${JOURNAL_EVENT_LABEL[card.event]}: ${card.entries.map((entry) => entry.date).join(", ")}`;
		case "file":
			return `${FILE_EVENT_LABEL[card.event]}: ${card.file.name}`;
		case "file_list":
			return `${card.heading}: ${card.total}`;
		case "weight":
			return `${WEIGHT_EVENT_LABEL[card.event]}: ${formatKg(card.kg)} kg, ${card.day.dateText}`;
		case "weight_chart":
			return `${card.heading}: ${card.summary.entries} ${card.summary.entries === 1 ? "entry" : "entries"}, latest ${formatKg(card.summary.latest.kg)} kg`;
		case "exercise_chart":
			return `${card.heading}: ${card.summary.sessions} ${card.summary.sessions === 1 ? "day" : "days"}`;
		case "workout":
			return `Workout logged: ${card.workout.dateText}, ${card.workout.exercises.map((exercise) => exercise.name).join(", ")}`;
		case "workout_list":
			return `${card.heading}: ${card.total}`;
	}
}
