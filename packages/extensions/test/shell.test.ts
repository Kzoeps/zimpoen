import { type AppDb, coreMigrations, insertAgentRow, migrate, openAppDb } from "@assistant/db";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecRequest, ExecResult } from "../src/broker/index.ts";
import { botsModule, botsStore, type DomainDeps, delegateModule } from "../src/index.ts";
import {
	BLOCKED_EGRESS_RANGES,
	buildRunArgv,
	type ContainerRunner,
	checkShellHost,
	createEngineRunner,
	createShellExtension,
	type EgressMarker,
	reapContainers,
	SHELL_LIMITS,
	type ShellHostConfig,
	type ShellRunRequest,
	volumeName,
} from "../src/shell/index.ts";

const CONFIG: ShellHostConfig = {
	engine: "docker",
	bin: "/usr/bin/docker",
	image: "docker.io/library/debian:stable-slim",
	network: "none",
	egressMarker: "/run/zimpoen-shell/egress.ok",
};

const ok = (output = ""): ExecResult => ({ exitCode: 0, output, timedOut: false, truncated: false });

/** A fake engine CLI: records every argv and answers from `answer`. */
function fakeExec(answer: (args: readonly string[]) => ExecResult = () => ok()) {
	const calls: ExecRequest[] = [];
	const exec = async (req: ExecRequest) => {
		calls.push(req);
		return answer(req.args);
	};
	return { calls, exec };
}

describe("sandbox argv", () => {
	const argv = buildRunArgv(CONFIG, { agentId: "pa", command: "echo $HOME; rm -rf /", timeoutMs: 1000, callId: "c1" });

	it("runs gVisor with a read-only root, no capabilities, no new privileges, limits and no network", () => {
		for (const flag of [
			"--runtime=runsc",
			"--read-only",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			`--pids-limit=${SHELL_LIMITS.pids}`,
			`--memory=${SHELL_LIMITS.memory}`,
			`--cpus=${SHELL_LIMITS.cpus}`,
			"--network=none",
			"--pull=never",
			"--rm",
		]) {
			expect(argv).toContain(flag);
		}
		expect(argv.some((arg) => arg.startsWith("--dns"))).toBe(false);
	});

	it("mounts only the agent's named volume, never a host path", () => {
		expect(argv.filter((arg) => arg === "-v" || arg.startsWith("--volume") || arg.includes("type=bind"))).toEqual([]);
		expect(argv.filter((arg) => arg === "--mount")).toHaveLength(1);
		expect(argv).toContain("type=volume,src=zimpoen-shell-pa,dst=/workspace");
		expect(argv.some((arg) => arg.startsWith("--env") && !arg.startsWith("--env=HOME="))).toBe(false);
	});

	it("passes the command as one argument to /bin/sh -c inside the container", () => {
		expect(argv.slice(-8)).toEqual([
			CONFIG.image,
			"timeout",
			"-s",
			"KILL",
			"6",
			"/bin/sh",
			"-c",
			"echo $HOME; rm -rf /",
		]);
		expect(argv[0]).toBe("/usr/bin/docker");
	});

	it("uses public resolvers on a filtered network", () => {
		const onNet = buildRunArgv(
			{ ...CONFIG, network: "zimpoen-shell" },
			{ agentId: "pa", command: "x", timeoutMs: 1, callId: "c" },
		);
		expect(onNet).toContain("--network=zimpoen-shell");
		expect(onNet).toContain("--dns=1.1.1.1");
	});

	it("gives each agent its own volume and none to the Inbox", () => {
		expect(volumeName("bot:research")).toBe("zimpoen-shell-bot-research");
		expect(() => volumeName("inbox")).toThrow();
		expect(() => volumeName("bot:../x")).toThrow();
	});
});

describe("engine runner", () => {
	it("creates and hands over the volume once, then runs the command", async () => {
		const { calls, exec } = fakeExec((args) =>
			args[0] === "volume" && args[1] === "inspect" ? { ...ok("no such volume"), exitCode: 1 } : ok("hi\n"),
		);
		const runner = createEngineRunner(CONFIG, exec);
		const req: ShellRunRequest = { agentId: "pa", command: "echo hi", timeoutMs: 5000, callId: "c1" };
		expect(await runner.run(req)).toMatchObject({ exitCode: 0, output: "hi\n", timedOut: false });
		await runner.run({ ...req, callId: "c2" });
		const verbs = calls.map((call) => call.args.slice(0, 2).join(" "));
		expect(verbs).toEqual(["volume inspect", "volume create", "run --rm", "run --rm", "run --rm"]);
		const chown = calls[2]?.args ?? [];
		expect(chown).toContain("--runtime=runsc");
		expect(chown).toContain("--network=none");
		expect(chown.slice(-3)).toEqual(["chown", "1000:1000", "/workspace"]);
		for (const call of calls) expect(Object.keys(call.env).sort()).toEqual(["LANG", "PATH"]);
		expect(calls[3]?.timeoutMs).toBe(5000);
	});

	it("removes an agent's volume, does nothing when there is none, and reports a failure", async () => {
		let exists = true;
		let rmFails = false;
		const { calls, exec } = fakeExec((args) => {
			if (args[1] === "inspect") return exists ? ok() : { ...ok("no such volume"), exitCode: 1 };
			if (args[1] === "rm") return rmFails ? { ...ok("volume in use"), exitCode: 1 } : ok();
			return ok();
		});
		const runner = createEngineRunner(CONFIG, exec);
		await runner.removeVolume("bot:coder");
		expect(calls.map((call) => call.args.join(" "))).toEqual([
			"volume inspect zimpoen-shell-bot-coder",
			"volume rm --force zimpoen-shell-bot-coder",
		]);
		exists = false;
		calls.length = 0;
		await runner.removeVolume("bot:coder");
		expect(calls).toHaveLength(1);
		exists = true;
		rmFails = true;
		await expect(runner.removeVolume("bot:coder")).rejects.toThrow("volume in use");
	});

	it("chowns an existing volume too, and retries a chown that failed", async () => {
		let chownFails = true;
		const { calls, exec } = fakeExec((args) => {
			if (args[0] === "run" && args.includes("chown") && chownFails) {
				chownFails = false;
				return { ...ok("image not pulled"), exitCode: 125 };
			}
			return ok();
		});
		const runner = createEngineRunner(CONFIG, exec);
		const req: ShellRunRequest = { agentId: "pa", command: "id", timeoutMs: 1000, callId: "c1" };
		await expect(runner.run(req)).rejects.toThrow("Could not prepare the sandbox volume");
		await runner.run(req);
		const chowns = calls.filter((call) => call.args.includes("chown"));
		expect(chowns).toHaveLength(2);
		expect(calls.filter((call) => call.args[1] === "create")).toEqual([]);
	});

	it("builds no container for an id that is not an agent's", async () => {
		const { calls, exec } = fakeExec();
		await expect(
			createEngineRunner(CONFIG, exec).run({ agentId: "inbox", command: "id", timeoutMs: 1000, callId: "c1" }),
		).rejects.toThrow("cannot have a shell sandbox");
		expect(calls).toEqual([]);
	});

	it("reaps leftover sandbox containers by label", async () => {
		const { calls, exec } = fakeExec((args) => (args[0] === "ps" ? ok("abc123def456\n0123456789ab\n") : ok()));
		expect(await reapContainers(CONFIG, exec)).toBe(2);
		expect(calls.map((call) => call.args)).toEqual([
			["ps", "--all", "--quiet", "--filter", "label=zimpoen.shell=1"],
			["rm", "--force", "abc123def456", "0123456789ab"],
		]);
		const none = fakeExec((args) => (args[0] === "ps" ? ok("") : ok()));
		expect(await reapContainers(CONFIG, none.exec)).toBe(0);
		expect(none.calls).toHaveLength(1);
	});

	it("removes a timed-out container and caps output", async () => {
		const big = "x".repeat(SHELL_LIMITS.maxOutputBytes + 50);
		const { calls, exec } = fakeExec((args) =>
			args[0] === "run" && !args.includes("chown")
				? { exitCode: 137, output: big, timedOut: true, truncated: true }
				: ok(),
		);
		const result = await createEngineRunner(CONFIG, exec).run({
			agentId: "pa",
			command: "yes",
			timeoutMs: 10,
			callId: "c1",
		});
		expect(result.timedOut).toBe(true);
		expect(result.output).toContain("[output truncated");
		expect(Buffer.byteLength(result.output)).toBeLessThan(SHELL_LIMITS.maxOutputBytes + 100);
		const rm = calls.at(-1)?.args ?? [];
		expect(rm.slice(0, 2)).toEqual(["rm", "--force"]);
		expect(rm[2]).toMatch(/^zimpoen-shell-pa-[0-9a-f]{12}$/);
	});
});

describe("host check", () => {
	const NET: ShellHostConfig = { ...CONFIG, network: "zimpoen-shell" };
	const markerText = `network=zimpoen-shell\nbridge=zs-br0\nblocked=${BLOCKED_EGRESS_RANGES.join(",")}\n`;
	const marker = (over: Partial<EgressMarker> = {}): EgressMarker => ({
		owner: 0,
		mode: 0o100644,
		text: markerText,
		...over,
	});
	const engine = (bridge = "zs-br0") => fakeExec((args) => (args[0] === "network" ? ok(`${bridge}\n`) : ok())).exec;

	it("passes with gVisor and no network, without reading a marker", async () => {
		const { calls, exec } = fakeExec();
		const readMarker = async () => {
			throw new Error("not read");
		};
		expect(await checkShellHost(CONFIG, { exec, readMarker })).toEqual([]);
		expect(calls[0]?.args).toContain("--runtime=runsc");
		expect(calls[0]?.args.slice(-7)).toEqual([
			"timeout",
			"-s",
			"KILL",
			"5",
			"/bin/sh",
			"-c",
			"command -v chown >/dev/null",
		]);
	});

	it("refuses when the runsc runtime is missing", async () => {
		const { exec } = fakeExec(() => ({ ...ok("unknown or invalid runtime name: runsc"), exitCode: 125 }));
		const problems = await checkShellHost(CONFIG, { exec });
		expect(problems.join()).toContain("gVisor");
		expect(problems.join()).toContain("runsc");
	});

	it("refuses a network without the egress marker", async () => {
		const problems = await checkShellHost(NET, { exec: engine(), readMarker: async () => undefined });
		expect(problems.join()).toContain("egress marker");
		expect(problems.join()).toContain("ops/shell-egress.sh");
	});

	it("refuses a marker anyone but root can write", async () => {
		const problems = await checkShellHost(NET, { exec: engine(), readMarker: async () => marker({ owner: 1000 }) });
		expect(problems.join()).toContain("owned by root");
		const writable = await checkShellHost(NET, { exec: engine(), readMarker: async () => marker({ mode: 0o100666 }) });
		expect(writable.join()).toContain("owned by root");
	});

	it("refuses rules that miss a range or filter another bridge", async () => {
		const partial = markerText.replace(",fd7a:115c:a1e0::/48", "");
		const missing = await checkShellHost(NET, { exec: engine(), readMarker: async () => marker({ text: partial }) });
		expect(missing.join()).toContain("fd7a:115c:a1e0::/48");
		const other = await checkShellHost(NET, { exec: engine("docker0"), readMarker: async () => marker() });
		expect(other.join()).toContain("bridge");
	});

	it("passes with the marker and a matching bridge", async () => {
		expect(await checkShellHost(NET, { exec: engine(), readMarker: async () => marker() })).toEqual([]);
	});
});

describe("shell_run tool", () => {
	const dbs: AppDb[] = [];
	afterEach(() => {
		for (const db of dbs.splice(0)) db.close();
	});

	const CONV = { pa: 1, inbox: 2, health: 3, "bot:coder": 4, "bot:reader": 5, ghost: 6 } as const;

	function setup(options: { requestIds?: string[]; shell?: boolean; fail?: boolean } = {}) {
		const db = openAppDb(":memory:");
		dbs.push(db);
		migrate(db, [...coreMigrations, ...delegateModule.migrations, ...botsModule.migrations]);
		for (const [id, conversationId] of Object.entries(CONV)) {
			if (id !== "ghost") insertAgentRow(db, { id, conversationId, createdAt: 0 });
		}
		const bot = { name: "B", avatar: "🤖", soul: "s", approvedVia: "owner" as const, now: 0 };
		botsStore.insertBot(db, { ...bot, slug: "coder", tools: ["shell"], callId: "b1" });
		botsStore.insertBot(db, { ...bot, slug: "reader", tools: ["web"], callId: "b2" });
		const runs: ShellRunRequest[] = [];
		const runner: ContainerRunner = {
			removeVolume: async () => undefined,
			run: async (req) => {
				runs.push(req);
				if (options.fail === true) throw new Error("Could not create the sandbox volume zimpoen-shell-pa: boom");
				return { exitCode: 0, output: "done", timedOut: false, truncated: false };
			},
		};
		const deps = {
			db,
			harness: () => {
				throw new Error("not used");
			},
			runRequestIds: async () => options.requestIds ?? ["msg-1"],
			...(options.shell === false ? {} : { shell: { runner } }),
		} as unknown as DomainDeps;
		const tools = createShellExtension(deps).tools ?? [];
		const call = async (conversationId: number, args: Record<string, unknown>): Promise<string> => {
			const tool = tools.find((candidate) => candidate.name === "shell_run");
			if (tool === undefined) throw new Error("shell_run not registered");
			const result: ToolExecutionResult = await tool.execute(
				args as never,
				{ callId: `call-${conversationId}`, conversationId } as unknown as ToolExecutionApi,
				BACKGROUND_CONTEXT,
			);
			return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
		};
		return { tools, runs, call };
	}

	it("registers nothing when the shell is off", () => {
		expect(setup({ shell: false }).tools).toEqual([]);
	});

	it("runs the PA's command in the PA's sandbox with the default timeout", async () => {
		const f = setup();
		expect(await f.call(CONV.pa, { command: "ls" })).toContain("Exit code 0");
		expect(f.runs).toEqual([{ agentId: "pa", command: "ls", timeoutMs: 60_000, callId: "call-1" }]);
	});

	it("surfaces a runner failure as a tool error", async () => {
		const f = setup({ fail: true });
		await expect(f.call(CONV.pa, { command: "ls" })).rejects.toThrow("Could not create the sandbox volume");
	});

	it("never runs for the Inbox, even if it were wired the tool", async () => {
		const f = setup();
		expect(await f.call(CONV.inbox, { command: "id" })).toContain("Refused");
		expect(f.runs).toEqual([]);
	});

	it("runs for a bot only when its preset has shell", async () => {
		const f = setup();
		expect(await f.call(CONV["bot:reader"], { command: "id" })).toContain("Refused");
		expect(await f.call(CONV.health, { command: "id" })).toContain("Refused");
		expect(await f.call(CONV.ghost, { command: "id" })).toContain("Refused");
		expect(await f.call(CONV["bot:coder"], { command: "id", timeoutSeconds: 300 })).toContain("Exit code 0");
		expect(f.runs).toEqual([{ agentId: "bot:coder", command: "id", timeoutMs: 300_000, callId: "call-4" }]);
	});

	it("refuses during a scheduled run and when the run's origin is unknown (rule 13)", async () => {
		const routine = setup({ requestIds: ["routine:r_ab12:2026-10-25T08:00:00.000Z"] });
		expect(await routine.call(CONV.pa, { command: "ls" })).toContain("rule 13");
		const unknown = setup({ requestIds: [] });
		expect(await unknown.call(CONV.pa, { command: "ls" })).toContain("rule 13");
		expect([...routine.runs, ...unknown.runs]).toEqual([]);
	});
});
