import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import { createDevProvider, FAUX_MODEL_ID, FAUX_PROVIDER_ID, scriptedReply } from "../src/dev-model.ts";

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
