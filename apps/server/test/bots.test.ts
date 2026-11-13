import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BOT_PRESETS, botsStore, MAX_BOTS } from "@assistant/extensions";
import type { AgentsResponse, ApiErrorBody, BotsResponse, TrustSettingsResponse } from "@assistant/shared";
import { AgentDoc, type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { archiveAgent } from "../src/agents.ts";
import type { RunningServer } from "../src/server.ts";
import { base, ctx, type Harness, START, setup } from "./domain-support.ts";
import { removeAllFixtures } from "./support.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) for (const server of h.servers.splice(0)) await server.close();
	await removeAllFixtures();
});

async function open(env: Record<string, string> = {}) {
	const h = await setup(env);
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

describe("bot agents and retiring", () => {
	it("never gives a bot delegate, bots, inbox, files, routines or a domain write module, whatever presets it has", async () => {
		const h = await open();
		const server = await h.start();
		const names = server.domain.botExtensions(BOT_PRESETS).map((extension) => extension.name);
		for (const forbidden of ["delegate", "bots", "inbox", "files", "routines", "daily", "tasks", "ledger", "health"]) {
			expect(names).not.toContain(forbidden);
		}
		expect(names).toContain("tasks-read");
	});

	it("stops a busy bot's run before archiving its conversation", async () => {
		const h = await open();
		const server = await h.start();
		botsStore.insertBot(server.db, { ...RESEARCH, approvedVia: "owner", callId: "call-1", now: START });
		await server.close();
		h.servers.splice(0);
		const again = await h.start();
		const id = conversationOf(again.db, "bot:research") as ConversationId;
		const conversation = await again.harness.conversation(id, ctx);
		await conversation?.submit({ type: "input", content: "think about something long" }, ctx);

		expect(await archiveAgent(again.harness, again.db, "bot:research")).toBe(true);
		expect((await again.harness.snapshot(LiveDoc, id, ctx))?.run).toBeUndefined();
		expect(conversationOf(again.db, "bot:research")).toBeUndefined();
		// Twice is fine.
		expect(await archiveAgent(again.harness, again.db, "bot:research")).toBe(false);
	});
});

async function call<T>(server: RunningServer, method: string, path: string, body?: unknown) {
	const response = await fetch(`${base(server)}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: response.status, body: (await response.json()) as T };
}

const agentIds = async (server: RunningServer) =>
	((await (await fetch(`${base(server)}/api/agents`)).json()) as AgentsResponse).agents.map((agent) => agent.id);

describe("the owner's Bots page", () => {
	it("creates a bot without asking, with the PA's checks, and it is a chat at once; deleting it archives the chat", async () => {
		const h = await open();
		const server = await h.start();

		const empty = await call<BotsResponse>(server, "GET", "/api/bots");
		expect(empty.body).toMatchObject({ bots: [], max: MAX_BOTS, presets: [...BOT_PRESETS] });

		const created = await call<BotsResponse>(server, "POST", "/api/bots", { ...RESEARCH, slug: " Research " });
		expect(created.status).toBe(201);
		expect(created.body.bots).toMatchObject([
			{ id: "bot:research", name: "Research", tools: ["web", "memory"], approvedVia: "owner" },
		]);
		expect(await agentIds(server)).toContain("bot:research");
		expect(server.db.get("SELECT 1 AS one FROM pending_actions")).toBeUndefined();

		const again = await call<ApiErrorBody>(server, "POST", "/api/bots", RESEARCH);
		expect(again.status).toBe(409);
		expect(again.body.error.message).toContain("already a bot bot:research");

		const bad = await call<ApiErrorBody>(server, "POST", "/api/bots", { ...RESEARCH, slug: "other", tools: ["inbox"] });
		expect(bad.status).toBe(400);
		expect(bad.body.error.message).toContain("cannot have 'inbox'");
		const reserved = await call<ApiErrorBody>(server, "POST", "/api/bots", { ...RESEARCH, slug: "pa" });
		expect(reserved.status).toBe(400);
		const shape = await call<ApiErrorBody>(server, "POST", "/api/bots", { ...RESEARCH, tools: "web" });
		expect(shape.status).toBe(400);

		const conversation = conversationOf(server.db, "bot:research") as ConversationId;
		const deleted = await call<BotsResponse>(server, "DELETE", "/api/bots/research", {});
		expect(deleted.status).toBe(200);
		expect(deleted.body.bots).toStrictEqual([]);
		expect(await agentIds(server)).not.toContain("bot:research");
		expect(await server.harness.conversation(conversation, ctx)).toBeDefined();

		const missing = await call<ApiErrorBody>(server, "DELETE", "/api/bots/research", {});
		expect(missing.status).toBe(404);
	});

	it("refuses a bot past the cap of the PA's tool", async () => {
		const h = await open();
		const server = await h.start();
		for (let i = 0; i < MAX_BOTS; i++) {
			botsStore.insertBot(server.db, {
				...RESEARCH,
				slug: `bot-${i}`,
				approvedVia: "owner",
				callId: `c${i}`,
				now: START,
			});
		}
		const full = await call<ApiErrorBody>(server, "POST", "/api/bots", RESEARCH);
		expect(full.status).toBe(409);
		expect(full.body.error.message).toContain(`already ${MAX_BOTS} bots`);
		expect(botsStore.getBot(server.db, "research")).toBeUndefined();
	});
});

const POLICY = {
	projects: [
		{ id: "zimpoen", trust: "normal" },
		{ id: "bank", trust: "strict" },
	],
	credentials: [],
	actions: [],
};

describe("trust levels in Settings", () => {
	it("starts from ZIMPOEN_PA_TRUST and the policy, keeps the owner's choice across restarts, and goes back on null", async () => {
		const h = await open({ ZIMPOEN_PA_TRUST: "strict", ZIMPOEN_CRED_BROKER: "inprocess" });
		const { credBroker } = h.fixture.config;
		if (credBroker.mode !== "inprocess") throw new Error("broker should be on");
		await mkdir(dirname(credBroker.policyPath), { recursive: true });
		await writeFile(credBroker.policyPath, JSON.stringify(POLICY));
		let server = await h.start();

		const initial = await call<TrustSettingsResponse>(server, "GET", "/api/settings/trust");
		expect(initial.body).toStrictEqual({
			pa: { level: "strict", defaultLevel: "strict", overridden: false },
			broker: "on",
			projects: [
				{ id: "zimpoen", level: "normal", defaultLevel: "normal", overridden: false },
				{ id: "bank", level: "strict", defaultLevel: "strict", overridden: false },
			],
		});

		expect((await call(server, "PUT", "/api/settings/trust/pa", { level: "open" })).status).toBe(200);
		const project = await call<TrustSettingsResponse>(server, "PUT", "/api/settings/trust/projects/bank", {
			level: "normal",
		});
		expect(project.body.projects[1]).toStrictEqual({
			id: "bank",
			level: "normal",
			defaultLevel: "strict",
			overridden: true,
		});

		await server.close();
		h.servers.splice(0);
		server = await h.start();
		const kept = await call<TrustSettingsResponse>(server, "GET", "/api/settings/trust");
		expect(kept.body.pa).toStrictEqual({ level: "open", defaultLevel: "strict", overridden: true });
		expect(h.logs.join("\n")).toContain("The PA's trust level is open");

		const reset = await call<TrustSettingsResponse>(server, "PUT", "/api/settings/trust/pa", { level: null });
		expect(reset.body.pa).toStrictEqual({ level: "strict", defaultLevel: "strict", overridden: false });

		const unknown = await call<ApiErrorBody>(server, "PUT", "/api/settings/trust/projects/nope", { level: "open" });
		expect(unknown.status).toBe(404);
		expect(unknown.body.error.message).toContain("Projects: zimpoen, bank");
		const invalid = await call<ApiErrorBody>(server, "PUT", "/api/settings/trust/pa", { level: "trusting" });
		expect(invalid.status).toBe(400);
	});

	it("has no projects with the broker off", async () => {
		const h = await open();
		const server = await h.start();
		const view = await call<TrustSettingsResponse>(server, "GET", "/api/settings/trust");
		expect(view.body).toMatchObject({ pa: { level: "normal" }, broker: "off", projects: [] });
		expect((await call(server, "PUT", "/api/settings/trust/projects/x", { level: "open" })).status).toBe(404);
	});
});
