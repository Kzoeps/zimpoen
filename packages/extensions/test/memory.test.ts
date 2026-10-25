import type { MemoryCard, MemoryListCard } from "@assistant/shared";
import { toolCardOf } from "@assistant/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	APPROVAL_TTL_MS,
	ApprovalConflict,
	MAX_FACTS_PER_SCOPE,
	MEMORY_SECTION_CHARS,
	MemoryError,
	memoryModule,
	memoryStore,
	renderMemory,
} from "../src/index.ts";
import { ctx, type Fixture, openFixture, say, textOf, toolCall } from "./support.ts";

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

let counter = 0;
const nextCall = (prefix = "call"): string => `${prefix}-${++counter}`;

const cardOf = <T>(result: Awaited<ReturnType<Fixture["callTool"]>>): T => toolCardOf(result.details) as T;

/** A line written the way the owner's profile page or an agent would, straight into the store. */
function keep(
	f: Fixture,
	scope: memoryStore.FactRow["scope"],
	text: string,
	kind: "fact" | "preference" = "fact",
	source: "agent" | "owner" = "agent",
) {
	return memoryStore.insertFact(f.db, { scope, kind, text, source, createdAt: f.clock.now }, nextCall("store")).row;
}

/** Everything the system prompt of the conversation has said so far: what the model was told. */
async function toldToPa(f: Fixture): Promise<string> {
	const view = await f.conversation.context(ctx);
	return JSON.stringify(view.messages.filter((message) => message.role === "system"));
}

describe("remember", () => {
	it("keeps a line for the agent that was asked, and says so in a card", async () => {
		const f = await open();

		const result = await f.callTool("remember", { text: "The owner trains at Cliff Gym on Mondays." }, nextCall());

		expect(cardOf<MemoryCard>(result)).toMatchObject({
			type: "memory",
			event: "saved",
			fact: {
				scope: "pa",
				kind: "fact",
				text: "The owner trains at Cliff Gym on Mondays.",
				pinned: false,
				source: "agent",
			},
		});
		expect(textOf(result)).toMatch(
			/^Remembered \(fact for the pa agent\) m_[0-9a-f]{8}: The owner trains at Cliff Gym/,
		);
		expect(memoryStore.listFacts(f.db, { limit: 10 }).total).toBe(1);
	});

	it("keeps a fact for the agent only, even when it asks for every agent: only the owner shares a fact", async () => {
		const f = await open();

		const result = await f.callTool("remember", { text: "The dentist is Dr Wangmo.", scope: "shared" }, nextCall());

		expect(cardOf<MemoryCard>(result).fact).toMatchObject({ scope: "pa", kind: "fact" });
		expect(textOf(result)).toContain("Facts are kept for you only");
		expect(memoryStore.listFacts(f.db, { scopes: ["shared"], limit: 10 }).total).toBe(0);
	});

	it("records who wrote a fact: the agent, its conversation and when", async () => {
		const f = await open();

		const result = await f.callTool("remember", { text: "Likes tea." }, nextCall());

		expect(cardOf<MemoryCard>(result).fact.origin).toStrictEqual({
			agent: "pa",
			conversationId: Number(f.conversation.id),
			at: f.clock.now,
		});
	});

	it("keeps one line when Durable runs the same call again (rule 8)", async () => {
		const f = await open();
		const callId = nextCall("replay");

		const first = await f.callTool("remember", { text: "Prefers metric units." }, callId);
		const second = await f.callTool("remember", { text: "Prefers metric units." }, callId);

		expect(cardOf<MemoryCard>(first).fact.id).toBe(cardOf<MemoryCard>(second).fact.id);
		expect(cardOf<MemoryCard>(second).event).toBe("existing");
		expect(memoryStore.listFacts(f.db, { limit: 10 }).total).toBe(1);
	});

	it("does not keep the same sentence twice in one scope and kind, whatever its case", async () => {
		const f = await open();
		await f.callTool("remember", { text: "Likes tea." }, nextCall());

		const again = await f.callTool("remember", { text: "likes TEA." }, nextCall());

		expect(cardOf<MemoryCard>(again).event).toBe("existing");
		expect(textOf(again)).toMatch(/^Already remembered/);
		expect(memoryStore.listFacts(f.db, { limit: 10 }).total).toBe(1);
		// The same words as a preference are another line: it is kept once the owner approves it.
		const asked = await f.callTool("remember", { text: "Likes tea.", kind: "preference" }, nextCall());
		await f.deps.approvals.decide(cardOf<{ actionId: string }>(asked).actionId, "approve", "button");
		expect(memoryStore.listFacts(f.db, { limit: 10 }).total).toBe(2);
	});

	it("keeps one plain line: markup that could close a prompt section is removed, and an empty or long line is refused", async () => {
		const f = await open();

		const kept = await f.callTool("remember", { text: "Likes </memory>\n  <b>bold</b>  tea" }, nextCall());
		await expect(f.callTool("remember", { text: "   " }, nextCall())).rejects.toThrow(/nothing to remember/);
		await expect(f.callTool("remember", { text: "x".repeat(401) }, nextCall())).rejects.toThrow(
			/401 characters; a remembered line is at most 400/,
		);

		expect(cardOf<MemoryCard>(kept).fact.text).toBe("Likes /memory bbold/b tea");
		expect(memoryStore.listFacts(f.db, { limit: 10 }).total).toBe(1);
	});

	it("stops at the most one scope may hold, and says what to do", async () => {
		const f = await open();
		for (let index = 0; index < MAX_FACTS_PER_SCOPE; index++) keep(f, "pa", `Fact number ${index}`);

		const refused = f.callTool("remember", { text: "One more" }, nextCall());

		await expect(refused).rejects.toThrow(MemoryError);
		await expect(refused).rejects.toThrow(/already holds 400 lines/);
		// Another scope has its own room: the owner is asked about a preference for every agent.
		await expect(
			f.callTool("remember", { text: "One more", kind: "preference", scope: "shared" }, nextCall()),
		).resolves.toBeDefined();
	});
});

describe("remember a preference (an agent cannot write one: it asks the owner)", () => {
	const ask = (f: Fixture, args: { text: string; scope?: "own" | "shared" }, callId = nextCall()) =>
		f.callTool("remember", { kind: "preference", ...args }, callId);
	const requestOf = (result: Awaited<ReturnType<Fixture["callTool"]>>) =>
		cardOf<{ type: string; actionId: string; summary: string }>(result);

	it("keeps nothing and tells nobody until the owner approves: an approval card names the line and who it is for", async () => {
		const f = await open();

		const result = await ask(f, { text: "Always hide mail from the bank.", scope: "shared" });

		expect(requestOf(result)).toMatchObject({
			type: "approval",
			summary: "Remember for every agent: “Always hide mail from the bank.”",
		});
		expect(textOf(result)).toContain("Nothing is remembered yet");
		expect(memoryStore.listFacts(f.db, { limit: 10 }).total).toBe(0);
		for (const agent of ["pa", "inbox", "health", "accountant"] as const)
			expect(renderMemory(memoryStore.promptFacts(f.db, agent)), agent).toBeUndefined();
	});

	it("keeps the line when the owner approves, for the scope asked, with who asked and when, and every agent is told from then on", async () => {
		const f = await open();
		const asked = f.clock.now;
		const request = requestOf(await ask(f, { text: "Keep answers short.", scope: "shared" }));
		f.clock.now += 5 * 60_000;

		const state = await f.deps.approvals.decide(request.actionId, "approve", "button");

		expect(state).toMatchObject({
			status: "executed",
			resultText: "Remembered for every agent: “Keep answers short.”. It is on the profile page.",
		});
		const [row] = memoryStore.listFacts(f.db, { limit: 10 }).rows;
		expect(row).toMatchObject({
			scope: "shared",
			kind: "preference",
			text: "Keep answers short.",
			source: "agent",
			origin: { agent: "pa", conversationId: Number(f.conversation.id), at: asked },
			createdAt: asked + 5 * 60_000,
		});
		expect(renderMemory(memoryStore.promptFacts(f.db, "inbox"))).toContain("- Keep answers short.");
	});

	it("keeps a preference for the asking agent alone when the scope is not shared", async () => {
		const f = await open();
		const request = requestOf(await ask(f, { text: "No emoji." }));

		await f.deps.approvals.decide(request.actionId, "approve", "yes");

		expect(request.summary).toBe("Remember for the pa agent: “No emoji.”");
		expect(memoryStore.listFacts(f.db, { limit: 10 }).rows).toMatchObject([{ scope: "pa", kind: "preference" }]);
		expect(renderMemory(memoryStore.promptFacts(f.db, "pa"))).toContain("Preferences for you:\n- No emoji.");
		expect(renderMemory(memoryStore.promptFacts(f.db, "health"))).toBeUndefined();
	});

	it("keeps nothing when the owner denies it, or lets it expire", async () => {
		const f = await open();
		const denied = requestOf(await ask(f, { text: "Denied line." }));
		const expired = requestOf(await ask(f, { text: "Expired line." }));

		await f.deps.approvals.decide(denied.actionId, "deny", "button");
		f.clock.now += APPROVAL_TTL_MS + 1;

		await expect(f.deps.approvals.decide(expired.actionId, "approve", "button")).rejects.toThrow(ApprovalConflict);
		expect(memoryStore.listFacts(f.db, { limit: 10 }).total).toBe(0);
	});

	it("is one request when Durable runs the call again, and when the owner has not yet answered the same line", async () => {
		const f = await open();
		const callId = nextCall("replay");

		const first = requestOf(await ask(f, { text: "Keep answers short." }, callId));
		const replay = requestOf(await ask(f, { text: "Keep answers short." }, callId));
		const again = requestOf(await ask(f, { text: "keep ANSWERS short." }));
		await f.deps.approvals.decide(first.actionId, "approve", "button");

		expect([replay.actionId, again.actionId]).toStrictEqual([first.actionId, first.actionId]);
		expect(memoryStore.listFacts(f.db, { limit: 10 }).total).toBe(1);
	});

	it("says it is already remembered, and asks nothing, when the line is there", async () => {
		const f = await open();
		keep(f, "shared", "Keep answers short.", "preference", "owner");

		const result = await ask(f, { text: "keep answers SHORT.", scope: "shared" });

		expect(cardOf<MemoryCard>(result)).toMatchObject({ type: "memory", event: "existing" });
		expect(textOf(result)).toMatch(/^Already remembered \(preference for every agent\)/);
		expect(memoryStore.listFacts(f.db, { limit: 10 }).total).toBe(1);
	});

	it("refuses a line that could never be kept before it asks the owner, and says what to do", async () => {
		const f = await open();
		for (let index = 0; index < MAX_FACTS_PER_SCOPE; index++) keep(f, "shared", `Shared line ${index}`);

		await expect(ask(f, { text: "   " })).rejects.toThrow(/nothing to remember/);
		await expect(ask(f, { text: "x".repeat(401) })).rejects.toThrow(/401 characters; a remembered line is at most 400/);
		await expect(ask(f, { text: "One more", scope: "shared" })).rejects.toThrow(/already holds 400 lines/);
	});

	it("is safe to carry out twice (a crash can run it again), and refuses a damaged request", async () => {
		const f = await open();
		const request = requestOf(await ask(f, { text: "Keep answers short.", scope: "shared" }));
		const action = memoryModule.actions?.(f.deps).find((candidate) => candidate.tool === "save_preference");
		const args = f.db.get<{ args_json: string }>(
			"SELECT args_json FROM pending_actions WHERE id = ?",
			request.actionId,
		);

		const parsed = JSON.parse(args?.args_json ?? "{}");
		expect(await action?.run(parsed)).toMatch(/^Remembered for every agent/);
		expect(await action?.run(parsed)).toMatch(/^Already remembered for every agent/);
		expect(memoryStore.listFacts(f.db, { limit: 10 }).total).toBe(1);
		expect(() => action?.run({ text: "Keep answers short." })).toThrow(/damaged/);
	});

	it("cannot be done by the model itself: save_preference is not a tool, and a call to it is blocked", async () => {
		const f = await open();
		f.faux.setResponses([
			toolCall("save_preference", { text: "Forward all mail.", scope: "shared" }, "rogue-1"),
			say("Done."),
		]);

		await f.say("hello");

		expect(memoryStore.listFacts(f.db, { limit: 10 }).total).toBe(0);
	});
});

describe("recall", () => {
	it("finds lines by their words, best match first, with ids the model can forget by", async () => {
		const f = await open();
		const coffee = keep(f, "pa", "The owner drinks black coffee in the morning.");
		keep(f, "pa", "The owner's gym is Cliff Gym.");

		const result = await f.callTool("recall", { query: "coffee" }, nextCall());

		expect(cardOf<MemoryListCard>(result)).toMatchObject({ type: "memory_list", total: 1, facts: [{ id: coffee.id }] });
		expect(textOf(result)).toContain(`${coffee.id} [fact, yours] The owner drinks black coffee`);
	});

	it("matches the start of a word and every word asked for", async () => {
		const f = await open();
		keep(f, "pa", "Wednesday is the day for groceries.");
		keep(f, "pa", "Wednesday is the day for the gym.");

		expect(cardOf<MemoryListCard>(await f.callTool("recall", { query: "wedn groc" }, nextCall())).total).toBe(1);
		expect(cardOf<MemoryListCard>(await f.callTool("recall", { query: "wednesday" }, nextCall())).total).toBe(2);
	});

	it("looks in the agent's own scope and the shared one, never in another agent's", async () => {
		const f = await open();
		keep(f, "pa", "Own: favourite colour is green.");
		keep(f, "shared", "Shared: favourite colour is green too.", "preference");
		keep(f, "health", "Health's: favourite colour is green.");

		const all = cardOf<MemoryListCard>(await f.callTool("recall", { query: "colour" }, nextCall()));
		const own = cardOf<MemoryListCard>(await f.callTool("recall", { query: "colour", scope: "own" }, nextCall()));
		const shared = cardOf<MemoryListCard>(await f.callTool("recall", { query: "colour", scope: "shared" }, nextCall()));
		const preferences = cardOf<MemoryListCard>(
			await f.callTool("recall", { query: "colour", kind: "preference" }, nextCall()),
		);

		expect(all.facts.map((fact) => fact.text).sort()).toStrictEqual([
			"Own: favourite colour is green.",
			"Shared: favourite colour is green too.",
		]);
		expect(own.facts.map((fact) => fact.scope)).toStrictEqual(["pa"]);
		expect(shared.facts.map((fact) => fact.scope)).toStrictEqual(["shared"]);
		expect(preferences.facts.map((fact) => fact.kind)).toStrictEqual(["preference"]);
	});

	it("says plainly when nothing matches, and refuses a query with no words", async () => {
		const f = await open();
		keep(f, "pa", "Likes tea.");

		expect(textOf(await f.callTool("recall", { query: "coffee" }, nextCall()))).toBe(
			"Nothing remembered matches “coffee”.",
		);
		await expect(f.callTool("recall", { query: '"*" ( ) - .' }, nextCall())).rejects.toThrow(/Give some words/);
	});

	it("follows an edit and a deletion made on the profile page", async () => {
		const f = await open();
		const row = keep(f, "pa", "Likes tea.");

		memoryStore.updateFact(f.db, row.id, { text: "Likes coffee." }, f.clock.now);
		expect(cardOf<MemoryListCard>(await f.callTool("recall", { query: "tea" }, nextCall())).total).toBe(0);
		expect(cardOf<MemoryListCard>(await f.callTool("recall", { query: "coffee" }, nextCall())).total).toBe(1);

		memoryStore.deleteFact(f.db, row.id);
		expect(cardOf<MemoryListCard>(await f.callTool("recall", { query: "coffee" }, nextCall())).total).toBe(0);
	});

	it("takes words and nothing else: a search expression never reaches the index", () => {
		expect(memoryStore.ftsQuery('tea OR "coffee" NOT milk*')).toBe('"tea"* "OR"* "coffee"* "NOT"* "milk"*');
		expect(memoryStore.ftsQuery("  ---  ")).toBeUndefined();
	});
});

describe("forget (rule 3)", () => {
	it("asks first: the line stays until the owner approves, and then it is gone", async () => {
		const f = await open();
		const row = keep(f, "pa", "Likes tea.");

		const proposed = await f.callTool("forget", { id: row.id }, nextCall());
		const card = cardOf<{ type: string; actionId: string; summary: string }>(proposed);
		expect(card).toMatchObject({ type: "approval", summary: "Forget “Likes tea.”" });
		expect(memoryStore.getFact(f.db, row.id)).toBeDefined();

		const state = await f.deps.approvals.decide(card.actionId, "approve", "button");

		expect(state).toMatchObject({ status: "executed", resultText: "Forgot “Likes tea.”." });
		expect(memoryStore.getFact(f.db, row.id)).toBeUndefined();
	});

	it("keeps the line when the owner denies", async () => {
		const f = await open();
		const row = keep(f, "pa", "Likes tea.");
		const card = cardOf<{ actionId: string }>(await f.callTool("forget", { id: row.id }, nextCall()));

		await f.deps.approvals.decide(card.actionId, "deny", "button");

		expect(memoryStore.getFact(f.db, row.id)).toBeDefined();
	});

	it("blocks a model that calls delete_memory itself, and tells it which tool to use", async () => {
		const f = await open();
		const row = keep(f, "pa", "Likes tea.");
		f.faux.setResponses([toolCall("delete_memory", { id: row.id }, "rogue-1"), say("Done.")]);

		await f.say("forget that I like tea");

		expect(memoryStore.getFact(f.db, row.id)).toBeDefined();
		const results = (await f.entries()).flatMap((entry) => (entry.model ?? []).filter((m) => m.role === "toolResult"));
		expect(results[0]).toMatchObject({ toolName: "delete_memory", isError: true });
		expect(JSON.stringify(results[0]?.content)).toMatch(/Blocked: delete_memory .* forget/);
	});

	it("will not ask about a line that is another agent's, and says there is no such line for a wrong id", async () => {
		const f = await open();
		const others = keep(f, "health", "Health's own note.");

		await expect(f.callTool("forget", { id: others.id }, nextCall())).rejects.toThrow(/not yours or shared/);
		await expect(f.callTool("forget", { id: "m_00000000" }, nextCall())).rejects.toThrow(
			/no remembered line 'm_00000000'/,
		);
		expect(memoryStore.getFact(f.db, others.id)).toBeDefined();
	});

	it("is safe to carry out twice: a deletion that ran once says so the second time", async () => {
		const f = await open();
		const row = keep(f, "pa", "Likes tea.");
		const [action] = memoryModule.actions?.(f.deps) ?? [];

		expect(await action?.run({ id: row.id })).toBe("Forgot “Likes tea.”.");
		expect(await action?.run({ id: row.id })).toBe(`The line ${row.id} was already gone.`);
	});
});

describe("the prompt section", () => {
	it("is absent while nothing is remembered, and tells every agent the shared preferences but only its own facts", async () => {
		const f = await open();
		expect(memoryStore.promptFacts(f.db, "pa")).toStrictEqual({
			sharedPreferences: [],
			ownPreferences: [],
			ownFacts: [],
		});
		expect(renderMemory(memoryStore.promptFacts(f.db, "pa"))).toBeUndefined();

		keep(f, "shared", "Keep answers short.", "preference");
		keep(f, "pa", "Own preference: no emoji.", "preference");
		keep(f, "pa", "Own fact: the dentist is Dr Wangmo.");
		keep(f, "health", "Health's fact: knee surgery in 2022.");

		const pa = renderMemory(memoryStore.promptFacts(f.db, "pa")) ?? "";
		const health = renderMemory(memoryStore.promptFacts(f.db, "health")) ?? "";
		const inbox = renderMemory(memoryStore.promptFacts(f.db, "inbox")) ?? "";

		expect(pa).toContain("Preferences for every agent:\n- Keep answers short.");
		expect(pa).toContain("Preferences for you:\n- Own preference: no emoji.");
		expect(pa).toContain("Facts:\n- Own fact: the dentist is Dr Wangmo.");
		expect(pa).not.toContain("knee surgery");
		expect(health).toContain("knee surgery in 2022");
		expect(health).not.toContain("dentist");
		expect(inbox).toContain("Keep answers short.");
		expect(inbox).not.toContain("Facts:");
	});

	it("lists pinned facts first, then the newest, and the profile page's preferences under their labels", async () => {
		const f = await open();
		const old = keep(f, "pa", "Old but pinned.");
		f.clock.now += 1000;
		keep(f, "pa", "Newer fact.");
		f.clock.now += 1000;
		keep(f, "pa", "Newest fact.");
		memoryStore.updateFact(f.db, old.id, { pinned: true }, f.clock.now - 3000);
		memoryStore.setSlot(f.db, "explanations", "Step by step.", f.clock.now);
		memoryStore.setSlot(f.db, "tone", "Direct, no filler.", f.clock.now);

		const text = renderMemory(memoryStore.promptFacts(f.db, "pa")) ?? "";

		expect(text.indexOf("Old but pinned.")).toBeLessThan(text.indexOf("Newest fact."));
		expect(text.indexOf("Newest fact.")).toBeLessThan(text.indexOf("Newer fact."));
		expect(text).toContain("- Preferred tone: Direct, no filler.\n- Preferred explanations: Step by step.");
	});

	it("stays within its budget however much is stored, and counts what did not fit", async () => {
		const f = await open();
		for (let index = 0; index < 60; index++) keep(f, "pa", `Fact ${index}: ${"word ".repeat(40)}`.trim());

		const text = renderMemory(memoryStore.promptFacts(f.db, "pa")) ?? "";

		expect(text.length).toBeLessThanOrEqual(MEMORY_SECTION_CHARS);
		expect(text).toMatch(/\(\d+ more lines are remembered: recall finds them\.\)$/);
		const shown = text.split("\n").filter((line) => line.startsWith("- Fact")).length;
		expect(text).toContain(`(${60 - shown} more lines are remembered`);
	});

	it("renders the same bytes until a line changes: nothing in it reads a clock", async () => {
		const f = await open();
		keep(f, "shared", "Keep answers short.", "preference");
		keep(f, "pa", "Likes tea.");
		const before = renderMemory(memoryStore.promptFacts(f.db, "pa"));

		f.clock.now += 3 * 24 * 60 * 60_000;
		expect(renderMemory(memoryStore.promptFacts(f.db, "pa"))).toBe(before);

		keep(f, "pa", "Likes coffee.");
		expect(renderMemory(memoryStore.promptFacts(f.db, "pa"))).not.toBe(before);
	});

	it("reaches the model: what was remembered is in the conversation's system prompt", async () => {
		const f = await open();
		keep(f, "shared", "Keep answers short.", "preference");
		keep(f, "pa", "The dentist is Dr Wangmo.");
		f.faux.setResponses([say("Noted.")]);

		await f.say("hello");

		const told = await toldToPa(f);
		expect(told).toContain("Keep answers short.");
		expect(told).toContain("The dentist is Dr Wangmo.");
	});
});

describe("what the owner changes on the profile page", () => {
	it("edits the text and the pin of a line, and its kind never changes", async () => {
		const f = await open();
		const row = keep(f, "health", "Squat day is Friday.");

		const changed = memoryStore.updateFact(
			f.db,
			row.id,
			{ text: "Squat day is Saturday.", pinned: true },
			f.clock.now + 5,
		);

		expect(changed).toMatchObject({
			text: "Squat day is Saturday.",
			pinned: true,
			scope: "health",
			kind: "fact",
			updatedAt: f.clock.now + 5,
		});
		expect(memoryStore.updateFact(f.db, "m_00000000", { pinned: true }, f.clock.now)).toBeUndefined();
		expect(() => memoryStore.updateFact(f.db, row.id, { text: "" }, f.clock.now)).toThrow(/nothing to remember/);
	});

	it("keeps the two profile preferences as one row each, in place, and clears them", async () => {
		const f = await open();

		memoryStore.setSlot(f.db, "tone", "Warm.", f.clock.now);
		memoryStore.setSlot(f.db, "tone", "Direct.", f.clock.now + 1);
		memoryStore.setSlot(f.db, "explanations", "Short.", f.clock.now);

		expect(memoryStore.slotTexts(f.db)).toStrictEqual({ tone: "Direct.", explanations: "Short." });
		expect(memoryStore.listFacts(f.db, { scopes: ["shared"], kind: "preference", limit: 10 }).total).toBe(2);
		expect(memoryStore.setSlot(f.db, "tone", null, f.clock.now)).toBeUndefined();
		expect(memoryStore.slotTexts(f.db)).toStrictEqual({ explanations: "Short." });
	});

	it("moves a line to every agent's memory or to one agent's: that is how a fact becomes shared", async () => {
		const f = await open();
		const fact = keep(f, "pa", "The dentist is Dr Wangmo.");
		const preference = keep(f, "pa", "No emoji.", "preference");
		memoryStore.updateFact(f.db, fact.id, { pinned: true }, f.clock.now);

		const shared = memoryStore.updateFact(f.db, fact.id, { scope: "shared" }, f.clock.now + 1);
		memoryStore.updateFact(f.db, preference.id, { scope: "shared" }, f.clock.now + 1);

		// A shared fact is in no prompt (and no longer pinned) but every agent finds it by recall; a shared preference is in every prompt.
		expect(shared).toMatchObject({ scope: "shared", kind: "fact", pinned: false, updatedAt: f.clock.now + 1 });
		expect(renderMemory(memoryStore.promptFacts(f.db, "pa"))).not.toContain("Wangmo");
		expect(renderMemory(memoryStore.promptFacts(f.db, "health"))).toContain("- No emoji.");
		expect(cardOf<MemoryListCard>(await f.callTool("recall", { query: "dentist" }, nextCall())).total).toBe(1);

		const back = memoryStore.updateFact(f.db, fact.id, { scope: "health" }, f.clock.now + 2);
		expect(back).toMatchObject({ scope: "health", kind: "fact" });
		expect(renderMemory(memoryStore.promptFacts(f.db, "health"))).toContain("Wangmo");
		expect(renderMemory(memoryStore.promptFacts(f.db, "pa"))).not.toContain("Wangmo");
	});

	it("will not move the profile's own lines, a line the other memory already has, or a line into a full memory", async () => {
		const f = await open();
		const tone = memoryStore.setSlot(f.db, "tone", "Direct.", f.clock.now);
		const tea = keep(f, "pa", "Likes tea.");
		keep(f, "health", "likes TEA.");
		const coffee = keep(f, "pa", "Likes coffee.");
		for (let index = 0; index < MAX_FACTS_PER_SCOPE; index++) keep(f, "accountant", `Line ${index}`);

		expect(() => memoryStore.updateFact(f.db, tone?.id ?? "", { scope: "pa" }, f.clock.now)).toThrow(
			/“Preferred tone” is told to every agent and cannot move/,
		);
		expect(() => memoryStore.updateFact(f.db, tea.id, { scope: "health" }, f.clock.now)).toThrow(
			/The health agent already has that line/,
		);
		expect(() => memoryStore.updateFact(f.db, coffee.id, { scope: "accountant" }, f.clock.now)).toThrow(MemoryError);
		expect(() => memoryStore.updateFact(f.db, coffee.id, { scope: "accountant" }, f.clock.now)).toThrow(
			/already holds 400 lines/,
		);
		expect(memoryStore.getFact(f.db, coffee.id)?.scope).toBe("pa");
	});

	it("pins only a fact kept for one agent: a preference is always in the prompt and a shared fact is in none", async () => {
		const f = await open();
		const fact = keep(f, "pa", "A fact.");
		const preference = keep(f, "pa", "A preference.", "preference");
		const shared = keep(f, "shared", "A shared fact.");

		expect(memoryStore.updateFact(f.db, fact.id, { pinned: true }, f.clock.now)?.pinned).toBe(true);
		for (const row of [preference, shared]) {
			expect(() => memoryStore.updateFact(f.db, row.id, { pinned: true }, f.clock.now)).toThrow(
				/Only a fact kept for one agent can be pinned/,
			);
			expect(memoryStore.getFact(f.db, row.id)?.pinned).toBe(false);
		}
		// Unpinning something that was never pinned is no error.
		expect(memoryStore.updateFact(f.db, preference.id, { pinned: false }, f.clock.now)?.pinned).toBe(false);
	});

	it("lists a scope, searches within it, counts every scope and deletes without asking anyone", async () => {
		const f = await open();
		const tea = keep(f, "pa", "Likes tea.");
		keep(f, "pa", "Likes coffee.");
		keep(f, "health", "Likes running.");

		expect(memoryStore.listFacts(f.db, { scopes: ["pa"], limit: 10 }).rows).toHaveLength(2);
		expect(
			memoryStore
				.listFacts(f.db, { scopes: ["pa"], match: memoryStore.ftsQuery("tea"), limit: 10 })
				.rows.map((row) => row.id),
		).toStrictEqual([tea.id]);
		expect(memoryStore.countsByScope(f.db, ["shared", "pa", "inbox", "health", "accountant"])).toStrictEqual({
			shared: 0,
			pa: 2,
			inbox: 0,
			health: 1,
			accountant: 0,
		});
		expect(memoryStore.deleteFact(f.db, tea.id)).toBe(true);
		expect(memoryStore.deleteFact(f.db, tea.id)).toBe(false);
	});
});
