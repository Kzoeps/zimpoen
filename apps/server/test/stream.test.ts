import { type AppDb, coreMigrations, getAgentRow, migrate, openAppDb } from "@assistant/db";
import type { SendMessageResponse } from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS, ensureAgents } from "../src/agents.ts";
import { createApp } from "../src/http/app.ts";
import { openRuntime, type Runtime } from "../src/runtime.ts";
import { runConversationStream, type SseFrame } from "../src/stream.ts";
import {
	answerText,
	appDepsFor,
	createFixture,
	eventsOf,
	type Fixture,
	isDone,
	removeAllFixtures,
	waitFor,
} from "./support.ts";

let fixture: Fixture;
let db: AppDb;
let runtime: Runtime;

beforeEach(async () => {
	fixture = await createFixture();
	db = openAppDb(fixture.config.paths.appDb);
	migrate(db, coreMigrations);
	// Slow enough that one answer spans several 100 ms partial commits.
	runtime = await openRuntime(fixture.config, { devModel: { tokensPerSecond: 40 } });
	await ensureAgents(runtime.harness, db, { shared: runtime.shared, modelMode: "faux" });
	runtime.harness.resume();
});
afterEach(async () => {
	await runtime.close();
	db.close();
	await removeAllFixtures();
});

const conversationId = (agentId: string) => (getAgentRow(db, agentId)?.conversationId ?? -1) as ConversationId;

function connect(agentId: string, heartbeatMs?: number) {
	const frames: SseFrame[] = [];
	const controller = new AbortController();
	const ended = runConversationStream({
		harness: runtime.harness,
		conversationId: conversationId(agentId),
		write: (frame) => void frames.push(frame),
		signal: controller.signal,
		unanswered: runtime.unanswered,
		heartbeatMs,
	});
	return { frames, controller, ended };
}

async function send(agentId: string, content: string, requestId: string): Promise<number> {
	const app = createApp(appDepsFor(runtime, db));
	const response = await app.request(`/api/conversations/${conversationId(agentId)}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content, requestId }),
	});
	return ((await response.json()) as SendMessageResponse).submissionId;
}

describe("runConversationStream", () => {
	it("sends a snapshot first, then the answer as it is written, then the settled submission", async () => {
		const stream = connect("pa");
		await waitFor(() => stream.frames.length > 0, { what: "the snapshot frame" });

		await send("pa", "stream this please", "req-stream-1");
		await waitFor(() => eventsOf(stream.frames).some(isDone), { what: "the submission to settle" });
		const events = eventsOf(stream.frames);

		expect(events[0]?.type).toBe("snapshot");
		expect(events.filter((event) => event.type === "snapshot")).toHaveLength(1);
		const types = events.map((event) => event.type);
		expect(types.indexOf("run_start")).toBeLessThan(types.indexOf("message_update"));
		expect(types.filter((type) => type === "message_update").length).toBeGreaterThan(2);
		// The visible answer is built from deltas, and the committed entry carries the full text.
		const deltas = events.flatMap((event) =>
			event.type === "message_update" ? event.changes.flatMap((c) => (c.type === "text_delta" ? [c.delta] : [])) : [],
		);
		const finalText = events.map(answerText).find((text) => text !== undefined);
		expect(finalText).toContain("You said: “stream this please”");
		// The first partial may already hold some text, so the deltas are the tail of the answer, in order.
		expect(deltas.length).toBeGreaterThan(2);
		expect(finalText).toContain(deltas.join(""));
		expect(types.indexOf("message_end")).toBeLessThan(types.lastIndexOf("submission"));
		expect(types).toContain("run_end");

		stream.controller.abort();
		expect(await stream.ended).toBe("disconnected");
	});

	it("never sends the system prompt or provider signatures to the client", async () => {
		const stream = connect("accountant");
		await send("accountant", "hello", "req-stream-2");
		await waitFor(() => eventsOf(stream.frames).some(isDone), { what: "the submission to settle" });

		const wire = stream.frames.map((frame) => ("data" in frame ? frame.data : "")).join("\n");

		expect(wire).not.toContain('"kind":"pi.system"');
		expect(wire).not.toContain('"role":"system"');
		expect(wire).not.toMatch(/thinkingSignature|textSignature|thoughtSignature/);
		// The persona prompt is code-owned configuration, not something the browser needs.
		const persona = AGENTS.find((agent) => agent.id === "accountant")?.instructions ?? "";
		expect(persona.length).toBeGreaterThan(40);
		expect(wire).not.toContain(persona.slice(0, 40));
		expect(wire).not.toContain('"instructions"');
		stream.controller.abort();
		await stream.ended;
	});

	it("gives a late joiner the current run and the partial answer in its snapshot", async () => {
		await send("health", "start before anyone listens", "req-late-1");
		await waitFor(
			async () =>
				(await runtime.harness.snapshot(LiveDoc, conversationId("health"), BACKGROUND_CONTEXT))?.generation?.message,
			{ what: "a partial answer to be committed" },
		);

		const stream = connect("health");
		await waitFor(() => stream.frames.length > 0, { what: "the snapshot frame" });
		const [first] = eventsOf(stream.frames);

		expect(first?.type === "snapshot" && first.run).toBeTruthy();
		expect(first?.type === "snapshot" && first.generation?.message?.role).toBe("assistant");
		expect(first?.type === "snapshot" && first.entries.some((entry) => entry.kind === "pi.user")).toBe(true);
		stream.controller.abort();
		await stream.ended;
	});

	it("keeps a quiet connection alive with named `ping` events, which a browser's EventSource can see", async () => {
		const stream = connect("inbox", 25);

		await waitFor(() => stream.frames.filter((frame) => frame.event === "ping").length >= 2, { what: "two pings" });

		const ping = stream.frames.find((frame) => frame.event === "ping");
		expect(JSON.parse(ping?.data ?? "")).toMatchObject({ at: expect.any(Number) });
		stream.controller.abort();
		await stream.ended;
	});

	it("survives a client that is already gone, or leaves while its snapshot is being written", async () => {
		const gone = new AbortController();
		gone.abort();
		const alreadyGone = await runConversationStream({
			harness: runtime.harness,
			conversationId: conversationId("pa"),
			signal: gone.signal,
			unanswered: runtime.unanswered,
			write: () => {
				throw new Error("nothing may be written to a client that left");
			},
		});

		// What a React StrictMode double mount does in development: the first request is aborted straight away.
		const leaving = new AbortController();
		const leftDuringSnapshot = await runConversationStream({
			harness: runtime.harness,
			conversationId: conversationId("pa"),
			signal: leaving.signal,
			unanswered: runtime.unanswered,
			write: () => leaving.abort(),
		});

		expect([alreadyGone, leftDuringSnapshot]).toStrictEqual(["disconnected", "disconnected"]);
	});

	it("survives a write that throws on a heartbeat instead of taking the process down", async () => {
		let writes = 0;
		const ended = await runConversationStream({
			harness: runtime.harness,
			conversationId: conversationId("pa"),
			signal: new AbortController().signal,
			unanswered: runtime.unanswered,
			heartbeatMs: 10,
			write: () => {
				if (++writes > 1) throw new Error("socket closed");
			},
		});

		expect(ended).toBe("disconnected");
	});

	it("tells a reconnecting client why a message was never answered, and leaves out the ones the user stopped", async () => {
		const pa = conversationId("pa");
		const conversation = await runtime.harness.conversation(pa, BACKGROUND_CONTEXT);
		await conversation?.configure({ model: { provider: "openai", modelId: "not-served-here" } }, BACKGROUND_CONTEXT);
		const unservedId = await send("pa", "this will fail", "req-unanswered-1");
		await (await runtime.harness.submission(unservedId as never, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);
		await conversation?.configure({ model: { provider: "faux", modelId: "faux-1" } }, BACKGROUND_CONTEXT);
		const stoppedId = await send("pa", "stop this one", "req-unanswered-2");
		await conversation?.abort(BACKGROUND_CONTEXT);
		await (await runtime.harness.submission(stoppedId as never, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);

		const stream = connect("pa");
		await waitFor(() => stream.frames.length > 0, { what: "the snapshot frame" });
		const [snapshot] = eventsOf(stream.frames);

		expect(snapshot?.type).toBe("snapshot");
		const unanswered = snapshot?.type === "snapshot" ? snapshot.unanswered : [];
		expect(unanswered).toHaveLength(1);
		expect(unanswered[0]).toMatchObject({ submissionId: unservedId, reason: "no_model" });
		const userEntry =
			snapshot?.type === "snapshot" ? snapshot.entries.find((e) => e.id === unanswered[0]?.entry) : undefined;
		expect(JSON.stringify(userEntry?.model)).toContain("this will fail");
		stream.controller.abort();
		await stream.ended;
	});

	it("stops watching when the client disconnects: nothing more is written", async () => {
		const stream = connect("pa", 20);
		await waitFor(() => stream.frames.length > 0);
		stream.controller.abort();
		expect(await stream.ended).toBe("disconnected");
		const written = stream.frames.length;

		await send("pa", "anyone there?", "req-gone-1");
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(stream.frames).toHaveLength(written);
	});

	it("ends as `closed` when the server shuts down", async () => {
		const stream = connect("pa");
		await waitFor(() => stream.frames.length > 0);

		await runtime.close();

		expect(await stream.ended).toBe("closed");
	});

	it("ends as `disconnected` when a write fails because the client is gone", async () => {
		let calls = 0;
		const ended = runConversationStream({
			harness: runtime.harness,
			conversationId: conversationId("pa"),
			signal: new AbortController().signal,
			unanswered: runtime.unanswered,
			write: () => {
				if (++calls > 1) throw new Error("socket closed");
			},
		});

		await send("pa", "this write will fail", "req-fail-1");

		expect(await ended).toBe("disconnected");
	});
});
