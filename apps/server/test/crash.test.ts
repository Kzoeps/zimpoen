import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentsResponse, MessagesPage, SendMessageResponse } from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src/server.ts";
import { createFixture, type Fixture, readSse, recordingLogger, removeAllFixtures, waitFor } from "./support.ts";

const childScript = fileURLToPath(new URL("./support/crash-child.ts", import.meta.url));
const ctx = BACKGROUND_CONTEXT;

const children: ChildProcess[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const server of servers.splice(0)) await server.close();
	await removeAllFixtures();
});

/** Start the real server in a child process over `fixture`'s data directory; resolves with its port. */
async function spawnServer(fixture: Fixture): Promise<{ child: ChildProcess; port: number }> {
	const child = spawn(process.execPath, [childScript], {
		env: {
			...process.env,
			ASSISTANT_DATA_DIR: fixture.config.dataDir,
			ASSISTANT_READ_PATHS: join(fixture.root, "docs"),
			ASSISTANT_AUTH: "off",
			ASSISTANT_MODEL_MODE: "faux",
			CRASH_CHILD_TOKENS_PER_SECOND: "20",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	const collect = (chunk: Buffer): void => {
		output += chunk.toString();
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	const port = await waitFor(() => /READY (\d+)/.exec(output)?.[1], {
		what: `the child server to start. Its output so far:\n${output}`,
		timeoutMs: 30_000,
	});
	return { child, port: Number(port) };
}

async function killHard(child: ChildProcess): Promise<void> {
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGKILL");
	await exited;
}

/** Ask the child's pa agent a question and wait until its answer is demonstrably being written. */
async function askAndWaitForPartial(port: number, text: string, requestId: string) {
	const base = `http://127.0.0.1:${port}`;
	const { agents } = (await (await fetch(`${base}/api/agents`)).json()) as AgentsResponse;
	const pa = agents.find((agent) => agent.id === "pa");
	if (pa === undefined) throw new Error("the child has no pa agent");
	const stream = await fetch(`${base}/api/conversations/${pa.conversationId}/stream`);
	const sawPartial = readSse(stream, (events) => events.some((event) => event.type === "message_update"), 15_000);
	const response = await fetch(`${base}/api/conversations/${pa.conversationId}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content: text, requestId }),
	});
	const { submissionId } = (await response.json()) as SendMessageResponse;
	await sawPartial;
	return { conversationId: pa.conversationId, submissionId };
}

describe("a server that is killed without any chance to clean up (SIGKILL)", () => {
	/**
	 * Unlike `close()`, which Durable treats as "not a restart", a hard kill leaves the run marked `running`. The next
	 * open counts it as a restart (`restarts`) and runs it again; five of those in a row park the task.
	 */
	it("takes over the stale lock, counts the restart, and finishes the interrupted answer exactly once", async () => {
		const fixture = await createFixture();
		const { child, port } = await spawnServer(fixture);
		const { conversationId, submissionId } = await askAndWaitForPartial(port, "survive a hard kill", "crash-1");
		expect(existsSync(join(fixture.config.dataDir, "server.lock"))).toBe(true);

		await killHard(child);
		expect(existsSync(join(fixture.config.dataDir, "server.lock"))).toBe(true); // nothing released it

		const logger = recordingLogger();
		const server = await startServer(fixture.config, { logger, devModel: { tokensPerSecond: 15 } });
		servers.push(server);
		const { tasks } = await server.harness.inspect(ctx);
		expect(tasks.some((task) => (task.record.restarts ?? 0) === 1)).toBe(true);

		const submission = await server.harness.submission(submissionId as SubmissionId, ctx);
		await waitFor(async () => (await submission?.status(ctx))?.status === "done", {
			what: "the interrupted run to finish after the hard kill",
			timeoutMs: 30_000,
		});
		const page = (await (
			await fetch(`http://127.0.0.1:${server.port}/api/conversations/${conversationId}/messages`, {
				headers: { "content-type": "application/json" },
			})
		).json()) as MessagesPage;
		const roles = page.entries.map((entry) => entry.model?.[0]?.role);
		const last = page.entries.at(-1)?.model?.[0];
		expect(roles.filter((role) => role === "user")).toHaveLength(1);
		expect(last?.role === "assistant" && last.stopReason).toBe("stop");
		expect(JSON.stringify(last)).toContain("You said: “survive a hard kill”");
		expect(logger.lines.filter((line) => line.startsWith("error"))).toStrictEqual([]);
	});

	it("parks the task once it hit the restart limit, says so loudly and in /api/agents, and does not retry by itself", async () => {
		const fixture = await createFixture();
		const { child, port } = await spawnServer(fixture);
		const { conversationId, submissionId } = await askAndWaitForPartial(port, "this run will be parked", "crash-2");
		await killHard(child);

		const logger = recordingLogger();
		const server = await startServer(fixture.config, { logger, restartLimit: 1, devModel: { tokensPerSecond: 15 } });
		servers.push(server);

		const parkedLog = logger.lines.filter((line) => line.includes("PARKED"));
		expect(parkedLog).toHaveLength(1);
		expect(parkedLog[0]).toMatch(/^error .*will not answer until the task is retried/s);
		const health = (await (await fetch(`http://127.0.0.1:${server.port}/api/agents`)).json()) as AgentsResponse;
		expect(health.health.parkedTasks).toBe(1);

		// Nothing retries it: the message stays unanswered however long we wait.
		await new Promise((resolve) => setTimeout(resolve, 600));
		const submission = await server.harness.submission(submissionId as SubmissionId, ctx);
		expect((await submission?.status(ctx))?.status).not.toBe("done");
		const page = (await (
			await fetch(`http://127.0.0.1:${server.port}/api/conversations/${conversationId}/messages`)
		).json()) as MessagesPage;
		expect(
			page.entries.some((entry) => entry.model?.[0]?.role === "assistant" && entry.model[0].stopReason === "stop"),
		).toBe(false);

		// A later start reports it again, because a parked task survives restarts.
		await server.close();
		servers.pop();
		const again = recordingLogger();
		servers.push(await startServer(fixture.config, { logger: again, restartLimit: 1 }));
		expect(again.lines.some((line) => line.startsWith("error") && line.includes("1 task(s) are parked"))).toBe(true);
	});
});
