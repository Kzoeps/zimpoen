import { type EventItem, gmailThreadUrl, type MailItem } from "@assistant/shared";
import { formatLocal, localDate } from "../time.ts";
import type { EventRow, MessageRow } from "./store.ts";
import { clip, describeSender } from "./text.ts";

/** How a mail is shown as one line (to the model and in a card): the sender and the subject are already one bounded line each. */
export function senderOf(row: Pick<MessageRow, "fromName" | "fromAddr">): string {
	return describeSender({ name: row.fromName, address: row.fromAddr });
}

export function mailItem(row: MessageRow, timezone: string, snippetChars = 140): MailItem {
	return {
		id: row.id,
		account: row.account,
		from: senderOf(row),
		subject: row.subject === "" ? "(no subject)" : row.subject,
		dateText: formatLocal(row.date, timezone),
		url: gmailThreadUrl(row.account, row.threadId),
		...(row.triage === undefined ? {} : { category: row.triage.category, urgency: row.triage.urgency }),
		...(row.snippet === "" ? {} : { snippet: clip(row.snippet, snippetChars) }),
	};
}

/** `[12] Thu 29 Oct 2026, 14:03 · work@x.example · From: Name <a@b.example> · Subject: ... · needs_reply (4)`. */
export function mailLine(row: MessageRow, timezone: string, snippetChars = 100): string {
	const item = mailItem(row, timezone, snippetChars);
	const triage = item.category === undefined ? "not classified yet" : `${item.category} (urgency ${item.urgency})`;
	return [
		`[${item.id}] ${item.dateText}`,
		item.account,
		`From: ${item.from}`,
		`Subject: ${item.subject}`,
		triage,
		...(item.snippet === undefined ? [] : [`Snippet: ${item.snippet}`]),
	].join(" · ");
}

/** How the end of a span reads beside its start: the time alone when it ends on the day it starts, the whole stamp otherwise. */
export function endTextOf(startMs: number, endMs: number, timezone: string): string {
	const end = formatLocal(endMs, timezone);
	return localDate(startMs, timezone) === localDate(endMs, timezone) ? end.slice(-5) : end;
}

export function eventItem(row: EventRow, timezone: string): EventItem {
	const startText = row.allDay
		? formatLocal(row.startAt, timezone).replace(/, \d{2}:\d{2}$/, "")
		: formatLocal(row.startAt, timezone);
	return {
		id: row.id,
		account: row.account,
		title: row.title,
		startText,
		allDay: row.allDay,
		attendees: row.attendees,
		...(row.allDay ? {} : { endText: endTextOf(row.startAt, row.endAt, timezone) }),
		...(row.location === "" ? {} : { location: row.location }),
	};
}

/** `[5] Thu 29 Oct 2026, 15:00 to 16:00 · Title · with a@x.example, b@y.example · at Place · account`. */
export function eventLine(row: EventRow, timezone: string): string {
	const item = eventItem(row, timezone);
	return [
		`[${item.id}] ${item.startText}${item.endText === undefined ? (item.allDay ? " (all day)" : "") : ` to ${item.endText}`}`,
		item.title,
		...(item.attendees.length === 0 ? [] : [`with ${item.attendees.join(", ")}`]),
		...(item.location === undefined ? [] : [`at ${item.location}`]),
		item.account,
	].join(" · ");
}
