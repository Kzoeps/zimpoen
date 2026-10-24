import { SNAPSHOT_ENTRY_LIMIT, type StreamEvent, type StreamSnapshot, type UnansweredInput } from "@assistant/shared";
import type { AgentEvent, AgentState, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";

/**
 * What the browser may see of Durable's state.
 *
 * Three kinds of data never leave the server: the `pi.system` entries (prompt and tool declarations, which the user
 * did not write and the UI does not render), opaque provider signatures (encrypted reasoning replay data, large and
 * meaningless to a client), and the agent's `instructions` and `cwd` (the persona prompt and a server path). Everything
 * else passes through unchanged, so the UI is typed against Durable's own shapes.
 */

const OPAQUE_KEYS: ReadonlySet<string> = new Set(["thinkingSignature", "textSignature", "thoughtSignature"]);

export function isSystemEntry(entry: EntryRecord): boolean {
	return entry.kind === "pi.system";
}

/** A copy of `value` without opaque provider signatures, at any depth. Input is JSON data and is never mutated. */
export function omitOpaque<T>(value: T): T {
	return strip(value) as T;
}

function strip(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(strip);
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
