import { SNAPSHOT_ENTRY_LIMIT, type StreamEvent, type StreamSnapshot, type UnansweredInput } from "@assistant/shared";
import type { AgentEvent, AgentState, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";

/**
 * What the browser may see of Durable's state.
 *
 * Three kinds of data never leave the server: the `pi.system` entries (prompt and tool declarations, which the user
 * did not write and the UI does not render), opaque provider signatures (encrypted reasoning replay data, large and
 * meaningless to a client), the bytes of images in tool results (a receipt the PA looked at: megabytes that every page
 * load and every reconnect would download, and that the UI never shows; the model still has them in Durable's own
 * storage), and the agent's `instructions` and `cwd` (the persona prompt and a server path). Everything else passes
 * through unchanged, so the UI is typed against Durable's own shapes.
 */

const OPAQUE_KEYS: ReadonlySet<string> = new Set(["thinkingSignature", "textSignature", "thoughtSignature"]);

export function isSystemEntry(entry: EntryRecord): boolean {
	return entry.kind === "pi.system";
}

/** A copy of `value` without opaque provider signatures, at any depth. Input is JSON data and is never mutated. */
export function omitOpaque<T>(value: T): T {
	return strip(value) as T;
}

type ImageBlock = { type: "image"; data: string; mimeType?: string };

const isImageBlock = (value: unknown): value is ImageBlock =>
	typeof value === "object" &&
	value !== null &&
	(value as { type?: unknown }).type === "image" &&
	typeof (value as { data?: unknown }).data === "string";

/** The file tools write the file's id first in the text that goes with its image ("fi_ab12cd34 “receipt.jpg”: image, …"). */
const LABELLED_FILE_ID = /^(fi_[0-9a-f]{8})\b/;

function fileIdOf(blocks: readonly unknown[]): string | undefined {
	for (const block of blocks) {
		if (typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "text") continue;
		const id = LABELLED_FILE_ID.exec(String((block as { text?: unknown }).text ?? ""))?.[1];
		if (id !== undefined) return id;
	}
	return undefined;
}

/**
 * What stands in for an image's bytes: its type, how many bytes were left out, and the id of the file when the block says
 * which one it is, so a client that wants the picture asks `GET /api/files/:id` instead of carrying it in every page.
 */
function withoutBytes(block: ImageBlock, fileId: string | undefined): Record<string, unknown> {
	return {
		type: "image",
		...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
		omitted: Math.floor((block.data.length * 3) / 4),
		...(fileId === undefined ? {} : { fileId }),
	};
}

function strip(value: unknown): unknown {
	if (Array.isArray(value)) {
		const fileId = fileIdOf(value);
		return value.map((item) => (isImageBlock(item) ? withoutBytes(item, fileId) : strip(item)));
	}
	if (typeof value !== "object" || value === null) return value;
	const copy: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (!OPAQUE_KEYS.has(key)) copy[key] = strip(child);
	}
	return copy;
}

/** Entries the client may render: system entries removed, signatures stripped, order kept. */
export function toWireEntries(entries: readonly EntryRecord[]): EntryRecord[] {
	return entries.filter((entry) => !isSystemEntry(entry)).map((entry) => omitOpaque(entry));
}

/** The agent settings the browser may see: model, thinking level and extension names, never the prompt or paths. */
export function publicAgent(agent: AgentState): AgentState {
	const { instructions: _instructions, cwd: _cwd, ...visible } = agent;
	return visible;
}

/**
 * `unanswered` is not part of Durable's snapshot; the stream module reads it from the submission records and passes it
 * in. Slices before copying: a long conversation has thousands of entries and only the newest `limit` are sent.
 */
export function toStreamSnapshot(
	snapshot: SnapshotEvent,
	unanswered: readonly UnansweredInput[] = [],
	limit: number = SNAPSHOT_ENTRY_LIMIT,
): StreamSnapshot {
	const visible = snapshot.entries.filter((entry) => !isSystemEntry(entry));
	// A head marker first means the active transcript starts after older, compacted-away history.
	const hasEarlier = visible.length > limit || snapshot.entries[0]?.head !== undefined;
	const { entries: _all, agent, ...rest } = snapshot;
	return omitOpaque({ ...rest, agent: publicAgent(agent), entries: visible.slice(-limit), hasEarlier, unanswered });
}

/** One agent event as the client gets it, or undefined when it only concerns hidden entries. */
export function toStreamEvent(event: AgentEvent): StreamEvent | undefined {
	switch (event.type) {
		case "snapshot":
			return toStreamSnapshot(event);
		case "agent_changed":
			return { ...event, agent: publicAgent(event.agent) };
		case "message_start":
			return event.message.role === "system" ? undefined : omitOpaque(event);
		case "message_end":
		case "entry_appended":
			return isSystemEntry(event.entry) ? undefined : omitOpaque(event);
		default:
			return omitOpaque(event);
	}
}

export function toStreamBatch(events: readonly AgentEvent[]): StreamEvent[] {
	const batch: StreamEvent[] = [];
	for (const event of events) {
		const projected = toStreamEvent(event);
		if (projected !== undefined) batch.push(projected);
	}
	return batch;
}
