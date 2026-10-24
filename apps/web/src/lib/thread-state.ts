import {
	type AssistantChatMessage,
	type EntryRecord,
	isSelfExplanatoryReason,
	type MessageChange,
	type StreamEvent,
	type UnansweredInput,
} from "@assistant/shared";

/**
 * Client-side state of one conversation, built only from the server's stream (`@assistant/shared` `StreamEvent`).
 *
 * Everything here is pure: `applyEvent(state, event)` returns the next state and never mutates its input, so it is
 * tested against event streams recorded from the real server (see `test/fixtures`).
 */

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

export type Notice = {
	kind: "error" | "retry";
	message: string;
};

export type ThreadState = {
	conversationId: number;
	connection: ConnectionStatus;
	/** False until the first snapshot arrives; the thread is loading, not empty. */
	ready: boolean;
	/** Committed entries, oldest first. Immutable once received, so their identity is stable between updates. */
	entries: readonly EntryRecord[];
	/** The assistant message being written right now, as far as it has been committed. */
	draft: AssistantChatMessage | undefined;
	/** A run is in progress: the agent is answering. */
	running: boolean;
	/** Entries older than the first one held exist on the server. */
	hasEarlier: boolean;
	/**
	 * The `before` of the next history request. After a page this is the server's cursor, not the oldest entry held: a
	 * page can hold only hidden entries, and asking again from the oldest held entry would fetch that page forever.
	 */
	earlierBefore: number | undefined;
	/**
	 * Messages of the user's that were never answered, by submission id, with Durable's reason. They come with every
	 * snapshot (so a reload still explains them) and from `submission` events.
	 */
	unanswered: readonly UnansweredInput[];
	notice: Notice | undefined;
};

export function createThreadState(conversationId: number): ThreadState {
	return {
		conversationId,
		connection: "connecting",
		ready: false,
		entries: [],
		draft: undefined,
		running: false,
		hasEarlier: false,
		earlierBefore: undefined,
		unanswered: [],
		notice: undefined,
	};
}

export function withConnection(state: ThreadState, connection: ConnectionStatus): ThreadState {
	return state.connection === connection ? state : { ...state, connection };
}

export function applyEvents(state: ThreadState, events: readonly StreamEvent[]): ThreadState {
	return events.reduce(applyEvent, state);
}

export function applyEvent(state: ThreadState, event: StreamEvent): ThreadState {
	switch (event.type) {
		case "snapshot": {
			const entries = mergeSnapshotEntries(state.entries, event.entries);
			return {
				...state,
				ready: true,
				entries,
				draft: event.generation?.message,
				running: event.run !== undefined,
				hasEarlier: event.hasEarlier || hasGapBefore(state, event.entries),
				earlierBefore: entries[0]?.id,
				unanswered: event.unanswered ?? [],
				notice: retryNotice(event.generation?.retry?.error),
			};
		}

		case "message_start":
			// A user or tool-result message arrives complete, with its `message_end`. Only an assistant message streams.
			return event.message.role === "assistant" ? { ...state, draft: event.message } : state;

		case "message_update":
			return state.draft === undefined
				? state
				: { ...state, draft: { ...event.changes.reduce(applyChange, state.draft), usage: event.usage } };

		case "message_end": {
			const finished = event.entry.model?.[0]?.role === "assistant";
			return { ...state, entries: appendEntry(state.entries, event.entry), draft: finished ? undefined : state.draft };
		}

		case "entry_appended":
			return { ...state, entries: appendEntry(state.entries, event.entry) };

		case "run_start":
			return { ...state, running: true, notice: undefined };

		case "run_end":
			// Anything still streaming has been committed as an entry by now; a leftover partial must not linger.
			return {
				...state,
				running: false,
				draft: undefined,
				notice: state.notice?.kind === "retry" ? undefined : state.notice,
			};

		case "auto_retry_start":
			return { ...state, notice: retryNotice(event.errorMessage, event.attempt) };

		case "auto_retry_end":
			return state.notice?.kind === "retry" ? { ...state, notice: undefined } : state;

		case "submission":
			return withSubmission(state, event.record);

		case "task_failed":
			return {
				...state,
				notice: { kind: "error", message: `Something went wrong inside the assistant: ${event.message}` },
			};

		default:
			// Tool, compaction, inbox, usage and turn events: nothing in M1 renders them.
			return state;
	}
}

/**
 * A page from the history endpoint: entries older than everything held, oldest first, and the `nextBefore` cursor it
 * returned (absent on the last page).
 */
export function prependHistory(
	state: ThreadState,
	older: readonly EntryRecord[],
	nextBefore: number | undefined,
): ThreadState {
	const known = new Set(state.entries.map((entry) => entry.id));
	const fresh = older.filter((entry) => !known.has(entry.id));
	return {
		...state,
		entries: sortById([...fresh, ...state.entries]),
		hasEarlier: nextBefore !== undefined,
		earlierBefore: nextBefore,
	};
}

/**
 * A snapshot replaces the live view, but history pages the user already loaded are immutable and still valid:
 * keep the ones that connect to the snapshot so a reconnect does not collapse the thread.
 */
function mergeSnapshotEntries(held: readonly EntryRecord[], snapshot: readonly EntryRecord[]): readonly EntryRecord[] {
	const sorted = sortById(snapshot);
	const first = sorted[0];
	if (first === undefined || !held.some((entry) => entry.id === first.id)) return sorted;
	return [...held.filter((entry) => entry.id < first.id), ...sorted];
}

/** Held history that does not connect to the snapshot was dropped, so older entries exist again. */
function hasGapBefore(state: ThreadState, snapshot: readonly EntryRecord[]): boolean {
	const first = snapshot[0];
	return state.entries.length > 0 && first !== undefined && !state.entries.some((entry) => entry.id === first.id);
}

function appendEntry(entries: readonly EntryRecord[], entry: EntryRecord): readonly EntryRecord[] {
	if (entries.some((existing) => existing.id === entry.id)) return entries;
	const last = entries.at(-1);
	return last === undefined || last.id < entry.id ? [...entries, entry] : sortById([...entries, entry]);
}

function sortById(entries: readonly EntryRecord[]): EntryRecord[] {
	return [...entries].sort((a, b) => a.id - b.id);
}

function retryNotice(error: string | undefined, attempt?: number): Notice | undefined {
	if (error === undefined) return undefined;
	const which = attempt === undefined ? "" : ` (attempt ${attempt})`;
	return { kind: "retry", message: `The model returned an error, trying again${which}: ${error}` };
}

type SubmissionRecord = Extract<StreamEvent, { type: "submission" }>["record"];

/**
 * A message that got no answer is remembered against the user's message, where it is shown for good. Only when the
 * message never reached the transcript is there nothing to attach it to, and the explanation is a notice instead.
 */
function withSubmission(state: ThreadState, record: SubmissionRecord): ThreadState {
	if (record.type !== "input" || record.status !== "unanswered") return state;
	const message = explainUnanswered(record.reason, record.detail);
	if (message === undefined) return state;
	if (record.entry === undefined) return { ...state, notice: { kind: "error", message } };
	const others = state.unanswered.filter((item) => item.submissionId !== record.id);
	const next: UnansweredInput = {
		submissionId: record.id,
		entry: record.entry,
		reason: record.reason,
		...(record.detail === undefined ? {} : { detail: record.detail }),
	};
	return { ...state, unanswered: [next, ...others] };
}

/** Why a message got no answer, in words for the user; undefined when nothing needs saying (answered or stopped). */
export function unansweredMessage(record: SubmissionRecord): string | undefined {
	if (record.type !== "input" || record.status !== "unanswered") return undefined;
	return explainUnanswered(record.reason, record.detail);
}

/** The words for a Durable `reason`; undefined for the ones the user caused and already knows about. */
export function explainUnanswered(reason: string, rawDetail?: unknown): string | undefined {
	if (isSelfExplanatoryReason(reason)) return undefined;
	const detail = typeof rawDetail === "string" ? rawDetail : undefined;
	switch (reason) {
		case "no_model":
			return "This agent has no model it can use. Choose another model for it in Settings, or check the server's model mode and sign-in.";
		case "model_error":
			return `The model could not answer${detail === undefined ? "" : `: ${detail}`}`;
		case "faulted":
			return `The assistant hit an internal error while answering${detail === undefined ? "" : `: ${detail}`}`;
		default:
			return `The message was not answered (${reason}).`;
	}
}

// Applying one change to the in-flight message

function applyChange(message: AssistantChatMessage, change: MessageChange): AssistantChatMessage {
	switch (change.type) {
		case "message":
			return change.message;
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
		case "block":
			return replaceBlock(message, change.contentIndex, () => change.block);
		case "text_delta":
			return replaceBlock(message, change.contentIndex, (block) =>
				block?.type === "text" ? { ...block, text: block.text + change.delta } : block,
			);
		case "thinking_delta":
			return replaceBlock(message, change.contentIndex, (block) =>
				block?.type === "thinking" ? { ...block, thinking: block.thinking + change.delta } : block,
			);
		case "toolcall_delta":
			return replaceBlock(message, change.contentIndex, (block) =>
				block?.type === "toolCall"
					? { ...block, arguments: appendAtPath(block.arguments, change.path, change.delta) as typeof block.arguments }
					: block,
			);
	}
}

type Block = AssistantChatMessage["content"][number];

function replaceBlock(
	message: AssistantChatMessage,
	index: number,
	next: (current: Block | undefined) => Block | undefined,
): AssistantChatMessage {
	const current = message.content[index];
	const replacement = next(current);
	if (replacement === undefined || replacement === current) return message;
	const content = [...message.content];
	content[index] = replacement;
	return { ...message, content };
}

/** Append `delta` to the string at `path`, copying only what is on the way there. */
function appendAtPath(root: unknown, path: readonly (string | number)[], delta: string): unknown {
	const [key, ...rest] = path;
	if (key === undefined) return typeof root === "string" ? root + delta : delta;
	const container = (typeof root === "object" && root !== null ? root : {}) as Record<string | number, unknown>;
	const copy = Array.isArray(container) ? [...container] : { ...container };
	(copy as Record<string | number, unknown>)[key] = appendAtPath(container[key], rest, delta);
	return copy;
}
