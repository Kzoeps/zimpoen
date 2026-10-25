import { join } from "node:path";
import { BIRTHDAY_ENTRY_KIND, NOTICE_ENTRY_KIND, type NoticeEntryData, type ToolCard } from "@assistant/shared";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_TTL_MS, ApprovalConflict, isYes, REMINDER_TASK_NAME, taskStore } from "../src/index.ts";
import {
	ctx,
	type Fixture,
	MINUTE,
	openFixture,
	restoreDurable,
	say,
	snapshotDurable,
	toolCall,
	waitFor,
} from "./support.ts";

const fixtures: Fixture[] = [];
async function open(...args: Parameters<typeof openFixture>): Promise<Fixture> {
	const fixture = await openFixture(...args);
	fixtures.push(fixture);
	return fixture;
}
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.close().catch(() => {});
		await fixture.dispose();
	}
});

/** Save a task with a reminder and return its id. */
async function taskWithReminder(f: Fixture, title = "Pay rent"): Promise<string> {
	await f.callTool("add_task", { title, remind_in_minutes: 60 }, `add-${title}`);
	const row = taskStore.listTasks(f.db, { status: "open", limit: 10 }).tasks.find((task) => task.title === title);
	if (row === undefined) throw new Error("task not saved");
	return row.id;
}

/** Ask the scripted model to propose deleting `taskId`; resolves with the approval card the tool returned. */
async function propose(f: Fixture, taskId: string, callId = `propose-${taskId}`) {
	f.faux.setResponses([toolCall("propose_delete_task", { task_id: taskId }, callId), say("Please approve.")]);
	await f.say(`delete ${taskId}`);
	const result = await lastToolResult(f);
	return { card: result.details as unknown as Extract<ToolCard, { type: "approval" }>, result };
}

async function lastToolResult(f: Fixture): Promise<ToolResultMessage> {
	const entries = await f.entries();
	const message = entries
		.flatMap((entry) => entry.model ?? [])
		.filter((candidate): candidate is ToolResultMessage => candidate.role === "toolResult")
		.at(-1);
	if (message === undefined) throw new Error("no tool result in the transcript");
	return message;
}

const resultText = (message: ToolResultMessage): string =>
	message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

const notices = async (f: Fixture) =>
	(await f.entriesOfKind(NOTICE_ENTRY_KIND)).map((entry) => entry.data as NoticeEntryData);

const taskExists = (f: Fixture, id: string): boolean => taskStore.getTask(f.db, id) !== undefined;

describe("proposing a deletion", () => {
	it("asks instead of deleting: the model gets a pending request, the thread gets an approval card", async () => {
		const f = await open();
		const id = await taskWithReminder(f);

		const { card, result } = await propose(f, id);

		expect(card).toMatchObject({ type: "approval", summary: "Delete task “Pay rent”" });
		expect(card.expiresAt).toBe(f.clock.now + APPROVAL_TTL_MS);
		expect(resultText(result)).toContain("Nothing is deleted yet");
		expect(taskExists(f, id)).toBe(true);
		expect(f.deps.approvals.state(card.actionId)?.status).toBe("pending");
	});

	it("is one request however often the call is replayed, and asking twice about the same task asks once", async () => {
		const f = await open();
		const id = await taskWithReminder(f);

		const first = await f.callTool("propose_delete_task", { task_id: id }, "p1");
		const replay = await f.callTool("propose_delete_task", { task_id: id }, "p1");
		const again = await f.callTool("propose_delete_task", { task_id: id }, "p2");

		const ids = [first, replay, again].map((result) => (result.details as unknown as { actionId: string }).actionId);
		expect(new Set(ids).size).toBe(1);
	});
});

describe("the beforeTool hook", () => {
	it("blocks delete_task when the model calls it without approval, and deletes nothing", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		f.faux.setResponses([toolCall("delete_task", { task_id: id }, "sneaky"), say("Blocked, I will ask first.")]);

		await f.say(`delete ${id} right now`);

		const result = await lastToolResult(f);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toMatch(/Blocked: delete_task .* needs the owner's approval.*propose_delete_task/s);
		expect(taskExists(f, id)).toBe(true);
	});

	it("does not accept an approval for another task or another tool", async () => {
		const f = await open();
		const rent = await taskWithReminder(f, "Pay rent");
		const gym = await taskWithReminder(f, "Gym");
		const { card } = await propose(f, rent);
		// Approve without carrying it out (as in the instant between the decision and the server running it).
		f.db.run("UPDATE pending_actions SET status = 'approved' WHERE id = ?", card.actionId);
		f.faux.setResponses([toolCall("delete_task", { task_id: gym }, "wrong-task"), say("ok")]);

		await f.say("delete the gym one");

		expect(resultText(await lastToolResult(f))).toMatch(/Blocked/);
		expect(taskExists(f, gym)).toBe(true);
		expect(taskExists(f, rent)).toBe(true);
	});

	it("lets delete_task through once exactly that deletion is approved, and records that it was carried out", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		const { card } = await propose(f, id);
		f.db.run("UPDATE pending_actions SET status = 'approved' WHERE id = ?", card.actionId);
		f.faux.setResponses([toolCall("delete_task", { task_id: id }, "approved-call"), say("Deleted.")]);

		await f.say("go ahead");

		const result = await lastToolResult(f);
		expect(result.isError).toBe(false);
		expect(resultText(result)).toBe("Deleted task “Pay rent”.");
		expect(taskExists(f, id)).toBe(false);
		expect(f.deps.approvals.state(card.actionId)?.status).toBe("executed");
		// Used up: a second call is blocked again.
		f.faux.setResponses([toolCall("delete_task", { task_id: id }, "again"), say("Blocked.")]);
		await f.say("again");
		expect(resultText(await lastToolResult(f))).toMatch(/Blocked/);
	});
});

describe("answering with a button", () => {
	it("approve carries the deletion out at once, stops its reminder, and posts the outcome without the model", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		const { card } = await propose(f, id);
		const modelCalls = f.faux.state.callCount;
		const timerBefore = taskStore.requireTask(f.db, id).durableTaskId;

		const state = await f.deps.approvals.decide(card.actionId, "approve", "button");

		expect(state).toMatchObject({ status: "executed", resultText: "Deleted task “Pay rent”." });
		expect(taskExists(f, id)).toBe(false);
		const [notice] = await notices(f);
		expect(notice).toMatchObject({
			text: "Deleted task “Pay rent”.",
			level: "info",
			approval: { actionId: card.actionId, outcome: "executed", via: "button" },
		});
		expect(f.faux.state.callCount).toBe(modelCalls);
		await waitFor(async () => {
			const page = await f.harness.commit((tx) => tx.scanTasks({ kind: REMINDER_TASK_NAME }, 10), ctx);
			return page.items.find((task) => Number(task.id) === timerBefore)?.state.status === "terminal";
		}, "the reminder to be cancelled");
		f.advance(120 * MINUTE);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(f.pushes).toHaveLength(0);
	});

	it("deny changes nothing and says so", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		const { card } = await propose(f, id);

		const state = await f.deps.approvals.decide(card.actionId, "deny", "button");

		expect(state.status).toBe("denied");
		expect(taskExists(f, id)).toBe(true);
		expect((await notices(f))[0]).toMatchObject({
			text: "Denied: Delete task “Pay rent”. Nothing was changed.",
			approval: { outcome: "denied" },
		});
	});

	it("answering twice the same way is harmless, answering the other way is refused, and nothing runs twice", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		const { card } = await propose(f, id);

		const first = await f.deps.approvals.decide(card.actionId, "approve", "button");
		const second = await f.deps.approvals.decide(card.actionId, "approve", "button");

		expect(second).toStrictEqual(first);
		await expect(f.deps.approvals.decide(card.actionId, "deny", "button")).rejects.toThrow(ApprovalConflict);
		expect(await notices(f)).toHaveLength(1);
	});

	it("refuses an answer after 24 hours: the request expired and nothing is deleted", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		const { card } = await propose(f, id);
		f.clock.now += APPROVAL_TTL_MS + 1;

		await expect(f.deps.approvals.decide(card.actionId, "approve", "button")).rejects.toThrow(/expired/);

		expect(taskExists(f, id)).toBe(true);
		expect(f.deps.approvals.state(card.actionId)?.status).toBe("expired");
	});

	it("reports a request that does not exist", async () => {
		const f = await open();

		await expect(f.deps.approvals.decide("ap_nope", "approve", "button")).rejects.toThrow(
			/no approval request 'ap_nope'/,
		);
	});

	it("tells the owner when the approved action itself fails", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		const { card } = await propose(f, id);
		f.deps.approvals.register({
			tool: "delete_task",
			proposeTool: "propose_delete_task",
			target: (args) => `task:${String(args.task_id)}`,
			run: () => {
				throw new Error("the disk is full");
			},
		});

		const state = await f.deps.approvals.decide(card.actionId, "approve", "button");

		expect(state).toMatchObject({ status: "failed", resultText: "the disk is full" });
		expect((await notices(f))[0]).toMatchObject({
			text: "Approved, but it did not work: the disk is full",
			level: "error",
			approval: { outcome: "failed" },
		});
	});
});

describe('a reply of "YES"', () => {
	it("approves the one request that is waiting, without asking the model", async () => {
		const f = await open();
		const recent = await taskWithReminder(f, "Recent");
		await propose(f, recent, "p-recent");
		const modelCalls = f.faux.state.callCount;

		const reply = await f.deps.approvals.tryYes(Number(f.conversation.id), "  Yes ", "req-1");

		expect(reply?.submissionId).toBeTypeOf("number");
		expect(taskExists(f, recent)).toBe(false);
		expect((await notices(f))[0]).toMatchObject({
			text: "You replied YES. Deleted task “Recent”.",
			approval: { outcome: "executed", via: "yes" },
		});
		expect(f.faux.state.callCount).toBe(modelCalls);
	});

	it("does not guess between two waiting requests: the YES goes to the model, and the buttons still work", async () => {
		const f = await open();
		const old = await taskWithReminder(f, "Old");
		const recent = await taskWithReminder(f, "Recent");
		const oldCard = (await propose(f, old, "p-old")).card;
		f.clock.now += MINUTE;
		await propose(f, recent, "p-recent");

		const reply = await f.deps.approvals.tryYes(Number(f.conversation.id), "YES", "req-1");

		expect(reply).toBeUndefined();
		expect(taskExists(f, old) && taskExists(f, recent)).toBe(true);
		expect(await notices(f)).toHaveLength(0);
		expect((await f.deps.approvals.decide(oldCard.actionId, "approve", "button")).status).toBe("executed");
	});

	it("does not approve once the owner has said something else since the request: a yes may answer another question", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		const { card } = await propose(f, id);

		// "Shall I list tomorrow's tasks?" "yes": the owner's next message is an ordinary one, so the YES is not an approval.
		expect(await f.deps.approvals.tryYes(Number(f.conversation.id), "what is on tomorrow?", "req-1")).toBeUndefined();
		expect(await f.deps.approvals.tryYes(Number(f.conversation.id), "YES", "req-2")).toBeUndefined();

		expect(taskExists(f, id)).toBe(true);
		expect(f.deps.approvals.state(card.actionId)?.status).toBe("pending");
		expect((await f.deps.approvals.decide(card.actionId, "approve", "button")).status).toBe("executed");
	});

	it("does not approve a deletion with a yes typed to a question the assistant asked by itself", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "Pay rent" }, "add-plain");
		const id = taskStore.listTasks(f.db, { status: "open", limit: 5 }).tasks[0]?.id ?? "";
		await f.callTool("add_person", { name: "Tashi", birthday: "10-25" }, "add-tashi"); // today: asked at 18:00
		const { card } = await propose(f, id);

		f.advance(4 * 60 * MINUTE); // 18:00: the timer posts "Did you wish Tashi a happy birthday?"
		await waitFor(async () => (await f.entriesOfKind(BIRTHDAY_ENTRY_KIND)).length === 1, "the evening question");

		// The owner's "yes" answers the question that is on screen, not the request that was waiting before it.
		expect(await f.deps.approvals.tryYes(Number(f.conversation.id), "yes", "req-1")).toBeUndefined();
		expect(taskExists(f, id)).toBe(true);
		expect(f.deps.approvals.state(card.actionId)?.status).toBe("pending");
		expect((await f.deps.approvals.decide(card.actionId, "approve", "button")).status).toBe("executed"); // the button still works
	});

	it("a request made after the other message is answerable again", async () => {
		const f = await open();
		const first = await taskWithReminder(f, "First");
		const second = await taskWithReminder(f, "Second");
		const firstCard = (await propose(f, first, "p1")).card;
		await f.deps.approvals.tryYes(Number(f.conversation.id), "hold on", "req-1"); // closes the first one's window
		expect((await f.deps.approvals.decide(firstCard.actionId, "deny", "button")).status).toBe("denied");
		await propose(f, second, "p2");

		const reply = await f.deps.approvals.tryYes(Number(f.conversation.id), "YES", "req-2");

		expect(reply?.submissionId).toBeTypeOf("number");
		expect(taskExists(f, second)).toBe(false);
		expect(taskExists(f, first)).toBe(true);
	});

	it("answers a resent message with the same notice, and never approves another request with it", async () => {
		const f = await open();
		const first = await taskWithReminder(f, "First");
		const second = await taskWithReminder(f, "Second");
		await propose(f, first, "p1");

		const one = await f.deps.approvals.tryYes(Number(f.conversation.id), "YES", "req-same");
		await propose(f, second, "p2"); // a request made after the YES: a resend of that message must not answer it
		const retry = await f.deps.approvals.tryYes(Number(f.conversation.id), "YES", "req-same");

		expect(retry).toStrictEqual(one);
		expect(taskExists(f, first)).toBe(false);
		expect(taskExists(f, second)).toBe(true);
		expect(await notices(f)).toHaveLength(1);
	});

	it.each(["yes please", "yes!", "no", "y", "yes yes"])(
		"leaves '%s' to the model: only the word YES approves",
		async (text) => {
			const f = await open();
			const id = await taskWithReminder(f);
			await propose(f, id);

			expect(isYes(text)).toBe(false);
			expect(await f.deps.approvals.tryYes(Number(f.conversation.id), text, "req-x")).toBeUndefined();
			expect(taskExists(f, id)).toBe(true);
		},
	);

	it("leaves YES to the model when nothing is waiting, or the only request expired", async () => {
		const f = await open();
		expect(await f.deps.approvals.tryYes(Number(f.conversation.id), "YES", "r1")).toBeUndefined();

		const id = await taskWithReminder(f);
		await propose(f, id);
		f.clock.now += APPROVAL_TTL_MS + 1;

		expect(await f.deps.approvals.tryYes(Number(f.conversation.id), "YES", "r2")).toBeUndefined();
		expect(taskExists(f, id)).toBe(true);
	});

	it("only answers requests of its own conversation", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		await propose(f, id);

		expect(await f.deps.approvals.tryYes(Number(f.conversation.id) + 99, "YES", "r1")).toBeUndefined();
		expect(taskExists(f, id)).toBe(true);
	});
});

describe("startup repair", () => {
	it("carries out an approval a crash interrupted, posts the notice once, and closes expired requests", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		const { card } = await propose(f, id);
		const stale = await taskWithReminder(f, "Stale");
		const staleCard = (await propose(f, stale, "p-stale")).card;
		// The process died after recording the approval and before carrying it out.
		f.db.run(
			"UPDATE pending_actions SET status = 'approved', decided_at = ?, decided_via = 'button' WHERE id = ?",
			f.clock.now,
			card.actionId,
		);
		f.db.run("UPDATE pending_actions SET expires_at = ? WHERE id = ?", f.clock.now - 1, staleCard.actionId);

		const first = await f.deps.approvals.recover();
		const second = await f.deps.approvals.recover();

		expect(first).toStrictEqual({ expired: 1, executed: 1, notified: 0, failures: [] });
		expect(second).toStrictEqual({ expired: 0, executed: 0, notified: 0, failures: [] });
		expect(taskExists(f, id)).toBe(false);
		expect(taskExists(f, stale)).toBe(true);
		expect(f.deps.approvals.state(staleCard.actionId)?.status).toBe("expired");
		expect(await notices(f)).toHaveLength(1);
	});

	it("posts the outcome notice that was lost between carrying out the action and writing it", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		const { card } = await propose(f, id);
		await f.deps.approvals.decide(card.actionId, "approve", "button");
		f.db.run("UPDATE pending_actions SET notified_at = NULL, notice_submission_id = NULL WHERE id = ?", card.actionId);

		expect(await f.deps.approvals.recover()).toMatchObject({ notified: 1 });

		expect(await notices(f)).toHaveLength(1); // the same request id found the notice that was already written
	});

	it("posts a notice again when Durable's database came back from before it, though app.sqlite says it was posted (power cut)", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		const { card } = await propose(f, id);
		await f.close();
		const snapshot = join(f.dir, "snapshot");
		await snapshotDurable(f.dir, snapshot); // the thread has the approval card and no notice yet

		const answered = await open({ dir: f.dir, clock: f.clock });
		await answered.deps.approvals.decide(card.actionId, "approve", "button");
		expect(await notices(answered)).toHaveLength(1);
		await answered.close();

		await restoreDurable(snapshot, f.dir); // durable.sqlite lost its last writes; app.sqlite kept the answer and `notified_at`
		const rewound = await open({ dir: f.dir, clock: f.clock });
		expect(await notices(rewound)).toHaveLength(0);
		const report = await rewound.deps.approvals.recover();

		expect(report).toMatchObject({ executed: 0, failures: [] });
		expect(await notices(rewound)).toHaveLength(1);
		expect((await notices(rewound))[0]).toMatchObject({ approval: { actionId: card.actionId, outcome: "executed" } });
		await rewound.deps.approvals.recover(); // and asking again changes nothing
		expect(await notices(rewound)).toHaveLength(1);
	});

	it("reports a request whose conversation is gone and still finishes the others", async () => {
		const f = await open();
		const id = await taskWithReminder(f);
		const { card } = await propose(f, id);
		await f.deps.approvals.decide(card.actionId, "deny", "button");
		f.db.run("UPDATE pending_actions SET notified_at = NULL, notice_submission_id = NULL WHERE id = ?", card.actionId);
		// What `DELETE FROM agents` leaves behind: an answered request of a conversation that is no longer in durable.sqlite.
		f.db.run(
			`INSERT INTO pending_actions (id, conversation_id, tool, target, args_json, summary, status, created_at, expires_at, decided_at, decided_via)
			 VALUES ('ap_orphan', 999, 'delete_task', 'task:t_gone', '{"task_id":"t_gone"}', 'Delete task “Gone”', 'denied', ?, ?, ?, 'button')`,
			f.clock.now - 60 * MINUTE,
			f.clock.now + APPROVAL_TTL_MS,
			f.clock.now - 59 * MINUTE,
		);

		const report = await f.deps.approvals.recover();

		expect(report.notified).toBe(1);
		expect(report.failures).toStrictEqual([
			{
				id: "ap_orphan",
				conversationId: 999,
				message: expect.stringMatching(/Conversation 999 does not exist in durable\.sqlite/),
			},
		]);
		expect(await notices(f)).toHaveLength(1);
	});
});
