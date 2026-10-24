import { STREAM_EVENT_NAME, STREAM_PING_EVENT_NAME, type StreamBatch } from "@assistant/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadStore, SILENCE_LIMIT_MS, STALE_AFTER_MS, threadFor } from "../src/lib/thread-store.ts";
import { recordings } from "./fixtures.ts";

/** Just enough of the browser's EventSource to drive the store from a test. */
class FakeEventSource {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static instances: FakeEventSource[] = [];

	readonly url: string;
	readyState = FakeEventSource.CONNECTING;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readonly listeners = new Map<string, (event: { data: string }) => void>();

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: (event: { data: string }) => void): void {
		this.listeners.set(type, listener);
	}

	close(): void {
		this.readyState = FakeEventSource.CLOSED;
	}

	open(): void {
		this.readyState = FakeEventSource.OPEN;
		this.onopen?.();
	}

	send(batch: StreamBatch): void {
		this.listeners.get(STREAM_EVENT_NAME)?.({ data: JSON.stringify(batch) });
	}

	/** The server's keep-alive: a named event that carries no conversation data. */
	ping(): void {
		this.listeners.get(STREAM_PING_EVENT_NAME)?.({ data: JSON.stringify({ at: Date.now() }) });
	}

	/** The connection drops. `refused` is a server that answered with an error: the browser gives up on those. */
	fail(refused = false): void {
		this.readyState = refused ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
		this.onerror?.();
	}
}

const sources = () => FakeEventSource.instances;
const latest = () => {
	const source = sources().at(-1);
	if (source === undefined) throw new Error("no EventSource was opened");
	return source;
};

const fetchMock = vi.fn<typeof fetch>();

/** The page's visibility and network events, which a node test has to supply itself. */
class FakePage extends EventTarget {
	visibilityState: "visible" | "hidden" = "visible";

	show(): void {
		this.visibilityState = "visible";
		this.dispatchEvent(new Event("visibilitychange"));
	}

	hide(): void {
		this.visibilityState = "hidden";
		this.dispatchEvent(new Event("visibilitychange"));
	}

	comeOnline(): void {
		this.dispatchEvent(new Event("online"));
	}
}
let page: FakePage;

beforeEach(() => {
	FakeEventSource.instances = [];
	page = new FakePage();
	vi.useFakeTimers();
	vi.stubGlobal("EventSource", FakeEventSource);
	vi.stubGlobal("fetch", fetchMock);
	vi.stubGlobal("document", page);
	vi.stubGlobal("addEventListener", page.addEventListener.bind(page));
	vi.stubGlobal("removeEventListener", page.removeEventListener.bind(page));
	fetchMock.mockReset();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const reply = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Every call gets its own Response: a body can be read only once. */
const respondWith = (body: unknown, status = 200) => fetchMock.mockImplementation(async () => reply(body, status));

describe("connecting", () => {
	it("opens the conversation's stream, goes live on open, and turns a snapshot frame into a ready thread", () => {
		const store = createThreadStore();

		store.getState().connect(2);
		expect(latest().url).toBe("/api/conversations/2/stream");
		expect(store.getState().thread).toMatchObject({ conversationId: 2, connection: "connecting", ready: false });

		latest().open();
		const [first] = recordings.chatTurns.connections[0] ?? [];
		latest().send(first ?? []);

		expect(store.getState().thread).toMatchObject({ connection: "live", ready: true, running: false });
	});

	it("switches conversation by closing the old stream and starting from a blank thread", () => {
		const store = createThreadStore();
		store.getState().connect(2);
		const first = latest();
		first.open();

		store.getState().connect(8);

		expect(first.readyState).toBe(FakeEventSource.CLOSED);
		expect(latest().url).toBe("/api/conversations/8/stream");
		expect(store.getState().thread).toMatchObject({ conversationId: 8, ready: false, entries: [] });
	});

	it("does not open a second stream when asked to connect to the conversation it already follows", () => {
		const store = createThreadStore();
		store.getState().connect(2);
		store.getState().connect(2);

		expect(sources()).toHaveLength(1);
	});

	it("closes the stream and forgets the thread on disconnect, and never reconnects afterwards", () => {
		const store = createThreadStore();
		store.getState().connect(2);
		latest().open();
		latest().fail(true);

		store.getState().disconnect();
		vi.advanceTimersByTime(60_000);

		expect(store.getState().thread).toBeUndefined();
		expect(sources()).toHaveLength(1);
	});
});

describe("losing the connection", () => {
	it("shows reconnecting while the browser retries by itself, and live again once it succeeds", () => {
		const store = createThreadStore();
		store.getState().connect(2);
		latest().open();
		latest().send(recordings.chatTurns.connections[0]?.[0] ?? []);

		latest().fail();
		expect(store.getState().thread?.connection).toBe("reconnecting");
		expect(sources()).toHaveLength(1);

		latest().open();
		expect(store.getState().thread?.connection).toBe("live");
	});

	it("reopens the stream itself, with growing delays, when the server refuses the connection, and starts over once it works", () => {
		const store = createThreadStore();
		store.getState().connect(2);
		latest().open();

		latest().fail(true);
		vi.advanceTimersByTime(999);
		expect(sources()).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sources()).toHaveLength(2);

		latest().fail(true);
		vi.advanceTimersByTime(1999);
		expect(sources()).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(sources()).toHaveLength(3);

		latest().open();
		latest().fail(true);
		vi.advanceTimersByTime(1000);
		expect(sources()).toHaveLength(4);
	});

	it("keeps what it showed while reconnecting, and replaces it with the new snapshot", () => {
		const store = createThreadStore();
		store.getState().connect(2);
		latest().open();
		const [cut, resumed] = recordings.restartResume.connections;
		for (const batch of cut ?? []) latest().send(batch);
		const before = store.getState().thread;

		latest().fail(true);
		expect(store.getState().thread?.entries).toBe(before?.entries);
		vi.advanceTimersByTime(1000);
		latest().open();
		for (const batch of resumed ?? []) latest().send(batch);

		const after = store.getState().thread;
		expect(after).toMatchObject({ connection: "live", running: false });
		expect(after?.entries.map((entry) => entry.model?.[0]?.role)).toStrictEqual(["user", "assistant", "assistant"]);
	});
});

describe("showing a thread", () => {
	it("only ever shows the thread of the conversation asked for, never the previous agent's during a switch", () => {
		const store = createThreadStore();
		store.getState().connect(2);

		expect(threadFor(store.getState(), 2)?.conversationId).toBe(2);
		// The view of agent 3 renders once before its effect has switched the store over.
		expect(threadFor(store.getState(), 3)).toBeUndefined();

		store.getState().disconnect();
		expect(threadFor(store.getState(), 2)).toBeUndefined();
	});
});

describe("sending", () => {
	it("posts the message with a requestId and the JSON content type, and gives the next message a new one", async () => {
		respondWith({ submissionId: 9 }, 202);
		const store = createThreadStore();
		store.getState().connect(2);

		await store.getState().send("hello there");
		await store.getState().send("hello there");

		const calls = fetchMock.mock.calls.map(([url, init]) => ({ url, init }));
		expect(calls[0]?.url).toBe("/api/conversations/2/messages");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(calls[0]?.init?.headers).toStrictEqual({ "content-type": "application/json" });
		const bodies = calls.map((call) => JSON.parse(String(call.init?.body)) as { content: string; requestId: string });
		expect(bodies[0]?.content).toBe("hello there");
		// The first was accepted, so the same words again are another message, not a retry of that one.
		expect(bodies[0]?.requestId).not.toBe(bodies[1]?.requestId);
	});

	it("keeps one requestId for one message across retries, so the server's duplicate check can protect it", async () => {
		const store = createThreadStore();
		store.getState().connect(2);
		const requestIds = async (): Promise<string[]> =>
			fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { requestId: string }).requestId);

		// The request reached the server, but the response was lost: the browser sees a failure and the user sends again.
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
		await expect(store.getState().send("pay the rent")).rejects.toThrow();
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
		await expect(store.getState().send("pay the rent")).rejects.toThrow();
		respondWith({ submissionId: 3 }, 202);
		await store.getState().send("pay the rent");
		const [first, second, third] = await requestIds();
		expect(second).toBe(first);
		expect(third).toBe(first);

		// Once accepted, the id is spent: the same words again are a new message.
		await store.getState().send("pay the rent");
		expect((await requestIds())[3]).not.toBe(first);
	});

	it("gives an edited message a new requestId, and does not carry an id from one conversation to another", async () => {
		const store = createThreadStore();
		store.getState().connect(2);
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));

		await expect(store.getState().send("draft one")).rejects.toThrow();
		await expect(store.getState().send("draft two")).rejects.toThrow();
		store.getState().connect(3);
		await expect(store.getState().send("draft two")).rejects.toThrow();

		const ids = fetchMock.mock.calls.map(
			([, init]) => (JSON.parse(String(init?.body)) as { requestId: string }).requestId,
		);
		expect(new Set(ids).size).toBe(3);
	});

	it("reports why a send failed and throws, so the composer can keep the text", async () => {
		fetchMock.mockResolvedValue(
			reply({ error: { code: "invalid_request", message: "'content' must be a non-empty string." } }, 400),
		);
		const store = createThreadStore();
		store.getState().connect(2);

		await expect(store.getState().send("x")).rejects.toThrow();

		expect(store.getState().sendError).toBe("'content' must be a non-empty string.");
	});

	it("says the server is unreachable when the request cannot be made, and clears the error on the next send", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
		const store = createThreadStore();
		store.getState().connect(2);

		await expect(store.getState().send("x")).rejects.toThrow();
		expect(store.getState().sendError).toContain("Cannot reach the assistant server");

		respondWith({ submissionId: 1 }, 202);
		await store.getState().send("x");
		expect(store.getState().sendError).toBeUndefined();
	});
});

describe("stopping and loading history", () => {
	it("posts an abort for the open conversation, and reports a failure instead of throwing", async () => {
		fetchMock.mockResolvedValueOnce(reply({ ok: true }));
		const store = createThreadStore();
		store.getState().connect(8);

		await store.getState().stop();
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/conversations/8/abort");

		fetchMock.mockResolvedValueOnce(reply({ error: { code: "internal_error", message: "boom" } }, 500));
		await store.getState().stop();
		expect(store.getState().sendError).toBe("boom");
	});

	it("asks for the page before the oldest entry it holds and puts it in front", async () => {
		const store = createThreadStore();
		store.getState().connect(2);
		latest().open();
		const snapshot = recordings.chatTurns.connections[1]?.[0] ?? [];
		latest().send(snapshot);
		const held = store.getState().thread?.entries ?? [];
		const oldest = held[0];
		if (oldest === undefined) throw new Error("fixture snapshot should hold entries");
		const older = { ...oldest, id: oldest.id - 5 };
		respondWith({ entries: [older], nextBefore: older.id });

		await store.getState().loadEarlier();

		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/conversations/2/messages?before=${oldest.id}&limit=50`);
		expect(store.getState().thread?.entries.map((entry) => entry.id)).toStrictEqual([
			older.id,
			...held.map((entry) => entry.id),
		]);
		expect(store.getState().thread?.hasEarlier).toBe(true);

		// The next request continues from the cursor the server gave, not from the oldest entry held.
		respondWith({ entries: [], nextBefore: older.id - 5 });
		await store.getState().loadEarlier();
		await store.getState().loadEarlier();
		expect(fetchMock.mock.calls.map(([url]) => String(url).match(/before=(\d+)/)?.[1])).toStrictEqual([
			String(oldest.id),
			String(older.id),
			String(older.id - 5),
		]);
	});
});

describe("a connection that dies without a word", () => {
	const open = () => {
		const store = createThreadStore();
		store.getState().connect(2);
		latest().open();
		latest().send(recordings.chatTurns.connections[0]?.[0] ?? []);
		return store;
	};

	it("reconnects when nothing, not even a ping, has arrived for too long", () => {
		const store = open();
		const first = latest();

		vi.advanceTimersByTime(SILENCE_LIMIT_MS - 1);
		expect(latest()).toBe(first);
		vi.advanceTimersByTime(2);

		expect(latest()).not.toBe(first);
		expect(first.readyState).toBe(FakeEventSource.CLOSED);
		expect(latest().url).toBe("/api/conversations/2/stream");
		expect(store.getState().thread?.connection).toBe("reconnecting");
		latest().open();
		expect(store.getState().thread?.connection).toBe("live");
	});

	it("treats every ping and every event as proof of life", () => {
		open();
		const first = latest();

		for (let i = 0; i < 6; i++) {
			vi.advanceTimersByTime(SILENCE_LIMIT_MS - 5_000);
			if (i % 2 === 0) first.ping();
			else first.send([]);
		}

		expect(latest()).toBe(first);
	});

	it("does not also fire the silence timer once the browser has reported the connection lost", () => {
		open();
		latest().fail(true);
		const afterError = sources().length;

		vi.advanceTimersByTime(1000); // the backoff before the retry
		expect(sources()).toHaveLength(afterError + 1);
		latest().open();
		vi.advanceTimersByTime(SILENCE_LIMIT_MS - 1);

		expect(sources()).toHaveLength(afterError + 1);
	});

	it("reconnects when the tab comes back after a quiet spell, but not when the connection was heard from recently", () => {
		open();
		const first = latest();
		vi.advanceTimersByTime(STALE_AFTER_MS - 1_000);
		first.ping();

		page.hide();
		vi.advanceTimersByTime(1_000);
		page.show();
		expect(latest()).toBe(first);

		vi.advanceTimersByTime(STALE_AFTER_MS + 1);
		page.show();
		expect(latest()).not.toBe(first);
	});

	it("reconnects when the network comes back, however recent the last message, and never when hidden tabs wake", () => {
		open();
		const first = latest();

		page.hide();
		expect(latest()).toBe(first);
		page.comeOnline();

		expect(latest()).not.toBe(first);
	});

	it("stops listening to the page, and stops its timers, when the thread is left", () => {
		const store = open();
		const count = sources().length;

		store.getState().disconnect();
		page.comeOnline();
		page.show();
		vi.advanceTimersByTime(SILENCE_LIMIT_MS * 2);

		expect(sources()).toHaveLength(count);
	});
});
