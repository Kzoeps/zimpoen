import type { AssistantChatMessage, EntryRecord } from "@assistant/shared";
import { explainUnanswered, type ThreadState } from "./thread-state.ts";

/**
 * What the thread shows, one item per bubble. Derived from `ThreadState`; assistant-ui gets it through
 * `convertMessage`. Only chat messages appear here: system-prompt entries never reach the client, and other entry
 * kinds (reminders, notices, tool results) are ignored until their milestones render them.
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

export type UiMessage =
	| {
			id: string;
			role: "user";
			createdAt: number;
			text: string;
			/** Why this message was never answered, when it was not: shown under it, also after a reload. */
			notAnswered?: string;
	  }
	| { id: string; role: "assistant"; createdAt: number; parts: UiPart[]; status: UiAssistantStatus };

const cache = new WeakMap<EntryRecord, UiMessage | null>();

/** All messages of a thread, oldest first, the one being written last. */
export function toUiMessages(state: Pick<ThreadState, "entries" | "draft" | "unanswered">): UiMessage[] {
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
	return markInterrupted(messages);
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
	const message = entry.model?.[0];
	if (entry.kind === "pi.user" && message?.role === "user") {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
		return { id: `user-${entry.id}`, role: "user", createdAt: message.timestamp, text };
	}
	if (entry.kind === "pi.assistant" && message?.role === "assistant") {
		return assistantToMessage(message, statusOf(message), String(entry.id));
	}
	return null;
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
