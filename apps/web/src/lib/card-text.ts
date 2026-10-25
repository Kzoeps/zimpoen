import type { FollowupCard, PersonCard, TaskCard } from "@assistant/shared";
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
	}
}
