import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { listPushSubscriptions, openAppDb } from "@assistant/db";
import { taskStore } from "@assistant/extensions";
import {
	type ApiErrorBody,
	type ApprovalCard,
	type ApprovalState,
	type MessagesPage,
	NOTICE_ENTRY_KIND,
	type NoticeEntryData,
	type PushConfigResponse,
	type PushPayload,
	REMINDER_ENTRY_KIND,
	type ReminderEntryData,
	type SendMessageResponse,
	toolCardOf,
} from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PUSH_SUBSCRIPTIONS } from "../src/http/app.ts";
import { PushGoneError, type PushSender, type PushTarget } from "../src/push/sender.ts";
import { type RunningServer, type StartServerOptions, startServer } from "../src/server.ts";
import { createFixture, type Fixture, recordingLogger, removeAllFixtures, waitFor } from "./support.ts";

const ctx = BACKGROUND_CONTEXT;
const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 25, 8, 0, 0);

/** A push service stand-in: records what it was asked to send, and can report a subscription as gone. */
class RecordingSender implements PushSender {
	readonly sent: Array<{ endpoint: string; payload: PushPayload }> = [];
	readonly gone = new Set<string>();

	async send(target: PushTarget, payload: PushPayload): Promise<void> {
		if (this.gone.has(target.endpoint)) throw new PushGoneError(target.endpoint, 410);
		this.sent.push({ endpoint: target.endpoint, payload });
	}
}

const servers: RunningServer[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	await removeAllFixtures();
});

type Harness = {
	fixture: Fixture;
	clock: { now: number };
	sender: RecordingSender;
	/** Every line the servers of this test logged, in order. */
	logs: string[];
	start(intervals?: StartServerOptions["intervals"]): Promise<RunningServer>;
};

function setup(): Promise<Harness> {
	return createFixture().then((fixture) => {
		const clock = { now: START };
		const sender = new RecordingSender();
		const logger = recordingLogger();
		return {
			fixture,
			clock,
			sender,
			logs: logger.lines,
			start: async (intervals) => {
				const server = await startServer(fixture.config, {
					logger,
					devModel: { tokensPerSecond: 1_000_000 },
					now: () => clock.now,
					pushSender: sender,
					...(intervals === undefined ? {} : { intervals }),
				});
				servers.push(server);
				return server;
			},
		};
	});
}

const base = (server: RunningServer) => `http://127.0.0.1:${server.port}`;
const JSON_HEADERS = { "content-type": "application/json" };

async function post<T>(server: RunningServer, path: string, body: unknown): Promise<{ status: number; body: T }> {
	const response = await fetch(`${base(server)}${path}`, {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as T };
}

const paConversation = (server: RunningServer): number =>
	server.db.get<{ conversation_id: number }>("SELECT conversation_id FROM agents WHERE id = 'pa'")?.conversation_id ??
	-1;

let requestCounter = 0;
/** Say something to the PA and wait until the run it started has finished. */
async function say(server: RunningServer, text: string): Promise<SendMessageResponse> {
	const { status, body } = await post<SendMessageResponse>(
		server,
		`/api/conversations/${paConversation(server)}/messages`,
		{
			content: text,
			requestId: `m2-${++requestCounter}`,
		},
	);
	expect(status).toBe(202);
	const submission = await server.harness.submission(body.submissionId as SubmissionId, ctx);
	await submission?.wait(ctx);
	return body;
}

async function entries(server: RunningServer): Promise<EntryRecord[]> {
	const response = await fetch(`${base(server)}/api/conversations/${paConversation(server)}/messages?limit=200`);
	return ((await response.json()) as MessagesPage).entries as EntryRecord[];
}

const ofKind = async (server: RunningServer, kind: string) =>
	(await entries(server)).filter((entry) => entry.kind === kind);

/** Cards that tool results carried, oldest first. */
async function cards(server: RunningServer) {
	return (await entries(server)).flatMap((entry) => {
		const message = entry.model?.[0];
		return message?.role === "toolResult" ? [toolCardOf(message.details)].filter((card) => card !== undefined) : [];
	});
}

function subscription(host = "push.example") {
	return {
		endpoint: `https://${host}/send/${randomBytes(6).toString("hex")}`,
		keys: { p256dh: randomBytes(65).toString("base64url"), auth: randomBytes(16).toString("base64url") },
	};
}

describe("Web Push endpoints", () => {
	it("generates the key pair on first start (0600), keeps it on the next, and hands the public half to the browser", async () => {
		const h = await setup();
		const first = await h.start();
		const key = ((await (await fetch(`${base(first)}/api/push/config`)).json()) as PushConfigResponse).publicKey;
		const file = h.fixture.config.paths.vapid;

		expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ publicKey: key });
		await first.close();
		servers.pop();

		const second = await h.start();
		expect(((await (await fetch(`${base(second)}/api/push/config`)).json()) as PushConfigResponse).publicKey).toBe(key);
	});

	it("stores a subscription, refuses malformed ones with what is wrong, and removes one on request", async () => {
		const h = await setup();
		const server = await h.start();
		const sub = subscription();

		const saved = await post<{ ok: boolean }>(server, "/api/push/subscribe", sub);
		expect(saved.status).toBe(201);
		expect(listPushSubscriptions(server.db).map((row) => row.endpoint)).toStrictEqual([sub.endpoint]);

		for (const [body, message] of [
			[{ ...sub, endpoint: "http://push.example/x" }, /https URL/],
			[{ ...sub, endpoint: "not a url" }, /not a URL/],
			[{ ...sub, keys: { ...sub.keys, p256dh: "short" } }, /p256dh.*65 bytes/],
			[{ ...sub, keys: { ...sub.keys, auth: randomBytes(32).toString("base64url") } }, /auth.*16 bytes/],
			[{ endpoint: sub.endpoint }, /p256dh/],
			[{ ...sub, endpoint: "https://127.0.0.1:8080/x" }, /public internet.*'127\.0\.0\.1'/],
			[{ ...sub, endpoint: "https://2130706433/x" }, /public internet.*'127\.0\.0\.1'/],
			[{ ...sub, endpoint: "https://[::1]/x" }, /public internet/],
			[{ ...sub, endpoint: "https://localhost/x" }, /public internet/],
			[{ ...sub, endpoint: "https://router/x" }, /public internet/],
			[{ ...sub, endpoint: "https://printer.local/x" }, /public internet/],
			[{ ...sub, endpoint: "https://nas.tail1234.ts.net/x" }, /public internet/],
		] as const) {
			const refused = await post<ApiErrorBody>(server, "/api/push/subscribe", body);
			expect(refused.status).toBe(400);
			expect(refused.body.error.message).toMatch(message);
		}

		const removed = await fetch(`${base(server)}/api/push/subscribe`, {
			method: "DELETE",
			headers: JSON_HEADERS,
			body: JSON.stringify({ endpoint: sub.endpoint }),
		});
		expect(await removed.json()).toStrictEqual({ removed: true });
		expect(listPushSubscriptions(server.db)).toHaveLength(0);
	});

	it("accepts the endpoints of the real push services", async () => {
		const h = await setup();
		const server = await h.start();

		for (const host of ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]) {
			const saved = await post(server, "/api/push/subscribe", subscription(host));
			expect(saved.status).toBe(201);
		}
	});

	it("stops at 20 devices, but lets a registered one register again", async () => {
		const h = await setup();
		const server = await h.start();
		const first = subscription();
		await post(server, "/api/push/subscribe", first);
		for (let device = 1; device < MAX_PUSH_SUBSCRIPTIONS; device++) {
			expect((await post(server, "/api/push/subscribe", subscription())).status).toBe(201);
		}

		const refused = await post<ApiErrorBody>(server, "/api/push/subscribe", subscription());
		const again = await post(server, "/api/push/subscribe", first);

		expect(refused).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
		expect(refused.body.error.message).toMatch(/20 devices.*Turn notifications off/);
		expect(again.status).toBe(201);
		expect(listPushSubscriptions(server.db)).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
	});

	it("is covered by the same guards as the rest of the API: JSON only", async () => {
		const h = await setup();
		const server = await h.start();

		const response = await fetch(`${base(server)}/api/push/subscribe`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify(subscription()),
		});

		expect(response.status).toBe(415);
	});
});

describe("start-up repair", () => {
	it("starts although a task and an approval belong to a conversation that is gone, and says how to clear them", async () => {
		const h = await setup();
		const first = await h.start();
		await first.close();
		servers.pop();
		// What deleting the agent rows after a mismatch leaves: rows of conversations durable.sqlite never heard of.
		const db = openAppDb(h.fixture.config.paths.appDb);
		const orphan = taskStore.insertTask(
			db,
			{
				title: "Orphan",
				notes: "",
				dueAllDay: false,
				remindAt: START + 10 * MINUTE,
				conversationId: 999,
				createdAt: START,
			},
			"orphan-call",
		).row;
		db.run(
			`INSERT INTO pending_actions (id, conversation_id, tool, target, args_json, summary, status, created_at, expires_at, decided_at, decided_via)
			 VALUES ('ap_orphan', 999, 'delete_task', 'task:t_gone', '{}', 'Delete task “Gone”', 'denied', ?, ?, ?, 'button')`,
			START,
			START + 24 * 60 * MINUTE,
			START,
		);
		db.close();

		const second = await h.start();

		expect(second.port).toBeGreaterThan(0);
		const log = h.logs.join("\n");
		expect(log).toContain(`could not give task ${orphan.id} its reminder timer`);
		expect(log).toContain(`UPDATE tasks_item SET remind_at = NULL WHERE id = '${orphan.id}'`);
		expect(log).toContain("could not post the outcome of request ap_orphan to conversation 999");
		expect(log).toContain("UPDATE pending_actions SET notified_at = 0 WHERE id = 'ap_orphan'");
	});
});

describe("a reminder through the whole server", () => {
	it("is created by the scripted model, fires at its time as a card and a minimal push, and costs no model call", async () => {
		const h = await setup();
		const server = await h.start();
		const sub = subscription();
		await post(server, "/api/push/subscribe", sub);

		await say(server, '/tool add_task {"title":"Pay rent","remind_in_minutes":1}');

		const [created] = await cards(server);
		expect(created).toMatchObject({ type: "task", event: "created", task: { title: "Pay rent", status: "open" } });
		expect(await ofKind(server, REMINDER_ENTRY_KIND)).toHaveLength(0);
		const modelRequests = (await entries(server)).filter((entry) => entry.kind === "pi.assistant").length;

		h.clock.now += MINUTE;
		server.harness.resume();
		const [card] = await waitFor(
			async () => {
				const found = await ofKind(server, REMINDER_ENTRY_KIND);
				return found.length > 0 ? found : undefined;
			},
			{ what: "the reminder card" },
		);
		await waitFor(() => h.sender.sent.length > 0, { what: "the push" });

		expect(card?.data as ReminderEntryData).toMatchObject({
			title: "Pay rent",
			remindAtText: "Sun 25 Oct 2026, 14:01",
		});
		expect(h.sender.sent).toStrictEqual([
			{ endpoint: sub.endpoint, payload: { title: "Reminder", body: "1 reminder", url: "/chat/pa", tag: "reminder" } },
		]);
		expect((await entries(server)).filter((entry) => entry.kind === "pi.assistant")).toHaveLength(modelRequests);
	});

	it("survives a restart of the whole server: close, reopen, advance, fire once", async () => {
		const h = await setup();
		const first = await h.start();
		await post(first, "/api/push/subscribe", subscription());
		await say(first, '/tool add_task {"title":"Call the bank","remind_in_minutes":10}');
		await first.close();
		servers.pop();

		h.clock.now += 10 * MINUTE;
		const second = await h.start();
		await waitFor(async () => (await ofKind(second, REMINDER_ENTRY_KIND)).length === 1, {
			what: "the reminder after restart",
		});
		await waitFor(() => h.sender.sent.length === 1, { what: "the push after restart" });
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(await ofKind(second, REMINDER_ENTRY_KIND)).toHaveLength(1);
		expect(h.sender.sent).toHaveLength(1);
	});

	it("wakes a reminder whose time passed while the timers were not looking (suspend, clock step) without any request", async () => {
		const h = await setup();
		const server = await h.start({ resumeMs: 20 });
		await post(server, "/api/push/subscribe", subscription());
		await say(server, '/tool add_task {"title":"Call the bank","remind_in_minutes":5}');
		await new Promise((resolve) => setTimeout(resolve, 100)); // Durable has armed its timer for five minutes from now

		h.clock.now += 60 * MINUTE; // the wall clock jumps; the timer of the process has not moved, and nobody calls resume()

		await waitFor(async () => (await ofKind(server, REMINDER_ENTRY_KIND)).length === 1, {
			what: "the reminder, woken by the periodic tick",
		});
		await waitFor(() => h.sender.sent.length === 1, { what: "its push" });
	});

	it("makes the timer again, while running, for a reminder whose timer Durable lost or ended", async () => {
		const h = await setup();
		const server = await h.start({ resumeMs: 20, sweepMs: 50 });
		await say(server, '/tool add_task {"title":"Pay rent","remind_in_minutes":5}');
		const timerOf = () =>
			server.db.get<{ durable_task_id: number | null; remind_gen: number }>(
				"SELECT durable_task_id, remind_gen FROM tasks_item WHERE title = 'Pay rent'",
			);
		const lost = timerOf();
		expect(lost?.durable_task_id).toBeTypeOf("number");

		// Durable ended the timer (a fault, or a power cut took it); the row still points at it.
		await server.harness.abortTask(lost?.durable_task_id as TaskId, ctx);
		await waitFor(
			() => {
				const now = timerOf();
				return now?.durable_task_id !== lost?.durable_task_id && now?.durable_task_id != null;
			},
			{ what: "the periodic sweep to make a new timer" },
		);
		h.clock.now += 5 * MINUTE;

		await waitFor(async () => (await ofKind(server, REMINDER_ENTRY_KIND)).length === 1, { what: "the reminder" });
		expect(timerOf()?.remind_gen).toBeGreaterThan(lost?.remind_gen ?? 0);
	});

	it("drops a subscription the push service reports gone (410) and keeps the others", async () => {
		const h = await setup();
		const server = await h.start();
		const alive = subscription("alive.example");
		const dead = subscription("dead.example");
		await post(server, "/api/push/subscribe", alive);
		await post(server, "/api/push/subscribe", dead);
		h.sender.gone.add(dead.endpoint);
		await say(server, '/tool add_task {"title":"Stretch","remind_in_minutes":1}');

		h.clock.now += MINUTE;
		server.harness.resume();
		await waitFor(() => h.sender.sent.length === 1, { what: "the push to the live subscription" });
		await waitFor(() => listPushSubscriptions(server.db).length === 1, { what: "the dead subscription to be removed" });

		expect(listPushSubscriptions(server.db)[0]?.endpoint).toBe(alive.endpoint);
		expect(h.sender.sent[0]?.endpoint).toBe(alive.endpoint);
	});
});

describe("approvals through the whole server", () => {
	async function proposeDeletion(
		server: RunningServer,
		title = "Pay rent",
	): Promise<{ taskId: string; card: ApprovalCard }> {
		await say(server, `/tool add_task {"title":${JSON.stringify(title)},"remind_in_minutes":60}`);
		const row = server.db.get<{ id: string }>("SELECT id FROM tasks_item WHERE title = ?", title);
		const taskId = row?.id ?? "";
		// The PA is not offered the rarely used tools until it searches for them: the dev model does the same.
		await say(server, '/tool tool_search {"query":"propose delete task"}');
		await say(server, `/tool propose_delete_task {"task_id":"${taskId}"}`);
		const card = (await cards(server)).find((candidate) => candidate.type === "approval");
		if (card?.type !== "approval") throw new Error("no approval card");
		return { taskId, card };
	}
	const taskCount = (server: RunningServer): number =>
		server.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks_item")?.n ?? -1;

	it("the Approve button deletes the task and posts the outcome, and a second tap is harmless", async () => {
		const h = await setup();
		const server = await h.start();
		const { card } = await proposeDeletion(server);

		const approved = await post<ApprovalState>(server, `/api/approvals/${card.actionId}`, { decision: "approve" });
		const again = await post<ApprovalState>(server, `/api/approvals/${card.actionId}`, { decision: "approve" });
		const refused = await post<ApiErrorBody>(server, `/api/approvals/${card.actionId}`, { decision: "deny" });

		expect(approved).toMatchObject({
			status: 200,
			body: { status: "executed", resultText: "Deleted task “Pay rent”." },
		});
		expect(again.body).toStrictEqual(approved.body);
		expect(refused).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
		expect(taskCount(server)).toBe(0);
		const notices = await ofKind(server, NOTICE_ENTRY_KIND);
		expect(notices.map((entry) => (entry.data as NoticeEntryData).approval)).toStrictEqual([
			{ actionId: card.actionId, outcome: "executed", via: "button" },
		]);
	});

	it("Deny leaves the task alone", async () => {
		const h = await setup();
		const server = await h.start();
		const { card } = await proposeDeletion(server);

		const denied = await post<ApprovalState>(server, `/api/approvals/${card.actionId}`, { decision: "deny" });

		expect(denied.body.status).toBe("denied");
		expect(taskCount(server)).toBe(1);
	});

	it("a reply of YES approves the newest request, and the model is not asked", async () => {
		const h = await setup();
		const server = await h.start();
		const { card } = await proposeDeletion(server);
		const answersBefore = (await entries(server)).filter((entry) => entry.kind === "pi.assistant").length;

		const reply = await say(server, "YES");

		expect(reply.submissionId).toBeTypeOf("number");
		expect(taskCount(server)).toBe(0);
		expect(server.domain.approvals.state(card.actionId)?.status).toBe("executed");
		const notice = (await ofKind(server, NOTICE_ENTRY_KIND))[0]?.data as NoticeEntryData;
		expect(notice).toMatchObject({ text: "You replied YES. Deleted task “Pay rent”.", approval: { via: "yes" } });
		expect((await entries(server)).filter((entry) => entry.kind === "pi.assistant")).toHaveLength(answersBefore);
		expect(
			(await entries(server)).some(
				(entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes('"YES"'),
			),
		).toBe(false);
	});

	it("a YES after another message is an ordinary message: the owner may be answering something else", async () => {
		const h = await setup();
		const server = await h.start();
		const { card, taskId } = await proposeDeletion(server);

		await say(server, "what is on tomorrow?");
		await say(server, "YES");

		expect(server.db.get("SELECT 1 FROM tasks_item WHERE id = ?", taskId)).toBeDefined();
		expect(server.domain.approvals.state(card.actionId)?.status).toBe("pending");
		const userMessages = (await entries(server)).filter((entry) => entry.kind === "pi.user");
		expect(JSON.stringify(userMessages.at(-1)?.model)).toContain("YES");
		// The button is still the way to answer it.
		const approved = await post<ApprovalState>(server, `/api/approvals/${card.actionId}`, { decision: "approve" });
		expect(approved.body.status).toBe("executed");
	});

	it("a YES with nothing to approve goes to the model like any message", async () => {
		const h = await setup();
		const server = await h.start();

		await say(server, "YES");

		const userMessages = (await entries(server)).filter((entry) => entry.kind === "pi.user");
		expect(JSON.stringify(userMessages.at(-1)?.model)).toContain("YES");
	});

	it("refuses an answer after 24 hours, on the button and on a YES", async () => {
		const h = await setup();
		const server = await h.start();
		const { card, taskId } = await proposeDeletion(server);
		h.clock.now += 24 * 60 * MINUTE + 1;

		const late = await post<ApiErrorBody>(server, `/api/approvals/${card.actionId}`, { decision: "approve" });
		await say(server, "YES");

		expect(late).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
		expect(late.body.error.message).toMatch(/expired/);
		expect(server.db.get("SELECT 1 FROM tasks_item WHERE id = ?", taskId)).toBeDefined();
	});

	it.each([
		["an unknown id", "ap_00000000", { decision: "approve" }, 404],
		["a decision that is not approve or deny", "ap_00000000", { decision: "maybe" }, 400],
	])("answers %s with a clear error", async (_name, id, body, status) => {
		const h = await setup();
		const server = await h.start();

		const response = await post<ApiErrorBody>(server, `/api/approvals/${id}`, body);

		expect(response.status).toBe(status);
		expect(response.body.error.message.length).toBeGreaterThan(10);
	});
});
