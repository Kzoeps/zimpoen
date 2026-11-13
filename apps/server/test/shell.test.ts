import type { ExecFn } from "@assistant/extensions";

type ExecRequest = Parameters<ExecFn>[0];
type ExecResult = Awaited<ReturnType<ExecFn>>;

import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { ctx, type Harness, setup } from "./domain-support.ts";
import { removeAllFixtures } from "./support.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) for (const server of h.servers.splice(0)) await server.close();
	await removeAllFixtures();
});

async function open(env: Record<string, string>) {
	const h = await setup(env);
	harnesses.push(h);
	return h;
}

const engine = (result: ExecResult) => {
	const calls: ExecRequest[] = [];
	return {
		calls,
		exec: async (req: ExecRequest) => {
			calls.push(req);
			return result;
		},
	};
};

const extensionsOf = async (h: Harness, agent: string) => {
	const server = h.servers[0];
	if (server === undefined) throw new Error("no server");
	const id = server.db.get<{ conversation_id: number }>("SELECT conversation_id FROM agents WHERE id = ?", agent)
		?.conversation_id as ConversationId;
	return (await server.harness.snapshot(AgentDoc, id, ctx))?.extensions ?? [];
};

describe("ZIMPOEN_SHELL through the whole server", () => {
	it("off (default): no agent has the shell and no engine is touched", async () => {
		const h = await open({});
		const fake = engine({ exitCode: 0, output: "", timedOut: false, truncated: false });
		await h.start(undefined, { shellHost: { exec: fake.exec } });
		expect(await extensionsOf(h, "pa")).not.toContain("shell");
		expect(fake.calls).toEqual([]);
	});

	it("on: the PA gets the shell, the Inbox and the specialists never do", async () => {
		const h = await open({ ZIMPOEN_SHELL: "on" });
		const fake = engine({ exitCode: 0, output: "", timedOut: false, truncated: false });
		const server = await h.start(undefined, { shellHost: { exec: fake.exec } });
		expect(fake.calls[0]?.args).toContain("--runtime=runsc");
		// Leftover containers of a server that died mid-call are reaped at start.
		expect(fake.calls[1]?.args).toEqual(["ps", "--all", "--quiet", "--filter", "label=zimpoen.shell=1"]);
		expect(await extensionsOf(h, "pa")).toContain("shell");
		for (const agent of ["inbox", "health", "accountant"]) expect(await extensionsOf(h, agent)).not.toContain("shell");
		expect(server.domain.inboxExtensions.map((extension) => extension.name)).not.toContain("shell");
		expect(server.domain.botExtensions(["web"]).map((extension) => extension.name)).not.toContain("shell");
		expect(server.domain.botExtensions(["shell"]).map((extension) => extension.name)).toContain("shell");
	});

	it("on: refuses to start without the gVisor runtime, saying what to fix", async () => {
		const h = await open({ ZIMPOEN_SHELL: "on" });
		const fake = engine({
			exitCode: 125,
			output: "unknown or invalid runtime name: runsc",
			timedOut: false,
			truncated: false,
		});
		await expect(h.start(undefined, { shellHost: { exec: fake.exec } })).rejects.toThrow(
			/runsc[\s\S]*ZIMPOEN_SHELL=off/,
		);
	});

	it("on with a network: refuses to start without the egress rules", async () => {
		const h = await open({ ZIMPOEN_SHELL: "on", ZIMPOEN_SHELL_NETWORK: "zimpoen-shell" });
		const fake = engine({ exitCode: 0, output: "", timedOut: false, truncated: false });
		await expect(
			h.start(undefined, { shellHost: { exec: fake.exec, readMarker: async () => undefined } }),
		).rejects.toThrow(/egress marker[\s\S]*ops\/shell-egress\.sh/);
	});
});
