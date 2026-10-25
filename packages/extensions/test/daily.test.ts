import { rm } from "node:fs/promises";
import { DAILY_ENTRY_KIND, type DailyEntryData } from "@assistant/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	atLocalTime,
	BRIEFING_JOB,
	BRIEFING_PUSH,
	dailyModule,
	dailyOccurrenceOn,
	dailyStore,
	InvalidDailyTime,
	nextDailyOccurrence,
	renderDailyRequest,
	renderJournalSection,
	taskStore,
	UnknownDailyJob,
	WRAPUP_PUSH,
} from "../src/index.ts";
import {
	ctx,
	type Fixture,
	MINUTE,
	openFixture,
	restoreDurable,
	say,
	snapshotDurable,
	TIMEZONE,
	textOf,
	toolCall,
	waitFor,
} from "./support.ts";

const HOUR = 60 * MINUTE;
const fixtures: Fixture[] = [];
/** Copies of Durable's database a test kept to put back later (see "after a power cut"): not inside a fixture's directory, so removed here. */
const backups: string[] = [];
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
	for (const backup of backups.splice(0)) await rm(backup, { recursive: true, force: true });
});

/** What the server does at start: the rows of the jobs, what a power cut may have taken, and the timers. */
async function startDaily(f: Fixture) {
	const recovery = await dailyModule.start(f.deps);
	const timers = await dailyModule.scheduler(f.deps).reconcile();
	return { recovery, timers };
}

const local = (date: string, time: string, timezone = TIMEZONE): number => atLocalTime(date, time, timezone);
const dailyEntries = async (f: Fixture) =>
	(await f.entriesOfKind(DAILY_ENTRY_KIND)).map((entry) => entry.data as unknown as DailyEntryData);
const schedule = (f: Fixture, job: string) => dailyStore.requireSchedule(f.db, job);
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** A task that is due on a local day, so that the briefing of that day has something to say. */
function addTask(f: Fixture, title: string, dueAt: number, callId = `call-${title}`) {
	return taskStore.insertTask(
		f.db,
		{ title, notes: "", dueAt, dueAllDay: false, conversationId: Number(f.conversation.id), createdAt: f.clock.now },
		callId,
	).row;
}

describe("the next run of a daily job", () => {
	const input = { timezone: TIMEZONE, time: "07:30", lateMinutes: 210 };

	it("is today when the time is still to come", () => {
		const next = nextDailyOccurrence({ ...input, now: local("2026-10-26", "06:00") });
		expect(next).toMatchObject({ date: "2026-10-26", at: local("2026-10-26", "07:30") });
	});

	it("is still today when the time has passed but its window has not: a server that was down runs it late, once", () => {
		expect(nextDailyOccurrence({ ...input, now: local("2026-10-26", "10:59") }).date).toBe("2026-10-26");
		expect(nextDailyOccurrence({ ...input, now: local("2026-10-26", "11:00") }).date).toBe("2026-10-26");
	});

	it("is the next day once the window is over: a missed day is not made up", () => {
		const next = nextDailyOccurrence({ ...input, now: local("2026-10-26", "11:01") });
		expect(next).toMatchObject({ date: "2026-10-27", at: local("2026-10-27", "07:30") });
	});

	it("is a later day than the one that ran, however early it is", () => {
		const next = nextDailyOccurrence({ ...input, now: local("2026-10-26", "07:31"), lastRunDate: "2026-10-26" });
		expect(next.date).toBe("2026-10-27");
	});

	it("never reaches into the next day: the wrap-up of a day is not asked after midnight", () => {
		const wrapup = { timezone: TIMEZONE, time: "22:30", lateMinutes: 180 };
		expect(dailyOccurrenceOn("2026-10-26", "22:30", 180, TIMEZONE).deadline).toBe(local("2026-10-27", "00:00") - 1);
		expect(nextDailyOccurrence({ ...wrapup, now: local("2026-10-26", "23:59") }).date).toBe("2026-10-26");
		expect(nextDailyOccurrence({ ...wrapup, now: local("2026-10-27", "00:30") }).date).toBe("2026-10-27");
	});

	describe("across a change of the clock (America/New_York)", () => {
		const newYork = { timezone: "America/New_York", time: "07:30", lateMinutes: 210 };
		const at = (date: string, time: string) => local(date, time, "America/New_York");

		it("is 07:30 on the wall clock on both sides of the autumn change, so 25 hours apart", () => {
			// Saturday evening: the clocks go back during the night, so Sunday's 07:30 is EST (UTC-5), not EDT (UTC-4).
			const sunday = nextDailyOccurrence({ ...newYork, now: at("2026-10-31", "20:00") });
			const monday = nextDailyOccurrence({ ...newYork, now: at("2026-10-31", "20:00"), lastRunDate: sunday.date });
			expect(sunday.date).toBe("2026-11-01");
			expect(new Date(sunday.at).toISOString()).toBe("2026-11-01T12:30:00.000Z");
			expect(monday.date).toBe("2026-11-02");
			expect(new Date(monday.at).toISOString()).toBe("2026-11-02T12:30:00.000Z");
			// Saturday 07:30 EDT to Sunday 07:30 EST is 25 hours, by the instant.
			const saturday = dailyOccurrenceOn("2026-10-31", "07:30", 210, "America/New_York");
			expect(sunday.at - saturday.at).toBe(25 * HOUR);
		});

		it("is 07:30 on the wall clock on both sides of the spring change, so 23 hours apart", () => {
			const before = dailyOccurrenceOn("2026-03-07", "07:30", 210, "America/New_York");
			const after = dailyOccurrenceOn("2026-03-08", "07:30", 210, "America/New_York");
			expect(new Date(before.at).toISOString()).toBe("2026-03-07T12:30:00.000Z");
			expect(new Date(after.at).toISOString()).toBe("2026-03-08T11:30:00.000Z");
			expect(after.at - before.at).toBe(23 * HOUR);
		});

		it("moves a time the clock skips to the later instant (02:30 does not exist on 8 March)", () => {
			const skipped = dailyOccurrenceOn("2026-03-08", "02:30", 60, "America/New_York");
			expect(new Date(skipped.at).toISOString()).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
		});
	});
});

describe("the briefing", () => {
	it("runs at its time, asks the PA once with the facts of the day, and pushes", async () => {
		const f = await open();
		// Sunday 14:00: the next briefing is Monday 26 October at 07:30.
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		expect(schedule(f, "briefing")).toMatchObject({
			dueDate: "2026-10-26",
			dueAt: local("2026-10-26", "07:30"),
			enabled: true,
		});
		f.faux.setResponses([say("Good morning. Pay rent at 09:00.")]);

		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(() => f.asked.length > 0, "the briefing request");
		await waitFor(() => f.pushes.length > 0, "the push");

		expect(f.asked).toHaveLength(1);
		const [request] = f.asked;
		expect(request?.requestId).toBe("briefing:2026-10-26");
		expect(request?.content).toContain("Morning briefing request for Mon 26 Oct 2026 (2026-10-26)");
		expect(request?.content).toContain("Pay rent");
		expect(request?.entry?.kind).toBe(DAILY_ENTRY_KIND);
		expect(f.pushes).toStrictEqual([BRIEFING_PUSH]);
		await waitFor(async () => (await f.entriesOfKind("pi.assistant")).length === 1, "the PA's answer");

		const [data] = await dailyEntries(f);
		expect(data).toMatchObject({ job: "briefing", date: "2026-10-26", dateText: "Mon 26 Oct 2026" });
		expect(data?.sections.map((section) => section.title)).toStrictEqual(["Tasks and reminders today"]);
		// The input is the card; the model read it as a user message.
		const [entry] = await f.entriesOfKind(DAILY_ENTRY_KIND);
		expect(entry?.model?.[0]).toMatchObject({ role: "user" });
		expect(schedule(f, "briefing")).toMatchObject({ dueDate: "2026-10-27", lastRunDate: "2026-10-26" });
	});

	it("runs again the next day, with that day's request id", async () => {
		const f = await open();
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		addTask(f, "Call the bank", local("2026-10-27", "10:00"));
		await startDaily(f);
		f.faux.setResponses([say("Day one."), say("Day two.")]);

		for (const day of ["2026-10-26", "2026-10-27"]) {
			f.clock.now = local(day, "07:30");
			f.advance(0);
			await waitFor(() => f.asked.some((asked) => asked.requestId === `briefing:${day}`), `the briefing of ${day}`);
			await waitFor(async () => schedule(f, "briefing").lastRunDate === day, `the row to note ${day}`);
			await waitFor(
				async () => (await f.harness.inspect(ctx)).tasks.some(({ record }) => record.kind === "app.daily"),
				"the next timer",
			);
		}
		expect(f.asked.map((asked) => asked.requestId)).toStrictEqual(["briefing:2026-10-26", "briefing:2026-10-27"]);
		// Each request has its own day's facts: the second has the second task due today, and the first one is now overdue.
		expect(f.asked[1]?.content).toMatch(/## Tasks and reminders today\n- t_[0-9a-f]{8} “Call the bank” — due 10:00/);
		expect(f.asked[1]?.content).toMatch(/## Overdue tasks\n- t_[0-9a-f]{8} “Pay rent”/);
	});

	it("posts a card and asks the model nothing when there is nothing to say", async () => {
		const f = await open();
		await startDaily(f);
		const callsBefore = f.faux.state.callCount;

		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(async () => (await dailyEntries(f)).length === 1, "the card");
		await waitFor(() => f.pushes.length > 0, "the push");
		await settle();

		const [data] = await dailyEntries(f);
		expect(data).toMatchObject({ job: "briefing", date: "2026-10-26", empty: true, sections: [] });
		const [entry] = await f.entriesOfKind(DAILY_ENTRY_KIND);
		expect(entry?.model).toBeUndefined(); // display-only: no message for the model, so no run
		expect(f.asked).toHaveLength(0);
		expect(f.faux.state.callCount).toBe(callsBefore);
		expect(await f.entriesOfKind("pi.assistant")).toHaveLength(0);
		expect(f.pushes).toStrictEqual([BRIEFING_PUSH]);
		expect(schedule(f, "briefing").lastRunDate).toBe("2026-10-26");
	});

	it("runs once, late, when the server comes back after its time but inside the window", async () => {
		const f = await open({ clock: { now: local("2026-10-26", "07:00") } });
		addTask(f, "Pay rent", local("2026-10-26", "12:00"));
		await startDaily(f);
		expect(schedule(f, "briefing").dueDate).toBe("2026-10-26");

		// The server is down at 07:30 and starts again at 09:00.
		f.clock.now = local("2026-10-26", "09:00");
		const again = await f.restart();
		fixtures.push(again);
		again.faux.setResponses([say("Good morning, a little late.")]);
		await startDaily(again);
		await waitFor(() => again.asked.length > 0, "the late briefing");
		await settle();

		expect(again.asked.map((asked) => asked.requestId)).toStrictEqual(["briefing:2026-10-26"]);
		const [data] = await dailyEntries(again);
		expect(data).toMatchObject({ date: "2026-10-26", late: true });
		expect(schedule(again, "briefing")).toMatchObject({ lastRunDate: "2026-10-26", dueDate: "2026-10-27" });
	});

	it("skips the day when the server comes back after the window, and runs the next morning", async () => {
		const f = await open({ clock: { now: local("2026-10-26", "07:00") } });
		addTask(f, "Pay rent", local("2026-10-26", "12:00"));
		await startDaily(f);

		f.clock.now = local("2026-10-26", "11:30"); // the window closed at 11:00
		const again = await f.restart();
		fixtures.push(again);
		again.faux.setResponses([say("Good morning.")]);
		await startDaily(again);
		await waitFor(() => schedule(again, "briefing").dueDate === "2026-10-27", "the day to be skipped");
		await settle();
		expect(again.asked).toHaveLength(0);
		expect(await dailyEntries(again)).toHaveLength(0);
		expect(schedule(again, "briefing")).toMatchObject({ dueAt: local("2026-10-27", "07:30") });
		expect(schedule(again, "briefing").lastRunDate).toBeUndefined();

		again.clock.now = local("2026-10-27", "07:30");
		again.advance(0);
		await waitFor(() => again.asked.length > 0, "the next morning's briefing");
		expect(again.asked[0]?.requestId).toBe("briefing:2026-10-27");
	});

	it("does not run a job that has just been created for a time that has passed: a first start has no past", async () => {
		const f = await open({ clock: { now: local("2026-10-26", "09:00") } });
		addTask(f, "Pay rent", local("2026-10-26", "12:00"));
		await startDaily(f);
		await settle();
		expect(f.asked).toHaveLength(0);
		expect(await dailyEntries(f)).toHaveLength(0);
		expect(schedule(f, "briefing")).toMatchObject({ dueDate: "2026-10-27" });
		expect(schedule(f, "wrapup")).toMatchObject({ dueDate: "2026-10-26" }); // 21:00 is still to come today
	});

	it("skips a run whose timer wakes after the window (the machine slept through it), without making it up", async () => {
		const f = await open();
		addTask(f, "Pay rent", local("2026-10-26", "12:00"));
		await startDaily(f);

		// Nothing wakes the timer until 12:00: the machine was suspended from the evening on.
		f.clock.now = local("2026-10-26", "12:00");
		f.advance(0);
		await waitFor(() => schedule(f, "briefing").dueDate === "2026-10-27", "the day to be skipped");
		await settle();

		expect(f.asked).toHaveLength(0);
		expect(await dailyEntries(f)).toHaveLength(0);
		expect(f.pushes).toHaveLength(0);
		const finished = (await f.harness.commit((tx) => tx.scanTasks({ kind: "app.daily" }, 20), ctx)).items;
		expect(finished.map((task) => task.state)).toContainEqual(
			expect.objectContaining({
				outcome: { status: "completed", result: { done: false, reason: "missed", date: "2026-10-26" } },
			}),
		);
	});

	it("asks once for a day however many times the run is repeated (the request id is the day)", async () => {
		const f = await open();
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		f.faux.setResponses([say("Good morning."), say("Again?")]);
		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(() => f.asked.length > 0, "the briefing");
		await waitFor(async () => (await f.entriesOfKind("pi.assistant")).length === 1, "the answer");

		// What a rerun after a crash does: the same request again.
		const first = f.asked[0];
		if (first === undefined) throw new Error("no request");
		await f.deps.ask(Number(f.conversation.id), first);
		await settle();

		expect(await dailyEntries(f)).toHaveLength(1);
		expect(await f.entriesOfKind("pi.assistant")).toHaveLength(1);
	});

	it("repeats what the first attempt decided when the process dies after the request was placed", async () => {
		let hang: ((error: Error) => void) | undefined;
		let asks = 0;
		const wrapAsk: NonNullable<Parameters<typeof openFixture>[0]>["wrapAsk"] =
			(ask) => async (conversationId, input) => {
				const result = await ask(conversationId, input);
				if (asks++ === 0) {
					// The request is in the transcript; the task has not recorded that or moved on. This is the crash window.
					await new Promise<never>((_resolve, reject) => {
						hang = reject;
					});
				}
				return result;
			};
		const f = await open({ wrapAsk });
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		f.faux.setResponses([say("Good morning.")]);
		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(() => hang !== undefined, "the request to be placed");

		// A task is added meanwhile: the repeat must still say what the first attempt decided to say.
		addTask(f, "Something new", local("2026-10-26", "10:00"));
		const closing = f.harness.close(ctx);
		hang?.(new Error("process died"));
		await closing;
		f.db.close();

		const again = await open({ dir: f.dir, clock: f.clock, wrapAsk });
		again.faux.setResponses([say("Good morning.")]);
		await waitFor(() => schedule(again, "briefing").lastRunDate === "2026-10-26", "the repeated run to finish");
		await settle();

		expect(asks).toBe(2); // the rerun asked again…
		expect(await dailyEntries(again)).toHaveLength(1); // …and the same request id found the same entry
		expect(again.asked.map((asked) => asked.requestId)).toStrictEqual(["briefing:2026-10-26"]);
		// The facts of the first attempt: the memo holds what it gathered, not what was added since.
		expect(again.asked[0]?.content).not.toContain("Something new");
		expect(again.pushes).toStrictEqual([BRIEFING_PUSH]); // the first run never got as far as the push
	});
});

describe("the evening wrap-up", () => {
	it("asks what the owner got done, with what the system recorded, and keeps the day in the journal", async () => {
		const f = await open();
		const done = addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		taskStore.completeTask(f.db, done.id, "call-done", local("2026-10-26", "15:00"));
		f.faux.setResponses([say("What did you get done today?")]);

		f.clock.now = local("2026-10-26", "21:00");
		f.advance(0);
		await waitFor(() => f.asked.some((asked) => asked.requestId === "wrapup:2026-10-26"), "the wrap-up");
		await waitFor(() => f.pushes.length > 0, "the push");

		const request = f.asked.find((asked) => asked.requestId === "wrapup:2026-10-26");
		expect(request?.content).toContain("Evening wrap-up request for Mon 26 Oct 2026 (2026-10-26)");
		expect(request?.content).toContain("call save_journal with date 2026-10-26");
		expect(request?.content).toContain("Pay rent");
		expect(f.pushes).toStrictEqual([WRAPUP_PUSH]);

		// The day exists before the answer does: that is what the prompt section reads.
		const day = dailyStore.getJournal(f.db, "2026-10-26");
		expect(day).toMatchObject({ date: "2026-10-26", askedAt: local("2026-10-26", "21:00") });
		expect(day?.userLog).toBeUndefined();
		expect(day?.autoSummary).toContain("Pay rent");
		expect(renderJournalSection(f.deps)).toContain("2026-10-26 (Mon 26 Oct 2026)");
	});

	it("asks even when the system recorded nothing: the owner may have done things it does not know about", async () => {
		const f = await open();
		await startDaily(f);
		f.faux.setResponses([say("What did you get done today?")]);
		f.clock.now = local("2026-10-26", "21:00");
		f.advance(0);
		await waitFor(() => f.asked.length > 0, "the wrap-up");
		expect(f.asked[0]?.content).toContain("The assistant recorded nothing today");
		expect((await dailyEntries(f))[0]).toMatchObject({ job: "wrapup", sections: [] });
		expect((await dailyEntries(f))[0]?.empty).toBeUndefined();
	});

	it("takes the owner's answer with save_journal, and the next morning's briefing brings what carried over", async () => {
		const f = await open();
		await startDaily(f);
		f.faux.setResponses([say("What did you get done today?")]);
		f.clock.now = local("2026-10-26", "21:00");
		f.advance(0);
		await waitFor(() => f.asked.some((asked) => asked.requestId === "wrapup:2026-10-26"), "the wrap-up");
		await waitFor(async () => (await f.entriesOfKind("pi.assistant")).length === 1, "the question");

		f.faux.setResponses([
			toolCall(
				"save_journal",
				{
					date: "2026-10-26",
					user_log: "Finished the report and went to the gym.",
					carried_over: ["Send the invoice", "Book the dentist"],
				},
				"call-save",
			),
			say("Saved. See you tomorrow."),
		]);
		await f.say("Finished the report, went to the gym. Still need to send the invoice and book the dentist.");
		const row = dailyStore.getJournal(f.db, "2026-10-26");
		expect(row).toMatchObject({
			userLog: "Finished the report and went to the gym.",
			carriedOver: ["Send the invoice", "Book the dentist"],
		});
		expect(renderJournalSection(f.deps)).toBeUndefined(); // answered: nothing waits any more

		f.faux.setResponses([say("Good morning.")]);
		f.clock.now = local("2026-10-27", "07:30");
		f.advance(0);
		await waitFor(
			() => f.asked.some((asked) => asked.requestId === "briefing:2026-10-27"),
			"the next morning's briefing",
		);
		const briefing = f.asked.find((asked) => asked.requestId === "briefing:2026-10-27");
		expect(briefing?.content).toContain("Carried over from yesterday");
		expect(briefing?.content).toContain("Send the invoice");
		expect(briefing?.content).toContain("Book the dentist");
	});
});

describe("save_journal and get_journal", () => {
	it("saves once per call id: a call that Durable replays after a crash changes nothing", async () => {
		const f = await open();
		const args = { date: "2026-10-25", user_log: "Cleaned the garage.", carried_over: ["Buy paint"] };
		const first = await f.callTool("save_journal", args, "call-1");
		expect(textOf(first)).toContain("Saved the journal of 2026-10-25");

		// The owner corrects it with a different call; then the first call is replayed.
		await f.callTool(
			"save_journal",
			{ ...args, user_log: "Cleaned the garage and the shed.", carried_over: [] },
			"call-2",
		);
		const replay = await f.callTool("save_journal", args, "call-1");

		expect(textOf(replay)).toContain("Saved the journal of 2026-10-25");
		const row = dailyStore.getJournal(f.db, "2026-10-25");
		expect(row?.userLog).toBe("Cleaned the garage and the shed.");
		expect(row?.carriedOver).toStrictEqual([]);
		expect(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM daily_call")?.n).toBe(2);
		expect(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pa_journal")?.n).toBe(1);
	});

	it("says what to fix: a day in the future, a date that is not one, an empty answer", async () => {
		const f = await open();
		await expect(f.callTool("save_journal", { date: "2026-10-26", user_log: "x" }, "c1")).rejects.toThrow(
			/in the future; today is 2026-10-25/,
		);
		await expect(f.callTool("save_journal", { date: "yesterday", user_log: "x" }, "c2")).rejects.toThrow(/YYYY-MM-DD/);
		await expect(f.callTool("save_journal", { date: "2026-02-30", user_log: "x" }, "c3")).rejects.toThrow(/YYYY-MM-DD/);
		await expect(f.callTool("save_journal", { date: "2026-10-25", user_log: "   " }, "c4")).rejects.toThrow(
			/must not be empty/,
		);
		expect(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pa_journal")?.n).toBe(0);
	});

	it("answers a replay from what the first run saved, even when the clock has moved on", async () => {
		const f = await open();
		await f.callTool("save_journal", { date: "2026-10-25", user_log: "Worked." }, "call-1");
		f.clock.now = local("2026-12-01", "10:00");
		const replay = await f.callTool("save_journal", { date: "2026-10-25", user_log: "Worked." }, "call-1");
		expect(textOf(replay)).toContain("Saved the journal of 2026-10-25");
	});

	it("reads one day or a range, and refuses a range longer than a month", async () => {
		const f = await open();
		await f.callTool(
			"save_journal",
			{ date: "2026-10-23", user_log: "Friday: wrote tests.", carried_over: ["Review PR"] },
			"c1",
		);
		await f.callTool("save_journal", { date: "2026-10-24", user_log: "Saturday: rested." }, "c2");

		const one = await f.callTool("get_journal", { date: "2026-10-23" }, "g1");
		expect(textOf(one)).toContain("Friday: wrote tests.");
		expect(textOf(one)).toContain("Carried over: Review PR");
		expect(textOf(one)).not.toContain("Saturday");

		const range = await f.callTool("get_journal", { from: "2026-10-20", to: "2026-10-25" }, "g2");
		expect(textOf(range)).toContain("2 day(s)");

		const recent = await f.callTool("get_journal", {}, "g3");
		expect(textOf(recent)).toContain("2 day(s)");

		await expect(f.callTool("get_journal", { from: "2026-01-01", to: "2026-10-25" }, "g4")).rejects.toThrow(
			/longer than 31 days/,
		);
		await expect(f.callTool("get_journal", { date: "2026-10-23", from: "2026-10-20" }, "g5")).rejects.toThrow(
			/either date or from\/to/,
		);
	});
});

describe("the first start", () => {
	it("names the jobs that got their first row, once: a new data directory is a set-up, not a repair", async () => {
		const f = await open();

		const first = await startDaily(f);
		expect(first.recovery.created).toStrictEqual(["briefing", "wrapup"]);
		// Their timers are made by the same repair pass; the server's log tells the two apart with `created`.
		expect(first.timers.rescheduled).toStrictEqual(["briefing", "wrapup"]);

		const second = await dailyModule.start(f.deps);
		expect(second.created).toStrictEqual([]);
		expect((await dailyModule.scheduler(f.deps).reconcile()).rescheduled).toStrictEqual([]);
	});
});

describe("the settings of the jobs", () => {
	it("moves a job to a new time at once: the old timer is stale, the new one fires at the new time", async () => {
		const f = await open();
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		const service = dailyModule.service(f.deps);
		const before = schedule(f, "briefing");

		const view = await service.update("briefing", { localTime: "08:15" });

		expect(view).toMatchObject({
			job: "briefing",
			localTime: "08:15",
			enabled: true,
			nextRunText: "Mon 26 Oct 2026, 08:15",
		});
		const after = schedule(f, "briefing");
		expect(after.gen).toBeGreaterThan(before.gen);
		expect(after.dueAt).toBe(local("2026-10-26", "08:15"));
		expect(after.durableTaskId).toBeTypeOf("number");
		expect(after.durableTaskId).not.toBe(before.durableTaskId);

		f.faux.setResponses([say("Good morning.")]);
		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await settle();
		expect(f.asked).toHaveLength(0); // the old time passed and nothing happened
		f.clock.now = local("2026-10-26", "08:15");
		f.advance(0);
		await waitFor(() => f.asked.length > 0, "the briefing at the new time");
	});

	it("means tomorrow by a time that has already passed today: an edit is not a late run", async () => {
		const f = await open({ clock: { now: local("2026-10-26", "07:45") } });
		await startDaily(f);
		const view = await dailyModule.service(f.deps).update("briefing", { localTime: "07:00" });
		expect(view.nextRunText).toBe("Tue 27 Oct 2026, 07:00");
		await settle();
		expect(f.asked).toHaveLength(0);
		expect(await dailyEntries(f)).toHaveLength(0);
	});

	it("switches a job off and on again; nothing fires while it is off", async () => {
		const f = await open();
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		const service = dailyModule.service(f.deps);

		const off = await service.update("briefing", { enabled: false });
		expect(off.enabled).toBe(false);
		expect(off.nextRunAt).toBeUndefined();
		expect(schedule(f, "briefing").durableTaskId).toBeUndefined();

		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await settle();
		expect(f.asked).toHaveLength(0);
		// And a repair does not bring a switched-off job back.
		expect((await dailyModule.scheduler(f.deps).reconcile()).rescheduled).toStrictEqual([]);

		f.faux.setResponses([say("Good morning.")]);
		// Switched on at 07:30 sharp: the next run is the one at 07:30, which is now, and not a late run of anything.
		f.clock.now = local("2026-10-26", "09:00");
		const on = await service.update("briefing", { enabled: true });
		expect(on).toMatchObject({ enabled: true, nextRunText: "Tue 27 Oct 2026, 07:30" });
		f.advance(0);
		await settle();
		expect(f.asked).toHaveLength(0); // switching on after the time has passed does not make up today's briefing
		expect(schedule(f, "briefing").durableTaskId).toBeTypeOf("number");
	});

	it("does not run a day twice because the time moved after it ran", async () => {
		const f = await open();
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		f.faux.setResponses([say("Good morning.")]);
		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(() => schedule(f, "briefing").lastRunDate === "2026-10-26", "the briefing to run");

		const view = await dailyModule.service(f.deps).update("briefing", { localTime: "10:00" });

		expect(view.nextRunText).toBe("Tue 27 Oct 2026, 10:00");
		f.clock.now = local("2026-10-26", "10:00");
		f.advance(0);
		await settle();
		expect(f.asked).toHaveLength(1);
	});

	it("refuses what it cannot do and says why", async () => {
		const f = await open();
		await startDaily(f);
		const service = dailyModule.service(f.deps);
		await expect(service.update("briefing", { localTime: "7:30" })).rejects.toBeInstanceOf(InvalidDailyTime);
		await expect(service.update("briefing", { localTime: "24:00" })).rejects.toThrow(/24-hour HH:MM/);
		await expect(service.update("lunch", { enabled: false })).rejects.toBeInstanceOf(UnknownDailyJob);
		expect(service.list().map((job) => [job.job, job.localTime, job.enabled])).toStrictEqual([
			["briefing", "07:30", true],
			["wrapup", "21:00", true],
		]);
	});

	it("gives each job its row once: start never changes what the owner set", async () => {
		const f = await open();
		await startDaily(f);
		await dailyModule.service(f.deps).update("wrapup", { localTime: "22:15" });
		const restarted = await f.restart();
		fixtures.push(restarted);
		await startDaily(restarted);
		expect(schedule(restarted, "wrapup").localTime).toBe("22:15");
	});
});

describe("across a change of the clock", () => {
	it("fires at 07:30 on the wall clock on the day the clocks go back, an hour later by the instant", async () => {
		const start = local("2026-10-31", "20:00", "America/New_York");
		const f = await open({ timezone: "America/New_York", clock: { now: start } });
		addTask(f, "Pay rent", local("2026-11-01", "09:00", "America/New_York"));
		f.faux.setResponses([say("Good morning.")]);
		await startDaily(f);
		expect(schedule(f, "briefing")).toMatchObject({ dueDate: "2026-11-01" });

		// 11:30Z is 07:30 EDT (the old offset) and 06:30 EST: not yet 07:30 on the wall clock.
		f.clock.now = Date.UTC(2026, 10, 1, 11, 30);
		f.advance(0);
		await settle();
		expect(f.asked).toHaveLength(0);

		f.clock.now = Date.UTC(2026, 10, 1, 12, 30);
		f.advance(0);
		await waitFor(() => f.asked.length > 0, "the briefing at 07:30 EST");
		expect(f.asked[0]?.requestId).toBe("briefing:2026-11-01");
	});

	it("moves on to the next calendar day when a run ends, never by adding 24 hours to an instant", async () => {
		const f = await open({
			timezone: "America/New_York",
			clock: { now: local("2026-03-07", "20:00", "America/New_York") },
		});
		addTask(f, "Pay rent", local("2026-03-08", "09:00", "America/New_York"));
		f.faux.setResponses([say("Good morning."), say("Good morning again.")]);
		await startDaily(f);
		expect(schedule(f, "briefing").dueAt).toBe(Date.UTC(2026, 2, 8, 11, 30)); // 07:30 EDT, after the clocks went forward

		f.clock.now = Date.UTC(2026, 2, 8, 11, 30);
		f.advance(0);
		await waitFor(() => schedule(f, "briefing").lastRunDate === "2026-03-08", "the briefing to run");
		expect(schedule(f, "briefing")).toMatchObject({ dueDate: "2026-03-09", dueAt: Date.UTC(2026, 2, 9, 11, 30) });
	});
});

describe("after a power cut", () => {
	it("writes today's briefing again when Durable's database lost it but app.sqlite remembers the run", async () => {
		const f = await open();
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		const backup = `${f.dir}-backup`;
		backups.push(backup);
		await f.close();
		await snapshotDurable(f.dir, backup);
		const reopened = await openFixture({ dir: f.dir, clock: f.clock });
		fixtures.push(reopened);
		reopened.faux.setResponses([say("Good morning.")]);
		reopened.clock.now = local("2026-10-26", "07:30");
		reopened.advance(0);
		await waitFor(() => schedule(reopened, "briefing").lastRunDate === "2026-10-26", "the briefing to run");
		await waitFor(async () => (await reopened.entriesOfKind("pi.assistant")).length === 1, "the answer");
		await reopened.close();

		// The power cut: Durable's database is back from before the briefing, app.sqlite is not.
		await restoreDurable(backup, f.dir);
		const afterCut = await openFixture({ dir: f.dir, clock: reopened.clock });
		fixtures.push(afterCut);
		expect(await afterCut.entriesOfKind(DAILY_ENTRY_KIND)).toHaveLength(0);
		afterCut.faux.setResponses([say("Good morning.")]);
		const { recovery } = await startDaily(afterCut);

		expect(recovery.redelivered).toStrictEqual(["briefing"]);
		await waitFor(
			async () => (await afterCut.entriesOfKind(DAILY_ENTRY_KIND)).length === 1,
			"the briefing to be written again",
		);
		expect(afterCut.pushes).toHaveLength(0); // the owner was told once: no second banner for something old

		// A start that finds it there keeps one.
		const again = await afterCut.restart();
		fixtures.push(again);
		again.faux.setResponses([say("Good morning.")]);
		await startDaily(again);
		await settle();
		expect(await again.entriesOfKind(DAILY_ENTRY_KIND)).toHaveLength(1);
		expect(await again.entriesOfKind("pi.assistant")).toHaveLength(1);
	});
});

describe("a restart on the day a job ran", () => {
	/** Another run of the process at 10:00 over the same files: a deploy, a crash, a reboot. */
	async function restartAt(f: Fixture, time: string): Promise<Fixture> {
		f.clock.now = local("2026-10-26", time);
		const again = await f.restart();
		fixtures.push(again);
		return again;
	}

	it("leaves the 07:30 'nothing today' card alone when a task has been added since: no model run is spent", async () => {
		const f = await open();
		await startDaily(f);
		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(async () => (await dailyEntries(f)).length === 1, "the card");
		await waitFor(() => schedule(f, "briefing").lastRunDate === "2026-10-26", "the run to be noted");
		addTask(f, "Pay rent", local("2026-10-26", "17:00"));

		const again = await restartAt(f, "10:00");
		again.faux.setResponses([say("This would be a model run.")]);
		const { recovery } = await startDaily(again);
		await settle();

		expect(recovery).toMatchObject({ redelivered: [], failures: [] });
		expect(again.asked).toHaveLength(0);
		expect(again.faux.state.callCount).toBe(0);
		expect(await dailyEntries(again)).toHaveLength(1);
		expect((await dailyEntries(again))[0]).toMatchObject({ empty: true });
		expect(await again.entriesOfKind("pi.assistant")).toHaveLength(0);
	});

	it("does not follow a briefing that asked the model with a 'nothing today' card when the list has emptied since", async () => {
		const f = await open();
		const task = addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		f.faux.setResponses([say("Good morning. Pay rent at 09:00.")]);
		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(async () => (await f.entriesOfKind("pi.assistant")).length === 1, "the answer");
		await waitFor(() => schedule(f, "briefing").lastRunDate === "2026-10-26", "the run to be noted");
		f.clock.now = local("2026-10-26", "10:00");
		taskStore.completeTask(f.db, task.id, "call-done", f.clock.now);

		const again = await restartAt(f, "10:00");
		const { recovery } = await startDaily(again);
		await settle();

		expect(recovery.redelivered).toStrictEqual([]);
		const cards = await dailyEntries(again);
		expect(cards).toHaveLength(1);
		expect(cards[0]).not.toHaveProperty("empty");
		expect(await again.entriesOfKind("pi.assistant")).toHaveLength(1);
	});

	it("does not close the YES window: a deletion proposed after the run can still be approved after a restart", async () => {
		const f = await open();
		await startDaily(f);
		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(() => schedule(f, "briefing").lastRunDate === "2026-10-26", "the run to be noted");
		f.clock.now = local("2026-10-26", "09:00");
		await f.callTool("add_task", { title: "Old task" }, "add-1");
		const old = taskStore.findByCallId(f.db, "add-1");
		await f.callTool("propose_delete_task", { task_id: old?.id }, "del-1");

		const again = await restartAt(f, "09:30");
		await startDaily(again);
		await settle();

		expect(await again.deps.approvals.tryYes(Number(again.conversation.id), "YES", "r-yes")).toBeDefined();
	});
});

describe("the YES window and the daily jobs", () => {
	const conversation = (f: Fixture) => Number(f.conversation.id);

	it("closes when a wrap-up is asked: a bare YES typed to its question goes to the model, not to a waiting deletion", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "Old task" }, "add-1");
		const old = taskStore.findByCallId(f.db, "add-1");
		await f.callTool("propose_delete_task", { task_id: old?.id }, "del-1");
		await startDaily(f);
		f.faux.setResponses([say("What did you get done today?")]);
		f.clock.now = local("2026-10-25", "21:00");
		f.advance(0);
		await waitFor(() => f.asked.length === 1, "the wrap-up");
		await waitFor(async () => (await f.entriesOfKind("pi.assistant")).length === 1, "the question");

		expect(await f.deps.approvals.tryYes(conversation(f), "YES", "r-yes")).toBeUndefined();
		expect(taskStore.getTask(f.db, old?.id ?? "")).toBeDefined();
	});

	it("closes again when a briefing that waited behind a running answer is read: a deletion proposed meanwhile is not approved by a YES to it", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "Old task" }, "add-1");
		const old = taskStore.findByCallId(f.db, "add-1");
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.faux.setResponses([
			async () => {
				await gate;
				return say("(first answer)");
			},
			() => say("Good morning. Shall I delete the old task? Reply yes."),
		]);
		const owner = await f.conversation.submit({ type: "input", content: "hello" }, ctx); // a run is busy
		await settle();
		// The briefing is asked now (the window closes now, with nothing waiting) and queues behind the run...
		const request = renderDailyRequest(BRIEFING_JOB, "2026-10-25", "Sun 25 Oct 2026", []);
		await f.deps.ask(conversation(f), {
			content: request,
			requestId: "briefing:2026-10-25",
			entry: {
				kind: DAILY_ENTRY_KIND,
				data: { job: "briefing", date: "2026-10-25", dateText: "Sun 25 Oct 2026", sections: [], firedAt: 1 },
			},
		});
		// ...and during that run a deletion is proposed: a request created after the window closed.
		await f.callTool("propose_delete_task", { task_id: old?.id }, "del-1");
		release();
		await owner.wait(ctx);
		await waitFor(async () => (await f.entriesOfKind("pi.assistant")).length === 2, "both answers");

		expect(await f.deps.approvals.tryYes(conversation(f), "YES", "r-yes")).toBeUndefined();
		expect(taskStore.getTask(f.db, old?.id ?? "")).toBeDefined();
	});

	it("leaves a request that was proposed during the briefing's own run open: that is the owner's to approve", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "Old task" }, "add-1");
		const old = taskStore.findByCallId(f.db, "add-1");
		f.faux.setResponses([
			toolCall("propose_delete_task", { task_id: old?.id }, "del-1"),
			say("Good morning. Delete the old task? Reply yes."),
		]);
		await f.deps.ask(conversation(f), {
			content: renderDailyRequest(BRIEFING_JOB, "2026-10-25", "Sun 25 Oct 2026", []),
			requestId: "briefing:2026-10-25",
			entry: {
				kind: DAILY_ENTRY_KIND,
				data: { job: "briefing", date: "2026-10-25", dateText: "Sun 25 Oct 2026", sections: [], firedAt: 1 },
			},
		});
		await waitFor(async () => (await f.entriesOfKind("pi.assistant")).length === 2, "the briefing's answer");

		expect(await f.deps.approvals.tryYes(conversation(f), "YES", "r-yes")).toBeDefined();
	});
});

describe("a facts provider that fails", () => {
	it("is left out and reported; the others are still told", async () => {
		const f = await open({
			providers: [
				{
					id: "broken",
					briefing: () => {
						throw new Error("the table is gone");
					},
				},
				{ id: "health", briefing: () => [{ title: "Weight", lines: ["Not logged yet this week."] }] },
			],
		});
		addTask(f, "Pay rent", local("2026-10-26", "09:00"));
		await startDaily(f);
		f.faux.setResponses([say("Good morning.")]);
		f.clock.now = local("2026-10-26", "07:30");
		f.advance(0);
		await waitFor(() => f.asked.length > 0, "the briefing");

		expect(f.asked[0]?.content).toContain("Pay rent");
		expect(f.asked[0]?.content).toContain("Not logged yet this week.");
		expect(
			f.reports.some(({ error }) => String((error as Error).message).includes("Facts provider 'broken' failed")),
		).toBe(true);
	});
});
