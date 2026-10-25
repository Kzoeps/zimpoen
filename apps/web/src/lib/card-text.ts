import {
	type AgentId,
	type DailyJobId,
	type FileCard,
	type FollowupCard,
	formatKg,
	formatMoney,
	type JournalCard,
	type PersonCard,
	type TaskCard,
	type TriageCategory,
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

/** What each daily job is called, with its icon: the card's heading and the chip over the answer. */
export const DAILY_LABEL: Record<DailyJobId, { icon: string; name: string }> = {
	briefing: { icon: "☀️", name: "Morning briefing" },
	wrapup: { icon: "🌙", name: "Evening wrap-up" },
	digest_midday: { icon: "📥", name: "Inbox digest" },
	digest_evening: { icon: "📥", name: "Inbox digest" },
};

/** The inbox digests are the jobs the Inbox agent writes: their card lists mail, not tasks. */
export const isDigest = (job: DailyJobId): boolean => job === "digest_midday" || job === "digest_evening";

/** What a mail's category is called on its chip. */
export const TRIAGE_LABEL: Record<TriageCategory, string> = {
	important: "important",
	needs_reply: "needs a reply",
	follow_up: "follow-up",
	newsletter: "newsletter",
	notification: "notification",
	promo: "promo",
	personal: "personal",
	finance: "money",
	other: "other",
};

/** The agents a question can be put to, as a sentence names them ("asked the Inbox"). */
export const ASKED_AGENT_LABEL: Record<Exclude<AgentId, "pa">, string> = {
	inbox: "the Inbox",
	health: "the Health agent",
	accountant: "the Accountant",
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
		case "daily": {
			const name = DAILY_LABEL[card.data.job].name;
			if (card.data.degraded !== undefined)
				return `${name}, ${card.data.dateText} (plain version: the weekly token limit was reached)`;
			if (card.data.empty !== true) return `${name}, ${card.data.dateText}`;
			return `${name}, ${card.data.dateText}: nothing ${isDigest(card.data.job) ? "new" : "today"}`;
		}
		case "memory":
			return `${card.event === "saved" ? "Remembered" : "Already remembered"}: ${card.fact.text}`;
		case "memory_list":
			return `${card.heading}: ${card.total}`;
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
		case "txn": {
			const [first] = card.txns;
			if (first === undefined) return "Entry recorded";
			const what = first.kind === "transfer" ? "Transfer" : first.kind === "income" ? "Income" : "Expense";
			return `${what} recorded: ${formatMoney(Math.abs(first.amountMinor), first.currency)}${first.merchant === undefined ? "" : `, ${first.merchant}`}`;
		}
		case "txn_list":
			return `${card.heading}: ${card.total}`;
		case "balances":
			return `Balances: ${card.accounts.length} ${card.accounts.length === 1 ? "account" : "accounts"}`;
		case "spending":
			return `${card.heading}, ${card.rangeText}: ${formatMoney(card.totalMinor, card.currency)}`;
		case "import_preview":
			return `Import preview: ${card.rows} rows into ${card.account}${(card.matchCount ?? 0) > 0 ? `, ${card.matchCount} left out` : ""}`;
		case "import_result":
			return `Imported ${card.inserted} entries into ${card.account}`;
		case "split":
			return `Split: ${card.title}, ${formatMoney(card.totalMinor, card.currency)}`;
		case "who_owes":
			return `${card.heading}: ${card.debts.length}`;
		case "invoice":
			return `${card.event === "preview" ? "Invoice preview" : "Invoice"} ${card.invoice.number}: ${formatMoney(card.invoice.amountMinor, card.invoice.currency)}`;
		case "invoice_list":
			return `${card.heading}: ${card.total}`;
		case "accountant_note":
			return `${card.heading}${card.lines[0] === undefined ? "" : `: ${card.lines[0]}`}`;
		case "mail_list":
			return `${card.heading}: ${card.total}`;
		case "mail":
			return `Mail from ${card.mail.from}: ${card.mail.subject}`;
		case "event_list":
			return `${card.heading}: ${card.total}`;
		case "inbox_note":
			return card.text;
		case "suggestion_sent":
			return `Suggested to the assistant: ${card.suggestion.title}`;
		case "agent_answer":
			return `${card.status === "answered" ? "Answer from" : "Asked"} ${ASKED_AGENT_LABEL[card.agent]}: ${card.question}`;
		case "suggestion":
			return `The Inbox suggests: ${card.data.title}`;
		case "delegated":
			return `Asked by the assistant: ${card.data.question}`;
		case "late_answer":
			return `Answer from ${ASKED_AGENT_LABEL[card.data.agent]}: ${card.data.question}`;
	}
}
