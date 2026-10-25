import {
	type AccountantCard,
	AGENDA_ENTRY_KIND,
	type AgendaEntryData,
	type ApprovalOutcome,
	type AssistantChatMessage,
	type AttachmentRef,
	BIRTHDAY_ENTRY_KIND,
	type BirthdayEntryData,
	DAILY_ENTRY_KIND,
	type DailyEntryData,
	DELEGATED_ENTRY_KIND,
	type DelegatedEntryData,
	type EntryRecord,
	type ExerciseChartCard,
	type FileCard,
	type FileListCard,
	FOLLOWUP_ENTRY_KIND,
	type FollowupCard,
	type FollowupEntryData,
	type FollowupListCard,
	type ImportPreviewCard,
	type InboxCard,
	isDailyJobId,
	type JournalCard,
	LATE_ANSWER_ENTRY_KIND,
	type LateAnswerEntryData,
	type MemoryCard,
	type MemoryListCard,
	NOTICE_ENTRY_KIND,
	type NoticeEntryData,
	type PeopleListCard,
	type PersonCard,
	REMINDER_ENTRY_KIND,
	type ReminderEntryData,
	SUGGESTION_ENTRY_KIND,
	type SuggestionEntryData,
	splitAttachments,
	type TaskCard,
	type TaskListCard,
	toolCardOf,
	type WeightCard,
	type WeightChartCard,
	type WorkoutCard,
	type WorkoutListCard,
} from "@assistant/shared";
import { explainUnanswered, type ThreadState } from "./thread-state.ts";

/**
 * What the thread shows, one item per bubble or card. Derived from `ThreadState`; assistant-ui gets it through
 * `convertMessage`. Chat messages (`pi.user`, `pi.assistant`) become bubbles; reminders, notices and the typed results
 * of tools become cards; system-prompt entries never reach the client and every other kind is ignored.
 */

export type UiPart = { type: "text"; text: string } | { type: "reasoning"; text: string };

export type UiAssistantStatus =
	| { type: "running" }
	| { type: "complete" }
	| { type: "stopped" }
	/** Stopped by a restart, not by the user: another answer to the same message follows. */
	| { type: "interrupted" }
	| { type: "cut-off" }
	| { type: "error"; message: string };

/** How an approval card stands, worked out from the notices that came after it. */
export type ApprovalCardState =
	| { status: "pending" }
	/** Its 24 hours passed without an answer. The server refuses a late answer. */
	| { status: "expired" }
	| { status: Exclude<ApprovalOutcome, "expired">; text: string; via: "button" | "yes" | "timeout" };

/** How a suggestion card of the Inbox stands, worked out from the notices that came after it. */
export type SuggestionCardState =
	| { status: "pending" }
	/** A week passed without an answer. The server refuses a late one. */
	| { status: "expired" }
	/** The owner pressed Add (the PA was asked) or Dismiss. `text` is the notice the server wrote for it. */
	| { status: "added" | "dismissed"; text: string };

/** A non-chat item of the thread. */
export type UiCard =
	| { type: "reminder"; data: ReminderEntryData }
	| { type: "notice"; data: NoticeEntryData }
	/** The agenda of a meeting, posted shortly before it. */
	| { type: "agenda"; data: AgendaEntryData }
	/** What a follow-up says by itself: a commitment is due, how did it go? (and once more the next morning). */
	| { type: "followup_question"; data: FollowupEntryData; answered?: true }
	/** The morning reminder or the evening question of a birthday. */
	| { type: "birthday"; data: BirthdayEntryData; answered?: true }
	/** The request of the morning briefing or the evening wrap-up with the facts it carried, or the card that stands in for a briefing with none. */
	| { type: "daily"; data: DailyEntryData }
	| JournalCard
	| FileCard
	| FileListCard
	| TaskListCard
	| TaskCard
	| FollowupCard
	| FollowupListCard
	| PersonCard
	| PeopleListCard
	| WeightCard
	| WeightChartCard
	| ExerciseChartCard
	| WorkoutCard
	| WorkoutListCard
	/** The Accountant's cards (ledger, splits, invoices). An import preview is `answered` once the import was confirmed. */
	| Exclude<AccountantCard, { type: "import_preview" }>
	| (ImportPreviewCard & { answered?: boolean })
	/** The Inbox agent's cards: mail, events, a note, a suggestion it made, and what the PA's `ask_agent` got back. */
	| InboxCard
	/** What `remember` kept and what `recall` found. */
	| MemoryCard
	| MemoryListCard
	/** In the PA's thread: the Inbox suggests a follow-up. The owner's Add or Dismiss settles it (`state`). */
	| { type: "suggestion"; data: SuggestionEntryData; state: SuggestionCardState }
	/** In a specialist's thread: the question the PA put to this agent. */
	| { type: "delegated"; data: DelegatedEntryData }
	/** In the PA's thread: the answer of an agent the PA had stopped waiting for. */
	| { type: "late_answer"; data: LateAnswerEntryData }
	| {
			type: "approval";
			actionId: string;
			summary: string;
			expiresAt: number;
			buttonOnly?: true;
			state: ApprovalCardState;
	  };

/** A file a message of the owner's carries, read back from the line that references it. */
export type UiAttachment = AttachmentRef & { sizeText: string };

export type UiMessage =
	| {
			id: string;
			role: "user";
			createdAt: number;
			/** What the owner wrote, without the lines that reference their files. */
			text: string;
			files?: UiAttachment[];
			/** Why this message was never answered, when it was not: shown under it, also after a reload. */
			notAnswered?: string;
	  }
	| {
			id: string;
			role: "assistant";
			createdAt: number;
			parts: UiPart[];
			status: UiAssistantStatus;
			/** What this answer is, when it answers the morning briefing or the evening wrap-up: "Morning briefing". */
			chip?: string;
	  }
	| { id: string; role: "system"; createdAt: number; card: UiCard };

const cache = new WeakMap<EntryRecord, UiMessage | null>();

/**
 * All messages of a thread, oldest first, the one being written last. `now` decides which approval requests have
 * expired (their entries are immutable, so the card cannot say so itself).
 */
export function toUiMessages(
	state: Pick<ThreadState, "entries" | "draft" | "unanswered">,
	now: number = Date.now(),
): UiMessage[] {
	const explanations = explanationsByEntry(state.unanswered);
	const messages: UiMessage[] = [];
	const seen = new Set<string>();
	const push = (message: UiMessage | null | undefined): void => {
		if (message === null || message === undefined) return;
		// Two answers can never share a request timestamp in practice; keep ids unique if one ever does.
		const unique = seen.has(message.id) ? { ...message, id: `${message.id}-${messages.length}` } : message;
		seen.add(unique.id);
		messages.push(unique);
	};
	for (const entry of state.entries) push(withExplanation(entryToMessage(entry), explanations.get(entry.id)));
	if (state.draft !== undefined) push(assistantToMessage(state.draft, { type: "running" }, "draft"));
	const approved = resolveApprovals(markInterrupted(messages), approvalOutcomes(state.entries), now);
	return chipAnswers(resolveAnswers(resolveSuggestions(approved, suggestionOutcomes(state.entries), now)));
}

/** What the chip above an answer says, by the job whose request it answers. */
export const DAILY_CHIP: Record<DailyEntryData["job"], string> = {
	briefing: "☀️ Morning briefing",
	wrapup: "🌙 Evening wrap-up",
	digest_midday: "📥 Inbox digest",
	digest_evening: "📥 Inbox digest",
};

/**
 * The briefing, the wrap-up and the inbox digests are requests the assistant makes by itself, and the agent's answer is an
 * ordinary message. To tell it from a reply to something the owner said, the first answer after the request carries a chip
 * with the job's name (the digest's request is in the Inbox thread, the others' in the PA's). Another message of the owner's ends it: what follows is a conversation. Cards in between (a task list the PA
 * looked up for the briefing, a reminder that fired meanwhile) do not: the answer is still the briefing's.
 */
function chipAnswers(messages: UiMessage[]): UiMessage[] {
	let pending: string | undefined;
	return messages.map((message) => {
		if (message.role === "system") {
			if (message.card.type === "daily") {
				pending = message.card.data.empty === true ? undefined : DAILY_CHIP[message.card.data.job];
			}
			return message;
		}
		if (message.role === "user") {
			pending = undefined;
			return message;
		}
		const chip = pending;
		pending = undefined;
		return chip === undefined ? message : { ...message, chip };
	});
}

/**
 * Mark the questions the thread shows as answered: a follow-up question once a later card records its outcome or closes
 * it, an evening birthday question once a later card records the wish for that birthday ("not yet" is an answer too), an
 * import preview once a later card says that import was confirmed.
 * Entries are immutable, so a question card cannot say so itself; without this its buttons stay live and a later tap ends in
 * the model's "already resolved".
 */
function resolveAnswers(messages: UiMessage[]): UiMessage[] {
	const closed = new Set<string>();
	const wished = new Set<string>();
	const imported = new Set<string>();
	// Newest first, so that every card has been seen by the time the question it answers is reached.
	return messages
		.toReversed()
		.map((message): UiMessage => {
			if (message.role !== "system") return message;
			const { card } = message;
			if (card.type === "followup" && (card.event === "outcome" || card.event === "resolved")) {
				closed.add(card.followup.id);
			} else if (card.type === "person" && card.event === "wish" && card.year !== undefined) {
				wished.add(`${card.person.id}:${card.year}`);
			} else if (card.type === "import_result") {
				imported.add(card.importId);
			} else if (card.type === "import_preview" && imported.has(card.importId)) {
				return { ...message, card: { ...card, answered: true } };
			} else if (card.type === "followup_question" && closed.has(card.data.followupId)) {
				return { ...message, card: { ...card, answered: true } };
			} else if (card.type === "birthday" && wished.has(`${card.data.personId}:${card.data.year}`)) {
				return { ...message, card: { ...card, answered: true } };
			}
			return message;
		})
		.toReversed();
}

type Decided = Exclude<ApprovalCardState, { status: "pending" | "expired" }>;

/** The outcome notices of the thread, by the approval request they answer. The newest one for a request wins. */
function approvalOutcomes(entries: readonly EntryRecord[]): Map<string, Decided> {
	const outcomes = new Map<string, Decided>();
	for (const entry of entries) {
		if (entry.kind !== NOTICE_ENTRY_KIND) continue;
		const data = entry.data as Partial<NoticeEntryData> | undefined;
		const approval = data?.approval;
		if (approval === undefined || approval.outcome === "expired" || typeof data?.text !== "string") continue;
		outcomes.set(approval.actionId, { status: approval.outcome, text: data.text, via: approval.via });
	}
	return outcomes;
}

/** Give each approval card the state the thread says it is in: answered, expired, or still waiting. */
function resolveApprovals(messages: UiMessage[], outcomes: Map<string, Decided>, now: number): UiMessage[] {
	return messages.map((message) => {
		if (message.role !== "system" || message.card.type !== "approval") return message;
		const decided = outcomes.get(message.card.actionId);
		const state: ApprovalCardState =
			decided ?? (message.card.expiresAt <= now ? { status: "expired" } : { status: "pending" });
		return { ...message, card: { ...message.card, state } };
	});
}

type SuggestionOutcome = Extract<SuggestionCardState, { status: "added" | "dismissed" }>;

/** What the owner did with each suggestion, from the notices the server wrote for it. The first answer stands, as it does on the server. */
function suggestionOutcomes(entries: readonly EntryRecord[]): Map<string, SuggestionOutcome> {
	const outcomes = new Map<string, SuggestionOutcome>();
	for (const entry of entries) {
		if (entry.kind !== NOTICE_ENTRY_KIND) continue;
		const data = entry.data as Partial<NoticeEntryData> | undefined;
		const suggestion = data?.suggestion;
		if (suggestion === undefined || typeof data?.text !== "string" || outcomes.has(suggestion.suggestionId)) continue;
		if (suggestion.outcome === "added" || suggestion.outcome === "dismissed") {
			outcomes.set(suggestion.suggestionId, { status: suggestion.outcome, text: data.text });
		}
	}
	return outcomes;
}

/**
 * Give each suggestion card the state the thread says it is in: answered, expired (its week passed: the entry is immutable,
 * so `now` decides, as for approvals), or still waiting for the owner.
 */
function resolveSuggestions(messages: UiMessage[], outcomes: Map<string, SuggestionOutcome>, now: number): UiMessage[] {
	return messages.map((message) => {
		if (message.role !== "system" || message.card.type !== "suggestion") return message;
		const { data } = message.card;
		const state: SuggestionCardState =
			outcomes.get(data.id) ??
			(typeof data.expiresAt === "number" && data.expiresAt <= now ? { status: "expired" } : { status: "pending" });
		return { ...message, card: { ...message.card, state } };
	});
}

function explanationsByEntry(unanswered: ThreadState["unanswered"]): Map<number, string> {
	const explanations = new Map<number, string>();
	for (const item of unanswered) {
		const text = explainUnanswered(item.reason, item.detail);
		// Newest first: when one message was submitted twice, the latest outcome is the one to show.
		if (item.entry !== undefined && text !== undefined && !explanations.has(item.entry)) {
			explanations.set(item.entry, text);
		}
	}
	return explanations;
}

/** The cached message itself when there is nothing to add, so unchanged messages keep their identity. */
function withExplanation(message: UiMessage | null, explanation: string | undefined): UiMessage | null {
	return message?.role === "user" && explanation !== undefined ? { ...message, notAnswered: explanation } : message;
}

/**
 * An answer the user stops is the last word on that message. An answer cut short and followed by another answer to the
 * same message was interrupted, which is what a restart mid-answer leaves behind.
 */
function markInterrupted(messages: UiMessage[]): UiMessage[] {
	return messages.map((message, index) =>
		message.role === "assistant" && message.status.type === "stopped" && messages[index + 1]?.role === "assistant"
			? { ...message, status: { type: "interrupted" } }
			: message,
	);
}

/** Memoized per entry object: entries never change, so unchanged messages keep their identity between updates. */
function entryToMessage(entry: EntryRecord): UiMessage | null {
	const cached = cache.get(entry);
	if (cached !== undefined) return cached;
	const message = convertEntry(entry);
	cache.set(entry, message);
	return message;
}

/**
 * Only `pi.user` and `pi.assistant` entries are chat bubbles. Other entries can carry model messages too (a compaction
 * summary is stored as a user message, a reset may carry a handoff note) but are context for the model, not chat.
 */
function convertEntry(entry: EntryRecord): UiMessage | null {
	const card = cardOf(entry);
	if (card !== undefined) return { id: `card-${entry.id}`, role: "system", createdAt: cardTime(entry), card };
	const message = entry.model?.[0];
	if (entry.kind === "pi.user" && message?.role === "user") {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
		const { text: written, files } = splitAttachments(text);
		return {
			id: `user-${entry.id}`,
			role: "user",
			createdAt: message.timestamp,
			text: written,
			...(files.length === 0 ? {} : { files }),
		};
	}
	if (entry.kind === "pi.assistant" && message?.role === "assistant") {
		return assistantToMessage(message, statusOf(message), String(entry.id));
	}
	return null;
}

/** The card an entry shows, if it is one: a reminder, an agenda, a question, a birthday, a notice, or a tool result that carries a typed card. */
function cardOf(entry: EntryRecord): UiCard | undefined {
	if (entry.kind === AGENDA_ENTRY_KIND) {
		const data = entry.data as Partial<AgendaEntryData> | undefined;
		return typeof data?.title === "string" && Array.isArray(data.points)
			? { type: "agenda", data: data as AgendaEntryData }
			: undefined;
	}
	if (entry.kind === FOLLOWUP_ENTRY_KIND) {
		const data = entry.data as Partial<FollowupEntryData> | undefined;
		return typeof data?.title === "string" ? { type: "followup_question", data: data as FollowupEntryData } : undefined;
	}
	if (entry.kind === BIRTHDAY_ENTRY_KIND) {
		const data = entry.data as Partial<BirthdayEntryData> | undefined;
		return typeof data?.name === "string" ? { type: "birthday", data: data as BirthdayEntryData } : undefined;
	}
	if (entry.kind === DAILY_ENTRY_KIND) {
		const data = entry.data as Partial<DailyEntryData> | undefined;
		return isDailyJobId(data?.job) && Array.isArray(data.sections)
			? { type: "daily", data: data as DailyEntryData }
			: undefined;
	}
	if (entry.kind === SUGGESTION_ENTRY_KIND) {
		const data = entry.data as Partial<SuggestionEntryData> | undefined;
		return typeof data?.id === "string" && typeof data.title === "string" && typeof data.atText === "string"
			? { type: "suggestion", data: data as SuggestionEntryData, state: { status: "pending" } }
			: undefined;
	}
	if (entry.kind === DELEGATED_ENTRY_KIND) {
		const data = entry.data as Partial<DelegatedEntryData> | undefined;
		return typeof data?.question === "string" ? { type: "delegated", data: data as DelegatedEntryData } : undefined;
	}
	if (entry.kind === LATE_ANSWER_ENTRY_KIND) {
		const data = entry.data as Partial<LateAnswerEntryData> | undefined;
		return typeof data?.answer === "string" && typeof data.question === "string"
			? { type: "late_answer", data: data as LateAnswerEntryData }
			: undefined;
	}
	if (entry.kind === REMINDER_ENTRY_KIND) {
		const data = entry.data as Partial<ReminderEntryData> | undefined;
		return typeof data?.title === "string" ? { type: "reminder", data: data as ReminderEntryData } : undefined;
	}
	if (entry.kind === NOTICE_ENTRY_KIND) {
		const data = entry.data as Partial<NoticeEntryData> | undefined;
		return typeof data?.text === "string" ? { type: "notice", data: data as NoticeEntryData } : undefined;
	}
	const message = entry.model?.[0];
	if (entry.kind !== "pi.tool-result" || message?.role !== "toolResult") return undefined;
	const card = toolCardOf(message.details);
	if (card === undefined) return undefined;
	// Until the notices say otherwise, a request is waiting; `resolveApprovals` settles it.
	return card.type === "approval" ? { ...card, state: { status: "pending" } } : card;
}

/** When the card happened: the time a timer posted it, otherwise the entry's message time. */
function cardTime(entry: EntryRecord): number {
	const data = entry.data as { firedAt?: unknown } | undefined;
	const posted = [
		REMINDER_ENTRY_KIND,
		AGENDA_ENTRY_KIND,
		FOLLOWUP_ENTRY_KIND,
		BIRTHDAY_ENTRY_KIND,
		DAILY_ENTRY_KIND,
		SUGGESTION_ENTRY_KIND,
		DELEGATED_ENTRY_KIND,
		LATE_ANSWER_ENTRY_KIND,
	];
	if (posted.includes(entry.kind) && typeof data?.firedAt === "number") return data.firedAt;
	const timestamp = entry.model?.[0]?.timestamp;
	return typeof timestamp === "number" ? timestamp : 0;
}

function statusOf(message: AssistantChatMessage): UiAssistantStatus {
	switch (message.stopReason) {
		case "aborted":
			return { type: "stopped" };
		case "error":
			return { type: "error", message: message.errorMessage ?? "The model returned an error." };
		case "length":
			return { type: "cut-off" };
		case "pending":
		case "deferred":
			return { type: "running" };
		default:
			return { type: "complete" };
	}
}

function assistantToMessage(
	message: AssistantChatMessage,
	status: UiAssistantStatus,
	fallbackId: string,
): UiMessage | null {
	const parts: UiPart[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text !== "") parts.push({ type: "text", text: block.text });
		else if (block.type === "thinking" && block.thinking !== "")
			parts.push({ type: "reasoning", text: block.thinking });
	}
	// Nothing to show: a stopped or finished message with no text. Errors and running drafts still get a bubble.
	if (parts.length === 0 && status.type !== "error" && status.type !== "running") return null;
	// The request's start time is the same on every partial and on the final message, so the id survives the hand-over.
	const id = Number.isFinite(message.timestamp) ? `assistant-${message.timestamp}` : `assistant-${fallbackId}`;
	return { id, role: "assistant", createdAt: message.timestamp, parts, status };
}
