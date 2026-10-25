import { healthStore } from "@assistant/extensions";
import {
	type ApprovalCard,
	DAILY_ENTRY_KIND,
	type DailyEntryData,
	type MessagesPage,
	NOTICE_ENTRY_KIND,
	type NoticeEntryData,
	type SendMessageResponse,
	type ToolCard,
	toolCardOf,
} from "@assistant/shared";
import { AgentDoc, type ConversationId, type EntryRecord, type SubmissionId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { base, ctx, type Harness, ofKind, post, setup, subscription } from "./domain-support.ts";
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

type Server = Awaited<ReturnType<typeof start>>["server"];

const local = (date: string, time: string): number => new Date(`${date}T${time}:00+06:00`).getTime();

type AgentId = "pa" | "inbox" | "health" | "accountant";

const conversationOf = (server: Server, agent: AgentId): number =>
	server.db.get<{ conversation_id: number }>("SELECT conversation_id FROM agents WHERE id = ?", agent)
		?.conversation_id ?? -1;

let counter = 0;
/** Say something to an agent and wait until the run it started has finished. */
async function sayTo(server: Server, agent: AgentId, text: string): Promise<SendMessageResponse> {
	const { status, body } = await post<SendMessageResponse>(
		server,
		`/api/conversations/${conversationOf(server, agent)}/messages`,
		{ content: text, requestId: `m6-${++counter}` },
	);
	expect(status).toBe(202);
	const submission = await server.harness.submission(body.submissionId as SubmissionId, ctx);
	await submission?.wait(ctx);
	return body;
}

async function entriesOf(server: Server, agent: AgentId): Promise<EntryRecord[]> {
	const response = await fetch(`${base(server)}/api/conversations/${conversationOf(server, agent)}/messages?limit=200`);
	return ((await response.json()) as MessagesPage).entries as EntryRecord[];
}

/** The typed cards the tool results of an agent's thread carry, oldest first. */
async function cardsOf(server: Server, agent: AgentId): Promise<ToolCard[]> {
	return (await entriesOf(server, agent)).flatMap((entry) => {
		const message = entry.model?.[0];
		if (message?.role !== "toolResult") return [];
		const card = toolCardOf(message.details);
		return card === undefined ? [] : [card];
	});
}

const toolResults = async (server: Server, agent: AgentId) =>
	(await entriesOf(server, agent)).flatMap((entry) =>
		(entry.model ?? []).filter((message) => message.role === "toolResult"),
	);

const offered = async (server: Server, agent: AgentId): Promise<string[]> => {
	const conversation = await server.harness.conversation(conversationOf(server, agent) as ConversationId, ctx);
	return ((await conversation?.agent(ctx))?.tools ?? []).map((tool) => tool.name).sort();
};

describe("the Health agent through the whole server", () => {
	it("applies the health tables and gives the Health agent its own tools, the approval hook and tool_search, and nobody else", async () => {
		const { server } = await start();

		const ids = server.db.all<{ id: string }>("SELECT id FROM _migrations ORDER BY id").map((row) => row.id);
		expect(ids).toEqual(expect.arrayContaining(["health/001_weight", "health/002_workouts", "health/003_call_ledger"]));
		const doc = await server.harness.snapshot(AgentDoc, conversationOf(server, "health") as ConversationId, ctx);
		expect(doc?.extensions).toStrictEqual(["profile", "health", "approvals", "tool-search"]);
		expect(await offered(server, "health")).toStrictEqual([
			"current_time",
			"exercise_progress",
			"list_workouts",
			"log_weight",
			"log_workout",
			"rename_exercise",
			"tool_search",
			"weight_trend",
		]);
		expect(await offered(server, "pa")).not.toContain("log_weight");
		const inbox = server.db.get<{ conversation_id: number }>("SELECT conversation_id FROM agents WHERE id = 'inbox'");
		const inboxDoc = await server.harness.snapshot(AgentDoc, inbox?.conversation_id as ConversationId, ctx);
		expect(inboxDoc?.extensions).toStrictEqual(["profile"]);
	});

	it("is the only agent that can log a weight: the PA's call is refused before it runs", async () => {
		const { server } = await start();

		await sayTo(server, "pa", '/tool log_weight {"weight":72.4}');

		const refused = (await toolResults(server, "pa")).at(-1);
		expect(refused).toMatchObject({ toolName: "log_weight", isError: true });
		expect(JSON.stringify(refused?.content)).toContain("Tool log_weight is not available");
		expect(healthStore.weightsBetween(server.db, undefined, "9999-12-31")).toHaveLength(0);
	});

	it("logs, trends and lists through the dev model, and every result is a typed card the thread can draw", async () => {
		const { server } = await start({ ASSISTANT_OWNER_HEIGHT_CM: "176" });

		await sayTo(server, "health", '/tool log_weight {"weight":160,"unit":"lb","date":"2026-10-23"}');
		await sayTo(server, "health", '/tool log_weight {"weight":72.4}');
		await sayTo(
			server,
			"health",
			'/tool log_workout {"exercises":[{"name":"bench","sets":[{"reps":8,"weight":60,"count":3}]},{"name":"pull ups","sets":[{"reps":8,"count":3}]}]}',
		);
		await sayTo(server, "health", '/tool weight_trend {"range":"30d"}');
		await sayTo(server, "health", '/tool exercise_progress {"exercise":"bench press"}');
		await sayTo(server, "health", "/tool list_workouts");

		const cards = await cardsOf(server, "health");
		expect(cards.map((card) => card.type)).toStrictEqual([
			"weight",
			"weight",
			"workout",
			"weight_chart",
			"exercise_chart",
			"workout_list",
		]);
		expect(cards[0]).toMatchObject({ kg: 72.57, fromLb: 160, bmi: 23.4 });
		expect(cards[1]).toMatchObject({ kg: 72.4, previous: { kg: 72.57, deltaKg: -0.2 } });
		expect(cards[3]).toMatchObject({
			summary: { entries: 2, latest: { kg: 72.4 }, bmi: 23.4 },
			points: [
				{ date: "2026-10-23", kg: 72.57, avg7: 72.57 },
				{ date: "2026-10-25", kg: 72.4, avg7: 72.49 },
			],
		});
		expect(cards[4]).toMatchObject({ exercise: "Bench press", metric: "e1rm", points: [{ e1rm: 76 }] });
		// What the model is told is text: every number in it came from the tool.
		const texts = (await toolResults(server, "health")).map((message) => JSON.stringify(message.content));
		expect(texts[3]).toContain("7-day average");
		expect(texts[3]).toContain("BMI at the latest weight: 23.4 (height 176 cm).");
	});

	/** Everything the system prompt of an agent's conversation has said so far: the sections, as the model received them. */
	const toldTo = async (server: Server, agent: AgentId): Promise<string> => {
		const conversation = await server.harness.conversation(conversationOf(server, agent) as ConversationId, ctx);
		const view = await conversation?.context(ctx);
		return JSON.stringify((view?.messages ?? []).filter((message) => message.role === "system"));
	};

	it("tells the Health agent the owner's height, and no other agent", async () => {
		const { server } = await start({ ASSISTANT_OWNER_HEIGHT_CM: "176" });
		await sayTo(server, "health", '/tool log_weight {"weight":72.4}');
		for (const agent of ["health", "pa", "inbox", "accountant"] as const) await sayTo(server, agent, "hello");

		// The control comes first: what the Health agent was told does name the height, so the search below can find it.
		expect(await toldTo(server, "health")).toContain("BMI 23.4 (height 176 cm)");
		for (const agent of ["pa", "inbox", "accountant"] as const) {
			expect(await toldTo(server, agent), agent).not.toMatch(/176|height|BMI/);
		}
	});

	it("asks before deleting a workout, and a YES in the Health thread approves it without the model", async () => {
		const { server } = await start();
		await sayTo(
			server,
			"health",
			'/tool log_workout {"exercises":[{"name":"cable crossover","sets":[{"reps":12,"weight":15,"count":3}]}]}',
		);
		const id = healthStore.sessionsBetween(server.db, undefined, "9999-12-31", 5).sessions[0]?.id ?? "";

		// The deletion tools are not offered until the model searches for them, as for the PA; the guard holds either way.
		await sayTo(server, "health", `/tool delete_workout {"session_id":"${id}"}`);
		expect((await toolResults(server, "health")).at(-1)).toMatchObject({ toolName: "delete_workout", isError: true });
		expect(JSON.stringify((await toolResults(server, "health")).at(-1)?.content)).toContain("not available");
		await sayTo(server, "health", '/tool tool_search {"query":"delete a workout"}');
		expect(await offered(server, "health")).toEqual(
			expect.arrayContaining(["propose_delete_workout", "delete_workout"]),
		);
		await sayTo(server, "health", `/tool delete_workout {"session_id":"${id}"}`);
		expect(JSON.stringify((await toolResults(server, "health")).at(-1)?.content)).toMatch(/Blocked: delete_workout/);
		expect(healthStore.getSession(server.db, id)).toBeDefined();
		await sayTo(server, "health", `/tool propose_delete_workout {"session_id":"${id}"}`);
		const card = (await cardsOf(server, "health")).find(
			(candidate): candidate is ApprovalCard => candidate.type === "approval",
		);
		expect(card?.summary).toBe("Delete the workout of Sun 25 Oct 2026 (1 exercise, 3 sets, volume 540 kg)");
		expect(healthStore.getSession(server.db, id)).toBeDefined(); // waiting for the owner

		const reply = await sayTo(server, "health", "YES");

		expect(reply.submissionId).toBeTypeOf("number");
		expect(healthStore.getSession(server.db, id)).toBeUndefined();
		expect(healthStore.listExercises(server.db)).toHaveLength(0);
		const [notice] = (await entriesOf(server, "health")).filter((entry) => entry.kind === NOTICE_ENTRY_KIND);
		expect(notice?.data as NoticeEntryData).toMatchObject({
			text: "You replied YES. Deleted the workout of Sun 25 Oct 2026.",
			approval: { via: "yes" },
		});
	});
});

describe("renaming and merging exercises through the whole server", () => {
	const logCrossover = async (server: Server) => {
		await sayTo(
			server,
			"health",
			'/tool log_workout {"date":"2026-10-20","exercises":[{"name":"cable crossover","sets":[{"reps":12,"weight":15,"count":3}]}]}',
		);
		await sayTo(
			server,
			"health",
			'/tool log_workout {"date":"2026-10-22","exercises":[{"name":"cable crosover","sets":[{"reps":10,"weight":17.5,"count":2}]}]}',
		);
	};

	it("offers rename from the start and merge only after a search, and the Health agent alone has them", async () => {
		const { server } = await start();

		expect(await offered(server, "health")).toContain("rename_exercise");
		expect(await offered(server, "health")).not.toContain("propose_merge_exercises");
		await sayTo(server, "health", '/tool tool_search {"query":"merge two exercises"}');
		expect(await offered(server, "health")).toEqual(
			expect.arrayContaining(["propose_merge_exercises", "merge_exercises"]),
		);
		for (const agent of ["pa", "inbox", "accountant"] as const) {
			expect(await offered(server, agent), agent).not.toContain("rename_exercise");
		}
		await sayTo(server, "pa", '/tool rename_exercise {"exercise":"squat","new_name":"Squats"}');
		expect(JSON.stringify((await toolResults(server, "pa")).at(-1)?.content)).toContain("not available");
	});

	it("renames at once, and merges after the owner's YES without the model", async () => {
		const { server } = await start();
		await logCrossover(server);
		expect(healthStore.listExercises(server.db).map((exercise) => exercise.name)).toStrictEqual([
			"Cable crosover",
			"Cable crossover",
		]);

		await sayTo(server, "health", '/tool rename_exercise {"exercise":"cable crossover","new_name":"Cable fly (low)"}');
		expect(JSON.stringify((await toolResults(server, "health")).at(-1)?.content)).toContain(
			'Renamed \\"Cable crossover\\" to \\"Cable fly (low)\\"',
		);
		await sayTo(server, "health", '/tool tool_search {"query":"merge two exercises"}');
		await sayTo(server, "health", '/tool propose_merge_exercises {"from":"cable crosover","into":"cable crossover"}');
		const card = (await cardsOf(server, "health")).find(
			(candidate): candidate is ApprovalCard => candidate.type === "approval",
		);
		expect(card?.summary).toBe(
			'Merge Cable crosover into Cable fly (low) (2 sets in 1 workout move; "Cable crosover" stays as another name for it)',
		);
		expect(healthStore.listExercises(server.db)).toHaveLength(2); // waiting for the owner

		await sayTo(server, "health", "YES");

		expect(healthStore.listExercises(server.db).map((exercise) => [exercise.name, exercise.aliases])).toStrictEqual([
			["Cable fly (low)", ["Cable crossover", "Cable crosover"]],
		]);
		const notices = (await entriesOf(server, "health")).filter((entry) => entry.kind === NOTICE_ENTRY_KIND);
		const notice = notices.at(-1)?.data as NoticeEntryData | undefined;
		expect(notice?.text).toContain(
			'You replied YES. Merged Cable crosover into Cable fly (low): 2 sets moved. "Cable crosover" still finds it.',
		);
	});
});

describe("the daily jobs carry what the health log knows", () => {
	const dailyOf = async (server: Server) =>
		(await entriesOf(server, "pa"))
			.filter((entry) => entry.kind === DAILY_ENTRY_KIND)
			.map((entry) => entry.data as DailyEntryData);

	it("tells the evening wrap-up what was weighed and trained, with the records", async () => {
		const { h, server } = await start();
		await sayTo(
			server,
			"health",
			'/tool log_workout {"date":"2026-10-22","exercises":[{"name":"squat","sets":[{"reps":5,"weight":100,"count":5}]}]}',
		);
		await sayTo(server, "health", '/tool log_weight {"weight":72.4}');
		await sayTo(
			server,
			"health",
			'/tool log_workout {"exercises":[{"name":"squat","sets":[{"reps":5,"weight":105,"count":5}]}]}',
		);

		h.clock.now = local("2026-10-25", "21:00");
		server.harness.resume();
		await waitFor(async () => (await dailyOf(server)).length === 1, { what: "the wrap-up" });

		const [wrapup] = await dailyOf(server);
		expect(wrapup?.sections.find((section) => section.title === "Health today")?.lines).toStrictEqual([
			"Weighed 72.4 kg (7-day average 72.4 kg)",
			"Trained: Squat 5x5 105 kg",
			"New personal records: Squat (estimated 1RM 122.5 kg, was 116.7 kg)",
		]);
		const [entry] = await ofKind(server, DAILY_ENTRY_KIND);
		expect(JSON.stringify(entry?.model)).toContain("Weighed 72.4 kg");
	});

	it("nudges the morning briefing when yesterday's weight was not logged, in the PA's thread and not as a push of content", async () => {
		const { h, server } = await start();
		await sayTo(server, "health", '/tool log_weight {"weight":72.6,"date":"2026-10-23"}');
		h.sender.sent.length = 0;

		h.clock.now = local("2026-10-26", "07:30");
		server.harness.resume();
		await waitFor(async () => (await dailyOf(server)).length === 1, { what: "the briefing" });

		const [briefing] = await dailyOf(server);
		expect(briefing?.sections.find((section) => section.title === "Health")?.lines).toStrictEqual([
			"No weight was logged yesterday (Sun 25 Oct 2026); the last one was 72.6 kg on Fri 23 Oct 2026. The owner logs it with the Health agent.",
		]);
		await waitFor(() => h.sender.sent.length === 1, { what: "the push" });
		expect(JSON.stringify(h.sender.sent[0]?.payload)).not.toMatch(/weight|kg/i);
	});
});
