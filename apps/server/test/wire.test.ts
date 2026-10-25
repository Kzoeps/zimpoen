import type { AgentEvent, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { omitOpaque, toStreamBatch, toStreamEvent, toStreamSnapshot, toWireEntries } from "../src/wire.ts";

const entry = (id: number, kind: string, message?: object, extra: object = {}): EntryRecord =>
	({ id, conversationId: 1, kind, ...(message === undefined ? {} : { model: [message] }), ...extra }) as EntryRecord;

const user = (id: number, text = "hi") => entry(id, "pi.user", { role: "user", content: text, timestamp: 1 });
const system = (id: number) =>
	entry(id, "pi.system", { role: "system", content: "", sections: { profile: "x" }, timestamp: 1 });
const assistant = (id: number, extra: object = {}) =>
	entry(id, "pi.assistant", {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hm", thinkingSignature: "ENCRYPTED" },
			{ type: "text", text: "hello", textSignature: '{"v":1}' },
		],
		stopReason: "stop",
		...extra,
	});

const emptySnapshot = (entries: EntryRecord[]): SnapshotEvent => ({
	type: "snapshot",
	entries,
	tools: [],
	nestedTools: [],
	compactions: [],
	inbox: [],
	agent: {},
	usage: { models: {}, tools: {} },
});

describe("omitOpaque", () => {
	it("removes provider signatures at any depth without touching the input", () => {
		const input = {
			a: [{ thinkingSignature: "x", keep: 1 }],
			b: { c: { thoughtSignature: "y", textSignature: "z", n: 2 } },
		};
		const frozen = structuredClone(input);

		expect(omitOpaque(input)).toStrictEqual({ a: [{ keep: 1 }], b: { c: { n: 2 } } });
		expect(input).toStrictEqual(frozen);
	});

	it("passes primitives and null through", () => {
		expect([omitOpaque(null), omitOpaque(3), omitOpaque("s")]).toStrictEqual([null, 3, "s"]);
	});
});

describe("the bytes of an image in a tool result", () => {
	const read = entry(7, "pi.toolResult", {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read_file",
		isError: false,
		timestamp: 1,
		content: [
			{ type: "text", text: "fi_ab12cd34 “receipt.jpg”: image, image/jpeg, 2.0 MB." },
			{ type: "image", data: "A".repeat(4000), mimeType: "image/jpeg" },
		],
	});

	it("are replaced by a marker that keeps the type, the size left out and the file id; the text stays", () => {
		const [wire] = toWireEntries([read]);
		expect(wire?.model?.[0]).toMatchObject({
			content: [
				{ type: "text", text: "fi_ab12cd34 “receipt.jpg”: image, image/jpeg, 2.0 MB." },
				{ type: "image", mimeType: "image/jpeg", omitted: 3000, fileId: "fi_ab12cd34" },
			],
		});
		expect(JSON.stringify(wire)).not.toContain("AAAA");
	});

	it("do not leave the server in a snapshot, a history page or a live event, and the stored entry keeps them", () => {
		const before = structuredClone(read);
		expect(JSON.stringify(toStreamSnapshot(emptySnapshot([user(1), read])))).not.toContain("AAAA");
		expect(JSON.stringify(toStreamEvent({ type: "entry_appended", entry: read } as AgentEvent))).not.toContain("AAAA");
		expect(read).toStrictEqual(before);
	});

	it("carry no file id when the text does not name one, and an image without a type keeps none", () => {
		const bare = entry(8, "pi.toolResult", {
			role: "toolResult",
			content: [
				{ type: "text", text: "a screenshot" },
				{ type: "image", data: "QUJD" },
			],
		});
		const [wire] = toWireEntries([bare]);
		const message = wire?.model?.[0] as { content: Array<Record<string, unknown>> } | undefined;
		expect(message?.content[1]).toStrictEqual({ type: "image", omitted: 3 });
	});
});

describe("toWireEntries", () => {
	it("hides system-prompt entries and strips signatures, keeping order", () => {
		const wire = toWireEntries([system(1), user(2), assistant(3)]);

		expect(wire.map((e) => e.id)).toStrictEqual([2, 3]);
		expect(JSON.stringify(wire)).not.toContain("ENCRYPTED");
		expect(JSON.stringify(wire)).not.toContain("textSignature");
	});
});

describe("toStreamSnapshot", () => {
	it("keeps the newest entries when there are more than the limit, and says earlier ones exist", () => {
		const entries = [user(1, "a"), assistant(2), user(3, "b"), assistant(4), user(5, "c")];

		const snapshot = toStreamSnapshot(emptySnapshot(entries), [], 3);

		expect(snapshot.entries.map((e) => e.id)).toStrictEqual([3, 4, 5]);
		expect(snapshot.hasEarlier).toBe(true);
	});

	it("reports no earlier history for a short transcript", () => {
		const snapshot = toStreamSnapshot(emptySnapshot([system(1), user(2), assistant(3)]), [], 50);

		expect(snapshot.entries.map((e) => e.id)).toStrictEqual([2, 3]);
		expect(snapshot.hasEarlier).toBe(false);
	});

	it("reports earlier history when the active transcript starts at a head marker", () => {
		const marker = entry(10, "pi.compaction", { role: "user", content: "summary", timestamp: 1 }, { head: 7 });

		expect(toStreamSnapshot(emptySnapshot([marker, user(11)]), [], 50).hasEarlier).toBe(true);
	});

	it("keeps the persona prompt and server paths of the agent out of the snapshot, but not its model", () => {
		const agent = { model: { provider: "faux", modelId: "faux-1" }, instructions: "SECRET PERSONA", cwd: "/srv/data" };

		const snapshot = toStreamSnapshot({ ...emptySnapshot([]), agent });

		expect(snapshot.agent).toStrictEqual({ model: { provider: "faux", modelId: "faux-1" } });
	});

	it("carries the unanswered messages it is given", () => {
		const unanswered = [{ submissionId: 4, entry: 2, reason: "no_model" }];

		expect(toStreamSnapshot(emptySnapshot([user(2)]), unanswered).unanswered).toStrictEqual(unanswered);
		expect(toStreamSnapshot(emptySnapshot([user(2)])).unanswered).toStrictEqual([]);
	});

	it("strips signatures from the in-flight partial too", () => {
		const partial = { role: "assistant", content: [{ type: "thinking", thinking: "t", thinkingSignature: "S" }] };
		const snapshot = toStreamSnapshot({ ...emptySnapshot([]), generation: { attempt: 1, message: partial as never } });

		expect(JSON.stringify(snapshot)).not.toContain("thinkingSignature");
		expect(snapshot.generation?.message).toStrictEqual({
			role: "assistant",
			content: [{ type: "thinking", thinking: "t" }],
		});
	});
});

describe("toStreamEvent", () => {
	it("drops the events of system-prompt entries and keeps everything else", () => {
		const events: AgentEvent[] = [
			{ type: "message_start", message: { role: "system", content: "", timestamp: 1 } as never },
			{ type: "message_end", entry: system(1) },
			{ type: "entry_appended", entry: system(2) },
			{ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } },
			{ type: "message_end", entry: user(3) },
			{ type: "run_start", inputs: [9 as never] },
		];

		expect(toStreamBatch(events).map((event) => event.type)).toStrictEqual([
			"message_start",
			"message_end",
			"run_start",
		]);
	});

	it("turns a snapshot event into a windowed snapshot", () => {
		const event = toStreamEvent(emptySnapshot([system(1), user(2)]));

		expect(event).toMatchObject({ type: "snapshot", hasEarlier: false });
		expect(event?.type === "snapshot" && event.entries.map((e) => e.id)).toStrictEqual([2]);
	});

	it("drops the persona prompt from agent changes too", () => {
		const event: AgentEvent = {
			type: "agent_changed",
			agent: { thinkingLevel: "low", instructions: "SECRET PERSONA" },
		};

		expect(toStreamEvent(event)).toStrictEqual({ type: "agent_changed", agent: { thinkingLevel: "low" } });
	});

	it("strips signatures from message updates", () => {
		const update: AgentEvent = {
			type: "message_update",
			usage: {} as never,
			changes: [{ type: "block", contentIndex: 0, block: { type: "thinking", thinking: "t", thinkingSignature: "S" } }],
		};

		expect(JSON.stringify(toStreamEvent(update))).not.toContain("thinkingSignature");
	});
});
