import { botsStore } from "@assistant/extensions";
import type { AgentsResponse } from "@assistant/shared";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { base, ctx, type Harness, START, setup } from "./domain-support.ts";
import { removeAllFixtures } from "./support.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) for (const server of h.servers.splice(0)) await server.close();
	await removeAllFixtures();
});

async function open() {
	const h = await setup();
	harnesses.push(h);
	return h;
}

const conversationOf = (db: { get: Harness["servers"][number]["db"]["get"] }, id: string) =>
	db.get<{ conversation_id: number }>("SELECT conversation_id FROM agents WHERE id = ?", id)?.conversation_id;

const RESEARCH = {
	slug: "research",
	name: "Research",
	avatar: "🔎",
	soul: "You look things up.",
	tools: ["web" as const, "memory" as const],
};

describe("bots through the whole server", () => {
	it("gives every bot row a conversation at start, lists it, and archives the conversation of a deleted bot", async () => {
		const h = await open();
		let server = await h.start();
		botsStore.insertBot(server.db, { ...RESEARCH, approvedVia: "owner", callId: "call-1", now: START });
		await server.close();
		h.servers.splice(0);

		server = await h.start();
		const first = conversationOf(server.db, "bot:research");
		expect(first).toBeDefined();
		const agents = (await (await fetch(`${base(server)}/api/agents`)).json()) as AgentsResponse;
		expect(agents.agents.map((agent) => agent.id)).toContain("bot:research");
		const stored = await server.harness.snapshot(AgentDoc, first as ConversationId, ctx);
		// Its presets, the approval hook and tool_search: never delegate, inbox, files or bots.
		expect(stored?.extensions).toStrictEqual(["profile", "web", "memory", "approvals", "tool-search"]);
		expect(stored?.instructions).toContain("You look things up.");

		botsStore.deleteBot(server.db, "research");
		await server.close();
		h.servers.splice(0);

		server = await h.start();
		expect(conversationOf(server.db, "bot:research")).toBeUndefined();
		expect(await server.harness.conversation(first as ConversationId, ctx)).toBeDefined();
		expect(h.logs.join("\n")).toContain("archived the conversations of deleted bots: bot:research");

		// The same slug again is a new chat: the archived one is not adopted.
		botsStore.insertBot(server.db, { ...RESEARCH, approvedVia: "owner", callId: "call-2", now: START });
		await server.close();
		h.servers.splice(0);
		server = await h.start();
		const second = conversationOf(server.db, "bot:research");
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
	});
});
