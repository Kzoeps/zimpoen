/**
 * The Inbox agent's side of the wire: how a mail is triaged, the cards its tools put in the thread, the suggestions it
 * hands to the PA, what the PA's `ask_agent` shows, and what Settings says about Google accounts.
 *
 * Everything here is plain JSON. Text that came from an email (a subject, a sender, a snippet) is untrusted: the server
 * cuts it to one line and a fixed length before it reaches a card, a tool result or a prompt, and the web renders it as text.
 */
import type { AgentId } from "./agents.ts";

/** What a mail is, as far as the owner's attention goes. `important`, `needs_reply` and `follow_up` are what a digest is about. */
export const TRIAGE_CATEGORIES = [
	"important",
	"needs_reply",
	"follow_up",
	"newsletter",
	"notification",
	"promo",
	"personal",
	"finance",
	"other",
] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export function isTriageCategory(value: unknown): value is TriageCategory {
	return (TRIAGE_CATEGORIES as readonly unknown[]).includes(value);
}

/** The categories a digest lists and the morning briefing counts: mail that wants the owner to do something. */
export const ATTENTION_CATEGORIES: readonly TriageCategory[] = ["important", "needs_reply", "follow_up"];

/** Where a triage came from: Jev, the local rules, or the owner (`mark_triage`, which also teaches the rules). */
export type TriageSource = "jev" | "rules" | "owner";

/** Which classifier is in use: Jev (a key is configured) or the local rules. */
export type TriageMode = "jev" | "rules";

/** 1 (can wait) to 5 (now). */
export const URGENCY_RANGE = { min: 1, max: 5 } as const;

export type TriageResult = {
	category: TriageCategory;
	urgency: number;
	/** Someone has to do something about it: read it, reply, decide. */
	needsHuman: boolean;
	source: TriageSource;
	/** One line that says why, for the owner and for debugging: "label IMPORTANT", "sender is on your list". */
	reason?: string;
	/** Rules were used while Jev could not be reached; Jev looks at it again at a later sync. */
	provisional?: true;
};

/** `https://mail.google.com/mail/u/<account>/#all/<thread>`: opens the conversation in the owner's own Gmail. */
export function gmailThreadUrl(account: string, threadId: string): string {
	return `https://mail.google.com/mail/u/${encodeURIComponent(account).replace(/%40/g, "@")}/#all/${encodeURIComponent(threadId)}`;
}

/** One mail as a card shows it. Every text field is already one line of bounded length. */
export type MailItem = {
	/** The local id the Inbox tools take (`read_mail`, `mark_triage`, `suggest_followup`). */
	id: number;
	account: string;
	from: string;
	subject: string;
	/** `Mon 26 Oct, 14:03` in the owner's zone. */
	dateText: string;
	category?: TriageCategory;
	urgency?: number;
	snippet?: string;
	/** Open the conversation in Gmail. */
	url: string;
};

/** The answer to `search_mail`. */
export type MailListCard = { type: "mail_list"; heading: string; mails: MailItem[]; total: number };

/** One mail after `read_mail`: the text is what was stored (bounded), shown as plain text. */
export type MailCard = {
	type: "mail";
	mail: MailItem;
	to?: string;
	text: string;
	/** There is more text than was returned. */
	more: boolean;
};

export type EventItem = {
	id: number;
	account: string;
	title: string;
	/** `Thu 29 Oct, 15:00` or `Thu 29 Oct` for an all-day event. */
	startText: string;
	endText?: string;
	allDay: boolean;
	attendees: string[];
	location?: string;
};

/** The answer to `list_events`. */
export type EventListCard = { type: "event_list"; heading: string; events: EventItem[]; total: number };

/** A line the Inbox tools put in the thread when there is nothing to list: a mail marked, a suggestion made. */
export type InboxNoteCard = { type: "inbox_note"; text: string };

/** What `suggest_followup` made, shown in the Inbox thread. The PA's thread gets {@link SuggestionEntryData}. */
export type SuggestionToolCard = { type: "suggestion_sent"; suggestion: SuggestionSummary };

/** What the PA's `ask_agent` got back (or: is still waiting for). */
export type AgentAnswerCard = {
	type: "agent_answer";
	agent: Exclude<AgentId, "pa">;
	question: string;
	/** `pending`: the agent is still working; its answer arrives as a card of its own. */
	status: "answered" | "pending" | "failed";
	answer?: string;
};

export type InboxCard = MailListCard | MailCard | EventListCard | InboxNoteCard | SuggestionToolCard | AgentAnswerCard;

/** What kind of follow-up the Inbox suggests: the PA's `add_followup` takes the same two kinds. */
export type SuggestionKind = "meeting" | "commitment";

/** `expired`: nobody answered within {@link SUGGESTION_TTL_MS}; it is not offered any more and nothing was added. */
export type SuggestionStatus = "pending" | "added" | "dismissed" | "expired";

/** How long a suggestion waits for the owner's answer: a week. After that Add and Dismiss are refused (the time it names has usually passed). */
export const SUGGESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SuggestionSource = {
	type: "mail" | "event";
	/** The subject or the event's title, for a line under the card. */
	label: string;
	/** For a mail: its thread in Gmail. */
	url?: string;
};

export type SuggestionSummary = {
	id: string;
	kind: SuggestionKind;
	title: string;
	counterpart?: string;
	context?: string;
	/** Epoch ms and the same moment in the owner's zone. */
	at: number;
	atText: string;
	endsAtText?: string;
	source: SuggestionSource;
};

/** Entry kind of what the Inbox agent suggests to the PA ("follow up with X on Thursday: add?"). Its `data` is a {@link SuggestionEntryData}. */
export const SUGGESTION_ENTRY_KIND = "app.suggestion";

export type SuggestionEntryData = SuggestionSummary & {
	firedAt: number;
	/** After this moment (epoch ms) the suggestion can no longer be answered: the card says so. */
	expiresAt: number;
};

/** Entry kind of the question one agent put to another (in the thread that was asked). Its `data` is a {@link DelegatedEntryData}. */
export const DELEGATED_ENTRY_KIND = "app.delegated";

export type DelegatedEntryData = { from: AgentId; question: string; firedAt: number };

/** Entry kind of an answer that came after the PA stopped waiting for it. Its `data` is a {@link LateAnswerEntryData}. */
export const LATE_ANSWER_ENTRY_KIND = "app.agent-answer";

export type LateAnswerEntryData = {
	agent: Exclude<AgentId, "pa">;
	question: string;
	answer: string;
	firedAt: number;
};

/** The owner's answer to a suggestion: the PA is asked to add it, or it is dropped. */
export type SuggestionDecision = "add" | "dismiss";

/** `POST /api/suggestions/:id`. */
export type DecideSuggestionRequest = { decision: SuggestionDecision };

export type SuggestionState = { id: string; status: SuggestionStatus };

/** `needs_reconnect`: Google no longer accepts the stored token (revoked, or a testing-mode token that expired). */
export type GoogleAccountStatus = "connected" | "needs_reconnect" | "disconnected";

export type GoogleAccountSummary = {
	email: string;
	status: GoogleAccountStatus;
	/** The last sync that finished without an error, epoch ms. Absent before the first one. */
	lastSyncAt?: number;
	lastSyncText?: string;
	/** Why the last sync failed, when it did. */
	lastError?: string;
	/** Mails kept for this account. */
	messages: number;
	/**
	 * Mails Gmail would not hand over after several syncs (too large to read, an answer this program cannot store): they are
	 * left out of search and digests, so the owner has to look for them in Gmail. Absent when there are none (the last two weeks).
	 */
	skipped?: { count: number; lastError: string };
};

/** `fake`: a scripted mailbox, nothing leaves this machine (development and tests). `real`: Google's APIs. */
export type GoogleMode = "real" | "fake";

/** `GET /api/settings/google`. */
export type GoogleSettingsResponse = {
	mode: GoogleMode;
	/** `<data>/secrets/google-oauth.json` exists (real mode). Without it no account can be connected. */
	clientConfigured: boolean;
	triage: {
		mode: TriageMode;
		lastError?: string;
		lastErrorText?: string;
		/** Jev failed several times in a row and is not asked until then, epoch ms: mail is sorted by the local rules meanwhile. */
		pausedUntil?: number;
		pausedUntilText?: string;
	};
	/** Minutes between two syncs of one account. */
	syncMinutes: number;
	accounts: GoogleAccountSummary[];
};

/** `DELETE /api/settings/google/accounts`. The address is in the body: it is not a safe thing to put in a path. */
export type DisconnectGoogleRequest = { email: string };
