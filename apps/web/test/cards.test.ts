import {
	AGENDA_ENTRY_KIND,
	type AgendaEntryData,
	BIRTHDAY_ENTRY_KIND,
	type BirthdayEntryData,
	type EntryRecord,
	FOLLOWUP_ENTRY_KIND,
	type FollowupEntryData,
	NOTICE_ENTRY_KIND,
	REMINDER_ENTRY_KIND,
} from "@assistant/shared";
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

describe("agenda, follow-up question and birthday cards", () => {
	const agenda: AgendaEntryData = {
		followupId: "f_1",
		title: "Meeting about the house",
		counterpart: "Dabtonog Realty",
		eventAt: 1_000,
		eventAtText: "Mon 26 Oct 2026, 10:00",
		today: true,
		points: ["Ask about the price", "Ask about parking"],
		firedAt: 5_000,
	};
	const question: FollowupEntryData = {
		followupId: "f_1",
		title: "Meeting about the house",
		kind: "meeting",
		stage: "ask",
		eventAt: 1_000,
		eventAtText: "Mon 26 Oct 2026, 10:00",
		chained: false,
		firedAt: 7_000,
	};
	const birthday: BirthdayEntryData = {
		personId: "p_1",
		name: "Pema",
		stage: "remind",
		year: 2026,
		dateText: "Tue 27 Oct 2026",
		turns: 36,
		firedAt: 9_000,
	};
	const entry = (id: number, kind: string, data: unknown): EntryRecord =>
		({ id, conversationId: 2, kind, data }) as unknown as EntryRecord;
	const messagesOf = (entries: EntryRecord[]) => toUiMessages({ entries, draft: undefined, unanswered: [] });

	it("shows each as a card of its own kind, stamped with the time its timer posted it", () => {
		const messages = messagesOf([
			entry(1, AGENDA_ENTRY_KIND, agenda),
			entry(2, FOLLOWUP_ENTRY_KIND, question),
			entry(3, BIRTHDAY_ENTRY_KIND, birthday),
			entry(4, BIRTHDAY_ENTRY_KIND, { ...birthday, stage: "check" }),
		]);

		expect(messages.map((message) => (message.role === "system" ? message.card.type : message.role))).toStrictEqual([
			"agenda",
			"followup_question",
			"birthday",
			"birthday",
		]);
		expect(messages.map((message) => message.createdAt)).toStrictEqual([5_000, 7_000, 9_000, 9_000]);
		expect(cardsOf(messages)[0]).toStrictEqual({ type: "agenda", data: agenda });
		expect(cardsOf(messages)[3]).toMatchObject({ type: "birthday", data: { stage: "check", year: 2026 } });
	});

	it("leaves out entries that lack what the card needs", () => {
		expect(
			messagesOf([
				entry(1, AGENDA_ENTRY_KIND, { ...agenda, points: undefined }),
				entry(2, AGENDA_ENTRY_KIND, { title: 3 }),
				entry(3, FOLLOWUP_ENTRY_KIND, { followupId: "f_1" }),
				entry(4, BIRTHDAY_ENTRY_KIND, { personId: "p_1" }),
				entry(5, FOLLOWUP_ENTRY_KIND, undefined),
			]),
		).toStrictEqual([]);
	});

	it("shows the cards that follow-up and people tools return in their results", () => {
		const result = (id: number, details: unknown): EntryRecord =>
			({
				id,
				conversationId: 2,
				kind: "pi.tool-result",
				model: [
					{
						role: "toolResult",
						toolCallId: `c${id}`,
						toolName: "t",
						content: [],
						details,
						isError: false,
						timestamp: id,
					},
				],
			}) as unknown as EntryRecord;
		const item = {
			id: "f_1",
			title: "Call the bank",
			kind: "commitment",
			status: "waiting",
			eventAt: 1,
			eventText: "x",
			agenda: [],
		};
		const person = { id: "p_1", name: "Pema", birthdayText: "27 Oct", nextText: "Tue 27 Oct 2026" };

		const types = cardsOf(
			messagesOf([
				result(1, { type: "followup", event: "created", followup: item }),
				result(2, { type: "followup_list", heading: "Which meeting?", followups: [item], total: 1 }),
				result(3, { type: "person", event: "created", person }),
				result(4, { type: "people_list", heading: "People", people: [person], total: 1 }),
			]),
		).map((card) => card.type);

		expect(types).toStrictEqual(["followup", "followup_list", "person", "people_list"]);
	});

	it("marks a question as answered once a later card records the outcome, closes the follow-up, or records the wish", () => {
		const result = (id: number, details: unknown): EntryRecord =>
			({
				id,
				conversationId: 2,
				kind: "pi.tool-result",
				model: [
					{
						role: "toolResult",
						toolCallId: `c${id}`,
						toolName: "t",
						content: [],
						details,
						isError: false,
						timestamp: id,
					},
				],
			}) as unknown as EntryRecord;
		const item = (id: string) => ({
			id,
			title: "x",
			kind: "meeting",
			status: "resolved",
			eventAt: 1,
			eventText: "x",
			agenda: [],
		});
		const person = { id: "p_1", name: "Pema", birthdayText: "27 Oct", nextText: "Tue 27 Oct 2026" };
		const check = { ...birthday, stage: "check" as const };

		const messages = messagesOf([
			entry(1, FOLLOWUP_ENTRY_KIND, question), // f_1: answered below
			entry(2, FOLLOWUP_ENTRY_KIND, { ...question, followupId: "f_2" }), // still open
			entry(3, FOLLOWUP_ENTRY_KIND, { ...question, followupId: "f_3" }), // closed without an outcome
			entry(4, BIRTHDAY_ENTRY_KIND, check), // 2026: answered below
			entry(5, BIRTHDAY_ENTRY_KIND, { ...check, year: 2027 }), // another year: open
			entry(6, FOLLOWUP_ENTRY_KIND, { ...question, followupId: "f_4" }), // asked after the outcome of f_1: open
			result(7, {
				type: "followup",
				event: "outcome",
				followup: item("f_1"),
				next: { ...item("f_4"), status: "waiting" },
			}),
			result(8, { type: "followup", event: "resolved", followup: item("f_3") }),
			result(9, { type: "person", event: "wish", person, wished: false, year: 2026 }),
		]);

		const answered = cardsOf(messages)
			.filter((card) => card.type === "followup_question" || card.type === "birthday")
			.map((card) => ("answered" in card ? card.answered : undefined));
		expect(answered).toStrictEqual([true, undefined, true, true, undefined, undefined]);
	});

	it("summarises them in words, and the question and the birthday differ by stage", () => {
		expect(cardSummary({ type: "agenda", data: agenda })).toBe("Agenda: Meeting about the house");
		expect(cardSummary({ type: "followup_question", data: question })).toBe("How did it go? Meeting about the house");
		expect(cardSummary({ type: "followup_question", data: { ...question, stage: "reask" } })).toBe(
			"Still open: how did it go? Meeting about the house",
		);
		expect(cardSummary({ type: "followup_question", data: { ...question, stage: "nudge" } })).toBe(
			"Due now: Meeting about the house",
		);
		expect(cardSummary({ type: "birthday", data: birthday })).toBe("Wish Pema a happy birthday");
		expect(cardSummary({ type: "birthday", data: { ...birthday, stage: "check" } })).toBe(
			"Did you wish Pema a happy birthday?",
		);
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
