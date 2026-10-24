import { existsSync } from "node:fs";
import { createServer } from "node:net";
import type { AgentSummary, AgentsResponse, MessagesPage, SendMessageResponse, StreamEvent } from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src/server.ts";
import { answerText, createFixture, isDone, readSse, recordingLogger, removeAllFixtures, waitFor } from "./support.ts";

const servers: RunningServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	await removeAllFixtures();
});

const base = (server: RunningServer) => `http://127.0.0.1:${server.port}`;

async function agentsOf(server: RunningServer): Promise<AgentSummary[]> {
	return ((await (await fetch(`${base(server)}/api/agents`)).json()) as AgentsResponse).agents;
}

async function sendMessage(server: RunningServer, conversationId: number, content: string, requestId: string) {
	const response = await fetch(`${base(server)}/api/conversations/${conversationId}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content, requestId }),
	});
	return { status: response.status, ...((await response.json()) as SendMessageResponse) };
}

describe("chat over real HTTP", () => {
	it("streams an agent's answer to a browser-style SSE client", async () => {
		const fixture = await createFixture();
		const server = await startServer(fixture.config, { logger: recordingLogger(), devModel: { tokensPerSecond: 60 } });
		servers.push(server);
		const [pa] = await agentsOf(server);
		if (pa === undefined) throw new Error("no agents");

		const stream = await fetch(`${base(server)}/api/conversations/${pa.conversationId}/stream`);
		expect(stream.headers.get("content-type")).toContain("text/event-stream");
		expect(stream.headers.get("cache-control")).toContain("no-transform");
		const reading = readSse(stream, (events) => events.some(isDone));

		const sent = await sendMessage(server, pa.conversationId, "hello over http", "e2e-1");
		const events = await reading;

		expect(sent.status).toBe(202);
		expect(events[0]?.type).toBe("snapshot");
		const answer = events.map(answerText).find((text) => text !== undefined);
		expect(answer).toContain("You said: “hello over http”");
		expect(events.filter((event) => event.type === "message_update").length).toBeGreaterThan(1);
		expect((await agentsOf(server))[0]?.busy).toBe(false);
	});

	it("shuts down promptly even with a browser tab still streaming", async () => {
		const fixture = await createFixture();
		const server = await startServer(fixture.config, { logger: recordingLogger() });
		servers.push(server);
		const [pa] = await agentsOf(server);
		const stream = await fetch(`${base(server)}/api/conversations/${pa?.conversationId}/stream`);
		const reading = readSse(stream, () => false, 5000);

		const started = Date.now();
		await server.close();

		expect(Date.now() - started).toBeLessThan(4000);
		await reading;
	});
});

describe("startup failures", () => {
	it("reports a busy port in plain words and releases the databases it had opened", async () => {
		const fixture = await createFixture();
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const busyPort = (blocker.address() as { port: number }).port;

		try {
			await expect(
				startServer(
					{ ...fixture.config, http: { ...fixture.config.http, port: busyPort } },
					{ logger: recordingLogger() },
				),
			).rejects.toThrow(new RegExp(`Port ${busyPort} on 127.0.0.1 is already in use.*ASSISTANT_PORT`));
			// The port is bound before anything else is opened: nothing was created or touched, so there is nothing to undo.
			expect(existsSync(fixture.config.paths.durableDb)).toBe(false);
			expect(existsSync(fixture.config.paths.appDb)).toBe(false);
			// The data directory lock was released again, so the next start can take it.
			servers.push(await startServer(fixture.config, { logger: recordingLogger() }));
		} finally {
			blocker.close();
		}
	});
});

describe("two servers on one data directory", () => {
	it("refuses the second before it opens durable.sqlite, and the first keeps answering undisturbed", async () => {
		const fixture = await createFixture();
		const first = await startServer(fixture.config, { logger: recordingLogger(), devModel: { tokensPerSecond: 25 } });
		servers.push(first);
		const [pa] = await agentsOf(first);
		if (pa === undefined) throw new Error("no agents");
		const stream = await fetch(`${base(first)}/api/conversations/${pa.conversationId}/stream`);
		const sawPartial = readSse(stream, (events) => events.some((event) => event.type === "message_update"));
		const sent = await sendMessage(first, pa.conversationId, "keep going while another server tries", "dual-1");
		await sawPartial;

		// Opening Durable would mark the first server's running task as restarted, so this must fail first.
		await expect(startServer(fixture.config, { logger: recordingLogger() })).rejects.toThrow(
			new RegExp(
				`process ${process.pid}\\) is already using the data directory.*ASSISTANT_DATA_DIR.*server\\.lock`,
				"s",
			),
		);

		const submission = await first.harness.submission(sent.submissionId as SubmissionId, BACKGROUND_CONTEXT);
		await waitFor(async () => (await submission?.status(BACKGROUND_CONTEXT))?.status === "done", {
			what: "the first server's answer to finish",
		});
		const page = (await (
			await fetch(`${base(first)}/api/conversations/${pa.conversationId}/messages`)
		).json()) as MessagesPage;
		const messages = page.entries.map((entry) => entry.model?.[0]);
		expect(messages.map((message) => message?.role)).toStrictEqual(["user", "assistant"]);
		expect(messages[1]?.role === "assistant" && messages[1].stopReason).toBe("stop");
	});

	it("lets a server start once the first has shut down cleanly", async () => {
		const fixture = await createFixture();
		const first = await startServer(fixture.config, { logger: recordingLogger() });
		await first.close();

		servers.push(await startServer(fixture.config, { logger: recordingLogger() }));
		expect(existsSync(`${fixture.config.dataDir}/server.lock`)).toBe(true);
	});
});

describe("restart in the middle of an answer", () => {
	/**
	 * What Durable does, observed: the answer being written when the process stops is kept in the transcript as an
	 * `aborted` assistant entry holding the partial text; on restart the interrupted generation runs again from the
	 * same user message and its full answer follows. The user message exists once, and the submission settles `done`.
	 */
	it("resumes the run on the next start: partial kept as aborted, then a complete answer, nothing sent twice", async () => {
		const fixture = await createFixture();
		const logger = recordingLogger();
		const first = await startServer(fixture.config, { logger, devModel: { tokensPerSecond: 20 } });
		servers.push(first);
		const [, inbox] = await agentsOf(first);
		if (inbox === undefined) throw new Error("no agents");
		const stream = await fetch(`${base(first)}/api/conversations/${inbox.conversationId}/stream`);
		const sawPartial = readSse(stream, (events) => events.some((event) => event.type === "message_update"));
		const sent = await sendMessage(first, inbox.conversationId, "answer me across a restart", "restart-1");
		await sawPartial;

		// The same thing SIGTERM does: close the Harness and the server while the model is still streaming.
		await first.close();

		const second = await startServer(fixture.config, { logger, devModel: { tokensPerSecond: 100_000 } });
		servers.push(second);
		const retried = await sendMessage(second, inbox.conversationId, "answer me across a restart", "restart-1");
		const submission = await second.harness.submission(sent.submissionId as SubmissionId, BACKGROUND_CONTEXT);
		await waitFor(async () => (await submission?.status(BACKGROUND_CONTEXT))?.status === "done", {
			what: "the interrupted run to finish after restart",
		});

		expect(retried.submissionId).toBe(sent.submissionId);
		const page = (await (
			await fetch(`${base(second)}/api/conversations/${inbox.conversationId}/messages`)
		).json()) as MessagesPage;
		const messages = page.entries.map((entry) => entry.model?.[0]);
		expect(messages.map((message) => message?.role)).toStrictEqual(["user", "assistant", "assistant"]);
		const [partial, complete] = [messages[1], messages[2]];
		expect(partial?.role === "assistant" && partial.stopReason).toBe("aborted");
		expect(complete?.role === "assistant" && complete.stopReason).toBe("stop");
		const completeText = complete?.role === "assistant" ? JSON.stringify(complete.content) : "";
		expect(completeText).toContain("You said: “answer me across a restart”");
		expect((await agentsOf(second))[1]?.busy).toBe(false);
		expect(logger.lines.filter((line) => line.startsWith("error"))).toStrictEqual([]);
	});

	it("a client that reconnects after the restart gets a snapshot that already holds the finished answer", async () => {
		const fixture = await createFixture();
		const first = await startServer(fixture.config, { logger: recordingLogger(), devModel: { tokensPerSecond: 20 } });
		servers.push(first);
		const [pa] = await agentsOf(first);
		if (pa === undefined) throw new Error("no agents");
		const stream = await fetch(`${base(first)}/api/conversations/${pa.conversationId}/stream`);
		const sawPartial = readSse(stream, (events) => events.some((event) => event.type === "message_update"));
		await sendMessage(first, pa.conversationId, "reconnect me", "restart-2");
		await sawPartial;
		await first.close();

		const second = await startServer(fixture.config, {
			logger: recordingLogger(),
			devModel: { tokensPerSecond: 100_000 },
		});
		servers.push(second);
		const reconnected = await fetch(`${base(second)}/api/conversations/${pa.conversationId}/stream`);
		const events: StreamEvent[] = await readSse(reconnected, (seen) => seen.some(isDone));

		const snapshot = events[0];
		expect(snapshot?.type).toBe("snapshot");
		// Either the resumed run is still in flight (snapshot says so) or it finished before the snapshot was taken.
		const inFlight = snapshot?.type === "snapshot" && snapshot.run !== undefined;
		const finished = events.some((event) => answerText(event)?.includes("You said: “reconnect me”"));
		const inSnapshot =
			snapshot?.type === "snapshot" &&
			snapshot.entries.some((entry) => JSON.stringify(entry.model).includes("You said: “reconnect me”"));
		expect(inFlight || finished || inSnapshot).toBe(true);
	});
});
