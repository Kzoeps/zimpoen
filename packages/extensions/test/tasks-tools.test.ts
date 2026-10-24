import { REMINDER_ENTRY_KIND, type TaskCard, type TaskListCard } from "@assistant/shared";
import { afterEach, describe, expect, it } from "vitest";
import { REMINDER_TASK_NAME, renderTasksSection, taskStore } from "../src/index.ts";
import { ctx, type Fixture, MINUTE, openFixture, START, TIMEZONE, waitFor } from "./support.ts";

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

const outputOf = (result: { output?: readonly { type: string; text?: string }[] }): string =>
	(result.output ?? []).map((part) => part.text ?? "").join("");

const DAY = 24 * 60 * MINUTE;

/** Live (not yet finished) reminder timers. */
async function liveTimers(f: Fixture) {
	const page = await f.harness.commit((tx) => tx.scanTasks({ kind: REMINDER_TASK_NAME }, 100), ctx);
	return page.items.filter((task) => task.state.status !== "terminal");
}

describe("add_task", () => {
	it("saves one row however often Durable replays the call (rule 8: idempotent by tool call id)", async () => {
		const f = await open();

		const first = await f.callTool("add_task", { title: "Pay rent", remind_in_minutes: 30 }, "call-A");
		f.clock.now += 5 * MINUTE; // a replay happens later: nothing computed from the clock may change what was saved
		const replay = await f.callTool("add_task", { title: "Pay rent", remind_in_minutes: 30 }, "call-A");

		const { tasks } = taskStore.listTasks(f.db, { status: "all", limit: 10 });
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.remindAt).toBe(START + 30 * MINUTE);
		expect(outputOf(replay)).toBe(outputOf(first));
		expect(await liveTimers(f)).toHaveLength(1);
	});

	it("two different calls make two tasks", async () => {
		const f = await open();

		await f.callTool("add_task", { title: "One" }, "call-1");
		await f.callTool("add_task", { title: "One" }, "call-2");

		expect(taskStore.listTasks(f.db, { status: "all", limit: 10 }).total).toBe(2);
	});

	it("completes the timer a crashed first run never started, when the call is replayed", async () => {
		const f = await open();
		// The first run got as far as saving the row, then the process died.
		taskStore.insertTask(
			f.db,
			{
				title: "Renew licence",
				notes: "",
				dueAllDay: false,
				remindAt: START + 10 * MINUTE,
				conversationId: Number(f.conversation.id),
				createdAt: START,
			},
			"call-crash",
		);
		expect(await liveTimers(f)).toHaveLength(0);

		await f.callTool("add_task", { title: "Renew licence", remind_in_minutes: 10 }, "call-crash");

		expect(taskStore.listTasks(f.db, { status: "all", limit: 10 }).total).toBe(1);
		expect(await liveTimers(f)).toHaveLength(1);
	});

	it("answers a replay with what its first run saved even when the reminder time has passed by then (rule 8)", async () => {
		const f = await open();
		// The first run saved the row (reminder 10 minutes ahead), then the process died before it started the timer.
		taskStore.insertTask(
			f.db,
			{
				title: "Renew licence",
				notes: "",
				dueAllDay: false,
				remindAt: START + 10 * MINUTE,
				conversationId: Number(f.conversation.id),
				createdAt: START,
			},
			"call-crash",
		);
		f.clock.now = START + 20 * MINUTE; // it is back 20 minutes later; Durable replays the same call with the same arguments

		const replay = await f.callTool(
			"add_task",
			{ title: "Renew licence", remind_at: "2026-10-25T14:10" },
			"call-crash",
		);

		expect(outputOf(replay)).toContain("Saved t_");
		expect(taskStore.listTasks(f.db, { status: "all", limit: 10 }).total).toBe(1);
		// The reminder is late, not lost: the timer exists and fires at once.
		f.advance(0);
		await waitFor(async () => (await f.entriesOfKind(REMINDER_ENTRY_KIND)).length === 1, "the late reminder");
	});

	it("reads clock times in the owner's zone and returns a card with them", async () => {
		const f = await open();

		const result = await f.callTool(
			"add_task",
			{ title: "Dentist", due: "2026-10-27T10:30", remind_at: "2026-10-27T09:00" },
			"call-1",
		);

		const card = result.details as unknown as TaskCard;
		expect(card).toMatchObject({
			type: "task",
			event: "created",
			task: {
				title: "Dentist",
				status: "open",
				dueText: "Tue 27 Oct 2026, 10:30",
				remindText: "Tue 27 Oct 2026, 09:00",
			},
		});
		expect(card.task.dueAt).toBe(Date.UTC(2026, 9, 27, 4, 30));
		expect(outputOf(result)).toContain("due 2026-10-27T10:30:00+06:00");
		expect(outputOf(result)).toContain("reminder 2026-10-27T09:00:00+06:00");
	});

	it("treats a date without a time as 'any time that day'", async () => {
		const f = await open();

		const result = await f.callTool("add_task", { title: "File taxes", due: "2026-10-31" }, "call-1");

		expect((result.details as unknown as TaskCard).task.dueText).toBe("Sat 31 Oct 2026");
		expect(outputOf(result)).toContain("due 2026-10-31 (any time that day)");
		expect(taskStore.listTasks(f.db, { status: "open", limit: 5 }).tasks[0]?.dueAllDay).toBe(true);
	});

	it.each([
		[
			"a reminder in the past",
			{ title: "x", remind_at: "2026-10-25T13:00" },
			/in the past; it is 2026-10-25T14:00:00\+06:00 now/,
		],
		["a reminder with no time of day", { title: "x", remind_at: "2026-10-26" }, /needs a time of day/],
		[
			"both ways to say when",
			{ title: "x", remind_at: "2026-10-26T09:00", remind_in_minutes: 5 },
			/either remind_at or remind_in_minutes/,
		],
		[
			"words instead of ISO",
			{ title: "x", remind_at: "tomorrow morning" },
			/remind_at: 'tomorrow morning' is not an ISO 8601/,
		],
		["an impossible due date", { title: "x", due: "2026-02-30" }, /due: .* is not a real date/],
		["a blank title", { title: "   " }, /title must not be empty/],
	])("refuses %s, and saves nothing", async (_name, args, message) => {
		const f = await open();

		await expect(f.callTool("add_task", args, "call-1")).rejects.toThrow(message);

		expect(taskStore.listTasks(f.db, { status: "all", limit: 10 }).total).toBe(0);
		expect(await liveTimers(f)).toHaveLength(0);
	});
});

describe("list_tasks", () => {
	async function seeded(): Promise<Fixture> {
		const f = await open();
		await f.callTool("add_task", { title: "Later", due: "2026-11-30" }, "c1");
		await f.callTool("add_task", { title: "No date" }, "c2");
		await f.callTool("add_task", { title: "Soon", due: "2026-10-26T09:00" }, "c3");
		await f.callTool("add_task", { title: "Finished" }, "c4");
		const finished = taskStore
			.listTasks(f.db, { status: "all", limit: 10 })
			.tasks.find((task) => task.title === "Finished");
		await f.callTool("complete_task", { task_id: finished?.id }, "c5");
		return f;
	}

	it("lists open tasks soonest due first, tasks without a date last, and hides finished ones", async () => {
		const f = await seeded();

		const result = await f.callTool("list_tasks", {}, "l1");

		const card = result.details as unknown as TaskListCard;
		expect(card.tasks.map((task) => task.title)).toStrictEqual(["Soon", "Later", "No date"]);
		expect(card).toMatchObject({ type: "task_list", heading: "Open tasks", total: 3 });
		expect(outputOf(result)).toMatch(/^Open tasks: 3\n- t_\w+ “Soon” — open; due 2026-10-26T09:00:00\+06:00/);
	});

	it("filters by status and by due window, and says when the list was cut short", async () => {
		const f = await seeded();

		expect(
			((await f.callTool("list_tasks", { status: "done" }, "l1")).details as unknown as TaskListCard).tasks.map(
				(t) => t.title,
			),
		).toStrictEqual(["Finished"]);
		const window = await f.callTool("list_tasks", { due_after: "2026-10-26", due_before: "2026-10-27" }, "l2");
		expect((window.details as unknown as TaskListCard).tasks.map((t) => t.title)).toStrictEqual(["Soon"]);
		const cut = await f.callTool("list_tasks", { status: "all", limit: 2 }, "l3");
		expect(outputOf(cut)).toContain("All tasks: 4 (showing 2 of 4)");
		expect(outputOf(await f.callTool("list_tasks", { due_before: "2026-01-01" }, "l4"))).toBe("No matching tasks.");
	});
});

describe("update_task, complete_task and snooze_reminder", () => {
	it("changes only the fields given and keeps the rest", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "Write report", notes: "for Q3", due: "2026-10-30" }, "c1");
		const [row] = taskStore.listTasks(f.db, { status: "open", limit: 5 }).tasks;

		await f.callTool("update_task", { task_id: row?.id, title: "Write Q3 report" }, "c2");
		await f.callTool("update_task", { task_id: row?.id, due: null }, "c3");

		const saved = taskStore.requireTask(f.db, row?.id ?? "");
		expect(saved).toMatchObject({ title: "Write Q3 report", notes: "for Q3" });
		expect(saved.dueAt).toBeUndefined();
	});

	it("refuses an update that changes nothing, and an unknown id, with what to do", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "x" }, "c1");
		const [row] = taskStore.listTasks(f.db, { status: "open", limit: 5 }).tasks;

		await expect(f.callTool("update_task", { task_id: row?.id }, "c2")).rejects.toThrow(/Nothing to change/);
		await expect(f.callTool("update_task", { task_id: "t_nope", title: "y" }, "c3")).rejects.toThrow(
			/No task 't_nope'.*list_tasks/,
		);
	});

	it("applies a relative snooze once however often the call is replayed (rule 8)", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "Call mum", remind_in_minutes: 5 }, "c1");
		const [row] = taskStore.listTasks(f.db, { status: "open", limit: 5 }).tasks;

		await f.callTool("snooze_reminder", { task_id: row?.id, minutes: 30 }, "snooze");
		const afterFirst = taskStore.requireTask(f.db, row?.id ?? "").remindAt;
		f.clock.now += 10 * MINUTE;
		await f.callTool("snooze_reminder", { task_id: row?.id, minutes: 30 }, "snooze");

		expect(afterFirst).toBe(START + 30 * MINUTE);
		expect(taskStore.requireTask(f.db, row?.id ?? "").remindAt).toBe(afterFirst);
		expect(await liveTimers(f)).toHaveLength(1);
	});

	it("answers replays of update_task and snooze_reminder with their first result, whatever the clock says by then", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "Call mum", remind_in_minutes: 5 }, "c1");
		const [row] = taskStore.listTasks(f.db, { status: "open", limit: 5 }).tasks;
		await f.callTool("update_task", { task_id: row?.id, remind_at: "2026-10-25T14:30" }, "update-1");
		const updatedTo = taskStore.requireTask(f.db, row?.id ?? "").remindAt;
		await f.callTool("snooze_reminder", { task_id: row?.id, until: "2026-10-25T15:00" }, "snooze-1");
		const snoozedTo = taskStore.requireTask(f.db, row?.id ?? "").remindAt;
		f.clock.now = START + 2 * 60 * MINUTE; // 16:00: both times are in the past now

		const updateReplay = await f.callTool(
			"update_task",
			{ task_id: row?.id, remind_at: "2026-10-25T14:30" },
			"update-1",
		);
		const snoozeReplay = await f.callTool(
			"snooze_reminder",
			{ task_id: row?.id, until: "2026-10-25T15:00" },
			"snooze-1",
		);

		expect(outputOf(updateReplay)).toMatch(/^Updated t_/);
		expect(outputOf(snoozeReplay)).toMatch(/^Snoozed: t_/);
		expect(updatedTo).toBe(Date.UTC(2026, 9, 25, 8, 30));
		expect(snoozedTo).toBe(Date.UTC(2026, 9, 25, 9, 0));
		expect(taskStore.requireTask(f.db, row?.id ?? "").remindAt).toBe(snoozedTo); // the replay of update-1 did not undo the snooze
	});

	it("refuses to clear the reminder and set a new one in the same call", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "x", remind_in_minutes: 30 }, "c1");
		const [row] = taskStore.listTasks(f.db, { status: "open", limit: 5 }).tasks;

		await expect(
			f.callTool("update_task", { task_id: row?.id, remind_at: null, remind_in_minutes: 5 }, "c2"),
		).rejects.toThrow(/Send only one of them/);

		expect(taskStore.requireTask(f.db, row?.id ?? "").remindAt).toBe(START + 30 * MINUTE);
	});

	it("completes a task once, keeps the first completion time, and a replay changes nothing", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "Tidy desk" }, "c1");
		const [row] = taskStore.listTasks(f.db, { status: "open", limit: 5 }).tasks;

		await f.callTool("complete_task", { task_id: row?.id }, "done");
		const first = taskStore.requireTask(f.db, row?.id ?? "");
		f.clock.now += DAY;
		const again = await f.callTool("complete_task", { task_id: row?.id }, "done-again");

		expect(first.status).toBe("done");
		expect(taskStore.requireTask(f.db, first.id).doneAt).toBe(first.doneAt);
		expect((again.details as unknown as TaskCard).event).toBe("completed");
		expect(taskStore.listTasks(f.db, { status: "open", limit: 5 }).total).toBe(0);
	});

	it("refuses to snooze a finished task, and needs exactly one of minutes or until", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "x" }, "c1");
		const [row] = taskStore.listTasks(f.db, { status: "open", limit: 5 }).tasks;

		await expect(f.callTool("snooze_reminder", { task_id: row?.id }, "s1")).rejects.toThrow(
			/exactly one of minutes or until/,
		);
		await f.callTool("complete_task", { task_id: row?.id }, "s2");
		await expect(f.callTool("snooze_reminder", { task_id: row?.id, minutes: 5 }, "s3")).rejects.toThrow(
			/is done, so there is nothing to snooze/,
		);
	});
});

describe("current_time", () => {
	it("tells the model the date, the weekday and the zone, from the Harness clock", async () => {
		const f = await open();

		expect(outputOf(await f.callTool("current_time", {}, "t1"))).toBe(
			`Now: 2026-10-25T14:00:00+06:00 (Sunday), time zone ${TIMEZONE}.`,
		);
	});
});

describe("the tasks prompt section", () => {
	const render = (f: Fixture) => renderTasksSection({ db: f.db, timezone: TIMEZONE });

	it("says there is nothing to do when the list is empty", async () => {
		const f = await open();

		expect(render(f)).toBe("No open tasks.");
	});

	it("counts open tasks and lists the next three that have a due date, soonest first", async () => {
		const f = await open();
		for (const [index, due] of ["2026-11-03", "2026-10-26T09:00", "2026-12-01", "2026-10-30T17:00"].entries()) {
			await f.callTool("add_task", { title: `Task ${index}`, due }, `c${index}`);
		}
		await f.callTool("add_task", { title: "Undated" }, "c9");

		const text = render(f);

		expect(text).toMatch(
			/^Open tasks: 5\.\nNext due:\n- t_\w+ “Task 1”, due Mon 26 Oct 2026, 09:00\n- t_\w+ “Task 3”, due Fri 30 Oct 2026, 17:00\n- t_\w+ “Task 0”, due Tue 3 Nov 2026$/,
		);
	});

	it("renders the same bytes however much time passes, so the provider's prompt cache stays warm", async () => {
		const f = await open();
		await f.callTool("add_task", { title: "Pay rent", due: "2026-10-27T09:00" }, "c1");

		const before = render(f);
		f.clock.now += 40 * DAY;

		expect(render(f)).toBe(before);
		expect(before).not.toMatch(/overdue|today|now/i);
	});
});
