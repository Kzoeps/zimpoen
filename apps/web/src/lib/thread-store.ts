import { STREAM_EVENT_NAME, STREAM_PING_EVENT_NAME, type StreamBatch } from "@assistant/shared";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiRequestError, abortRun, fetchEarlier, newRequestId, sendMessage, streamUrl } from "./api.ts";
import { applyEvents, createThreadState, prependHistory, type ThreadState, withConnection } from "./thread-state.ts";

export type ThreadStoreState = {
	/** The conversation being viewed; undefined until `connect()`. */
	thread: ThreadState | undefined;
	/** Why the last send failed, for the user. Cleared by the next send or by switching conversation. */
	sendError: string | undefined;
	connect(conversationId: number): void;
	disconnect(): void;
	/** Throws if the message was not accepted, so the composer can keep the user's text. */
	send(text: string): Promise<void>;
	stop(): Promise<void>;
	loadEarlier(): Promise<void>;
};

export type ThreadStore = StoreApi<ThreadStoreState>;

/**
 * The thread of `conversationId`, or nothing when the store holds another one. The store is switched to a new
 * conversation in an effect, so the first render after the user picks another agent still sees the previous agent's
 * thread; a view must only ever show the thread that is its own.
 */
export function threadFor(state: Pick<ThreadStoreState, "thread">, conversationId: number): ThreadState | undefined {
	return state.thread?.conversationId === conversationId ? state.thread : undefined;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

/** The server pings every 15 s. Silence for more than two pings and a bit means the connection is dead, not quiet. */
export const SILENCE_LIMIT_MS = 40_000;

/** Coming back to a tab or to the network: a connection quiet for longer than a ping interval is not trusted. */
export const STALE_AFTER_MS = 20_000;

/**
 * The browser's connection to one conversation at a time: an `EventSource` feeding `applyEvents`.
 *
 * Reconnecting is free of bookkeeping because the server starts every connection with a snapshot: whatever was missed
 * while disconnected is simply replaced. `EventSource` retries by itself after a dropped connection; when the server
 * refuses the connection outright (it is restarting, or briefly unavailable) the browser gives up, so this retries too.
 *
 * A phone can also lose a connection without anybody being told (Wi-Fi to cellular, Android dozing): the socket stays
 * "open" and nothing arrives. The server therefore pings, and this reconnects when nothing, ping or event, arrived for
 * {@link SILENCE_LIMIT_MS}, and when the tab becomes visible or the network comes back after a quiet spell.
 *
 * One message keeps one `requestId` however many times the user sends it again after a failure, so the server's
 * duplicate check protects a retry whose first attempt actually arrived but whose answer got lost.
 */
export function createThreadStore(): ThreadStore {
	let source: EventSource | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let stopListeningForWake: (() => void) | undefined;
	let lastActivity = 0;
	let failures = 0;
	let unsent: { conversationId: number; text: string; requestId: string } | undefined;

	return createStore<ThreadStoreState>()((set, get) => {
		const update = (change: (thread: ThreadState) => ThreadState): void =>
			set((state) => (state.thread === undefined ? state : { thread: change(state.thread) }));

		const closeSource = (): void => {
			source?.close();
			source = undefined;
			clearTimeout(retryTimer);
			clearTimeout(watchdog);
		};

		/** Anything from the server counts as proof the connection lives; silence for too long does not. */
		const heard = (conversationId: number): void => {
			lastActivity = Date.now();
			clearTimeout(watchdog);
			watchdog = setTimeout(() => reconnect(conversationId), SILENCE_LIMIT_MS);
		};

		/** Start over now, without backoff: used when the connection is known or suspected to be dead. */
		function reconnect(conversationId: number): void {
			update((thread) => withConnection(thread, thread.ready ? "reconnecting" : "connecting"));
			open(conversationId);
		}

		function open(conversationId: number): void {
			closeSource();
			const events = new EventSource(streamUrl(conversationId));
			source = events;
			heard(conversationId);
			events.onopen = () => {
				failures = 0;
				heard(conversationId);
				update((thread) => withConnection(thread, "live"));
			};
			events.addEventListener(STREAM_EVENT_NAME, (event) => {
				heard(conversationId);
				const batch = JSON.parse((event as MessageEvent<string>).data) as StreamBatch;
				update((thread) => applyEvents(thread, batch));
			});
			events.addEventListener(STREAM_PING_EVENT_NAME, () => heard(conversationId));
			events.onerror = () => {
				update((thread) => withConnection(thread, thread.ready ? "reconnecting" : "connecting"));
				if (events.readyState !== EventSource.CLOSED) return; // the browser is retrying by itself
				clearTimeout(watchdog); // a dead connection must not also trigger the silence reconnect
				const delay = RETRY_DELAYS_MS[Math.min(failures++, RETRY_DELAYS_MS.length - 1)];
				retryTimer = setTimeout(() => open(conversationId), delay);
			};
		}

		const listenForWake = (conversationId: number): void => {
			stopListeningForWake?.();
			stopListeningForWake = onWake((reason) => {
				const stale = Date.now() - lastActivity > STALE_AFTER_MS;
				// The network coming back says nothing about how old the last message is: the old socket is not trusted.
				if (reason === "online" || stale) reconnect(conversationId);
			});
		};

		return {
			thread: undefined,
			sendError: undefined,

			connect(conversationId) {
				if (get().thread?.conversationId === conversationId && source !== undefined) return;
				failures = 0;
				set({ thread: createThreadState(conversationId), sendError: undefined });
				open(conversationId);
				listenForWake(conversationId);
			},

			disconnect() {
				closeSource();
				stopListeningForWake?.();
				stopListeningForWake = undefined;
				set({ thread: undefined, sendError: undefined });
			},

			async send(text) {
				const thread = get().thread;
				if (thread === undefined) throw new Error("Not connected to a conversation.");
				set({ sendError: undefined });
				// The same text sent again after a failure is the same message: reuse its id. Anything else is a new one.
				const retry = unsent?.conversationId === thread.conversationId && unsent.text === text;
				const requestId = retry && unsent !== undefined ? unsent.requestId : newRequestId();
				unsent = { conversationId: thread.conversationId, text, requestId };
				try {
					await sendMessage(thread.conversationId, { content: text, requestId });
					unsent = undefined;
				} catch (error) {
					set({ sendError: error instanceof ApiRequestError ? error.message : "The message could not be sent." });
					throw error;
				}
			},

			async stop() {
				const thread = get().thread;
				if (thread === undefined) return;
				try {
					await abortRun(thread.conversationId);
				} catch (error) {
					set({ sendError: error instanceof ApiRequestError ? error.message : "Could not stop the answer." });
				}
			},

			async loadEarlier() {
				const thread = get().thread;
				const before = thread?.earlierBefore;
				if (thread === undefined || before === undefined) return;
				try {
					const page = await fetchEarlier(thread.conversationId, before);
					update((current) =>
						current.conversationId === thread.conversationId
							? prependHistory(current, page.entries, page.nextBefore)
							: current,
					);
				} catch (error) {
					set({ sendError: error instanceof ApiRequestError ? error.message : "Could not load earlier messages." });
				}
			},
		};
	});
}

type WakeReason = "visible" | "online";

/** Calls `onWake` when the tab becomes visible again or the browser regains its network. Returns the way to stop. */
function onWake(onWake: (reason: WakeReason) => void): () => void {
	const document = globalThis.document as Document | undefined;
	const onVisibility = (): void => {
		if (document?.visibilityState === "visible") onWake("visible");
	};
	const onOnline = (): void => onWake("online");
	document?.addEventListener("visibilitychange", onVisibility);
	globalThis.addEventListener?.("online", onOnline);
	return () => {
		document?.removeEventListener("visibilitychange", onVisibility);
		globalThis.removeEventListener?.("online", onOnline);
	};
}
