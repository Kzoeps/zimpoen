import type { TaskCard } from "@assistant/shared";
import type { UiCard } from "./ui-messages.ts";

/** Words for each kind of task event, as the card's heading says them. */
export const TASK_EVENT_LABEL: Record<TaskCard["event"], string> = {
	created: "Task saved",
	updated: "Task updated",
	completed: "Marked done",
	snoozed: "Reminder moved",
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
		case "task":
			return `${TASK_EVENT_LABEL[card.event]}: ${card.task.title}`;
		case "task_list":
			return `${card.heading}: ${card.total}`;
		case "approval":
			return `Approval needed: ${card.summary}`;
	}
}
