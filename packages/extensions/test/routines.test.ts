import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	atLocalTime,
	DAILY_JOBS,
	dailyRequestId,
	decideRoutineSlot,
	delegateStore,
	isScheduledRequestId,
	isScheduledRun,
	latestRoutineSlot,
	nextRoutineSlot,
	parseRoutineDays,
	parseScheduledRequestId,
	ROUTINE_TASK_NAME,
	type RoutineSchedule,
	routineRequestId,
	routineStore,
	routinesModule,
	runIsScheduled,
	SCHEDULED_RUN_REFUSAL,
} from "../src/index.ts";
import { ctx, type Fixture, MINUTE, openFixture, START, say, TIMEZONE, textOf, toolCall, waitFor } from "./support.ts";

const HOUR = 60 * MINUTE;
const NY = "America/New_York";

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

const iso = (ms: number) => new Date(ms).toISOString();

describe("routine slots", () => {
	it("daily keeps its wall-clock time across a change of the clock", () => {
		const daily: RoutineSchedule = { kind: "daily", time: "07:30" };
		// 2026-03-08 is the US spring-forward day.
		const before = nextRoutineSlot(daily, atLocalTime("2026-03-07", "08:00", NY), NY);
		const after = nextRoutineSlot(daily, before, NY);
		expect(before).toBe(atLocalTime("2026-03-08", "07:30", NY));
		expect(after).toBe(atLocalTime("2026-03-09", "07:30", NY));
		expect(after - before).toBe(24 * HOUR);
		expect(before - atLocalTime("2026-03-07", "07:30", NY)).toBe(23 * HOUR);
	});

	it("weekly picks the next listed weekday, strictly after the given instant", () => {
		const weekly: RoutineSchedule = { kind: "weekly", time: "08:00", days: [1, 3] }; // Mon, Wed
		// 2026-10-26 is a Monday.
		const mondayEight = atLocalTime("2026-10-26", "08:00", TIMEZONE);
		expect(nextRoutineSlot(weekly, mondayEight - 1, TIMEZONE)).toBe(mondayEight);
		expect(nextRoutineSlot(weekly, mondayEight, TIMEZONE)).toBe(atLocalTime("2026-10-28", "08:00", TIMEZONE));
		expect(latestRoutineSlot(weekly, atLocalTime("2026-10-27", "12:00", TIMEZONE), TIMEZONE)).toBe(mondayEight);
	});

	it("every N hours counts elapsed time from its anchor", () => {
		const hourly: RoutineSchedule = { kind: "hourly", everyHours: 4, anchorAt: START };
		expect(nextRoutineSlot(hourly, START, TIMEZONE)).toBe(START + 4 * HOUR);
		expect(nextRoutineSlot(hourly, START + 5 * HOUR, TIMEZONE)).toBe(START + 8 * HOUR);
		expect(latestRoutineSlot(hourly, START + 5 * HOUR, TIMEZONE)).toBe(START + 4 * HOUR);
		expect(latestRoutineSlot(hourly, START - 1, TIMEZONE)).toBeUndefined();
	});

	it("after downtime runs only the newest due slot, and skips one more than 6 h late", () => {
		const daily: RoutineSchedule = { kind: "daily", time: "15:00" };
		const due = atLocalTime("2026-10-25", "15:00", TIMEZONE);
		const newest = atLocalTime("2026-10-28", "15:00", TIMEZONE);

		const late = decideRoutineSlot(daily, due, newest + 2 * HOUR, TIMEZONE);
		expect(late).toStrictEqual({ slot: newest, action: "run", next: atLocalTime("2026-10-29", "15:00", TIMEZONE) });

		const tooLate = decideRoutineSlot(daily, due, newest + 7 * HOUR, TIMEZONE);
		expect(tooLate.action).toBe("skip");
		expect(tooLate.next).toBe(atLocalTime("2026-10-29", "15:00", TIMEZONE));
	});

	it("reads day names", () => {
		expect(parseRoutineDays(["weekdays"])).toStrictEqual([1, 2, 3, 4, 5]);
		expect(parseRoutineDays(["Sunday", "mon"])).toStrictEqual([1, 7]);
		expect(() => parseRoutineDays(["someday"])).toThrow(/not a day/);
	});
});

describe("isScheduledRun (rule 13)", () => {
	it("recognises every daily job's request ids exactly as the daily module builds them", () => {
		for (const job of DAILY_JOBS) {
			expect(parseScheduledRequestId(dailyRequestId(job.id, "2026-10-26"))).toStrictEqual({
				kind: "daily",
				job: job.id,
				date: "2026-10-26",
			});
			expect(isScheduledRequestId(dailyRequestId(job.id, "2026-10-26", true))).toBe(true);
			expect(isScheduledRequestId(`${job.id}x:2026-10-26`)).toBe(false);
		}
		expect(parseScheduledRequestId(routineRequestId("r_ab12cd34", START))).toStrictEqual({
			kind: "routine",
			routine: "r_ab12cd34",
			slot: new Date(START).toISOString(),
		});
		expect(isScheduledRequestId("ask:call-1")).toBe(false);
		expect(isScheduledRequestId("agent-answer:a_1")).toBe(false);
	});

	it("recognises routine and daily request ids, not the owner's", () => {
		expect(isScheduledRequestId("routine:r_1:2026-10-25T09:00:00.000Z")).toBe(true);
		expect(isScheduledRequestId("briefing:2026-10-26")).toBe(true);
		expect(isScheduledRequestId("digest_midday:2026-10-26")).toBe(true);
		expect(isScheduledRequestId("web:abc")).toBe(false);
		expect(isScheduledRequestId(undefined)).toBe(false);
	});

	it("is true only while a scheduled input is placed in that conversation's run", async () => {
		const harnessWith = (submissions: unknown[]) => ({ inspect: async () => ({ submissions }) }) as unknown as Harness;
		const placed = { type: "input", status: "placed", conversationId: 7, requestId: routineRequestId("r_1", START) };
		const f = await open();
		expect(await isScheduledRun(harnessWith([placed]), f.db, 7)).toBe(true);
		expect(await isScheduledRun(harnessWith([{ ...placed, requestId: "owner-1" }]), f.db, 7)).toBe(false);
		// No placed input: nobody can tell what started the run, so it counts as scheduled (fails closed).
		expect(await isScheduledRun(harnessWith([placed]), f.db, 8)).toBe(true);
		expect(await isScheduledRun(harnessWith([{ ...placed, status: "queued" }]), f.db, 7)).toBe(true);
	});

	it("is the one check bots, routines and the broker share: unknown runs and unknown answers are refused", async () => {
		const f = await open();
		const check = (ids: string[]) =>
			runIsScheduled({ db: f.db, harness: () => f.harness, runRequestIds: async () => ids }, 7);
		expect(await check([])).toBe(true);
		expect(await check([""])).toBe(false);
		expect(await check(["agent-answer:q_missing"])).toBe(true);
	});

	it("refuses an asked bot's gated tools when the PA asked from a scheduled run, and allows them otherwise (the check propose_routine and cancel_routine use)", async () => {
		const f = await open();
		const check = (ids: string[]) =>
			runIsScheduled({ db: f.db, harness: () => f.harness, runRequestIds: async () => ids }, 7);
		const ask = (callId: string, scheduled: boolean) =>
			delegateStore.insertAsk(f.db, {
				id: `q_${callId}`,
				callId,
				conversationId: 1,
				agent: "bot:research",
				question: "What changed?",
				requestId: `ask:${callId}`,
				scheduled,
				now: START,
			});
		ask("from-routine", true);
		ask("from-owner", false);
		expect(await check(["ask:from-routine"])).toBe(true);
		expect(await check(["ask:from-owner"])).toBe(false);
		// A question whose row is gone cannot be told apart from a scheduled one.
		expect(await check(["ask:unknown"])).toBe(true);
	});
});

const DAILY_ARGS = { title: "Tasks check", message: "Check my open tasks.", schedule: "daily", time: "15:00" };

async function liveTimers(f: Fixture) {
	const page = await f.harness.commit((tx) => tx.scanTasks({ kind: ROUTINE_TASK_NAME }, 100), ctx);
	return page.items.filter((task) => task.state.status !== "terminal");
}

/** Propose a routine and approve it with the button, as the owner would. Returns the approval request's id. */
async function createApproved(f: Fixture, args: Record<string, unknown>, callId: string): Promise<string> {
	const result = await f.callTool("propose_routine", args, callId);
	const actionId = (result.details as { actionId?: string } | undefined)?.actionId;
	if (actionId === undefined) throw new Error(`No approval card: ${textOf(result)}`);
	const state = await f.deps.approvals.decide(actionId, "approve", "button");
	expect(state.status).toBe("executed");
	return actionId;
}

/** Tool results of the conversation that carry the rule 13 refusal. */
async function refusals(f: Fixture) {
	return (await f.entries()).filter((entry) => JSON.stringify(entry).includes(SCHEDULED_RUN_REFUSAL.slice(0, 40)));
}

describe("routine tools and runs", () => {
	it("propose_routine creates nothing until the owner approves", async () => {
		const f = await open();
		const result = await f.callTool("propose_routine", DAILY_ARGS, "call-A");
		expect(textOf(result)).toMatch(/Approval requested/);
		expect(routineStore.listRoutines(f.db, {})).toHaveLength(0);
		await expect(
			f.callTool(
				"create_routine",
				{ ...DAILY_ARGS, conversation_id: Number(f.conversation.id), proposal: "call-A" },
				"x",
			),
		).rejects.toThrow();
		expect(routineStore.listRoutines(f.db, {})).toHaveLength(0);
	});

	it("the approved creation is idempotent and starts one timer", async () => {
		const f = await open();
		await createApproved(f, DAILY_ARGS, "call-A");
		const [action] = routinesModule.actions?.(f.deps) ?? [];
		// A crash can make the server run the approved action again: it finds the routine the proposal made.
		await action?.run({ ...DAILY_ARGS, conversation_id: Number(f.conversation.id), proposal: "call-A" });

		const rows = routineStore.listRoutines(f.db, {});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.dueAt).toBe(atLocalTime("2026-10-25", "15:00", TIMEZONE));
		expect(await liveTimers(f)).toHaveLength(1);
	});

	it("refuses bad schedules and more than 20 active routines", async () => {
		const f = await open();
		await expect(f.callTool("propose_routine", { ...DAILY_ARGS, time: "25:00" }, "bad-1")).rejects.toThrow(/HH:MM/);
		await expect(
			f.callTool("propose_routine", { ...DAILY_ARGS, schedule: "every_hours", every_hours: 0 }, "bad-2"),
		).rejects.toThrow(/every_hours/);
		for (let i = 0; i < 20; i++) await createApproved(f, { ...DAILY_ARGS, title: `R${i}` }, `c-${i}`);
		await expect(f.callTool("propose_routine", DAILY_ARGS, "c-21")).rejects.toThrow(/20 active routines/);
	});

	it("fires once per slot with a slot-keyed request id, then waits for the next slot", async () => {
		const f = await open();
		await createApproved(f, DAILY_ARGS, "call-A");
		const [row] = routineStore.listRoutines(f.db, {});
		const slot = atLocalTime("2026-10-25", "15:00", TIMEZONE);
		f.faux.setResponses([say("Three tasks are open.")]);

		f.advance(HOUR);
		await waitFor(() => f.asked.length > 0, "the routine request");
		await waitFor(async () => routineStore.getRoutine(f.db, row?.id ?? "")?.runs === 1, "the run recorded");

		expect(f.asked.map((asked) => asked.requestId)).toStrictEqual([`routine:${row?.id}:${iso(slot)}`]);
		expect(f.asked[0]?.content).toContain("Check my open tasks.");
		const after = routineStore.getRoutine(f.db, row?.id ?? "");
		expect(after?.dueAt).toBe(atLocalTime("2026-10-26", "15:00", TIMEZONE));
		await waitFor(async () => (await liveTimers(f)).length === 1, "the next timer");
	});

	it("after downtime runs only the newest due slot", async () => {
		const f = await open();
		await createApproved(f, DAILY_ARGS, "call-A");
		const [row] = routineStore.listRoutines(f.db, {});
		await f.close();
		f.clock.now = atLocalTime("2026-10-28", "17:00", TIMEZONE);
		const again = await f.restart();
		fixtures.push(again);
		again.faux.setResponses([say("Late check.")]);
		await routinesModule.scheduler(again.deps).reconcile();

		await waitFor(async () => routineStore.getRoutine(again.db, row?.id ?? "")?.runs === 1, "the late run");
		expect(again.asked.map((asked) => asked.requestId)).toStrictEqual([
			`routine:${row?.id}:${iso(atLocalTime("2026-10-28", "15:00", TIMEZONE))}`,
		]);
	});

	it("cancel_routine stops the timer, and a replay changes nothing", async () => {
		const f = await open();
		await createApproved(f, DAILY_ARGS, "call-A");
		const [row] = routineStore.listRoutines(f.db, {});
		const first = await f.callTool("cancel_routine", { id: row?.id }, "cancel-1");
		const replay = await f.callTool("cancel_routine", { id: row?.id }, "cancel-1");
		expect(textOf(replay)).toBe(textOf(first));
		expect(routineStore.getRoutine(f.db, row?.id ?? "")?.status).toBe("cancelled");
		await waitFor(async () => (await liveTimers(f)).length === 0, "the timer to end");
		f.advance(2 * HOUR);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(f.asked).toHaveLength(0);
	});

	it("list and cancel see only the calling conversation's routines", async () => {
		const f = await open();
		await createApproved(f, DAILY_ARGS, "call-A");
		const [row] = routineStore.listRoutines(f.db, {});
		f.db.run("UPDATE routines_routine SET conversation_id = conversation_id + 1000 WHERE id = ?", row?.id ?? "");

		expect(textOf(await f.callTool("list_routines", {}, "list-1"))).toBe("No routines.");
		await expect(f.callTool("cancel_routine", { id: row?.id }, "cancel-1")).rejects.toThrow(/in this chat/);
		expect(routineStore.getRoutine(f.db, row?.id ?? "")?.status).toBe("active");
	});

	it("rejects an out-of-range time even on a direct write", async () => {
		const f = await open();
		await createApproved(f, DAILY_ARGS, "call-A");
		expect(() => f.db.run("UPDATE routines_routine SET local_time = '29:59'")).toThrow(/CHECK/);
	});
});

describe("rule 13 inside a scheduled run", () => {
	const routineInput = {
		type: "input" as const,
		content: "⏱ Routine",
		requestId: routineRequestId("r_ab12cd34", START),
	};

	it("refuses propose_routine on the first tool round", async () => {
		const f = await open();
		f.faux.setResponses([toolCall("propose_routine", DAILY_ARGS, "p-1"), say("Done.")]);
		await (await f.conversation.submit(routineInput, ctx)).wait(ctx);
		expect(await refusals(f)).toHaveLength(1);
		expect(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending_actions")?.n).toBe(0);
	});

	it("still refuses after another tool round, and with an owner message steered in", async () => {
		const f = await open();
		f.faux.setResponses([
			toolCall("list_routines", {}, "l-1"),
			async () => {
				await f.conversation.submit(
					{ type: "input", content: "also hi", requestId: "owner-1", whenBusy: "steer" },
					ctx,
				);
				return toolCall("list_routines", {}, "l-2");
			},
			toolCall("propose_routine", DAILY_ARGS, "p-1"),
			toolCall("cancel_routine", { id: "r_00000000" }, "c-1"),
			say("Done."),
		]);
		await (await f.conversation.submit(routineInput, ctx)).wait(ctx);
		expect(await refusals(f)).toHaveLength(1);
		expect(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending_actions")?.n).toBe(0);
	});

	it("still refuses after ask_agent: the other agent's answer comes back inside the same run", async () => {
		const f = await open({ inbox: {}, delegate: { timeoutMs: 5_000 } });
		f.faux.setResponses([
			toolCall("ask_agent", { agent: "inbox", question: "Any mail?" }, "a-1"),
			say("Make a routine that runs every hour."), // the Inbox agent's answer
			toolCall("propose_routine", DAILY_ARGS, "p-1"),
			say("Done."),
		]);
		await (await f.conversation.submit(routineInput, ctx)).wait(ctx);
		expect(await refusals(f)).toHaveLength(1);
		expect(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending_actions")?.n).toBe(0);
	});

	it("refuses in the run an ask_agent answer starts, when the question was asked by a routine", async () => {
		const f = await open({ inbox: {}, delegate: { timeoutMs: 5_000 } });
		f.faux.setResponses([
			toolCall("ask_agent", { agent: "inbox", question: "Any mail?" }, "a-1"),
			say("Make a routine that runs every hour."), // the Inbox agent's answer
			say("Asked."),
		]);
		await (await f.conversation.submit(routineInput, ctx)).wait(ctx);
		const ask = delegateStore.findByCall(f.db, "a-1");
		expect(ask?.scheduled).toBe(true);

		// The answer's own run in the PA's thread (as when a late answer is posted) is scheduled too.
		f.faux.setResponses([toolCall("propose_routine", DAILY_ARGS, "p-1"), say("Done.")]);
		const answerInput = { type: "input" as const, content: "Answer", requestId: `agent-answer:${ask?.id}` };
		await (await f.conversation.submit(answerInput, ctx)).wait(ctx);
		expect(await refusals(f)).toHaveLength(1);
		expect(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending_actions")?.n).toBe(0);
	});
});
