import { deleteAgentRow, getAgentRow, insertAgentRow } from "@assistant/db";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BotSpec,
	type BotsDeps,
	botsStore,
	cleanBotSpec,
	DELETE_BOT_ACTION,
	decideTrust,
	isScheduledRequestId,
	MAX_BOTS,
	type TrustLevel,
} from "../src/index.ts";
import { ctx, type Fixture, openFixture, say, textOf, toolCall, waitFor } from "./support.ts";

const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.close().catch(() => {});
		await fixture.dispose();
	}
});

/** A fixture whose bots get a real (empty) conversation and `agents` row, as the server's runtime does. */
async function open(trustLevel: TrustLevel = "normal", overrides: Partial<BotsDeps> = {}) {
	const spawned: BotSpec[] = [];
	const retired: string[] = [];
	const holder: { fixture?: Fixture } = {};
	const bots: BotsDeps = {
		trustLevel,
		spawn: async (spec) => {
			spawned.push(spec);
			const f = holder.fixture as Fixture;
			if (getAgentRow(f.db, `bot:${spec.slug}`) !== undefined) return;
			const conversation = await f.harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [] } },
				ctx,
			);
			insertAgentRow(f.db, { id: `bot:${spec.slug}`, conversationId: Number(conversation.id), createdAt: f.clock.now });
		},
		retire: async (slug) => {
			retired.push(slug);
			deleteAgentRow((holder.fixture as Fixture).db, `bot:${slug}`);
		},
		...overrides,
	};
	const fixture = await openFixture({ bots });
	holder.fixture = fixture;
	fixtures.push(fixture);
	return { f: fixture, spawned, retired };
}

const RESEARCH = {
	slug: "research",
	name: "Research",
	avatar: "🔎",
	soul: "You look things up on the web and summarise them in five lines.",
	tools: ["web", "memory"],
};

const pendingApprovalId = (f: Fixture): string => {
	const row = f.db.get<{ id: string }>("SELECT id FROM pending_actions WHERE status = 'pending'");
	if (row === undefined) throw new Error("no pending approval");
	return row.id;
};

describe("trust levels", () => {
	it("open allows, normal and strict ask for anything but routine, strict may deny", () => {
		expect(decideTrust("open", "bot_lifecycle")).toBe("allow");
		expect(decideTrust("normal", "routine")).toBe("allow");
		expect(decideTrust("normal", "bot_lifecycle")).toBe("ask");
		expect(decideTrust("strict", "deploy_prod")).toBe("ask");
		expect(decideTrust("strict", "deploy_prod", { strictDeny: true })).toBe("deny");
		expect(decideTrust("normal", "deploy_prod", { strictDeny: true })).toBe("ask");
	});
});

describe("bot specs", () => {
	it("refuses presets outside the allowlist, a long soul and slugs of built-in agents", () => {
		for (const tool of ["inbox", "delegate", "files", "bots", "routines", "approvals", "daily"]) {
			expect(() => cleanBotSpec({ ...RESEARCH, tools: [tool] })).toThrow(/cannot have/);
		}
		expect(() => cleanBotSpec({ ...RESEARCH, soul: "x".repeat(6001) })).toThrow(/at most 6000/);
		for (const slug of ["pa", "inbox", "shared", "Bad Slug", "x"]) {
			expect(() => cleanBotSpec({ ...RESEARCH, slug })).toThrow(/slug/);
		}
		expect(cleanBotSpec({ ...RESEARCH, tools: ["memory", "web", "memory"] }).tools).toStrictEqual(["web", "memory"]);
	});
});

describe("create_bot and delete_bot", () => {
	it("asks the owner at trust level normal, and creates the bot when they approve", async () => {
		const { f, spawned } = await open("normal");
		const result = await f.callTool("create_bot", RESEARCH, "call-create");

		expect(textOf(result)).toContain("Asked the owner to approve");
		expect(botsStore.getBot(f.db, "research")).toBeUndefined();
		expect(spawned).toHaveLength(0);

		await f.deps.approvals.decide(pendingApprovalId(f), "approve", "button");
		expect(botsStore.getBot(f.db, "research")).toMatchObject({ name: "Research", approvedVia: "owner" });
		expect(spawned.map((spec) => spec.slug)).toStrictEqual(["research"]);
		expect(getAgentRow(f.db, "bot:research")).toBeDefined();

		// A replay of the same call answers the same and asks nothing new.
		const again = await f.callTool("create_bot", RESEARCH, "call-create");
		expect(textOf(again)).toBe(textOf(result));
		expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM pending_actions")?.n).toBe(1);
	});

	it("creates without asking at trust level open", async () => {
		const { f, spawned } = await open("open");
		const result = await f.callTool("create_bot", RESEARCH, "call-open");

		expect(textOf(result)).toContain("Created the bot Research (bot:research)");
		expect(botsStore.getBot(f.db, "research")?.approvedVia).toBe("open");
		expect(spawned).toHaveLength(1);
		expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM pending_actions")?.n).toBe(0);
	});

	it(`refuses a ninth bot and a slug that is taken`, async () => {
		const { f } = await open("open");
		for (let index = 0; index < MAX_BOTS; index += 1) {
			await f.callTool("create_bot", { ...RESEARCH, slug: `bot-${index}` }, `call-${index}`);
		}
		await expect(f.callTool("create_bot", { ...RESEARCH, slug: "one-more" }, "call-more")).rejects.toThrow(
			`already ${MAX_BOTS} bots`,
		);
		await expect(f.callTool("create_bot", { ...RESEARCH, slug: "bot-0" }, "call-taken")).rejects.toThrow(
			"already a bot bot:bot-0",
		);
	});

	it("deletes a bot after approval: the row goes and its conversation is retired", async () => {
		const { f, retired } = await open("open");
		await f.callTool("create_bot", RESEARCH, "call-create");
		f.deps.bots = { ...(f.deps.bots as BotsDeps), trustLevel: "normal" };

		const result = await f.callTool("delete_bot", { slug: "bot:research" }, "call-delete");
		expect(textOf(result)).toContain("Delete the bot");
		expect(botsStore.getBot(f.db, "research")).toBeDefined();
		const pending = f.db.get<{ tool: string }>("SELECT tool FROM pending_actions WHERE status = 'pending'");
		expect(pending?.tool).toBe(DELETE_BOT_ACTION);

		await f.deps.approvals.decide(pendingApprovalId(f), "approve", "button");
		expect(botsStore.getBot(f.db, "research")).toBeUndefined();
		expect(retired).toStrictEqual(["research"]);
		expect(getAgentRow(f.db, "bot:research")).toBeUndefined();
	});

	it("lists the bots", async () => {
		const { f } = await open("open");
		expect(textOf(await f.callTool("list_bots", {}, "call-list-0"))).toContain("There are no bots");
		await f.callTool("create_bot", RESEARCH, "call-create");
		expect(textOf(await f.callTool("list_bots", {}, "call-list-1"))).toContain("bot:research 🔎 Research: web, memory");
	});
});

describe("rule 13: no bot changes during scheduled runs", () => {
	it("knows the request ids of scheduled runs", () => {
		for (const id of [
			"routine:r_1:2026-10-25T07",
			"briefing:2026-10-25",
			"wrapup:2026-10-25",
			"digest_midday:2026-10-25",
		]) {
			expect(isScheduledRequestId(id)).toBe(true);
		}
		for (const id of ["ask:call-1", "tg:42", "web-3f2a", "approval:a_1"]) expect(isScheduledRequestId(id)).toBe(false);
	});

	it("refuses create_bot in a run a routine started, and allows it in one the owner started", async () => {
		const { f } = await open("open");
		f.faux.setResponses([toolCall("create_bot", RESEARCH, "call-sched"), say("I could not.")]);
		const { submissionId } = await f.deps.ask(Number(f.conversation.id), {
			content: "Weekly: tidy up your bots.",
			requestId: "routine:r_1:2026-10-25T08",
		});
		const submission = await f.harness.submission(submissionId as never, ctx);
		await submission?.wait(ctx);

		const results = (await f.entries()).flatMap((entry) =>
			(entry.model ?? []).filter((message) => message.role === "toolResult"),
		);
		expect(JSON.stringify(results)).toContain("scheduled run");
		expect(botsStore.getBot(f.db, "research")).toBeUndefined();

		f.faux.setResponses([toolCall("create_bot", RESEARCH, "call-owner"), say("Done.")]);
		await f.say("make me a research bot");
		expect(botsStore.getBot(f.db, "research")).toBeDefined();
	});
});

describe("ask_agent and bots (hub and spoke)", () => {
	it("asks a bot by its id, and refuses one that does not exist", async () => {
		const { f } = await open("open");
		await f.callTool("create_bot", RESEARCH, "call-create");
		f.faux.setResponses([say("Three sources agree.")]);

		const answer = await f.callTool("ask_agent", { agent: "bot:research", question: "Is it true?" }, "call-ask");
		expect(textOf(answer)).toContain("Answer from the Research bot");
		expect(textOf(answer)).toContain("Three sources agree.");

		await expect(f.callTool("ask_agent", { agent: "bot:nobody", question: "Hello?" }, "call-none")).rejects.toThrow(
			"There is no agent 'bot:nobody'",
		);
	});

	it("settles a question to a bot that was deleted while it worked", async () => {
		const { f } = await open("open", {});
		await f.callTool("create_bot", RESEARCH, "call-create");
		f.db.run(
			`INSERT INTO delegate_ask (id, source_call_id, conversation_id, agent, question, request_id, status, late, created_at)
			 VALUES ('q_1', 'call-q', ?, 'bot:research', 'Still there?', 'ask:call-q', 'waiting', 1, ?)`,
			Number(f.conversation.id),
			f.clock.now,
		);
		await f.callTool("delete_bot", { slug: "research" }, "call-delete");

		const { delegateModule } = await import("../src/index.ts");
		await delegateModule.service(f.deps).recover();
		await waitFor(
			() => f.db.get<{ status: string }>("SELECT status FROM delegate_ask WHERE id = 'q_1'")?.status === "failed",
			"the ask to settle",
		);
	});
});
