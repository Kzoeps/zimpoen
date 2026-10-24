import type { AgentEvent, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";

/** SSE `event:` name of every data frame. Each frame's `data:` is a JSON {@link StreamBatch}. */
export const STREAM_EVENT_NAME = "events";

/**
 * SSE `event:` name of the keep-alive frame sent every 15 s. A comment line would be invisible to `EventSource`, so
 * the browser could not tell a quiet conversation from a dead connection. Its data is `{ "at": <epoch ms> }`.
 */
export const STREAM_PING_EVENT_NAME = "ping";

/** Entries a snapshot carries at most; older ones come from `GET /api/conversations/:id/messages`. */
export const SNAPSHOT_ENTRY_LIMIT = 200;

/**
 * A message of the user's that the agent will never answer, and why. Durable keeps the reason in the submission, so a
 * reload still shows it.
 */
export type UnansweredInput = {
	submissionId: number;
	/** The user's message (a `pi.user` entry). Absent when the input never reached the transcript. */
	entry?: number;
	/** Durable's reason, for example `no_model` or `model_error`. */
	reason: string;
	detail?: unknown;
};

/** Reasons that need no explanation: the user stopped the answer, or reset the conversation. */
export function isSelfExplanatoryReason(reason: string): boolean {
	return reason === "aborted" || reason === "reset";
}

/** The newest {@link UnansweredInput}s a snapshot carries. */
export const SNAPSHOT_UNANSWERED_LIMIT = 20;

/**
 * Durable's `snapshot` event as the server sends it: system-prompt entries removed, at most
 * {@link SNAPSHOT_ENTRY_LIMIT} entries (the newest), oldest first.
 */
export type StreamSnapshot = Omit<SnapshotEvent, "entries"> & {
	entries: readonly EntryRecord[];
	/** Older entries exist than `entries` holds. */
	hasEarlier: boolean;
	/** Recent messages that got no answer, newest first, without the self-explanatory ones. */
	unanswered: readonly UnansweredInput[];
};

/**
 * What a client applies to its state, in order. A `snapshot` replaces everything the client holds: it is the first
 * event of every connection, and may appear again if the client falls behind. Every other event is Durable's agent
 * event (experimental, see `apps/server/src/stream.ts`), except that system-prompt entries and opaque provider
 * signatures are removed.
 */
export type StreamEvent = StreamSnapshot | Exclude<AgentEvent, { type: "snapshot" }>;

/** One SSE frame: the events of one Durable commit, or one snapshot. */
export type StreamBatch = readonly StreamEvent[];

/** A model message as stored in an entry: user, assistant, tool result or system. */
export type ChatMessage = NonNullable<EntryRecord["model"]>[number];

export type AssistantChatMessage = Extract<ChatMessage, { role: "assistant" }>;

export type UserChatMessage = Extract<ChatMessage, { role: "user" }>;

/** One edit to the assistant message that is still being written, relative to that message. */
export type MessageChange = Extract<AgentEvent, { type: "message_update" }>["changes"][number];

export type { AgentEvent, EntryRecord };
