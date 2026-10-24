// Records the event streams the web tests replay: what the browser really receives from this server.
//
//   node apps/server/scripts/record-fixtures.ts
//
// Runs the whole server on a temp data directory with the scripted dev model, drives four scenarios over real HTTP,
// and writes apps/web/test/fixtures/*.json. Re-run it after upgrading Durable, whose event protocol is experimental,
// and review the diff: if the web tests still pass, the browser still understands the server.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AgentSummary, AgentsResponse, StreamBatch } from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type RunningServer, startServer } from "../src/server.ts";
import { createFixture, readSseBatches, removeAllFixtures } from "../test/support.ts";

const outDir = fileURLToPath(new URL("../../web/test/fixtures/", import.meta.url));
const quiet = { info() {}, warn() {}, error: console.error };
const isDone = (batches: StreamBatch[]) =>
	batches
		.flat()
		.some(
			(event) => event.type === "submission" && event.record.status !== "queued" && event.record.status !== "placed",
		);

type Recording = { description: string; connections: StreamBatch[][] };

async function agents(server: RunningServer): Promise<AgentSummary[]> {
	return ((await (await fetch(`http://127.0.0.1:${server.port}/api/agents`)).json()) as AgentsResponse).agents;
}

const stream = (server: RunningServer, id: number) =>
	fetch(`http://127.0.0.1:${server.port}/api/conversations/${id}/stream`);

async function send(server: RunningServer, id: number, content: string, requestId: string): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${server.port}/api/conversations/${id}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content, requestId }),
	});
	if (response.status !== 202) throw new Error(`send failed: ${response.status} ${await response.text()}`);
}

async function save(name: string, recording: Recording): Promise<void> {
	await mkdir(outDir, { recursive: true });
	await writeFile(`${outDir}${name}.json`, `${JSON.stringify(recording, null, "\t")}\n`);
	const events = recording.connections.flat(2).length;
	console.log(`recorded ${name}: ${recording.connections.length} connection(s), ${events} events`);
}

/** Two turns; the second is watched on a fresh connection, as after a page reload. */
async function chatTurns(): Promise<Recording> {
	const fixture = await createFixture();
	const server = await startServer(fixture.config, { logger: quiet, devModel: { tokensPerSecond: 80 } });
	try {
		const [pa] = await agents(server);
		if (pa === undefined) throw new Error("no agents");
		const first = readSseBatches(await stream(server, pa.conversationId), isDone);
		await send(server, pa.conversationId, "What is on my plate today?", "fixture-chat-1");
		const turnOne = await first;

		const second = readSseBatches(await stream(server, pa.conversationId), isDone);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await send(server, pa.conversationId, "And tomorrow?", "fixture-chat-2");
		return {
			description:
				"Two turns with the dev model; the second turn is on a new connection that starts with a snapshot of the first.",
			connections: [turnOne, await second],
		};
	} finally {
		await server.close();
		await fixture.cleanup();
	}
}

/** The user presses Stop while the answer is streaming. */
async function stopMidway(): Promise<Recording> {
	const fixture = await createFixture();
	const server = await startServer(fixture.config, { logger: quiet, devModel: { tokensPerSecond: 40 } });
	try {
		const [, inbox] = await agents(server);
		if (inbox === undefined) throw new Error("no agents");
		const reading = readSseBatches(await stream(server, inbox.conversationId), (batches) => isDone(batches));
		await send(server, inbox.conversationId, "Write something long", "fixture-stop-1");
		await new Promise((resolve) => setTimeout(resolve, 700));
		await fetch(`http://127.0.0.1:${server.port}/api/conversations/${inbox.conversationId}/abort`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		return {
			description:
				"Stop pressed mid-answer: the partial is kept as an aborted message, the submission ends unanswered/aborted.",
			connections: [await reading],
		};
	} finally {
		await server.close();
		await fixture.cleanup();
	}
}

/** The server restarts while the answer is streaming; the browser reconnects to the new process. */
async function restartResume(): Promise<Recording> {
	const fixture = await createFixture();
	const first = await startServer(fixture.config, { logger: quiet, devModel: { tokensPerSecond: 20 } });
	let second: RunningServer | undefined;
	try {
		const [, , health] = await agents(first);
		if (health === undefined) throw new Error("no agents");
		const before = readSseBatches(
			await stream(first, health.conversationId),
			(batches) => batches.flat().filter((e) => e.type === "message_update").length >= 3,
		);
		await send(first, health.conversationId, "Tell me about my week", "fixture-restart-1");
		const interrupted = await before;
		await first.close();

		second = await startServer(fixture.config, { logger: quiet, devModel: { tokensPerSecond: 60 } });
		const after = await readSseBatches(await stream(second, health.conversationId), isDone);
		return {
			description:
				"Server restarted mid-answer: first connection is cut, the second starts with a snapshot and the resumed run completes.",
			connections: [interrupted, after],
		};
	} finally {
		await second?.close();
		await first.close();
		await fixture.cleanup();
	}
}

/** The agent's model is not available: the message is never answered. */
async function noModel(): Promise<Recording> {
	const fixture = await createFixture();
	const server = await startServer(fixture.config, { logger: quiet });
	try {
		const [, , , accountant] = await agents(server);
		if (accountant === undefined) throw new Error("no agents");
		const conversation = await server.harness.conversation(accountant.conversationId as never, BACKGROUND_CONTEXT);
		await conversation?.configure(
			{ model: { provider: "openai", modelId: "not-registered-in-faux-mode" } },
			BACKGROUND_CONTEXT,
		);
		const reading = readSseBatches(await stream(server, accountant.conversationId), isDone);
		await send(server, accountant.conversationId, "Split 900 between three people", "fixture-nomodel-1");
		const live = await reading;
		// A page reload: the new connection's snapshot must still carry the reason the message was not answered.
		const reloaded = await readSseBatches(
			await stream(server, accountant.conversationId),
			(batches) => batches.length > 0,
		);
		return {
			description:
				"The agent's model is not served by this process: the submission ends unanswered with reason no_model. " +
				"The second connection is a reload and holds only its snapshot.",
			connections: [live, reloaded],
		};
	} finally {
		await server.close();
		await fixture.cleanup();
	}
}

try {
	await save("chat-turns", await chatTurns());
	await save("stop-midway", await stopMidway());
	await save("restart-resume", await restartResume());
	await save("no-model", await noModel());
} finally {
	await removeAllFixtures();
}
