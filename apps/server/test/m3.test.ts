import { join } from "node:path";
import { openAppDb } from "@assistant/db";
import { followupStore, peopleStore } from "@assistant/extensions";
import {
	AGENDA_ENTRY_KIND,
	type AgendaEntryData,
	BIRTHDAY_ENTRY_KIND,
	type BirthdayEntryData,
	FOLLOWUP_ENTRY_KIND,
	type FollowupEntryData,
} from "@assistant/shared";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	cards,
	ctx,
	entries,
	type Harness,
	MINUTE,
	modelAnswers,
	ofKind,
	paConversation,
	post,
	restoreDurable,
	say,
	setup,
	snapshotDurable,
	subscription,
} from "./domain-support.ts";
import { removeAllFixtures, waitFor } from "./support.ts";

const harnesses: Harness[] = [];
async function start(env: Record<string, string> = {}) {
	const h = await setup(env);
	harnesses.push(h);
	const server = await h.start();
	await post(server, "/api/push/subscribe", subscription());
	return { h, server };
}
afterEach(async () => {
	for (const h of harnesses.splice(0)) for (const server of h.servers.splice(0)) await server.close();
	await removeAllFixtures();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("migrations and agents", () => {
	it("applies the followups and people tables, and gives the PA the new tools and sections", async () => {
		const { server } = await start();

		const ids = server.db.all<{ id: string }>("SELECT id FROM _migrations ORDER BY id").map((row) => row.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				"followups/001_items",
				"followups/002_call_ledger",
				"followups/003_reask_and_assumed_time",
				"people/001_people",
				"people/002_call_ledger",
				"people/003_reminded_year",
			]),
		);
		const stored = await server.harness.snapshot(AgentDoc, paConversation(server) as ConversationId, ctx);
		expect(stored?.extensions).toStrictEqual(["profile", "tasks", "followups", "people", "approvals", "tool-search"]);
		const other = server.db.get<{ conversation_id: number }>("SELECT conversation_id FROM agents WHERE id = 'health'");
		const healthDoc = await server.harness.snapshot(AgentDoc, other?.conversation_id as ConversationId, ctx);
		expect(healthDoc?.extensions).toStrictEqual(["profile"]); // capability by tool presence: only the PA has them
	});
});

describe("a follow-up through the whole server", () => {
	it("agenda, question and a chained follow-up: each is a card and a minimal push, and none costs a model call", async () => {
		const { h, server } = await start();
		await say(
			server,
			'/tool add_followup {"title":"Meeting about the house","counterpart":"Dabtonog Realty","context":"Emailed them about the plot","event_in_minutes":60}',
		);
		await say(server, '/tool add_agenda_point {"text":"Ask about the price","meeting":"Dabtonog"}');
		await say(server, '/tool add_agenda_point {"text":"Ask about parking","meeting":"house"}');
		const [created, firstPoint, secondPoint] = await cards(server);
		expect(created).toMatchObject({
			type: "followup",
			event: "created",
			followup: { title: "Meeting about the house" },
		});
		expect(secondPoint).toMatchObject({
			type: "followup",
			event: "agenda_added",
			followup: { agenda: ["Ask about the price", "Ask about parking"] },
		});
		expect(firstPoint).toMatchObject({ event: "agenda_added" });
		const answers = await modelAnswers(server);

		h.clock.now += 45 * MINUTE; // 14:45: fifteen minutes before it
		server.harness.resume();
		await waitFor(async () => (await ofKind(server, AGENDA_ENTRY_KIND)).length === 1, { what: "the agenda card" });
		h.clock.now += 45 * MINUTE; // 15:30: thirty minutes after it started
		server.harness.resume();
		await waitFor(async () => (await ofKind(server, FOLLOWUP_ENTRY_KIND)).length === 1, { what: "the question card" });
		await waitFor(() => h.sender.sent.length === 2, { what: "both pushes" });

		const [agenda] = await ofKind(server, AGENDA_ENTRY_KIND);
		expect(agenda?.data as AgendaEntryData).toMatchObject({
			title: "Meeting about the house",
			points: ["Ask about the price", "Ask about parking"],
			eventAtText: "Sun 25 Oct 2026, 15:00",
		});
		const [question] = await ofKind(server, FOLLOWUP_ENTRY_KIND);
		expect(question?.data as FollowupEntryData).toMatchObject({ title: "Meeting about the house", chained: false });
		expect(h.sender.sent.map((sent) => sent.payload)).toStrictEqual([
			{ title: "Agenda", body: "1 meeting is about to start", url: "/chat/pa", tag: "agenda" },
			{ title: "Follow-up", body: "1 question: how did it go?", url: "/chat/pa", tag: "followup" },
		]);
		expect(await modelAnswers(server)).toBe(answers); // the two cards cost nothing

		// The owner answers in the chat: it needs a follow-up in a day.
		const id = followupStore.listFollowups(server.db, { status: "asked", limit: 5 }).followups[0]?.id ?? "";
		await say(
			server,
			`/tool record_outcome {"followup_id":"${id}","outcome":"They agreed to a viewing","needs_followup":true,"next_in_minutes":1440,"next_step":"Call the firm to confirm the viewing"}`,
		);
		const chained = (await cards(server)).at(-1);
		expect(chained).toMatchObject({
			type: "followup",
			event: "outcome",
			followup: { status: "resolved", outcome: "They agreed to a viewing" },
			next: { title: "Call the firm to confirm the viewing", status: "waiting", kind: "commitment" },
		});

		h.clock.now += 1440 * MINUTE + 30 * MINUTE;
		server.harness.resume();
		await waitFor(async () => (await ofKind(server, FOLLOWUP_ENTRY_KIND)).length === 2, {
			what: "the second question",
		});
		const [, second] = await ofKind(server, FOLLOWUP_ENTRY_KIND);
		expect(second?.data).toMatchObject({ chained: true });
	});

	it("survives a restart of the whole server: the question is asked once, and an agenda that came too late is not posted", async () => {
		const { h, server } = await start();
		await say(server, '/tool add_followup {"title":"Call the bank","event_in_minutes":60}');
		await say(server, '/tool add_agenda_point {"text":"Ask about the rate"}');
		await server.close();
		h.servers.pop();

		h.clock.now += 120 * MINUTE; // back at 16:00: the meeting has come and gone
		const second = await h.start();
		await waitFor(async () => (await ofKind(second, FOLLOWUP_ENTRY_KIND)).length === 1, {
			what: "the question after restart",
		});
		await settle();

		expect(await ofKind(second, FOLLOWUP_ENTRY_KIND)).toHaveLength(1);
		expect(await ofKind(second, AGENDA_ENTRY_KIND)).toHaveLength(0);
		expect(h.sender.sent).toHaveLength(1);
	});
});

describe("a birthday through the whole server", () => {
	it("is asked about at the configured time, a minimal push, no model call; record_wish settles it", async () => {
		const { h, server } = await start({ ASSISTANT_BIRTHDAY_CHECK_TIME: "15:00" });
		await say(server, '/tool add_person {"name":"Pema","relation":"friend","birthday":"1990-10-25"}');
		expect(await cards(server)).toMatchObject([
			{ type: "person", event: "created", person: { name: "Pema", turns: 36 } },
		]);
		const answers = await modelAnswers(server);

		h.clock.now += 59 * MINUTE; // 14:59
		server.harness.resume();
		await settle();
		expect(await ofKind(server, BIRTHDAY_ENTRY_KIND)).toHaveLength(0);
		h.clock.now += MINUTE; // 15:00: the setting, not the default 18:00
		server.harness.resume();
		await waitFor(async () => (await ofKind(server, BIRTHDAY_ENTRY_KIND)).length === 1, {
			what: "the evening question",
		});
		await waitFor(() => h.sender.sent.length === 1, { what: "its push" });

		const [entry] = await ofKind(server, BIRTHDAY_ENTRY_KIND);
		expect(entry?.data as BirthdayEntryData).toMatchObject({ name: "Pema", stage: "check", year: 2026, turns: 36 });
		expect(h.sender.sent[0]?.payload).toStrictEqual({
			title: "Birthday",
			body: "1 question: did you wish them?",
			url: "/chat/pa",
			tag: "birthday",
		});
		expect(await modelAnswers(server)).toBe(answers);

		const id = peopleStore.listPeople(server.db)[0]?.id ?? "";
		await say(server, `/tool record_wish {"person_id":"${id}","wished":true}`);
		expect(peopleStore.wishOf(server.db, id, 2026)).toBe(true);
		// The cycle moved on: the next one is a year away, with a timer waiting.
		await waitFor(() => peopleStore.requirePerson(server.db, id).cycleYear === 2027, { what: "next year's cycle" });
	});

	it("keeps its yearly timer across a restart", async () => {
		const { h, server } = await start();
		await say(server, '/tool add_person {"name":"Karma","birthday":"10-25"}');
		await server.close();
		h.servers.pop();

		h.clock.now += 4 * 60 * MINUTE; // 18:00
		const second = await h.start();
		await waitFor(async () => (await ofKind(second, BIRTHDAY_ENTRY_KIND)).length === 1, {
			what: "the question after restart",
		});
		expect((await ofKind(second, BIRTHDAY_ENTRY_KIND))[0]?.data).toMatchObject({ name: "Karma", stage: "check" });
	});
});

describe("start-up repair of follow-ups and birthdays", () => {
	it("starts although a follow-up and a person belong to a conversation that is gone, and says how to clear them", async () => {
		const { h, server } = await start();
		await server.close();
		h.servers.pop();
		const db = openAppDb(h.fixture.config.paths.appDb);
		const orphan = followupStore.insertFollowup(
			db,
			{
				title: "Orphan meeting",
				counterpart: "",
				context: "",
				kind: "meeting",
				eventAt: h.clock.now + 60 * MINUTE,
				askAt: h.clock.now + 90 * MINUTE,
				agendaLeadMinutes: 15,
				conversationId: 999,
				createdAt: h.clock.now,
			},
			"orphan-followup",
		).row;
		const person = peopleStore.insertPerson(
			db,
			{
				name: "Orphan",
				relation: "",
				birthdayMd: "12-01",
				notes: "",
				cycle: { year: 2026, remindAt: h.clock.now + 60 * MINUTE, checkAt: h.clock.now + 120 * MINUTE },
				conversationId: 999,
				createdAt: h.clock.now,
			},
			"orphan-person",
		).row;
		db.close();

		const restarted = await h.start();

		expect(restarted.port).toBeGreaterThan(0);
		const log = h.logs.join("\n");
		expect(log).toContain(`could not give follow-up ${orphan.id} its timer`);
		expect(log).toContain(
			`UPDATE followups_item SET conversation_id = (SELECT conversation_id FROM agents WHERE id = 'pa') WHERE id = '${orphan.id}'`,
		);
		expect(log).toContain(`could not give ${person.id} its birthday timer`);
		expect(log).toContain(
			`UPDATE people_person SET conversation_id = (SELECT conversation_id FROM agents WHERE id = 'pa') WHERE id = '${person.id}'`,
		);
	});

	it("makes the timer again, while running, for a follow-up whose timer Durable lost or ended", async () => {
		const { h } = await start();
		const server = h.servers[0];
		if (server === undefined) throw new Error("no server");
		await say(server, '/tool add_followup {"title":"Call the bank","event_in_minutes":60}');
		const row = followupStore.listFollowups(server.db, { status: "all", limit: 5 }).followups[0];
		await server.harness.abortTask(row?.durableTaskId as never, ctx);

		const report = await server.domain.sweep();

		expect(report.followups.rescheduled).toStrictEqual([row?.id]);
		expect(followupStore.requireFollowup(server.db, row?.id ?? "").durableTaskId).not.toBe(row?.durableTaskId);
	});
});

describe("the PA's tools", () => {
	const offered = async (server: Awaited<ReturnType<typeof start>>["server"]): Promise<string[]> => {
		const conversation = await server.harness.conversation(paConversation(server) as ConversationId, ctx);
		return ((await conversation?.agent(ctx))?.tools ?? []).map((tool) => tool.name).sort();
	};

	it("offers the everyday tools and finds the rest with tool_search; the dev model's /tool needs it first, too", async () => {
		const { server } = await start();
		expect(await offered(server)).toStrictEqual([
			"add_agenda_point",
			"add_followup",
			"add_person",
			"add_task",
			"complete_task",
			"current_time",
			"list_tasks",
			"record_outcome",
			"record_wish",
			"snooze_reminder",
			"tool_search",
		]);
		await say(server, '/tool add_followup {"title":"Meeting about the house","event_in_minutes":600}');
		const id = followupStore.listFollowups(server.db, { status: "all", limit: 5 }).followups[0]?.id ?? "";

		// Not loaded: the model is not offered it, so a call to it is refused before it runs.
		await say(server, `/tool update_followup {"followup_id":"${id}","title":"House viewing"}`);
		const refused = (await toolResults(server)).at(-1);
		expect(refused).toMatchObject({ toolName: "update_followup", isError: true });
		expect(JSON.stringify(refused?.content)).toContain("Tool update_followup is not available");
		expect(followupStore.requireFollowup(server.db, id).title).toBe("Meeting about the house");

		await say(server, '/tool tool_search {"query":"move or rename a meeting"}');
		expect(await offered(server)).toContain("update_followup");
		expect(await offered(server)).not.toContain("list_people"); // what the search did not match stays out
		await say(server, `/tool update_followup {"followup_id":"${id}","title":"House viewing"}`);

		expect(followupStore.requireFollowup(server.db, id).title).toBe("House viewing");
		expect((await cards(server)).at(-1)).toMatchObject({ type: "followup", event: "updated" });
	});

	it("keeps the approval hook in front of a delete tool that was loaded", async () => {
		const { server } = await start();
		await say(server, '/tool add_followup {"title":"Meeting about the house","event_in_minutes":600}');
		const id = followupStore.listFollowups(server.db, { status: "all", limit: 5 }).followups[0]?.id ?? "";
		await say(server, '/tool tool_search {"query":"delete follow-up permanently"}');

		await say(server, `/tool delete_followup {"followup_id":"${id}"}`);

		const blocked = (await toolResults(server)).at(-1);
		expect(blocked).toMatchObject({ toolName: "delete_followup", isError: true });
		expect(JSON.stringify(blocked?.content)).toMatch(/Blocked: delete_followup .* propose_delete_followup/);
		expect(followupStore.getFollowup(server.db, id)).toBeDefined();
	});
});

describe("a yes typed to a question the assistant asked by itself", () => {
	it("is an ordinary message, not the approval of a deletion that was waiting before the question", async () => {
		const { h, server } = await start({ ASSISTANT_BIRTHDAY_CHECK_TIME: "15:00" });
		await say(server, '/tool add_person {"name":"Pema","birthday":"10-25"}');
		await say(server, '/tool add_followup {"title":"Call the bank","event_in_minutes":600}');
		const id = followupStore.listFollowups(server.db, { status: "all", limit: 5 }).followups[0]?.id ?? "";
		await say(server, '/tool tool_search {"query":"propose delete follow-up"}');
		await say(server, `/tool propose_delete_followup {"followup_id":"${id}"}`);
		const approval = (await cards(server)).find((card) => card.type === "approval");
		if (approval?.type !== "approval") throw new Error("no approval card");

		h.clock.now += 61 * MINUTE; // 15:01: "Did you wish Pema a happy birthday?"
		server.harness.resume();
		await waitFor(async () => (await ofKind(server, BIRTHDAY_ENTRY_KIND)).length === 1, { what: "the question" });
		await say(server, "yes"); // what the owner types to that question

		expect(followupStore.getFollowup(server.db, id)).toBeDefined();
		expect(server.domain.approvals.state(approval.actionId)?.status).toBe("pending");
		const lastUser = (await entries(server)).filter((entry) => entry.kind === "pi.user").at(-1);
		expect(JSON.stringify(lastUser?.model)).toContain("yes"); // it went to the model, like any message
		// The button still answers the deletion.
		const approved = await post<{ status: string }>(server, `/api/approvals/${approval.actionId}`, {
			decision: "approve",
		});
		expect(approved.body.status).toBe("executed");
		expect(followupStore.getFollowup(server.db, id)).toBeUndefined();
	});
});

describe("birthday cards after a power cut", () => {
	it("are posted again at start when Durable's database lost them after the cycle had ended, without another push", async () => {
		const h = await setup();
		const first = await h.start();
		await post(first, "/api/push/subscribe", subscription());
		await say(first, '/tool add_person {"name":"Pema","birthday":"10-25"}'); // today: asked at 18:00
		await first.close();
		h.servers.pop();
		const snapshot = join(h.fixture.root, "snapshot");
		await snapshotDurable(h.fixture.config, snapshot);

		h.clock.now += 5 * 60 * MINUTE; // 19:00
		const ran = await h.start();
		await waitFor(async () => (await ofKind(ran, BIRTHDAY_ENTRY_KIND)).length === 1, { what: "the evening question" });
		await waitFor(() => peopleStore.listPeople(ran.db)[0]?.cycleYear === 2027, { what: "the cycle to move on" });
		await waitFor(() => h.sender.sent.length === 1, { what: "its push" });
		await ran.close();
		h.servers.pop();

		await restoreDurable(h.fixture.config, snapshot); // the power cut
		const rewound = await h.start();

		await waitFor(async () => (await ofKind(rewound, BIRTHDAY_ENTRY_KIND)).length === 1, {
			what: "the question to be posted again",
		});
		await settle();
		expect((await ofKind(rewound, BIRTHDAY_ENTRY_KIND))[0]?.data).toMatchObject({
			stage: "check",
			year: 2026,
			name: "Pema",
		});
		expect(h.sender.sent).toHaveLength(1); // the owner was nudged when it was first asked
	});
});

/** The tool results of the PA's thread, oldest first. */
async function toolResults(server: Parameters<typeof cards>[0]) {
	return (await entries(server)).flatMap((entry) =>
		(entry.model ?? []).flatMap((message) => (message.role === "toolResult" ? [message] : [])),
	);
}
