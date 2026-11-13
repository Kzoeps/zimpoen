import type { AgentsResponse } from "@assistant/shared";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.ts";
import { createHcBoardLead, ctoFor } from "../src/cto.ts";
import { base, ctx, type Harness, setup } from "./domain-support.ts";
import { removeAllFixtures } from "./support.ts";

const context = { cwd: "/work/assistant", homeDir: "/home/dorje" };
const auth = { ASSISTANT_AUTH: "off" };

function problemsOf(env: Record<string, string>): string[] {
	try {
		parseConfig({ ...auth, ...env }, context);
	} catch (error) {
		if (error instanceof ConfigError) return error.problems.map((problem) => problem.setting);
		throw error;
	}
	return [];
}

describe("CTO config", () => {
	it("is off by default and needs repos when on", () => {
		expect(parseConfig(auth, context).cto).toStrictEqual({ mode: "off" });
		expect(problemsOf({ ZIMPOEN_CTO: "on" })).toEqual(["ZIMPOEN_CTO_REPOS"]);
		expect(
			parseConfig({ ...auth, ZIMPOEN_CTO: "on", ZIMPOEN_CTO_REPOS: "org/app, zimpoen,org/app" }, context).cto,
		).toStrictEqual({ mode: "on", boardBin: "hc-board", hcBin: "hc", repos: ["org/app", "zimpoen"], trust: "normal" });
	});

	it("lists every bad setting", () => {
		expect(
			problemsOf({
				ZIMPOEN_CTO: "on",
				ZIMPOEN_CTO_REPOS: "-evil,../x",
				ZIMPOEN_CTO_TRUST: "yolo",
				ZIMPOEN_CTO_BOARD_BIN: "--help",
				ZIMPOEN_CTO_HC_BIN: "rel/hc",
			}),
		).toEqual([
			"ZIMPOEN_CTO_REPOS",
			"ZIMPOEN_CTO_REPOS",
			"ZIMPOEN_CTO_TRUST",
			"ZIMPOEN_CTO_BOARD_BIN",
			"ZIMPOEN_CTO_HC_BIN",
		]);
		expect(problemsOf({ ZIMPOEN_CTO: "maybe" })).toEqual(["ZIMPOEN_CTO"]);
	});
});

describe("hc-board coding lead", () => {
	function recording(outputs: Record<string, string> = {}) {
		const calls: Array<{ file: string; args: readonly string[] }> = [];
		const lead = createHcBoardLead({
			boardBin: "/opt/hc-board",
			hcBin: "/opt/hc",
			exec: async (file, args) => {
				calls.push({ file, args });
				const out = outputs[args[0] ?? ""];
				if (out === undefined) throw new Error(`${file} ${args[0]} failed: No card '${args[1]}'.`);
				return out;
			},
		});
		return { lead, calls };
	}

	it("passes every value as its own argv entry, with fixed commands", async () => {
		const { lead, calls } = recording({
			create: "created\nt12\n",
			send: "",
			show: "t12 [running] Health\n  note: on it\n",
		});
		const request = { key: "call-1", repo: "zimpoen", goal: "a; rm -rf / $(x)", doneWhen: "tests", outOfScope: "ui" };
		expect(await lead.createCard(request)).toEqual({ cardId: "t12" });
		await lead.notifyLead("t12");
		expect(await lead.readCard("t12")).toMatchObject({ id: "t12", status: "running", note: "on it" });
		expect(calls).toEqual([
			{
				file: "/opt/hc-board",
				args: [
					"create",
					"--key",
					"call-1",
					"--repo",
					"zimpoen",
					"--goal",
					"a; rm -rf / $(x)",
					"--done-when",
					"tests",
					"--out-of-scope",
					"ui",
				],
			},
			{
				file: "/opt/hc",
				args: ["send", "lead", "New coding card t12 from zimpoen's CTO. Read it with: hc-board show t12"],
			},
			{ file: "/opt/hc-board", args: ["show", "t12"] },
		]);
	});

	it("refuses a bad card id from the board or the model, and reads a missing card as undefined", async () => {
		const { lead, calls } = recording({ create: "--oops" });
		await expect(lead.createCard({ key: "k", repo: "r", goal: "g", doneWhen: "d", outOfScope: "o" })).rejects.toThrow(
			/not a card id/,
		);
		await expect(lead.notifyLead("-x")).rejects.toThrow(/not a card id/);
		expect(await lead.readCard("t99")).toBeUndefined();
		expect(calls.map((call) => call.args[0])).toEqual(["create", "show"]);
	});

	it("is nothing when off", () => {
		expect(ctoFor({ mode: "off" })).toBeUndefined();
	});
});

describe("CTO agent through the whole server", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const h of harnesses.splice(0)) for (const server of h.servers.splice(0)) await server.close();
		await removeAllFixtures();
	});

	it("does not exist when off", async () => {
		const h = await setup();
		harnesses.push(h);
		const server = await h.start();
		const agents = (await (await fetch(`${base(server)}/api/agents`)).json()) as AgentsResponse;
		expect(agents.agents.map((agent) => agent.id)).not.toContain("cto");
		expect(server.domain.ctoExtensions).toBeUndefined();
	});

	it("exists when on, with board tools, the broker hook and tool_search, and no ask_agent", async () => {
		const h = await setup({ ZIMPOEN_CTO: "on", ZIMPOEN_CTO_REPOS: "zimpoen" });
		harnesses.push(h);
		const server = await h.start(undefined, {
			ctoExec: async () => {
				throw new Error("not called");
			},
		});
		const agents = (await (await fetch(`${base(server)}/api/agents`)).json()) as AgentsResponse;
		const cto = agents.agents.find((agent) => agent.id === "cto");
		expect(cto?.name).toBe("CTO");
		const stored = await server.harness.snapshot(AgentDoc, cto?.conversationId as ConversationId, ctx);
		expect(stored?.extensions).toStrictEqual(["profile", "cto", "approvals", "tool-search"]);
		expect(stored?.instructions).toContain("only through the PA");
		expect(h.logs.join("\n")).toContain("[cto] on: repos zimpoen, trust normal");
	});
});
