import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import {
	createDevProvider,
	FAUX_MODEL_ID,
	FAUX_PROVIDER_ID,
	parseToolCommand,
	scriptedReply,
	scriptedToolReply,
} from "../src/dev-model.ts";

describe("scriptedReply", () => {
	it("echoes the user's message and says which message of the conversation it answers", () => {
		const reply = scriptedReply({ userText: "what is my balance?", userTurns: 3 });

		expect(reply).toContain("You said: “what is my balance?”");
		expect(reply).toContain("message 3 of this conversation");
		expect(reply).toContain("Faux model (dev mode)");
	});

	it("shortens a very long message so the reply still streams in seconds", () => {
		const reply = scriptedReply({ userText: "x".repeat(5000), userTurns: 1 });

		expect(reply.length).toBeLessThan(700);
		expect(reply).toContain(`${"x".repeat(280)}…`);
	});
});

describe("createDevProvider", () => {
	const user = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

	async function ask(provider: ReturnType<typeof createDevProvider>, text: string, reasoning?: "medium") {
		const models = createModels();
		models.setProvider(provider.provider);
		const model = models.getModel(FAUX_PROVIDER_ID, FAUX_MODEL_ID);
		if (model === undefined) throw new Error("faux model missing");
		return await models.completeSimple(model, { messages: [user(text)] }, reasoning ? { reasoning } : undefined);
	}

	it("answers any number of requests, not just the few scripted ones", async () => {
		const provider = createDevProvider({ tokensPerSecond: 100_000 });

		const replies = [];
		for (let i = 0; i < 20; i++) replies.push(await ask(provider, `message ${i}`));

		expect(replies.every((reply) => reply.stopReason === "stop")).toBe(true);
		const last = replies.at(-1)?.content.find((block) => block.type === "text");
		expect(last && "text" in last ? last.text : "").toContain("You said: “message 19”");
	});

	it("includes a thinking block only when the agent asked for reasoning", async () => {
		const provider = createDevProvider({ tokensPerSecond: 100_000 });

		const plain = await ask(provider, "hi");
		const thoughtful = await ask(provider, "hi", "medium");

		expect(plain.content.map((block) => block.type)).toStrictEqual(["text"]);
		expect(thoughtful.content.map((block) => block.type)).toStrictEqual(["thinking", "text"]);
	});
});

describe("/tool commands", () => {
	it("turns '/tool name {json}' into a name and arguments, and leaves other messages alone", () => {
		expect(parseToolCommand('/tool add_task {"title":"Pay rent","remind_in_minutes":1}')).toStrictEqual({
			name: "add_task",
			args: { title: "Pay rent", remind_in_minutes: 1 },
		});
		expect(parseToolCommand("  /tool list_tasks  ")).toStrictEqual({ name: "list_tasks", args: {} });
		expect(parseToolCommand("remind me to /tool something")).toBeUndefined();
		expect(parseToolCommand("hello")).toBeUndefined();
	});

	it("explains arguments that are not a JSON object instead of calling the tool with nonsense", () => {
		for (const text of ["/tool add_task {oops", "/tool add_task [1,2]", "/tool add_task 5"]) {
			expect(parseToolCommand(text)).toStrictEqual({ problem: expect.stringContaining("must be a JSON object") });
		}
	});

	it("calls the tool when asked, with the same call id if the answer is generated again", async () => {
		const user = { role: "user" as const, content: '/tool list_tasks {"status":"all"}', timestamp: 1 };
		const ask = async () => {
			const provider = createDevProvider({ tokensPerSecond: 100_000 });
			const models = createModels();
			models.setProvider(provider.provider);
			const model = models.getModel(FAUX_PROVIDER_ID, FAUX_MODEL_ID);
			if (model === undefined) throw new Error("faux model missing");
			return await models.completeSimple(model, { messages: [user] });
		};

		const first = await ask();
		const again = await ask();

		expect(first.stopReason).toBe("toolUse");
		const call = first.content.find((block) => block.type === "toolCall");
		expect(call).toMatchObject({ name: "list_tasks", arguments: { status: "all" } });
		expect(again.content.find((block) => block.type === "toolCall")).toMatchObject({ id: (call as { id: string }).id });
	});

	it("says what the tool returned once it has, so the run ends instead of calling it again", () => {
		expect(scriptedToolReply("add_task", "Saved t_1", false)).toContain("add_task returned:\n\nSaved t_1");
		expect(scriptedToolReply("add_task", "Boom", true)).toContain("the tool add_task failed");
	});
});
