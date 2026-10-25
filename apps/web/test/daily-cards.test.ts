import {
	DAILY_ENTRY_KIND,
	type DailyEntryData,
	type EntryRecord,
	type FileSummary,
	type JournalCardItem,
} from "@assistant/shared";
import { describe, expect, it } from "vitest";
import { cardSummary } from "../src/lib/card-text.ts";
import { convertMessage } from "../src/lib/convert-message.ts";
import { toUiMessages, type UiCard, type UiMessage } from "../src/lib/ui-messages.ts";

const briefing: DailyEntryData = {
	job: "briefing",
	date: "2026-10-26",
	dateText: "Mon 26 Oct 2026",
	sections: [{ title: "Tasks due today", lines: ["Pay rent (t_1), due 23:00"] }],
	firedAt: 5_000,
};
const wrapup: DailyEntryData = {
	...briefing,
	job: "wrapup",
	sections: [{ title: "Done today", lines: ["Pay rent"] }],
	firedAt: 90_000,
};
const nothingToday: DailyEntryData = { ...briefing, sections: [], empty: true };

const entry = (id: number, kind: string, rest: object): EntryRecord =>
	({ id, conversationId: 2, kind, ...rest }) as unknown as EntryRecord;
/** The request is a custom entry whose model message is the user's: the thread must show a card, not a bubble. */
const daily = (id: number, data: DailyEntryData): EntryRecord =>
	entry(id, DAILY_ENTRY_KIND, {
		data,
		...(data.empty === true ? {} : { model: [{ role: "user", content: "Briefing request", timestamp: data.firedAt }] }),
	});
const owner = (id: number, content: string): EntryRecord =>
	entry(id, "pi.user", { model: [{ role: "user", content, timestamp: id * 1_000 }] });
const answer = (id: number, text: string): EntryRecord =>
	entry(id, "pi.assistant", {
		model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: id * 1_000 }],
	});
const toolCard = (id: number, details: unknown): EntryRecord =>
	entry(id, "pi.tool-result", {
		model: [
			{
				role: "toolResult",
				toolCallId: `c${id}`,
				toolName: "t",
				content: [],
				details,
				isError: false,
				timestamp: id * 1_000,
			},
		],
	});

const messagesOf = (entries: EntryRecord[]): UiMessage[] => toUiMessages({ entries, draft: undefined, unanswered: [] });
const chipsOf = (messages: UiMessage[]): Array<string | undefined> =>
	messages.flatMap((message) => (message.role === "assistant" ? [message.chip] : []));
const cardsOf = (messages: UiMessage[]): UiCard[] =>
	messages.flatMap((message) => (message.role === "system" ? [message.card] : []));

describe("the briefing and the wrap-up in the thread", () => {
	it("shows the request as a card stamped with the time it ran, not as a message from the owner", () => {
		const messages = messagesOf([daily(1, briefing)]);

		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ role: "system", createdAt: 5_000, card: { type: "daily", data: briefing } });
	});

	it("puts a chip on the first answer after a briefing and on no other", () => {
		const messages = messagesOf([
			daily(1, briefing),
			answer(2, "Good morning. Pay rent today."),
			answer(3, "Anything else?"),
		]);

		const [first, second] = chipsOf(messages);
		expect(first).toMatch(/Morning briefing/);
		expect(second).toBeUndefined();
	});

	it("keeps the chip when the assistant looks something up first and its card lands before the answer", () => {
		const tasks = { type: "task_list", heading: "Open tasks", tasks: [], total: 0 };

		const messages = messagesOf([daily(1, briefing), toolCard(2, tasks), answer(3, "Good morning.")]);

		expect(cardsOf(messages).map((card) => card.type)).toStrictEqual(["daily", "task_list"]);
		expect(chipsOf(messages)[0]).toMatch(/Morning briefing/);
	});

	it("does not label a reply once the owner has spoken", () => {
		const messages = messagesOf([daily(1, briefing), owner(2, "What about Friday?"), answer(3, "Friday is free.")]);

		expect(chipsOf(messages)).toStrictEqual([undefined]);
	});

	it("labels the answer to a wrap-up with the wrap-up's name, and the next briefing starts again", () => {
		const messages = messagesOf([
			daily(1, wrapup),
			answer(2, "What did you get done today?"),
			owner(3, "Paid rent"),
			answer(4, "Saved."),
			daily(5, { ...briefing, firedAt: 200_000 }),
			answer(6, "Good morning."),
		]);

		const [wrapUpAnswer, reply, nextBriefing] = chipsOf(messages);
		expect(wrapUpAnswer).toMatch(/Evening wrap-up/);
		expect(reply).toBeUndefined();
		expect(nextBriefing).toMatch(/Morning briefing/);
	});

	it("labels nothing after a briefing that stood alone because there was nothing to report", () => {
		const messages = messagesOf([daily(1, briefing), daily(2, nothingToday), answer(3, "Hello!")]);

		expect(cardsOf(messages).map((card) => (card.type === "daily" ? card.data.empty === true : false))).toStrictEqual([
			false,
			true,
		]);
		expect(chipsOf(messages)).toStrictEqual([undefined]);
	});

	it("leaves out a daily entry that has no known job or no facts, instead of drawing an empty card", () => {
		expect(
			messagesOf([
				entry(1, DAILY_ENTRY_KIND, { data: { ...briefing, job: "lunch" } }),
				entry(2, DAILY_ENTRY_KIND, { data: { ...briefing, sections: undefined } }),
				entry(3, DAILY_ENTRY_KIND, {}),
			]),
		).toStrictEqual([]);
	});
});

describe("files in the owner's messages", () => {
	it("turns the reference lines at the end of a message into files and shows only the words as text", () => {
		const messages = messagesOf([
			owner(
				1,
				"The March statement\n\n[Attached file: bank march.csv · text/csv · 1.5 MB · id fi_deadbeef]\n[Attached file: receipt.png · image/png · 340 KB · id fi_0a1b2c3d]",
			),
		]);

		expect(messages[0]).toMatchObject({
			role: "user",
			text: "The March statement",
			files: [
				{ id: "fi_deadbeef", name: "bank march.csv", mime: "text/csv", sizeText: "1.5 MB" },
				{ id: "fi_0a1b2c3d", name: "receipt.png", mime: "image/png", sizeText: "340 KB" },
			],
		});
	});

	it("shows a message made only of files with no text, and a plain message without a files list", () => {
		const [filesOnly, plain] = messagesOf([
			owner(1, "[Attached file: receipt.png · image/png · 340 KB · id fi_0a1b2c3d]"),
			owner(2, "Nothing attached"),
		]);

		expect(filesOnly).toMatchObject({ role: "user", text: "" });
		expect(plain).not.toHaveProperty("files");
	});

	it("hands the files of a message and the chip of an answer to the components in the metadata they read", () => {
		const [user, assistant] = messagesOf([
			owner(1, "Look\n\n[Attached file: receipt.png · image/png · 340 KB · id fi_0a1b2c3d]"),
			daily(2, briefing),
			answer(3, "Good morning."),
		]).filter((message) => message.role !== "system");

		expect(convertMessage(user as UiMessage).metadata?.custom).toMatchObject({
			files: [{ id: "fi_0a1b2c3d", name: "receipt.png" }],
		});
		expect(convertMessage(assistant as UiMessage).metadata?.custom).toMatchObject({
			chip: expect.stringMatching(/Morning briefing/),
		});
	});

	it("adds no metadata to a message that has nothing to carry", () => {
		const [plain, reply] = messagesOf([owner(1, "Hi"), answer(2, "Hello")]);

		expect(convertMessage(plain as UiMessage).metadata).toBeUndefined();
		expect(convertMessage(reply as UiMessage).metadata).toBeUndefined();
	});
});

describe("journal and file results", () => {
	const csv: FileSummary = {
		id: "fi_deadbeef",
		name: "bank march.csv",
		mime: "text/csv",
		kind: "csv",
		size: 1_572_864,
		description: "The March bank statement",
		tags: ["bank", "2026-03"],
		source: "upload",
		addedAt: 1,
	};
	const day = (date: string, rest: Partial<JournalCardItem> = {}): JournalCardItem => ({
		date,
		dateText: date,
		carriedOver: [],
		...rest,
	});

	it("shows what the journal and file tools return as cards, in the place they were made", () => {
		const cards = cardsOf(
			messagesOf([
				toolCard(1, { type: "journal", event: "saved", entries: [day("2026-10-26", { userLog: "Paid rent" })] }),
				toolCard(2, { type: "file", event: "described", file: csv }),
				toolCard(3, { type: "file_list", heading: "Files", files: [csv], total: 1 }),
			]),
		);

		expect(cards.map((card) => card.type)).toStrictEqual(["journal", "file", "file_list"]);
		expect(cards[1]).toMatchObject({ file: { name: "bank march.csv", description: "The March bank statement" } });
	});

	it("says each in one line for readers that cannot show the card", () => {
		const summaries = (
			[
				{ type: "daily", data: briefing },
				{ type: "daily", data: wrapup },
				{ type: "daily", data: nothingToday },
				{ type: "journal", event: "saved", entries: [day("2026-10-26")] },
				{ type: "journal", event: "shown", entries: [day("2026-10-25"), day("2026-10-26")] },
				{ type: "file", event: "described", file: csv },
				{ type: "file", event: "registered", file: csv },
				{ type: "file_list", heading: "Files matching “bank”", files: [csv], total: 4 },
			] satisfies UiCard[]
		).map(cardSummary);

		expect(summaries).toStrictEqual([
			"Morning briefing, Mon 26 Oct 2026",
			"Evening wrap-up, Mon 26 Oct 2026",
			"Morning briefing, Mon 26 Oct 2026: nothing today",
			"Journal saved: 2026-10-26",
			"Journal: 2026-10-25, 2026-10-26",
			"File described: bank march.csv",
			"File found: bank march.csv",
			"Files matching “bank”: 4",
		]);
	});
});
