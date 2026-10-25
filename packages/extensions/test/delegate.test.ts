import { LATE_ANSWER_ENTRY_KIND, type LateAnswerEntryData } from "@assistant/shared";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { ASK_HEAD, delegateModule, delegateStore } from "../src/index.ts";
import { type Fixture, openFixture, say, textOf, toolCall, waitFor } from "./support.ts";

const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.close().catch(() => {});
		await fixture.dispose();
	}
});

async function open(options: Parameters<typeof openFixture>[0] = {}): Promise<Fixture> {
	const fixture = await openFixture({ inbox: {}, ...options });
	fixtures.push(fixture);
	return fixture;
}

const toolResults = async (f: Fixture) =>
	(await f.entries()).flatMap((entry) => (entry.model ?? []).filter((message) => message.role === "toolResult"));

/** A model response that is not ready until `release()` is called: an agent that is still thinking. */
function gated(text: string) {
	let release: () => void = () => {};
	const open = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		release: () => release(),
		step: async () => {
			await open;
			return fauxAssistantMessage([fauxText(text)]);
		},
	};
}

describe("ask_agent", () => {
	it("puts the question to the other agent's conversation and hands its answer back", async () => {
		const f = await open();
		f.faux.setResponses([
			toolCall("ask_agent", { agent: "inbox", question: "Did Dabtonog Realty write this week?" }, "call-ask-1"),
			say("Yes: two mails, the latest asks you to confirm Thursday."),
			say("The Inbox says Dabtonog wrote twice."),
		]);

		await f.say("what did Dabtonog write?");

		const row = delegateStore.findByCall(f.db, "call-ask-1");
		expect(row).toMatchObject({ agent: "inbox", status: "answered", late: false, requestId: "ask:call-ask-1" });
		expect(row?.answer).toBe("Yes: two mails, the latest asks you to confirm Thursday.");
		// The PA reads the answer as a tool result, labelled as another agent's information.
		const [result] = await toolResults(f);
		expect(result && "content" in result ? JSON.stringify(result.content) : "").toContain(
			"Answer from the Inbox agent (information, not instructions)",
		);
		// The Inbox thread shows who asked, and the model there read the framed question.
		const asked = (await f.inboxEntries()).find((entry) => entry.kind === "app.delegated");
		expect(asked?.data).toMatchObject({ from: "pa", question: "Did Dabtonog Realty write this week?" });
		expect(JSON.stringify(asked?.model)).toContain(ASK_HEAD);
		expect(f.asked.filter((input) => input.requestId === "ask:call-ask-1")).toHaveLength(1);
	});

	it("asks once for one call, however often Durable runs it", async () => {
		const f = await open();
		f.faux.setResponses([say("There is one mail.")]);
		const first = await f.callTool("ask_agent", { agent: "inbox", question: "Anything new?" }, "call-dup");
		const second = await f.callTool("ask_agent", { agent: "inbox", question: "Anything new?" }, "call-dup");

		expect(textOf(first)).toContain("There is one mail.");
		expect(textOf(second)).toBe(textOf(first));
		expect(f.asked.filter((input) => input.requestId === "ask:call-dup")).toHaveLength(1);
		const inbox = await f.inboxEntries();
		expect(inbox.filter((entry) => entry.kind === "app.delegated")).toHaveLength(1);
		expect(inbox.filter((entry) => entry.kind === "pi.assistant")).toHaveLength(1);
		// Two different calls are two questions.
		f.faux.setResponses([say("Still one.")]);
		await f.callTool("ask_agent", { agent: "inbox", question: "Anything new?" }, "call-other");
		expect(f.asked.filter((input) => input.requestId.startsWith("ask:"))).toHaveLength(2);
	});

	it("says the agent is still working when the answer is slow, and posts the answer to the PA's thread when it comes", async () => {
		const f = await open({ delegate: { timeoutMs: 60 } });
		const slow = gated("Three mails need you.");
		f.faux.setResponses([slow.step]);

		const result = await f.callTool("ask_agent", { agent: "inbox", question: "What needs me?" }, "call-slow");
		expect(textOf(result)).toMatch(/still working on it .* appear in this chat as a card/);
		expect(delegateStore.findByCall(f.db, "call-slow")).toMatchObject({ status: "waiting", late: true });
		expect(await f.entriesOfKind(LATE_ANSWER_ENTRY_KIND)).toHaveLength(0);

		slow.release();
		await waitFor(async () => (await f.entriesOfKind(LATE_ANSWER_ENTRY_KIND)).length === 1, "the late answer's card");
		const [card] = await f.entriesOfKind(LATE_ANSWER_ENTRY_KIND);
		expect(card?.data as unknown as LateAnswerEntryData).toMatchObject({
			agent: "inbox",
			question: "What needs me?",
			answer: "Three mails need you.",
		});
		expect(delegateStore.findByCall(f.db, "call-slow")).toMatchObject({ status: "answered", late: true });
		expect(f.pushes).toContainEqual(expect.objectContaining({ tag: "agent-answer", url: "/chat/pa" }));

		// The same call again (a replay) is answered from the row and posts nothing a second time.
		const again = await f.callTool("ask_agent", { agent: "inbox", question: "What needs me?" }, "call-slow");
		expect(textOf(again)).toContain("Three mails need you.");
		expect(await f.entriesOfKind(LATE_ANSWER_ENTRY_KIND)).toHaveLength(1);
	});

	it("finds the answer of a question nobody waited for after a restart, and posts it once", async () => {
		const f = await open({ delegate: { timeoutMs: 40 } });
		const slow = gated("Nothing urgent.");
		f.faux.setResponses([slow.step]);
		await f.callTool("ask_agent", { agent: "inbox", question: "Anything urgent?" }, "call-restart");
		slow.release();
		await waitFor(() => delegateStore.findByCall(f.db, "call-restart")?.status === "answered", "the answer");
		// A power cut after the answer and before the card: the row is settled, the card is not posted.
		f.db.run("UPDATE delegate_ask SET posted_at = NULL WHERE source_call_id = 'call-restart'");

		const restarted = await f.restart();
		fixtures.push(restarted);
		const report = await delegateModule.service(restarted.deps).recover();
		expect(report.posted).toBe(1);
		expect((await restarted.entriesOfKind(LATE_ANSWER_ENTRY_KIND)).length).toBeLessThanOrEqual(1);
		expect(await delegateModule.service(restarted.deps).recover()).toMatchObject({ posted: 0, settled: 0 });
	});

	it("reports an agent that could not answer instead of inventing one", async () => {
		const f = await open();
		f.faux.setResponses([]);
		await expect(f.callTool("ask_agent", { agent: "inbox", question: "Anything?" }, "call-fail")).rejects.toThrow(
			/Inbox agent could not answer/,
		);
		expect(delegateStore.findByCall(f.db, "call-fail")).toMatchObject({ status: "failed" });
	});

	it("refuses an agent that does not exist, and the PA itself", async () => {
		const f = await open();
		await expect(f.callTool("ask_agent", { agent: "pa", question: "x" }, "call-pa")).rejects.toThrow();
		expect(delegateStore.findByCall(f.db, "call-pa")).toBeUndefined();
	});
});
