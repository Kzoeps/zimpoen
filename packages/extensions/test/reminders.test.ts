import { join } from "node:path";
import { REMINDER_ENTRY_KIND, type ReminderEntryData } from "@assistant/shared";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { REMINDER_PUSH, REMINDER_TASK_NAME, renderTasksSection, taskStore, tasksModule } from "../src/index.ts";
import {
	ctx,
	type Fixture,
	MINUTE,
	openFixture,
	restoreDurable,
	say,
	snapshotDurable,
	TIMEZONE,
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

/** Ask the scripted model to save a task with a reminder `minutes` from now. */
async function addReminder(f: Fixture, title: string, minutes: number, callId = `call-${title}`): Promise<string> {
	f.faux.setResponses([toolCall("add_task", { title, remind_in_minutes: minutes }, callId), say("Saved.")]);
	await f.say(`remind me to ${title}`);
	const row = taskStore.listTasks(f.db, { status: "open", limit: 50 }).tasks.find((task) => task.title === title);
	if (row === undefined) throw new Error(`the task '${title}' was not saved`);
	return row.id;
}

const reminderEntries = (f: Fixture) => f.entriesOfKind(REMINDER_ENTRY_KIND);

/** Reminder timers Durable still holds, by outcome of the task they belong to. */
async function reminderTasks(f: Fixture) {
	const page = await f.harness.commit((tx) => tx.scanTasks({ kind: REMINDER_TASK_NAME }, 100), ctx);
	return page.items;
}

/** Let Durable run whatever is runnable, then look again: used to prove that something does NOT happen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("a reminder", () => {
	it("sleeps until its time, then posts a card to the conversation and notifies the phone, once", async () => {
		const f = await open();
		const id = await addReminder(f, "Pay rent", 1);

		const row = taskStore.requireTask(f.db, id);
		expect(row.remindAt).toBe(f.clock.now + MINUTE);
		expect(row.durableTaskId).toBeTypeOf("number");
		await settle();
		expect(await reminderEntries(f)).toHaveLength(0);

		f.advance(MINUTE);
		const [entry] = await waitFor(async () => {
			const found = await reminderEntries(f);
			return found.length > 0 ? found : undefined;
		}, "the reminder card");
		await waitFor(() => f.pushes.length > 0, "the push");
		await settle();

		const data = entry?.data as ReminderEntryData;
		expect(data).toMatchObject({
			taskId: id,
			title: "Pay rent",
			remindAt: row.remindAt,
			remindAtText: "Sun 25 Oct 2026, 14:01",
		});
		expect(entry?.model).toBeUndefined(); // display-only: see the test about queued follow-ups below
		expect(await reminderEntries(f)).toHaveLength(1);
		expect(f.pushes).toStrictEqual([REMINDER_PUSH]);
		expect(taskStore.requireTask(f.db, id).remindedAt).toBe(f.clock.now);
		const [task] = await reminderTasks(f);
		expect(task?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "completed", result: { fired: true } },
		});
	});

	it("costs the model nothing: the card is a write, and no generation runs for it", async () => {
		const f = await open();
		await addReminder(f, "Water plants", 1);
		const requestsBefore = f.faux.state.callCount;

		f.advance(MINUTE);
		await waitFor(async () => (await reminderEntries(f)).length === 1, "the reminder card");

		expect(f.faux.state.callCount).toBe(requestsBefore);
	});

	it("starts no run even when a failed one left a follow-up queued (the model may be down: expired sign-in)", async () => {
		const f = await open();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const failing = async () => {
			await gate;
			return fauxAssistantMessage([], { stopReason: "error", errorMessage: "simulated model failure" });
		};
		f.faux.setResponses(Array.from({ length: 12 }, () => failing));
		await f.callTool("add_task", { title: "Pay rent", remind_in_minutes: 5 }, "add-1");
		const first = await f.conversation.submit({ type: "input", content: "first question" }, ctx);
		await waitFor(() => f.faux.state.callCount > 0, "the first run to reach the model");
		const second = await f.conversation.submit(
			{ type: "input", content: "typed while busy", whenBusy: "followUp" },
			ctx,
		);
		release();
		await first.wait(ctx).catch(() => undefined);
		await waitFor(async () => (await first.status(ctx)).status !== "placed", "the first run to give up");
		const callsBefore = f.faux.state.callCount;
		const statusBefore = (await second.status(ctx)).status;
		expect(statusBefore).toBe("queued");

		f.advance(5 * MINUTE);
		await waitFor(async () => (await reminderEntries(f)).length === 1, "the reminder card");
		await settle();

		expect(f.faux.state.callCount).toBe(callsBefore);
		expect((await second.status(ctx)).status).toBe(statusBefore);
		expect(f.pushes).toHaveLength(1);
	});

	it("survives the Stop button: a conversation abort does not cancel a reminder that is only waiting", async () => {
		const f = await open();
		await addReminder(f, "Pay rent", 5);

		await f.conversation.abort(ctx); // Stop while idle
		f.faux.setResponses([toolCall("current_time", {}, "t1"), say("done")]);
		await f.say("hello");
		await f.conversation.abort(ctx); // and after a run
		f.advance(5 * MINUTE);

		await waitFor(async () => (await reminderEntries(f)).length === 1, "the reminder, after Stop was pressed twice");
		expect(f.pushes).toHaveLength(1);
	});

	it("is told to the model by the tasks prompt section, from the database: sent reminders of open tasks", async () => {
		const f = await open();
		const id = await addReminder(f, "Pay rent", 1);
		const render = () => renderTasksSection({ db: f.db, timezone: TIMEZONE });
		expect(render()).not.toMatch(/Reminders already sent/);

		f.advance(MINUTE);
		await waitFor(async () => (await reminderEntries(f)).length === 1, "the reminder card");

		expect(render()).toContain("Reminders already sent to the owner for tasks that are still open");
		expect(render()).toContain(`- ${id} “Pay rent”, reminder was set for Sun 25 Oct 2026, 14:01`);
		// Snoozing makes it a reminder that is yet to come; finishing the task removes it: neither is "sent" any more.
		f.faux.setResponses([toolCall("snooze_reminder", { task_id: id, minutes: 10 }, "snooze-1"), say("Ok.")]);
		await f.say("snooze it");
		expect(render()).not.toMatch(/Reminders already sent/);
	});

	it("still fires after the process was restarted while it slept", async () => {
		const f = await open();
		const id = await addReminder(f, "Call the bank", 10);
		const restarted = await f.restart();
		fixtures.push(restarted);

		expect(await reminderEntries(restarted)).toHaveLength(0);
		restarted.advance(10 * MINUTE);
		await waitFor(async () => (await reminderEntries(restarted)).length === 1, "the reminder card after the restart");
		await waitFor(() => restarted.pushes.length === 1, "the push after the restart");

		expect(taskStore.requireTask(restarted.db, id).remindedAt).toBeDefined();
	});

	it("fires at once when the process was down past its time, and only once however often it restarts", async () => {
		const f = await open();
		await addReminder(f, "Submit the form", 5);
		await f.close();
		f.clock.now += 3 * 60 * MINUTE;

		const first = await open({ dir: f.dir, clock: f.clock });
		await waitFor(async () => (await reminderEntries(first)).length === 1, "the late reminder");
		const second = await first.restart();
		fixtures.push(second);
		await settle();

		expect(await reminderEntries(second)).toHaveLength(1);
		expect(first.pushes.length + second.pushes.length).toBe(1);
	});

	it("is posted once even when the process dies between writing the card and recording that it did", async () => {
		let hang: ((error: Error) => void) | undefined;
		let writes = 0;
		const wrapPost: NonNullable<Parameters<typeof openFixture>[0]>["wrapPost"] =
			(post) => async (conversationId, entry) => {
				const result = await post(conversationId, entry);
				if (entry.kind === REMINDER_ENTRY_KIND && writes++ === 0) {
					// The card is in the transcript; the task has not yet recorded that or moved on. This is the crash window.
					await new Promise<never>((_resolve, reject) => {
						hang = reject;
					});
				}
				return result;
			};
		const f = await open({ wrapPost });
		await addReminder(f, "Take medicine", 1);
		f.advance(MINUTE);
		await waitFor(
			async () => (await reminderEntries(f)).length === 1 && hang !== undefined,
			"the write before the crash",
		);

		// Stop the process while the phase is stuck: Durable counts it as cut off, not as failed.
		const closing = f.harness.close(ctx);
		hang?.(new Error("process died"));
		await closing;
		f.db.close();

		const again = await open({ dir: f.dir, clock: f.clock, wrapPost });
		await waitFor(() => again.pushes.length === 1, "the push after recovery");
		await settle();

		expect(writes).toBe(2); // the rerun asked again…
		expect(await reminderEntries(again)).toHaveLength(1); // …and the same request id found the same entry
		expect(f.pushes).toHaveLength(0); // the first run never got as far as the push
		const [task] = await reminderTasks(again);
		expect(task?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "completed", result: { fired: true } },
		});
	});

	it("is posted again when Durable's database comes back older than app.sqlite, which remembers it was sent (power cut)", async () => {
		const f = await open();
		const id = await addReminder(f, "Take medicine", 5);
		await f.close();
		const snapshot = join(f.dir, "snapshot");
		await snapshotDurable(f.dir, snapshot); // the last sync point of durable.sqlite: the timer exists and sleeps

		const sent = await open({ dir: f.dir, clock: f.clock });
		sent.advance(5 * MINUTE);
		await waitFor(async () => (await reminderEntries(sent)).length === 1 && sent.pushes.length === 1, "the reminder");
		const remindedAt = taskStore.requireTask(sent.db, id).remindedAt;
		expect(remindedAt).toBeDefined();
		await sent.close();

		// The power cut: durable.sqlite is as it was at its last sync point, app.sqlite kept its fully synced commits.
		await restoreDurable(snapshot, f.dir);
		const rewound = await open({ dir: f.dir, clock: f.clock });
		await waitFor(async () => (await reminderEntries(rewound)).length === 1, "the card to be posted again");
		await waitFor(() => rewound.pushes.length === 1, "the push to be sent again");

		const [task] = await reminderTasks(rewound);
		expect(task?.state).toMatchObject({ outcome: { status: "completed", result: { fired: true } } });
		expect(taskStore.requireTask(rewound.db, id).remindedAt).toBe(remindedAt); // the first time is kept
	});

	it("does not fault the task when the push fails: the card is already in the thread", async () => {
		const f = await open({ failPush: () => true });
		await addReminder(f, "Stretch", 1);

		f.advance(MINUTE);
		await waitFor(async () => (await reminderTasks(f))[0]?.state.status === "terminal", "the task to finish");

		const [task] = await reminderTasks(f);
		expect(task?.state).toMatchObject({ outcome: { status: "completed", result: { fired: true } } });
		expect(await reminderEntries(f)).toHaveLength(1);
		expect(f.reports.some(({ info }) => info.type === "task_error")).toBe(true);
	});
});

describe("changing a reminder", () => {
	it("snoozing replaces the reminder: the old time passes quietly and the new one fires", async () => {
		const f = await open();
		const id = await addReminder(f, "Review PR", 5);
		const [oldTimer] = await reminderTasks(f);
		f.faux.setResponses([toolCall("snooze_reminder", { task_id: id, minutes: 30 }, "snooze-1"), say("Snoozed.")]);
		await f.say("snooze it half an hour");

		f.advance(5 * MINUTE);
		await settle();
		expect(await reminderEntries(f)).toHaveLength(0);
		expect(f.pushes).toHaveLength(0);
		await waitFor(
			async () => (await reminderTasks(f)).find((task) => task.id === oldTimer?.id)?.state.status === "terminal",
			"the old timer to be cancelled",
		);

		f.advance(30 * MINUTE);
		await waitFor(async () => (await reminderEntries(f)).length === 1, "the snoozed reminder");
		expect(f.pushes).toHaveLength(1);
	});

	it("snoozing after it fired schedules it again", async () => {
		const f = await open();
		const id = await addReminder(f, "Stand up", 1);
		f.advance(MINUTE);
		await waitFor(async () => (await reminderEntries(f)).length === 1, "the first reminder");

		f.faux.setResponses([toolCall("snooze_reminder", { task_id: id, minutes: 10 }, "snooze-2"), say("Ok.")]);
		await f.say("snooze it 10 minutes");
		expect(taskStore.requireTask(f.db, id).remindedAt).toBeUndefined();
		f.advance(10 * MINUTE);

		await waitFor(async () => (await reminderEntries(f)).length === 2, "the second reminder");
		await waitFor(() => f.pushes.length === 2, "the second push");
	});

	it("completing the task cancels its reminder", async () => {
		const f = await open();
		const id = await addReminder(f, "Book flights", 5);
		f.faux.setResponses([toolCall("complete_task", { task_id: id }, "done-1"), say("Done.")]);
		await f.say("done with that");

		f.advance(5 * MINUTE);
		await settle();

		expect(await reminderEntries(f)).toHaveLength(0);
		expect(f.pushes).toHaveLength(0);
		const [task] = await reminderTasks(f);
		expect(task?.state).toMatchObject({ status: "terminal" });
	});

	it("clearing the reminder with update_task cancels it, and a new time replaces it", async () => {
		const f = await open();
		const id = await addReminder(f, "Send invoice", 5);
		f.faux.setResponses([toolCall("update_task", { task_id: id, remind_at: null }, "clear-1"), say("Cleared.")]);
		await f.say("never mind the reminder");
		f.advance(5 * MINUTE);
		await settle();
		expect(await reminderEntries(f)).toHaveLength(0);
		expect(taskStore.requireTask(f.db, id).remindAt).toBeUndefined();

		f.faux.setResponses([toolCall("update_task", { task_id: id, remind_in_minutes: 2 }, "again-1"), say("Set.")]);
		await f.say("remind me in two minutes after all");
		f.advance(2 * MINUTE);
		await waitFor(async () => (await reminderEntries(f)).length === 1, "the new reminder");
	});

	it("a timer that was never aborted (rescheduled while the process was down) ends itself without posting", async () => {
		const f = await open();
		const id = await addReminder(f, "Water the garden", 5);
		// Change the row behind Durable's back, as a crash between the database write and the abort would leave it.
		taskStore.applyChange(f.db, id, { remindAt: f.clock.now + 60 * MINUTE }, "manual-1", "update_task", f.clock.now);

		f.advance(5 * MINUTE);
		await waitFor(async () => (await reminderTasks(f))[0]?.state.status === "terminal", "the stale timer to end");

		const [task] = await reminderTasks(f);
		expect(task?.state).toMatchObject({
			outcome: { status: "completed", result: { fired: false, reason: "superseded" } },
		});
		expect(await reminderEntries(f)).toHaveLength(0);
	});
});

describe("startup repair (reconcile)", () => {
	const scheduler = (f: Fixture) => tasksModule.scheduler(f.deps);

	it("creates the timer a power cut took from Durable's database, so the reminder is not lost", async () => {
		const f = await open();
		const id = await addReminder(f, "Renew passport", 5);
		const [lost] = await reminderTasks(f);
		// Durable's database syncs less often than app.sqlite: simulate it forgetting the timer.
		await f.harness.abortTask(lost?.id as never, ctx);
		await waitFor(async () => (await reminderTasks(f))[0]?.state.status === "terminal", "the timer to end");

		const report = await scheduler(f).reconcile();

		expect(report).toStrictEqual({ rescheduled: [id], failures: [] });
		f.advance(5 * MINUTE);
		await waitFor(async () => (await reminderEntries(f)).length === 1, "the reminder from the new timer");
	});

	it("replaces a timer that Durable faulted, without a restart: the row must not keep pointing at a dead task", async () => {
		let failures = 1;
		const wrapPost: NonNullable<Parameters<typeof openFixture>[0]>["wrapPost"] =
			(post) => async (conversationId, entry) => {
				if (entry.kind === REMINDER_ENTRY_KIND && failures-- > 0) throw new Error("transient failure while posting");
				return await post(conversationId, entry);
			};
		const f = await open({ wrapPost });
		const id = await addReminder(f, "Pay rent", 5);
		const deadTimer = taskStore.requireTask(f.db, id).durableTaskId;

		f.advance(5 * MINUTE);
		await waitFor(() => f.reports.some(({ info }) => info.type === "task_faulted"), "the timer to fault");
		f.advance(60 * MINUTE);
		await settle();
		expect(await reminderEntries(f)).toHaveLength(0);
		expect(taskStore.requireTask(f.db, id).durableTaskId).toBe(deadTimer); // the row still points at the dead task

		const report = await scheduler(f).reconcile();
		f.harness.resume();

		expect(report).toStrictEqual({ rescheduled: [id], failures: [] });
		await waitFor(async () => (await reminderEntries(f)).length === 1, "the reminder from the replacement timer");
		await waitFor(() => f.pushes.length === 1, "its push");
		expect(taskStore.requireTask(f.db, id).remindedAt).toBeDefined();
	});

	it("reports a task whose conversation Durable does not have, and still repairs the others", async () => {
		const f = await open();
		const healthy = await addReminder(f, "Healthy", 20);
		const [lost] = await reminderTasks(f);
		await f.harness.abortTask(lost?.id as never, ctx); // the healthy one lost its timer too, and is after the orphan
		await waitFor(async () => (await reminderTasks(f))[0]?.state.status === "terminal", "the timer to end");
		// What `DELETE FROM agents` leaves behind: a row for a conversation that is no longer in durable.sqlite.
		const orphan = taskStore.insertTask(
			f.db,
			{
				title: "Orphan",
				notes: "",
				dueAllDay: false,
				remindAt: f.clock.now + 10 * MINUTE,
				conversationId: 999,
				createdAt: f.clock.now,
			},
			"orphan-call",
		).row;

		const report = await scheduler(f).reconcile();

		expect(report.rescheduled).toStrictEqual([healthy]);
		expect(report.failures).toStrictEqual([
			{
				itemId: orphan.id,
				conversationId: 999,
				message: expect.stringMatching(/conversation 999, which durable\.sqlite does not have/),
			},
		]);
	});

	it("re-links a timer the row lost track of, instead of making a second one that would fire twice", async () => {
		const f = await open();
		const id = await addReminder(f, "Collect parcel", 5);
		f.db.run("UPDATE tasks_item SET durable_task_id = NULL WHERE id = ?", id);

		const report = await scheduler(f).reconcile();

		expect(report).toStrictEqual({ rescheduled: [], failures: [] });
		expect(taskStore.requireTask(f.db, id).durableTaskId).toBeTypeOf("number");
		expect((await reminderTasks(f)).filter((task) => task.state.status !== "terminal")).toHaveLength(1);
		f.advance(5 * MINUTE);
		await waitFor(async () => (await reminderEntries(f)).length === 1, "the reminder");
		await settle();
		expect(await reminderEntries(f)).toHaveLength(1);
	});

	it("leaves a healthy reminder alone", async () => {
		const f = await open();
		await addReminder(f, "Order cake", 5);

		expect(await scheduler(f).reconcile()).toStrictEqual({ rescheduled: [], failures: [] });
		expect(await reminderTasks(f)).toHaveLength(1);
	});
});
