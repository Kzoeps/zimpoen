import { STREAM_EVENT_NAME, STREAM_PING_EVENT_NAME, type StreamEvent } from "@assistant/shared";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type ConversationId, type Harness, type WatchEnd, watchEvents } from "@earendil-works/pi-durable";
import type { UnansweredReader } from "./unanswered.ts";
import { toStreamBatch, toStreamSnapshot } from "./wire.ts";

/**
 * The only module that uses `watchEvents`, which Durable marks experimental: when its event protocol changes, this file
 * and `wire.ts` change and the browser's contract (`@assistant/shared`) does not.
 */

/** One Server-Sent Events frame: a named event with its data. */
export type SseFrame = { event: string; data: string };

export type ConversationStreamOptions = {
	harness: Harness;
	conversationId: ConversationId;
	/** Receives frames in order. Awaited: a slow client delays only its own stream. */
	write: (frame: SseFrame) => void | Promise<void>;
	/** Aborts when the client disconnects. */
	signal: AbortSignal;
	/** Where snapshots get the list of messages that were never answered. */
	unanswered: UnansweredReader;
	/** Default 15 s. */
	heartbeatMs?: number;
};

export type ConversationStreamEnd = "disconnected" | "closed" | "failed";

export const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * Serve one client: a snapshot first, then the events of every later commit, until the client leaves or the Harness
 * closes. A reconnecting client simply gets a fresh snapshot; nothing is replayed.
 *
 * Durable buffers at most 100 undelivered commits for a slow consumer and then replaces them with a snapshot, which
 * reaches the client as another `snapshot` event inside a normal frame.
 */
export async function runConversationStream(options: ConversationStreamOptions): Promise<ConversationStreamEnd> {
	const { harness, conversationId, write, signal, unanswered } = options;
	// The acquisition context governs the watch's lifetime: aborting it ends the watch.
	const watch = await acquireWatch(harness, conversationId, signal);
	if (watch === undefined) return "disconnected";

	const heartbeat = startHeartbeat(write, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
	try {
		// Written before start(), which is what guarantees the snapshot precedes every later batch. The submissions are
		// read after the watch exists, so anything that settles from here on also arrives as an event (applied twice
		// by the client, which keys them by submission id).
		const first = await withUnanswered(unanswered, conversationId, [toStreamSnapshot(watch.snapshot)]);
		await write(frame(first));
		// A client that left while the snapshot was being written has cancelled the watch, and start() would throw.
		if (signal.aborted) return "disconnected";
		watch.start(async (events) => {
			const batch = await withUnanswered(unanswered, conversationId, toStreamBatch(events));
			if (batch.length > 0) await write(frame(batch));
		});
		const ended = await Promise.race([watch.closed.then((end) => end.reason), heartbeat.failed, disconnected(signal)]);
		return endOf(ended);
	} finally {
		heartbeat.stop();
		await watch.stop();
	}
}

/** The watch, or undefined when the client had already gone: `watchEvents` rethrows the abort of a dead request. */
async function acquireWatch(harness: Harness, conversationId: ConversationId, signal: AbortSignal) {
	if (signal.aborted) return undefined;
	try {
		return await watchEvents(harness, conversationId, withAbortSignal(signal, BACKGROUND_CONTEXT));
	} catch (error) {
		if (signal.aborted) return undefined;
		throw error;
	}
}

/**
 * Snapshots carry the recent messages that got no answer and why, so the reason survives a reload. Events for later
 * commits reach the client as they happen; a snapshot (the first frame, or one that replaces a client that fell behind)
 * is the only place the history of failures can be restored from.
 */
async function withUnanswered(
	unanswered: UnansweredReader,
	conversationId: ConversationId,
	batch: StreamEvent[],
): Promise<StreamEvent[]> {
	if (!batch.some((event) => event.type === "snapshot")) return batch;
	const list = await unanswered(conversationId);
	return batch.map((event) => (event.type === "snapshot" ? { ...event, unanswered: list } : event));
}

/**
 * A ping every `intervalMs`, so proxies and phones do not drop a connection that is merely quiet. It is a named event
 * rather than a comment because `EventSource` never surfaces comments: the page could not tell a quiet conversation
 * from a connection that died without a close.
 */
function startHeartbeat(write: ConversationStreamOptions["write"], intervalMs: number) {
	let resolveFailed: (reason: "write_failed") => void = () => {};
	const failed = new Promise<"write_failed">((resolve) => {
		resolveFailed = resolve;
	});
	const timer = setInterval(() => {
		// Starting from a resolved promise keeps a `write` that throws synchronously from escaping the timer callback.
		Promise.resolve()
			.then(() => write({ event: STREAM_PING_EVENT_NAME, data: JSON.stringify({ at: Date.now() }) }))
			.catch(() => resolveFailed("write_failed"));
	}, intervalMs);
	return { failed, stop: () => clearInterval(timer) };
}

function disconnected(signal: AbortSignal): Promise<"disconnected"> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve("disconnected");
		else signal.addEventListener("abort", () => resolve("disconnected"), { once: true });
	});
}

/**
 * Why a watch ended, as the caller cares about it. The reason names are those of the published 1.4.0 package;
 * the repository's README, at a later commit, calls `session_closed` and `session_failed` `ended` and `failed`.
 */
function endOf(reason: "write_failed" | "disconnected" | WatchEnd["reason"]): ConversationStreamEnd {
	switch (reason) {
		case "session_closed":
			return "closed";
		case "session_failed":
			return "failed";
		default:
			// Cancelled, stopped, retired, a failed write, or a vanished client: nobody is listening any more.
			return "disconnected";
	}
}

function frame(batch: readonly StreamEvent[]): SseFrame {
	return { event: STREAM_EVENT_NAME, data: JSON.stringify(batch) };
}
