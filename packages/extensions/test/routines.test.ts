import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	atLocalTime,
	decideRoutineSlot,
	isScheduledRequestId,
	isScheduledRun,
	latestRoutineSlot,
	nextRoutineSlot,
	parseRoutineDays,
	ROUTINE_TASK_NAME,
	type RoutineSchedule,
	routineStore,
	routinesModule,
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
	it("recognises routine and daily request ids, not the owner's", () => {
		expect(isScheduledRequestId("routine:r_1:2026-10-25T09:00:00.000Z")).toBe(true);
		expect(isScheduledRequestId("briefing:2026-10-26")).toBe(true);
		expect(isScheduledRequestId("digest_midday:2026-10-26")).toBe(true);
		expect(isScheduledRequestId("web:abc")).toBe(false);
		expect(isScheduledRequestId(undefined)).toBe(false);
	});

	it("is true only while a scheduled input is placed in that conversation's run", async () => {
		const harnessWith = (submissions: unknown[]) => ({ inspect: async () => ({ submissions }) }) as unknown as Harness;
		const placed = { type: "input", status: "placed", conversationId: 7, requestId: "routine:r_1:x" };
		expect(await isScheduledRun(harnessWith([placed]), 7)).toBe(true);
		expect(await isScheduledRun(harnessWith([placed]), 8)).toBe(false);
		expect(await isScheduledRun(harnessWith([{ ...placed, status: "queued" }]), 7)).toBe(false);
		expect(await isScheduledRun(harnessWith([{ ...placed, requestId: "owner-1" }]), 7)).toBe(false);
	});
});

const DAILY_ARGS = { title: "Tasks check", message: "Check my open tasks.", schedule: "daily", time: "15:00" };

async function liveTimers(f: Fixture) {
	const page = await f.harness.commit((tx) => tx.scanTasks({ kind: ROUTINE_TASK_NAME }, 100), ctx);
	return page.items.filter((task) => task.state.status !== "terminal");
}

describe("routine tools and runs", () => {
	it("create_routine is idempotent by call id and starts one timer", async () => {
		const f = await open();
		const first = await f.callTool("create_routine", DAILY_ARGS, "call-A");
		f.clock.now += 5 * MINUTE;
		const replay = await f.callTool("create_routine", DAILY_ARGS, "call-A");

		const rows = routineStore.listRoutines(f.db, {});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.dueAt).toBe(atLocalTime("2026-10-25", "15:00", TIMEZONE));
		expect(textOf(replay)).toBe(textOf(first));
		expect(await liveTimers(f)).toHaveLength(1);
	});

	it("refuses bad schedules and more than 20 active routines", async () => {
		const f = await open();
		await expect(f.callTool("create_routine", { ...DAILY_ARGS, time: "25:00" }, "bad-1")).rejects.toThrow(/HH:MM/);
		await expect(
			f.callTool("create_routine", { ...DAILY_ARGS, schedule: "every_hours", every_hours: 0 }, "bad-2"),
		).rejects.toThrow(/every_hours/);
		for (let i = 0; i < 20; i++) await f.callTool("create_routine", { ...DAILY_ARGS, title: `R${i}` }, `c-${i}`);
		await expect(f.callTool("create_routine", DAILY_ARGS, "c-21")).rejects.toThrow(/20 active routines/);
	});

	it("fires once per slot with a slot-keyed request id, then waits for the next slot", async () => {
		const f = await open();
		await f.callTool("create_routine", DAILY_ARGS, "call-A");
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
		await f.callTool("create_routine", DAILY_ARGS, "call-A");
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
		await f.callTool("create_routine", DAILY_ARGS, "call-A");
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

	it("refuses create_routine inside a routine run (rule 13)", async () => {
		const f = await open();
		f.faux.setResponses([toolCall("create_routine", { ...DAILY_ARGS, title: "Spawned" }, "nested-1"), say("Done.")]);
		const submission = await f.conversation.submit(
			{ type: "input", content: "⏱ Routine", requestId: "routine:r_x:2026-10-25T09:00:00.000Z" },
			ctx,
		);
		await submission.wait(ctx);

		expect(routineStore.listRoutines(f.db, {})).toHaveLength(0);
		const results = (await f.entries()).filter((entry) =>
			JSON.stringify(entry).includes(SCHEDULED_RUN_REFUSAL.slice(0, 40)),
		);
		expect(results.length).toBeGreaterThan(0);
	});
});
