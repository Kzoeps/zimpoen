import type { AssistantChatMessage, EntryRecord, StreamEvent, StreamSnapshot } from "@assistant/shared";
import { describe, expect, it } from "vitest";
import { convertMessage } from "../src/lib/convert-message.ts";
import {
	applyEvent,
	applyEvents,
	createThreadState,
	prependHistory,
	type ThreadState,
	unansweredMessage,
	withConnection,
} from "../src/lib/thread-state.ts";
import { toUiMessages, type UiMessage } from "../src/lib/ui-messages.ts";
import { recordings } from "./fixtures.ts";

const fresh = (): ThreadState => createThreadState(2);

/** Apply every batch of a connection, returning the state after each batch. */
function replay(state: ThreadState, batches: readonly (readonly StreamEvent[])[]): ThreadState[] {
	const states: ThreadState[] = [];
	let current = state;
	for (const batch of batches) {
		current = applyEvents(current, batch);
		states.push(current);
	}
	return states;
}

const last = <T>(items: readonly T[]): T => {
	const item = items.at(-1);
	if (item === undefined) throw new Error("expected at least one item");
	return item;
};

const assistantMessage = (content: AssistantChatMessage["content"], extra: Partial<AssistantChatMessage> = {}) =>
	({
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
		stopReason: "stop",
		timestamp: 1000,
		...extra,
	}) as AssistantChatMessage;
const entry = (id: number, model: unknown, kind = "pi.assistant"): EntryRecord =>
	({ id, conversationId: 2, kind, model: [model] }) as unknown as EntryRecord;
const snapshot = (entries: EntryRecord[], extra: Partial<StreamSnapshot> = {}): StreamSnapshot =>
	({
		type: "snapshot",
		entries,
		tools: [],
		nestedTools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: {},
		hasEarlier: false,
		unanswered: [],
		...extra,
	}) as unknown as StreamSnapshot;
const assistantText = (message: UiMessage | undefined): string =>
	message?.role === "assistant" ? message.parts.map((part) => part.text).join("") : "";

describe("replaying a recorded chat", () => {
	const [first, second] = recordings.chatTurns.connections;
	if (first === undefined || second === undefined) throw new Error("fixture needs two connections");

	it("shows the question, then the answer growing in place, then a finished answer", () => {
		const states = replay(fresh(), first);
		const finalState = last(states);

		expect(states[0]).toMatchObject({ ready: true, running: false });
		expect(toUiMessages(states[0] as ThreadState)).toStrictEqual([]);
		expect(finalState.running).toBe(false);
		expect(finalState.draft).toBeUndefined();
		const messages = toUiMessages(finalState);
		expect(messages.map((message) => message.role)).toStrictEqual(["user", "assistant"]);
		expect(messages[0]).toMatchObject({ text: "What is on my plate today?" });
		expect(messages[1]).toMatchObject({ status: { type: "complete" } });
		expect(assistantText(messages[1])).toContain("You said: “What is on my plate today?”");
	});

	it("streams monotonically: each state's visible text extends the previous one, under one stable message id", () => {
		const states = replay(fresh(), first);
		const streaming = states.flatMap((state) => {
			const assistant = toUiMessages(state).find((message) => message.role === "assistant");
			return assistant === undefined ? [] : [assistant];
		});

		expect(streaming.length).toBeGreaterThan(5);
		expect(new Set(streaming.map((message) => message.id)).size).toBe(1);
		for (let i = 1; i < streaming.length; i++) {
			expect(assistantText(streaming[i]).startsWith(assistantText(streaming[i - 1]))).toBe(true);
		}
		expect(streaming[0]).toMatchObject({ status: { type: "running" } });
		expect(last(streaming)).toMatchObject({ status: { type: "complete" } });
		const hadThinking = streaming.some(
			(message) => message.role === "assistant" && message.parts.some((part) => part.type === "reasoning"),
		);
		expect(hadThinking).toBe(true);
	});

	it("marks the thread running from run_start until run_end", () => {
		const states = replay(fresh(), first);
		const running = states.map((state) => state.running);

		expect(running.indexOf(true)).toBeGreaterThan(0);
		expect(running.lastIndexOf(true)).toBeLessThan(running.length - 1);
		expect(last(running)).toBe(false);
	});

	it("rebuilds the same thread from a reconnect snapshot, without duplicating anything", () => {
		const afterFirstTurn = last(replay(fresh(), first));

		const reconnected = replay(withConnection(afterFirstTurn, "reconnecting"), second);
		const fromScratch = replay(fresh(), second);

		const carried = toUiMessages(last(reconnected));
		expect(carried.map((message) => message.role)).toStrictEqual(["user", "assistant", "user", "assistant"]);
		expect(new Set(carried.map((message) => message.id)).size).toBe(4);
		expect(carried).toStrictEqual(toUiMessages(last(fromScratch)));
		expect(carried[2]).toMatchObject({ text: "And tomorrow?" });
	});
});

describe("replaying a stopped answer", () => {
	it("keeps what was written as a stopped message and raises no error notice", () => {
		const [connection] = recordings.stopMidway.connections;
		const state = last(replay(fresh(), connection ?? []));

		const messages = toUiMessages(state);
		expect(messages.map((message) => message.role)).toStrictEqual(["user", "assistant"]);
		expect(messages[1]).toMatchObject({ status: { type: "stopped" } });
		expect(assistantText(messages[1]).length).toBeGreaterThan(10);
		expect(state.running).toBe(false);
		expect(state.draft).toBeUndefined();
		expect(state.notice).toBeUndefined();
	});
});

describe("replaying a server restart", () => {
	const [cut, resumed] = recordings.restartResume.connections;

	it("holds the question and a partial answer when the connection drops", () => {
		const state = last(replay(fresh(), cut ?? []));

		expect(state.running).toBe(true);
		expect(toUiMessages(state).map((message) => message.role)).toStrictEqual(["user", "assistant"]);
		expect(toUiMessages(state)[1]).toMatchObject({ status: { type: "running" } });
	});

	it("after reconnecting, shows the cut-short partial, then the complete answer that replaces it, then idle", () => {
		const dropped = withConnection(last(replay(fresh(), cut ?? [])), "reconnecting");

		const states = replay(dropped, resumed ?? []);

		const afterSnapshot = toUiMessages(states[0] as ThreadState);
		expect(states[0]).toMatchObject({ running: true, connection: "reconnecting" });
		expect(afterSnapshot.map((message) => message.role)).toStrictEqual(["user", "assistant"]);
		expect(afterSnapshot[1]).toMatchObject({ status: { type: "stopped" } });

		const finalState = last(states);
		const finalMessages = toUiMessages(finalState);
		expect(finalMessages.map((message) => message.role)).toStrictEqual(["user", "assistant", "assistant"]);
		// Once an answer follows, the cut-short one is known to be a casualty of the restart, not a user's Stop.
		expect(finalMessages[1]).toMatchObject({ status: { type: "interrupted" } });
		expect(finalMessages[2]).toMatchObject({ status: { type: "complete" } });
		expect(new Set(finalMessages.map((message) => message.id)).size).toBe(3);
		expect(finalState.running).toBe(false);
	});
});

describe("replaying a message that gets no answer", () => {
	const [connection] = recordings.noModel.connections;

	it("keeps the reason with the user's message, in words, and does not leave a notice behind", () => {
		const state = last(replay(fresh(), connection ?? []));

		const [message] = toUiMessages(state);
		expect(toUiMessages(state).map((m) => m.role)).toStrictEqual(["user"]);
		expect(message?.role === "user" && message.notAnswered).toContain("no model it can use");
		expect(state.running).toBe(false);
		expect(state.notice).toBeUndefined();
		expect(state.unanswered).toMatchObject([
			{ reason: "no_model", entry: message ? Number(message.id.replace("user-", "")) : -1 },
		]);
	});

	it("still explains the message after a reload, because the snapshot carries the reason", () => {
		const [, reload] = recordings.noModel.connections;

		const reloaded = last(replay(fresh(), reload ?? []));

		const [message] = toUiMessages(reloaded);
		expect(reloaded.notice).toBeUndefined();
		expect(message?.role === "user" && message.notAnswered).toContain("no model it can use");
		expect(convertMessage(message as UiMessage)).toMatchObject({
			metadata: { custom: { notAnswered: expect.stringContaining("no model it can use") } },
		});
	});

	it("replaces what it knew with each snapshot, and leaves messages that were answered unmarked", () => {
		const user = (id: number) => entry(id, { role: "user", content: `m${id}`, timestamp: id }, "pi.user");
		const withReason = applyEvent(fresh(), {
			...snapshot([user(1), user(2)]),
			unanswered: [{ submissionId: 9, entry: 1, reason: "model_error", detail: "401" }],
		});
		expect(toUiMessages(withReason).map((m) => m.role === "user" && m.notAnswered)).toStrictEqual([
			"The model could not answer: 401",
			undefined,
		]);

		const cleared = applyEvent(withReason, snapshot([user(1), user(2)]));
		expect(cleared.unanswered).toStrictEqual([]);
	});

	it("shows a notice instead when the message never reached the transcript, and says nothing for a stop by the user", () => {
		const unanswered = (reason: string, entryId?: number) =>
			({
				type: "submission",
				record: {
					id: 5,
					type: "input",
					status: "unanswered",
					reason,
					...(entryId === undefined ? {} : { entry: entryId }),
				},
			}) as StreamEvent;

		expect(applyEvent(fresh(), unanswered("no_model")).notice?.message).toContain("no model it can use");
		expect(applyEvent(fresh(), unanswered("aborted", 3))).toStrictEqual(fresh());
		expect(applyEvent(fresh(), unanswered("reset", 3))).toStrictEqual(fresh());
	});
});

describe("applyEvent edge cases", () => {
	const usage = assistantMessage([]).usage;

	it("applies text, thinking and tool-call deltas to the right block and ignores deltas that do not fit", () => {
		let state = applyEvent(fresh(), {
			type: "message_start",
			message: assistantMessage([{ type: "thinking", thinking: "he" }]),
		});
		state = applyEvent(state, {
			type: "message_update",
			usage,
			changes: [
				{ type: "thinking_delta", contentIndex: 0, delta: "llo" },
				{ type: "text_start", contentIndex: 1, block: { type: "text", text: "a" } },
				{ type: "text_delta", contentIndex: 1, delta: "b" },
				{ type: "text_delta", contentIndex: 0, delta: "WRONG BLOCK" },
				{ type: "text_delta", contentIndex: 7, delta: "NO BLOCK" },
				{
					type: "toolcall_start",
					contentIndex: 2,
					block: { type: "toolCall", id: "c1", name: "t", arguments: { a: "x" } },
				},
				{ type: "toolcall_delta", contentIndex: 2, path: ["a"], delta: "yz" },
			],
		});

		expect(state.draft?.content).toStrictEqual([
			{ type: "thinking", thinking: "hello" },
			{ type: "text", text: "ab" },
			{ type: "toolCall", id: "c1", name: "t", arguments: { a: "xyz" } },
		]);
	});

	it("replaces the whole draft for a `message` change and ignores updates when nothing is streaming", () => {
		const idle = applyEvent(fresh(), { type: "message_update", usage, changes: [] });
		expect(idle).toStrictEqual(fresh());

		const started = applyEvent(fresh(), {
			type: "message_start",
			message: assistantMessage([{ type: "text", text: "x" }]),
		});
		const replaced = applyEvent(started, {
			type: "message_update",
			usage,
			changes: [{ type: "message", message: assistantMessage([{ type: "text", text: "whole" }]) }],
		});
		expect(replaced.draft?.content).toStrictEqual([{ type: "text", text: "whole" }]);
	});

	it("never mutates the state it was given", () => {
		const started = applyEvent(fresh(), {
			type: "message_start",
			message: assistantMessage([{ type: "text", text: "x" }]),
		});
		const frozen = structuredClone(started);

		applyEvent(started, {
			type: "message_update",
			usage,
			changes: [{ type: "text_delta", contentIndex: 0, delta: "y" }],
		});

		expect(started).toStrictEqual(frozen);
	});

	it("orders a snapshot by entry id even when a head marker with a higher id comes first", () => {
		const marker = entry(90, { role: "user", content: "summary", timestamp: 1 }, "pi.compaction");
		const state = applyEvent(
			fresh(),
			snapshot([
				marker,
				entry(60, { role: "user", content: "older", timestamp: 2 }, "pi.user"),
				entry(91, { role: "user", content: "newer", timestamp: 3 }, "pi.user"),
			]),
		);

		expect(state.entries.map((e) => e.id)).toStrictEqual([60, 90, 91]);
		expect(toUiMessages(state).map((m) => (m.role === "user" ? m.text : ""))).toStrictEqual(["older", "newer"]);
	});

	it("keeps loaded history that connects to a new snapshot and drops history that does not, saying earlier entries exist", () => {
		const user = (id: number) => entry(id, { role: "user", content: `m${id}`, timestamp: id }, "pi.user");
		const held = { ...fresh(), ready: true, entries: [user(1), user(2), user(3), user(4)] } satisfies ThreadState;

		const connected = applyEvent(held, snapshot([user(3), user(4), user(5)]));
		const gap = applyEvent(held, snapshot([user(50), user(51)], { hasEarlier: false }));

		expect(connected.entries.map((e) => e.id)).toStrictEqual([1, 2, 3, 4, 5]);
		expect(gap.entries.map((e) => e.id)).toStrictEqual([50, 51]);
		expect(gap.hasEarlier).toBe(true);
	});

	it("prepends history pages once, oldest first, and records whether more exists", () => {
		const user = (id: number) => entry(id, { role: "user", content: `m${id}`, timestamp: id }, "pi.user");
		const state = { ...fresh(), entries: [user(5), user(6)], hasEarlier: true, earlierBefore: 5 } satisfies ThreadState;

		const once = prependHistory(state, [user(3), user(4), user(5)], 3);
		const twice = prependHistory(once, [user(1), user(2)], undefined);

		expect(once.entries.map((e) => e.id)).toStrictEqual([3, 4, 5, 6]);
		expect(twice.entries.map((e) => e.id)).toStrictEqual([1, 2, 3, 4, 5, 6]);
		expect([once.hasEarlier, twice.hasEarlier]).toStrictEqual([true, false]);
	});

	it("follows the server's cursor, so a page of hidden entries cannot be requested forever", () => {
		const user = (id: number) => entry(id, { role: "user", content: `m${id}`, timestamp: id }, "pi.user");
		const fromSnapshot = applyEvent(fresh(), snapshot([user(40), user(41)], { hasEarlier: true }));
		expect(fromSnapshot.earlierBefore).toBe(40);

		// The page before 40 held only system entries: nothing visible to add, but the cursor moved on.
		const emptyPage = prependHistory(fromSnapshot, [], 30);

		expect(emptyPage.entries).toStrictEqual(fromSnapshot.entries);
		expect(emptyPage).toMatchObject({ hasEarlier: true, earlierBefore: 30 });
	});

	it("ignores entries it has no view for, and an entry that arrives twice", () => {
		const reminder = { id: 7, conversationId: 2, kind: "app.reminder", data: { text: "x" } } as unknown as EntryRecord;
		const answer = entry(8, assistantMessage([{ type: "text", text: "hi" }]));

		let state = applyEvent(fresh(), { type: "entry_appended", entry: reminder });
		state = applyEvent(state, { type: "message_end", entry: answer });
		state = applyEvent(state, { type: "message_end", entry: answer });

		expect(state.entries.map((e) => e.id)).toStrictEqual([7, 8]);
		expect(toUiMessages(state)).toHaveLength(1);
	});

	it("shows model errors as an error bubble, cut-off answers as such, and hides empty stopped messages", () => {
		const errored = entry(
			1,
			assistantMessage([], { stopReason: "error", errorMessage: "429 rate limited", timestamp: 1 }),
		);
		const cut = entry(2, assistantMessage([{ type: "text", text: "partial" }], { stopReason: "length", timestamp: 2 }));
		const emptyStopped = entry(3, assistantMessage([], { stopReason: "aborted", timestamp: 3 }));

		const messages = toUiMessages({ entries: [errored, cut, emptyStopped], draft: undefined, unanswered: [] });

		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ status: { type: "error", message: "429 rate limited" } });
		expect(messages[1]).toMatchObject({ status: { type: "cut-off" } });
	});

	it("keeps unique ids even if two answers share a timestamp", () => {
		const a = entry(1, assistantMessage([{ type: "text", text: "a" }], { timestamp: 5 }));
		const b = entry(2, assistantMessage([{ type: "text", text: "b" }], { timestamp: 5 }));

		const ids = toUiMessages({ entries: [a, b], draft: undefined, unanswered: [] }).map((m) => m.id);

		expect(new Set(ids).size).toBe(2);
	});

	it("shows a retry notice while the model is retried and clears it when the run ends", () => {
		let state = applyEvent(fresh(), { type: "auto_retry_start", attempt: 2, at: 0, errorMessage: "overloaded" });
		expect(state.notice).toStrictEqual({
			kind: "retry",
			message: "The model returned an error, trying again (attempt 2): overloaded",
		});

		state = applyEvent(state, { type: "auto_retry_end", attempt: 2 });
		expect(state.notice).toBeUndefined();
	});

	it("explains each way a message can go unanswered, and stays quiet when the user stopped it", () => {
		const record = (reason: string, detail?: string) =>
			({ type: "input", status: "unanswered", reason, ...(detail === undefined ? {} : { detail }) }) as never;

		expect(unansweredMessage(record("aborted"))).toBeUndefined();
		expect(unansweredMessage(record("reset"))).toBeUndefined();
		expect(unansweredMessage(record("model_error", "401 unauthorized"))).toBe(
			"The model could not answer: 401 unauthorized",
		);
		expect(unansweredMessage(record("faulted", "boom"))).toContain("internal error");
		expect(unansweredMessage(record("something_new"))).toContain("something_new");
		expect(unansweredMessage({ type: "input", status: "done" } as never)).toBeUndefined();
	});
});

describe("convertMessage", () => {
	it("gives assistant-ui user text and assistant text with reasoning, with a status for each outcome", () => {
		const base = { id: "assistant-1", role: "assistant", createdAt: 5 } as const;
		const parts = [
			{ type: "reasoning", text: "thinking" },
			{ type: "text", text: "answer" },
		] as const;

		expect(convertMessage({ id: "user-1", role: "user", createdAt: 5, text: "hi" })).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "hi" }],
		});
		const converted = convertMessage({ ...base, parts: [...parts], status: { type: "complete" } });
		expect(converted).toMatchObject({
			role: "assistant",
			content: [...parts],
			status: { type: "complete", reason: "stop" },
		});
		expect(convertMessage({ ...base, parts: [], status: { type: "running" } }).status).toStrictEqual({
			type: "running",
		});
		expect(convertMessage({ ...base, parts: [], status: { type: "stopped" } }).status).toStrictEqual({
			type: "incomplete",
			reason: "cancelled",
		});
		expect(convertMessage({ ...base, parts: [], status: { type: "interrupted" } }).status).toStrictEqual({
			type: "incomplete",
			reason: "other",
		});
		expect(convertMessage({ ...base, parts: [], status: { type: "cut-off" } }).status).toStrictEqual({
			type: "incomplete",
			reason: "length",
		});
		expect(convertMessage({ ...base, parts: [], status: { type: "error", message: "bad" } }).status).toStrictEqual({
			type: "incomplete",
			reason: "error",
			error: "bad",
		});
	});
});
