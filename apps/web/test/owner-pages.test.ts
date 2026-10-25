import {
	type BudgetHealth,
	canPin,
	type DailyEntryData,
	type MemoryCard,
	type MemoryFactView,
	type MemoryListCard,
} from "@assistant/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardView } from "../src/components/cards.tsx";
import { BudgetBanner } from "../src/components/chat-shell.tsx";
import { MemoryCardView, MemoryListView } from "../src/components/memory-cards.tsx";
import { cardSummary } from "../src/lib/card-text.ts";
import {
	activityQueryString,
	cacheShare,
	formatCost,
	formatTokens,
	memoryQueryString,
	moveTargets,
	originLabel,
	parseTokenLimit,
	percentOf,
} from "../src/lib/owner-pages.ts";

const fact: MemoryFactView = {
	id: "m_ab12cd34",
	scope: "shared",
	kind: "preference",
	text: "Keep answers short.",
	pinned: false,
	source: "agent",
	createdAt: 1,
	updatedAt: 1,
};

describe("what the owner types as a weekly limit", () => {
	it.each([
		["500000", 500_000],
		["500,000", 500_000],
		[" 500 000 ", 500_000],
		["500k", 500_000],
		["1.5M", 1_500_000],
		["2m", 2_000_000],
		["", null],
		["   ", null],
	])("reads %j as %j", (text, expected) => {
		expect(parseTokenLimit(text)).toBe(expected);
	});

	it.each(["abc", "0", "-5", "1e6", "1.5.2", "k", "12 tokens", "99999999999999999999"])("does not take %j", (text) => {
		expect(parseTokenLimit(text)).toBeUndefined();
	});
});

describe("how the numbers read", () => {
	it("writes tokens with separators, millions short, and money at the precision that shows something", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(12_345)).toBe("12,345");
		expect(formatTokens(1_250_000)).toBe("1.3M");
		expect(formatTokens(25_000_000)).toBe("25M");
		expect(formatCost(0)).toBe("$0");
		expect(formatCost(0.0034)).toBe("$0.0034");
		expect(formatCost(12.3456)).toBe("$12.35");
	});

	it("fills a bar to the share used, and never past full", () => {
		expect(percentOf(250, 1_000)).toBe(25);
		expect(percentOf(5_000, 1_000)).toBe(100);
		expect(percentOf(10, undefined)).toBe(0);
		expect(cacheShare({ input: 10, output: 10, cacheRead: 70, cacheWrite: 10, tokens: 100, cost: 0 })).toBe(80);
		expect(cacheShare({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 })).toBe(0);
	});
});

describe("what the pages ask the server", () => {
	it("sends only the filters that are set, and never 'all' or an empty day", () => {
		expect(activityQueryString({})).toBe("");
		expect(activityQueryString({ agent: "all", from: "", to: "" })).toBe("");
		expect(activityQueryString({ agent: "health", from: "2026-10-01", to: "2026-10-26", cursor: "abc" })).toBe(
			"?agent=health&from=2026-10-01&to=2026-10-26&cursor=abc",
		);
		expect(memoryQueryString({ scope: "all", kind: "all", q: "  " })).toBe("");
		expect(memoryQueryString({ scope: "pa", q: " green tea " })).toBe("?scope=pa&q=green+tea");
	});
});

describe("the cards of remember and recall", () => {
	it("says what was kept, for whom, and where to change it", () => {
		const card: MemoryCard = { type: "memory", event: "saved", fact };
		const html = renderToStaticMarkup(createElement(MemoryCardView, { card }));

		expect(html).toContain("Remembered");
		expect(html).toContain("Preference for every agent");
		expect(html).toContain("Keep answers short.");
		expect(html).toContain('href="/profile"');
		expect(renderToStaticMarkup(createElement(MemoryCardView, { card: { ...card, event: "existing" } }))).toContain(
			"Already remembered",
		);
	});

	it("lists what recall found, and says so when nothing matched", () => {
		const found: MemoryListCard = { type: "memory_list", heading: "Recalled: “short”", facts: [fact], total: 1 };
		const none: MemoryListCard = { ...found, facts: [], total: 0 };

		expect(renderToStaticMarkup(createElement(MemoryListView, { card: found }))).toContain("1 found");
		expect(renderToStaticMarkup(createElement(MemoryListView, { card: none }))).toContain("nothing");
	});

	it("is summarised in one line for a screen reader or a notification", () => {
		expect(cardSummary({ type: "memory", event: "saved", fact })).toBe("Remembered: Keep answers short.");
		expect(cardSummary({ type: "memory_list", heading: "Recalled: “short”", facts: [fact], total: 1 })).toBe(
			"Recalled: “short”: 1",
		);
	});
});

describe("a briefing that the weekly limit made a plain card", () => {
	const data: DailyEntryData = {
		job: "briefing",
		date: "2026-10-26",
		dateText: "Mon 26 Oct 2026",
		sections: [{ title: "Tasks and reminders today", lines: ["Pay rent — due 09:00"] }],
		degraded: { usedTokens: 12_000, limitTokens: 10_000 },
		firedAt: 5_000,
	};

	it("says why, with the numbers, shows the facts open, and links to the limits", () => {
		const html = renderToStaticMarkup(createElement(CardView, { card: { type: "daily", data } }));

		expect(html).toContain('data-testid="degraded-note"');
		expect(html).toContain("12,000 of");
		expect(html).toContain("10,000");
		expect(html).toContain("no model wrote this");
		expect(html).toContain('<details class="card__facts" open="">');
		expect(html).toContain("Pay rent");
		expect(html).toContain('href="/usage"');
	});

	it("is not shown as degraded when the run was an ordinary one", () => {
		const { degraded: _gone, ...ordinary } = data;
		expect(renderToStaticMarkup(createElement(CardView, { card: { type: "daily", data: ordinary } }))).not.toContain(
			"degraded-note",
		);
		expect(cardSummary({ type: "daily", data })).toContain("plain version");
	});
});

describe("the banner", () => {
	const over: BudgetHealth = { over: [{ agent: "pa", name: "Assistant", used: 12_000, limit: 10_000 }] };

	it("names the agent, the numbers and what still works", () => {
		const html = renderToStaticMarkup(createElement(BudgetBanner, { budget: over }));

		expect(html).toContain('data-testid="budget-banner"');
		expect(html).toContain("Assistant has used its weekly token limit (12,000 of 10,000)");
		expect(html).toContain("what you type still gets an answer");
		expect(html).toContain('href="/usage"');
	});

	it("speaks in the plural for two agents", () => {
		const two: BudgetHealth = { over: [...over.over, { agent: "inbox", name: "Inbox", used: 5, limit: 1 }] };
		expect(renderToStaticMarkup(createElement(BudgetBanner, { budget: two }))).toContain(
			"Assistant and Inbox have used their weekly token limit",
		);
	});
});

describe("moving, pinning and who a remembered line came from", () => {
	const line = (change: Partial<MemoryFactView>): MemoryFactView => ({ ...fact, ...change });

	it("offers every place but the one the line is in, and none for the profile's own lines", () => {
		expect(moveTargets(line({ scope: "pa" })).map((target) => target.label)).toStrictEqual([
			"Every agent",
			"Inbox",
			"Health",
			"Accountant",
		]);
		expect(moveTargets(line({ scope: "shared" })).map((target) => target.scope)).toStrictEqual([
			"pa",
			"inbox",
			"health",
			"accountant",
		]);
		expect(moveTargets(line({ scope: "shared", slot: "tone" }))).toStrictEqual([]);
	});

	it("pins only a fact kept for one agent", () => {
		expect(canPin({ kind: "fact", scope: "pa" })).toBe(true);
		expect(canPin({ kind: "preference", scope: "pa" })).toBe(false);
		expect(canPin({ kind: "fact", scope: "shared" })).toBe(false);
	});

	it("says who wrote a line: the owner, an agent that was approved for a preference, an agent that noted a fact", () => {
		const origin = { agent: "accountant", conversationId: 4, at: 1 } as const;
		expect(originLabel(line({ source: "owner" }))).toBe("written by you");
		expect(originLabel(line({ kind: "preference", origin }))).toBe(
			"asked for by the Accountant agent, and you approved it",
		);
		expect(originLabel(line({ kind: "fact", origin }))).toBe("noted by the Accountant agent");
		expect(originLabel(line({ origin: undefined }))).toBe("kept by an agent");
	});

	it("asks for the whole of a scope in one request", () => {
		expect(memoryQueryString({ scope: "pa", limit: 500 })).toBe("?scope=pa&limit=500");
	});
});
