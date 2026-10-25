import type { PushPayload } from "@assistant/shared";
import type { Context } from "@earendil-works/chord";
import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { DomainDeps } from "../module.ts";
import { scheduleOf } from "../schedule.ts";
import type { TimerScheduler } from "../timers.ts";
import { isDayOver, isTooLateToAsk, nextCycle, occurrenceDate, startCycle } from "./birthdays.ts";
import { birthdayCard } from "./cards.ts";
import * as store from "./store.ts";

/** Durable task kind of a person's yearly birthday timer. Stored in task records, so renaming it orphans timers that are waiting. */
export const BIRTHDAY_TASK_NAME = "app.birthday";

/** Where a tap on these notifications goes: people belong to the PA, whose thread is `/chat/pa`. */
export const BIRTHDAY_URL = "/chat/pa";

/** What the phone shows. Minimal on purpose: a push passes through Google's or Apple's servers, so no names. */
export const BIRTHDAY_PUSH: PushPayload = {
	title: "Birthday",
	body: "1 birthday today",
	url: BIRTHDAY_URL,
	tag: "birthday",
};
export const BIRTHDAY_CHECK_PUSH: PushPayload = {
	title: "Birthday",
	body: "1 question: did you wish them?",
	url: BIRTHDAY_URL,
	tag: "birthday",
};

export type BirthdayInput = {
	/** The `people_person` row whose birthday this watches. */
	personId: string;
	/** The row's `gen` when this task was created. The task acts only while the row still has this one. */
	gen: number;
};

export type BirthdayState =
	| { phase: "remind_wait" }
	| { phase: "remind" }
	| { phase: "check_wait" }
	| { phase: "check" };

/** The year's cycle finished (and whether the owner was asked), or why the timer ended without finishing it. */
export type BirthdayResult = { done: true; year: number; asked: boolean } | { done: false; reason: "superseded" };

type BirthdayDeps = Pick<DomainDeps, "db" | "timezone" | "post" | "notify" | "schedule">;
type Runtime = TaskRuntime<BirthdayInput, BirthdayState, BirthdayResult, object>;

/**
 * One person's birthday, year after year (PLAN §5.4): wake in the morning to post the reminder, wake in the evening to
 * ask whether the owner wished them well, then start the next year's timer. It costs no model tokens: both cards are
 * display-only writes, and the model learns what the evening question is about from the `people` prompt section.
 *
 * The task is a timer; `people_person` is the truth. The row holds the cycle that is waiting (its year, the two moments)
 * and the generation of the timer that serves it. Changing the birthday or deleting the person changes only the row, and
 * a task created for an older generation finds out when it wakes and ends without posting. Finishing a cycle also changes
 * only the row first (the next year's cycle, a new generation); the successor timer is then created, and if that fails
 * the periodic repair creates it, because a person always wants one. Nothing has to be atomic across the two databases.
 *
 * A phase reruns from its top after a crash, so each effect tolerates that: the cards use a `requestId` made of the person
 * and the day (see `birthdayCard`), so a rerun finds the entry already there instead of posting another, and a push is at
 * least once (one tag, so the phone replaces a duplicate banner). The one effect no rerun can repair is a card that Durable's
 * database lost after the cycle ended; `recoverCards` posts those again at start.
 */
export function createBirthdayTask(deps: BirthdayDeps, scheduler: () => TimerScheduler | undefined) {
	const { db, timezone } = deps;
	const settings = scheduleOf(deps);
	const times = { remind: settings.birthdayRemindTime, check: settings.birthdayCheckTime };

	/** The row this task still serves, or undefined after it ended itself as superseded. */
	async function current(
		task: { input: BirthdayInput },
		runtime: Runtime,
		context: Context,
	): Promise<store.PersonRow | undefined> {
		const row = store.getPerson(db, task.input.personId);
		if (store.isCurrent(row, task.input)) return row;
		await finish(runtime, { done: false, reason: "superseded" }, context);
		return undefined;
	}

	async function push(runtime: Runtime, payload: PushPayload): Promise<void> {
		try {
			await deps.notify(payload);
		} catch (error) {
			// The card is already in the thread; a failed push is reported, never a reason to fault the task.
			runtime.report(error);
		}
	}

	return defineTask<BirthdayInput, BirthdayState, BirthdayResult>({
		name: BIRTHDAY_TASK_NAME,
		version: 1,
		initial: () => ({ phase: "remind_wait" }),
		phases: {
			remind_wait: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				// No reminder when the cycle began after its moment: someone added today, at noon, knows it is their birthday.
				if (row.remindAt === undefined) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "check_wait" } }), context);
					return;
				}
				await runtime.sleepUntil(row.remindAt, { phase: "remind" }, context);
			},

			remind: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				const now = runtime.now();
				const date = occurrenceDate(row.birthdayMd, row.cycleYear);
				// Late beats never, but only within the day: a reminder to wish someone well tomorrow is no use. Nor is one for
				// a birthday the owner has already said they wished.
				if (store.wishOf(db, row.id, row.cycleYear) !== true && !isDayOver(date, now, timezone)) {
					await deps.post(runtime.conversationId, birthdayCard(row, "remind", row.cycleYear, now, timezone));
					store.markReminded(db, row.id, task.input.gen, row.cycleYear, now);
					await push(runtime, BIRTHDAY_PUSH);
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "check_wait" } }), context);
			},

			check_wait: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				await runtime.sleepUntil(row.checkAt, { phase: "check" }, context);
			},

			check: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				const now = runtime.now();
				const year = row.cycleYear;
				// "Wished" ends the day's business. A recorded "not yet" does not: it is exactly what the evening question is for.
				// Nor is a birthday that is long past worth a question (a server that was off for days).
				const asked =
					store.wishOf(db, row.id, year) !== true &&
					!isTooLateToAsk(occurrenceDate(row.birthdayMd, year), now, timezone);
				if (asked) {
					await deps.post(runtime.conversationId, birthdayCard(row, "check", year, now, timezone));
					store.markAsked(db, row.id, task.input.gen, year, now);
					await push(runtime, BIRTHDAY_CHECK_PUSH);
				}
				await startNextYear(row, task.input.gen, runtime, now);
				await finish(runtime, { done: true, year, asked }, context);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	/** Next year's cycle goes into the row first; then its timer is created. A failure is left to the periodic repair. */
	async function startNextYear(row: store.PersonRow, gen: number, runtime: Runtime, now: number): Promise<void> {
		const next = startCycle(nextCycle(row.birthdayMd, now, timezone, times, row.cycleYear), now);
		if (!store.advanceCycle(db, row.id, gen, next, now)) return;
		try {
			await scheduler()?.ensureScheduled(row.id);
		} catch (error) {
			runtime.report(error);
		}
	}
}

export type BirthdayTask = ReturnType<typeof createBirthdayTask>;

function finish(runtime: Runtime, result: BirthdayResult, context: Context): Promise<void> {
	return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
}
