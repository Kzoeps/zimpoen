import { DAILY_ENTRY_KIND, type DailyEntryData } from "@assistant/shared";
import { UsageDoc } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	atLocalTime,
	type BudgetGate,
	createUsageService,
	dailyModule,
	dailyStore,
	taskStore,
	usageModule,
	usageStore,
	weekStartOf,
} from "../src/index.ts";
import { ctx, type Fixture, MINUTE, openFixture, say, TIMEZONE, waitFor } from "./support.ts";

const fixtures: Fixture[] = [];
async function open(...args: Parameters<typeof openFixture>): Promise<Fixture> {
	const fixture = await openFixture(...args);
	fixtures.push(fixture);
	return fixture;
}
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.close().catch(() => {});
		await fixture.dispose();
	}
});

const DAY = 24 * 60 * MINUTE;
const local = (date: string, time: string): number => atLocalTime(date, time, TIMEZONE);
const usage = (f: Fixture) => usageModule.service(f.deps);
const AGENTS = [
	{ id: "pa", name: "Assistant", avatar: "🧭" },
	{ id: "inbox", name: "Inbox", avatar: "📥" },
] as const;

type Ledger = Record<string, { tokens: number; input?: number; output?: number; cost?: number }>;

/**
 * Put Durable's running total for the conversation at exactly this: what its ledger holds after the model has spent that
 * much. (The ledger only grows when a model answers; this is the same document, written directly, so that a test can say
 * "1,000 tokens" and "0.5 dollars".)
 */
async function setLedger(f: Fixture, models: Ledger, tools: Ledger = {}): Promise<void> {
	const entry = (item: Ledger[string]) => ({
		input: item.input ?? item.tokens,
		output: item.output ?? 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: item.tokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: item.cost ?? 0 },
	});
	await f.harness.commit(async (tx) => {
		const doc = await tx.doc(UsageDoc, f.conversation.id);
		for (const key of Object.keys(doc.models)) delete doc.models[key];
		for (const key of Object.keys(doc.tools)) delete doc.tools[key];
		for (const [key, item] of Object.entries(models)) doc.models[key] = entry(item);
		for (const [key, item] of Object.entries(tools)) doc.tools[key] = entry(item);
	}, ctx);
}

const dayTokens = (f: Fixture, from: string, to: string, agent = "pa"): number =>
	usageStore.rangeCounters(f.db, agent, from, to).tokens;

describe("the week", () => {
	it("starts on the Monday, whichever day of it you ask from", () => {
		expect(weekStartOf("2026-10-26")).toBe("2026-10-26"); // Monday
		expect(weekStartOf("2026-10-25")).toBe("2026-10-19"); // Sunday belongs to the week before
		expect(weekStartOf("2026-10-28")).toBe("2026-10-26");
		expect(weekStartOf("2026-11-01")).toBe("2026-10-26");
		expect(weekStartOf("2027-01-01")).toBe("2026-12-28"); // across the year
	});
});

describe("sampling Durable's usage into days", () => {
	it("copies what was spent before the first look without dating it, then dates what is new to the day it was seen", async () => {
		const f = await open();
		await setLedger(f, { "faux/faux-1": { tokens: 5_000 } });

		await usage(f).sample();
		expect(dayTokens(f, "2000-01-01", "2100-01-01")).toBe(0);

		await setLedger(f, { "faux/faux-1": { tokens: 5_800 } });
		await usage(f).sample();
		expect(dayTokens(f, "2026-10-25", "2026-10-25")).toBe(800);

		// The next day's growth is the next day's.
		f.clock.now += DAY;
		await setLedger(f, { "faux/faux-1": { tokens: 6_000 } });
		await usage(f).sample();
		expect(dayTokens(f, "2026-10-25", "2026-10-25")).toBe(800);
		expect(dayTokens(f, "2026-10-26", "2026-10-26")).toBe(200);
	});

	it("counts nothing twice: reading again with no change, and many readings at once, add nothing", async () => {
		const f = await open();
		await usage(f).sample();
		await setLedger(f, { "faux/faux-1": { tokens: 1_000 } });

		await Promise.all([usage(f).sample(), usage(f).sample(), usage(f).sample(), usage(f).sample()]);
		await usage(f).sample();

		expect(dayTokens(f, "2026-10-25", "2026-10-25")).toBe(1_000);
	});

	it("follows a ledger that went down (a database restored from before) and counts the growth after it from there", async () => {
		const f = await open();
		await usage(f).sample();
		await setLedger(f, { "faux/faux-1": { tokens: 1_000 } });
		await usage(f).sample();

		await setLedger(f, { "faux/faux-1": { tokens: 400 } });
		await usage(f).sample();
		expect(dayTokens(f, "2026-10-25", "2026-10-25")).toBe(1_000); // never less than was seen

		await setLedger(f, { "faux/faux-1": { tokens: 700 } });
		await usage(f).sample();
		expect(dayTokens(f, "2026-10-25", "2026-10-25")).toBe(1_300);
	});

	it("counts a provider's fraction of a token to the nearest token: it is not a reason to skip the reading", async () => {
		const f = await open();
		await usage(f).sample();

		await setLedger(f, { "faux/faux-1": { tokens: 1_000.4, input: 600.6, output: 399.9 } });
		await usage(f).sample();

		expect(usageStore.rangeCounters(f.db, "pa", "2026-10-25", "2026-10-25")).toMatchObject({
			tokens: 1_000,
			input: 601,
			output: 400,
		});
	});

	it("says once in the log, not at every reading, that an agent's spending could not be read", async () => {
		const f = await open();
		const warnings: string[] = [];
		const service = createUsageService({
			...f.deps,
			harness: () => {
				throw new Error("the conversation is lost");
			},
			warn: (message) => warnings.push(message),
		});

		await service.sample();
		await service.sample();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/pa agent spent \(the conversation is lost\); the weekly limit does not see it/);
	});

	it("keeps models and tools apart, and money in whole micro-dollars", async () => {
		const f = await open();
		await usage(f).sample();

		await setLedger(
			f,
			{ "openai/gpt-6.1-sol": { tokens: 2_000, input: 1_500, output: 500, cost: 0.0123456789 } },
			{ codemode: { tokens: 300 } },
		);
		const report = await usage(f).report(AGENTS);

		const pa = report.agents.find((agent) => agent.id === "pa");
		expect(pa?.week).toMatchObject({ tokens: 2_300, input: 1_800, output: 500, cost: 0.012346 });
		expect(pa?.models).toStrictEqual([
			expect.objectContaining({
				model: "openai/gpt-6.1-sol",
				tokens: 2_000,
				input: 1_500,
				output: 500,
				cost: 0.012346,
			}),
			expect.objectContaining({ model: "tool:codemode", tokens: 300 }),
		]);
		expect(pa?.allTime.tokens).toBe(2_300);
	});

	it("samples what a real answer spent: the faux model reports tokens, and they are this week's", async () => {
		const f = await open();
		await usage(f).sample();
		f.faux.setResponses([say("Hello there, this is a reasonably long answer so that it counts for something.")]);

		await f.say("hello");
		await usage(f).sample();

		expect(dayTokens(f, "2026-10-25", "2026-10-25")).toBeGreaterThan(0);
	});
});

describe("the limit and the report", () => {
	it("has no standing for an agent without a limit, and reaches the limit at exactly the limit", async () => {
		const f = await open();
		await usage(f).sample();
		await setLedger(f, { "faux/faux-1": { tokens: 900 } });
		expect(await usage(f).check("pa")).toBeUndefined();

		usage(f).setLimit("pa", 1_000);
		expect(await usage(f).check("pa")).toMatchObject({ used: 900, limit: 1_000, over: false, weekStart: "2026-10-19" });

		await setLedger(f, { "faux/faux-1": { tokens: 1_000 } });
		expect(await usage(f).check("pa")).toMatchObject({ used: 1_000, limit: 1_000, over: true });

		usage(f).setLimit("pa", null);
		expect(await usage(f).check("pa")).toBeUndefined();
	});

	it("marks an agent as over on the dashboard at exactly its limit, as the banner and the daily jobs do", async () => {
		const f = await open();
		await usage(f).sample();
		usage(f).setLimit("pa", 1_000);
		const paOf = async () => (await usage(f).report(AGENTS)).agents.find((agent) => agent.id === "pa");

		await setLedger(f, { "faux/faux-1": { tokens: 999 } });
		expect(await paOf()).toMatchObject({ limit: 1_000, over: false, week: { tokens: 999 } });
		await setLedger(f, { "faux/faux-1": { tokens: 1_000 } });
		expect(await paOf()).toMatchObject({ limit: 1_000, over: true, week: { tokens: 1_000 } });

		f.clock.now += 31_000;
		expect(await usage(f).alerts(AGENTS)).toStrictEqual([
			{ agent: "pa", name: "Assistant", used: 1_000, limit: 1_000 },
		]);
		// An agent without a limit is never over, however much it spends.
		expect((await usage(f).report(AGENTS)).agents.find((agent) => agent.id === "inbox")).toMatchObject({ over: false });
	});

	it("counts the week from Monday: Sunday's spend does not weigh on Monday's limit", async () => {
		const f = await open();
		await usage(f).sample();
		usage(f).setLimit("pa", 1_000);
		await setLedger(f, { "faux/faux-1": { tokens: 1_500 } });
		expect(await usage(f).check("pa")).toMatchObject({ over: true }); // Sunday 25 October: the week of the 19th

		f.clock.now += DAY; // Monday 26 October
		expect(await usage(f).check("pa")).toMatchObject({ used: 0, over: false, weekStart: "2026-10-26" });
	});

	it("reports fourteen days and eight weeks, oldest first, with the quiet ones as zeros", async () => {
		const f = await open();
		await usage(f).sample();
		await setLedger(f, { "faux/faux-1": { tokens: 300 } });
		await usage(f).sample();
		f.clock.now += 2 * DAY;
		await setLedger(f, { "faux/faux-1": { tokens: 800 } });

		const report = await usage(f).report(AGENTS);

		expect(report).toMatchObject({ timezone: TIMEZONE, today: "2026-10-27", weekStart: "2026-10-26" });
		expect(report.days).toHaveLength(14);
		expect(report.days[0]?.date).toBe("2026-10-14");
		expect(report.days.at(-1)).toMatchObject({
			date: "2026-10-27",
			label: "Tue 27 Oct",
			tokens: 500,
			byAgent: { pa: 500 },
		});
		expect(report.days.find((day) => day.date === "2026-10-25")).toMatchObject({ tokens: 300 });
		expect(report.days.find((day) => day.date === "2026-10-26")).toMatchObject({ tokens: 0, byAgent: {} });
		expect(report.weeks).toHaveLength(8);
		expect(report.weeks.at(-1)).toMatchObject({ start: "2026-10-26", label: "Week of 26 Oct", tokens: 500 });
		expect(report.weeks.at(-2)).toMatchObject({ start: "2026-10-19", label: "Week of 19 Oct", tokens: 300 });
		expect(report.weeks[0]?.start).toBe("2026-09-07");
	});

	it("names the agents that reached their limit, for the banner", async () => {
		const f = await open();
		await usage(f).sample();
		usage(f).setLimit("pa", 100);
		usage(f).setLimit("inbox", 10_000_000);
		await setLedger(f, { "faux/faux-1": { tokens: 250 } });

		// The banner is asked every few seconds by every open tab: a reading younger than 30 seconds is reused, not repeated.
		expect(await usage(f).alerts(AGENTS)).toStrictEqual([]);
		f.clock.now += 31_000;
		expect(await usage(f).alerts(AGENTS)).toStrictEqual([{ agent: "pa", name: "Assistant", used: 250, limit: 100 }]);
	});
});

describe("the budget guard in the daily jobs", () => {
	/** A gate the test moves: the weekly standing of every agent. */
	function gate(state: { used: number; limit: number }): BudgetGate {
		return {
			check: async (agent) => ({
				agent,
				used: state.used,
				limit: state.limit,
				over: state.used >= state.limit,
				weekStart: "2026-10-26",
			}),
		};
	}

	const entries = async (f: Fixture) =>
		(await f.entriesOfKind(DAILY_ENTRY_KIND)).map((entry) => entry.data as unknown as DailyEntryData);
	const startDaily = async (f: Fixture) => {
		await dailyModule.start(f.deps);
		await dailyModule.scheduler(f.deps).reconcile();
	};
	const addTask = (f: Fixture, title: string, dueAt: number) =>
		taskStore.insertTask(
			f.db,
			{ title, notes: "", dueAt, dueAllDay: false, conversationId: Number(f.conversation.id), createdAt: f.clock.now },
			`call-${title}`,
		).row;

	it("posts the briefing as a plain card with its facts, asks the model nothing, and still pushes", async () => {
		const f = await open({ budget: gate({ used: 12_000, limit: 10_000 }) });
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);

		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(() => f.pushes.length > 0, "the briefing's push");

		expect(f.asked).toStrictEqual([]);
		expect(await f.entriesOfKind("pi.assistant")).toHaveLength(0);
		const [card] = await entries(f);
		expect(card).toMatchObject({
			job: "briefing",
			date: "2026-10-26",
			degraded: { usedTokens: 12_000, limitTokens: 10_000 },
		});
		expect(card?.empty).toBeUndefined();
		expect(JSON.stringify(card?.sections)).toContain("Pay rent");
		expect(f.posted.map((entry) => entry.requestId)).toContain("briefing:2026-10-26:empty");
		expect(dailyStore.requireSchedule(f.db, "briefing").lastRunDate).toBe("2026-10-26");
	});

	it("asks the model as before while the week is within its limit", async () => {
		const f = await open({ budget: gate({ used: 9_999, limit: 10_000 }) });
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		f.faux.setResponses([say("Good morning.")]);

		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(() => f.asked.length > 0, "the briefing");

		expect((await entries(f))[0]?.degraded).toBeUndefined();
		expect(f.asked.map((asked) => asked.requestId)).toStrictEqual(["briefing:2026-10-26"]);
	});

	it("posts the wrap-up as a plain card too, and still opens the journal day so that the owner can answer unasked", async () => {
		const f = await open({ budget: gate({ used: 50, limit: 10 }) });
		await startDaily(f);

		f.clock.now = local("2026-10-26", "21:00");
		f.advance(0);
		await waitFor(() => f.pushes.length > 0, "the wrap-up's push");

		expect(f.asked).toStrictEqual([]);
		expect((await entries(f))[0]).toMatchObject({ job: "wrapup", degraded: { usedTokens: 50, limitTokens: 10 } });
		expect(dailyStore.getJournal(f.db, "2026-10-26")).toMatchObject({ date: "2026-10-26" });
	});

	it("keeps a day with nothing to say as the one-line card it always was (the limit changes nothing there)", async () => {
		const f = await open({ budget: gate({ used: 12_000, limit: 10_000 }) });
		await startDaily(f);

		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(() => f.pushes.length > 0, "the briefing's push");

		const [card] = await entries(f);
		expect(card).toMatchObject({ job: "briefing", empty: true });
		expect(card?.degraded).toBeUndefined();
	});

	it("keeps the decision when the process dies after posting: a rerun does not ask the model for a day that got the plain card", async () => {
		const standing = { used: 12_000, limit: 10_000 };
		let hang: ((error: Error) => void) | undefined;
		let posts = 0;
		const wrapPost: NonNullable<Parameters<typeof openFixture>[0]>["wrapPost"] =
			(post) => async (conversationId, entry) => {
				const result = await post(conversationId, entry);
				if (entry.kind === DAILY_ENTRY_KIND && posts++ === 0) {
					await new Promise<never>((_resolve, reject) => {
						hang = reject;
					});
				}
				return result;
			};
		const f = await open({ wrapPost, budget: gate(standing) });
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(() => hang !== undefined, "the card to be posted");

		// The week turns (or the owner raises the limit) before the process is back: the first attempt's decision still stands.
		standing.limit = 1_000_000;
		const closing = f.harness.close(ctx);
		hang?.(new Error("process died"));
		await closing;
		f.db.close();

		const again = await open({ dir: f.dir, clock: f.clock, wrapPost, budget: gate(standing) });
		await waitFor(
			() => dailyStore.requireSchedule(again.db, "briefing").lastRunDate === "2026-10-26",
			"the repeated run",
		);

		expect(again.asked).toStrictEqual([]);
		expect(await again.entriesOfKind(DAILY_ENTRY_KIND)).toHaveLength(1);
		expect(await again.entriesOfKind("pi.assistant")).toHaveLength(0);
	});

	it("goes ahead when the limit cannot be read: a broken gate must not silence the briefing", async () => {
		const broken: BudgetGate = {
			check: async () => {
				throw new Error("usage ledger unreadable");
			},
		};
		const f = await open({ budget: broken });
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		f.faux.setResponses([say("Good morning.")]);

		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(() => f.asked.length > 0, "the briefing");

		expect(f.reports.some((report) => String(report.error).includes("weekly token limit"))).toBe(true);
	});
});
