import { type EntryRecord, NOTICE_ENTRY_KIND, REMINDER_ENTRY_KIND } from "@assistant/shared";
import { describe, expect, it } from "vitest";
import { cardSummary } from "../src/lib/card-text.ts";
import { convertMessage } from "../src/lib/convert-message.ts";
import { applyEvents, createThreadState } from "../src/lib/thread-state.ts";
import { toUiMessages, type UiCard, type UiMessage } from "../src/lib/ui-messages.ts";
import { recordings } from "./fixtures.ts";

const cardsOf = (messages: UiMessage[]): UiCard[] =>
	messages.flatMap((message) => (message.role === "system" ? [message.card] : []));

/** What a connection's events build, as the thread would show it. */
function replay(connection: number, now = Date.now()) {
	const batches = recordings.remindersAndApprovals.connections[connection] ?? [];
	const state = batches.reduce((current, batch) => applyEvents(current, batch), createThreadState(2));
	return toUiMessages(state, now);
}

describe("a thread recorded from the real server: reminder, tasks and an approved deletion", () => {
	it("shows chat bubbles and cards in the order they happened", () => {
		const messages = replay(0);

		expect(
			messages.map((message) => (message.role === "system" ? `card:${message.card.type}` : message.role)),
		).toStrictEqual([
			"user",
			"card:task", // add_task: the saved task
			"assistant",
			"card:reminder", // fired a minute later, written without the model
			"user",
			"card:task",
			"assistant",
			"user",
			"card:approval", // propose_delete_task
			"assistant",
			"card:notice", // the outcome of the approval
		]);
	});

	it("renders the reminder from the zero-token write", () => {
		const [, reminder] = cardsOf(replay(0));

		expect(reminder).toMatchObject({
			type: "reminder",
			data: { title: "Pay rent", remindAtText: "Sun 25 Oct 2026, 14:01" },
		});
	});

	it("turns the approval card into what the notice says happened, not a button that is still live", () => {
		const approval = cardsOf(replay(0)).find((card) => card.type === "approval");

		expect(approval).toMatchObject({
			type: "approval",
			summary: "Delete task “Old report”",
			state: { status: "executed", text: "Deleted task “Old report”.", via: "button" },
		});
	});

	it("shows the same thread after a reload, which starts from a snapshot", () => {
		const live = replay(0);
		const reloaded = replay(1);

		const shape = (messages: UiMessage[]) =>
			messages.map((message) => (message.role === "system" ? message.card.type : message.role));
		expect(shape(reloaded)).toStrictEqual(shape(live));
		expect(cardsOf(reloaded).find((card) => card.type === "approval")).toMatchObject({ state: { status: "executed" } });
	});
});

describe("approval cards", () => {
	const NOW = 1_000_000;
	const approvalEntry = (id: number, actionId: string, expiresAt: number): EntryRecord =>
		({
			id,
			conversationId: 2,
			kind: "pi.tool-result",
			model: [
				{
					role: "toolResult",
					toolCallId: `call-${id}`,
					toolName: "propose_delete_task",
					content: [{ type: "text", text: "Approval requested" }],
					details: { type: "approval", actionId, summary: "Delete task “X”", expiresAt },
					isError: false,
					timestamp: NOW - 1000,
				},
			],
		}) as unknown as EntryRecord;
	const noticeEntry = (
		id: number,
		actionId: string,
		outcome: "executed" | "failed" | "denied",
		text: string,
	): EntryRecord =>
		({
			id,
			conversationId: 2,
			kind: NOTICE_ENTRY_KIND,
			data: { text, level: outcome === "failed" ? "error" : "info", approval: { actionId, outcome, via: "yes" } },
			model: [{ role: "user", content: "[Approval] ...", timestamp: NOW }],
		}) as unknown as EntryRecord;
	const stateOf = (entries: EntryRecord[], now = NOW) => {
		const card = cardsOf(toUiMessages({ entries, draft: undefined, unanswered: [] }, now)).find(
			(c) => c.type === "approval",
		);
		return card?.type === "approval" ? card.state : undefined;
	};

	it("waits while the request is open and before its deadline", () => {
		expect(stateOf([approvalEntry(1, "ap_1", NOW + 5000)])).toStrictEqual({ status: "pending" });
	});

	it("expires on its own once the deadline has passed and no answer came", () => {
		expect(stateOf([approvalEntry(1, "ap_1", NOW + 5000)], NOW + 5000)).toStrictEqual({ status: "expired" });
	});

	it.each([
		["executed", "Deleted task “X”."],
		["failed", "Approved, but it did not work: disk full"],
		["denied", "Denied: Delete task “X”. Nothing was changed."],
	] as const)("shows an answer of '%s', even after the deadline", (outcome, text) => {
		const entries = [approvalEntry(1, "ap_1", NOW + 5000), noticeEntry(2, "ap_1", outcome, text)];

		expect(stateOf(entries, NOW + 99_999)).toStrictEqual({ status: outcome, text, via: "yes" });
	});

	it("keeps requests apart: a notice settles only the card it names", () => {
		const entries = [
			approvalEntry(1, "ap_1", NOW + 5000),
			approvalEntry(2, "ap_2", NOW + 5000),
			noticeEntry(3, "ap_2", "denied", "Denied"),
		];
		const cards = cardsOf(toUiMessages({ entries, draft: undefined, unanswered: [] }, NOW));

		expect(cards.map((card) => (card.type === "approval" ? card.state.status : card.type))).toStrictEqual([
			"pending",
			"denied",
			"notice",
		]);
	});
});

describe("what is not a card", () => {
	const toolResult = (details: unknown, isError = false): EntryRecord =>
		({
			id: 1,
			conversationId: 2,
			kind: "pi.tool-result",
			model: [{ role: "toolResult", toolCallId: "c", toolName: "t", content: [], details, isError, timestamp: 5 }],
		}) as unknown as EntryRecord;
	const messagesOf = (entries: EntryRecord[]) => toUiMessages({ entries, draft: undefined, unanswered: [] });

	it("ignores tool results whose details are not a known card, and results without details", () => {
		expect(
			messagesOf([toolResult({ type: "diagnostics" }), toolResult(undefined, true), toolResult("plain")]),
		).toStrictEqual([]);
	});

	it("ignores reminder and notice entries that lack what a card needs, instead of rendering an empty card", () => {
		const entries = [
			{ id: 1, conversationId: 2, kind: REMINDER_ENTRY_KIND, data: { note: "no title" } },
			{ id: 2, conversationId: 2, kind: NOTICE_ENTRY_KIND },
		] as unknown as EntryRecord[];

		expect(messagesOf(entries)).toStrictEqual([]);
	});
});

describe("handing cards to assistant-ui", () => {
	it("makes a system message that carries the card in its metadata, with a one-line summary for readers that cannot show it", () => {
		const card: UiCard = { type: "notice", data: { text: "Deleted task “X”.", level: "info" } };

		const converted = convertMessage({ id: "card-5", role: "system", createdAt: 1, card });

		expect(converted).toMatchObject({ role: "system", id: "card-5", metadata: { custom: { card } } });
		expect(converted.content).toStrictEqual([{ type: "text", text: "Deleted task “X”." }]);
	});

	it("summarises every kind of card in words", () => {
		const task = { id: "t_1", title: "Pay rent", status: "open" as const };
		expect(
			cardSummary({
				type: "reminder",
				data: { taskId: "t_1", title: "Pay rent", remindAt: 1, remindAtText: "x", firedAt: 1 },
			}),
		).toBe("Reminder: Pay rent");
		expect(cardSummary({ type: "task", event: "completed", task })).toBe("Marked done: Pay rent");
		expect(cardSummary({ type: "task_list", heading: "Open tasks", tasks: [task], total: 3 })).toBe("Open tasks: 3");
		expect(
			cardSummary({ type: "approval", actionId: "a", summary: "Delete X", expiresAt: 1, state: { status: "pending" } }),
		).toBe("Approval needed: Delete X");
	});
});
