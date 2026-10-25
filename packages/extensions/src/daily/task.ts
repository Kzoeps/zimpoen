import type { PushPayload } from "@assistant/shared";
import type { Context } from "@earendil-works/chord";
import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { DomainDeps } from "../module.ts";
import type { TimerScheduler } from "../timers.ts";
import type { DailyFactsProvider } from "./facts.ts";
import { type DailyJob, jobOf } from "./jobs.ts";
import { nextOccurrence, occurrenceOn } from "./occurrence.ts";
import { buildPlan, type DailyPlan, deliver } from "./run.ts";
import * as store from "./store.ts";

/** Durable task kind of a daily job's timer. Stored in task records, so renaming it orphans timers that are waiting. */
export const DAILY_TASK_NAME = "app.daily";

export type DailyInput = {
	/** The `schedule_daily` row this timer serves: `briefing` or `wrapup`. */
	job: string;
	/** The row's `gen` when this task was created. The task acts only while the row still has this one. */
	gen: number;
};

export type DailyState = { phase: "wait" } | { phase: "run" };

/** What the run was, or why the timer ended without one. */
export type DailyResult =
	| { done: true; date: string; late: boolean; asked: boolean }
	| { done: false; reason: "superseded" }
	/** The server was not there in time, and the run's window was over when it came back: the day is skipped. */
	| { done: false; reason: "missed"; date: string };

type DailyTaskDeps = Pick<DomainDeps, "db" | "timezone" | "post" | "ask" | "notify">;
type Runtime = TaskRuntime<DailyInput, DailyState, DailyResult, object>;

/** The conversation a job writes into, or undefined when its agent has no conversation yet. */
export type ConversationOf = (job: DailyJob) => number | undefined;

/**
 * One daily job, day after day (PLAN §5.4): sleep until the job's time, gather the day's facts, put them to the PA (or
 * post a card when there is nothing to say), push, then start the next day's timer.
 *
 * The task is a timer; `schedule_daily` is the truth. The row holds the run that is waiting (its day and instant) and
 * the generation of the timer that serves it. Changing the time, or switching the job off, changes only the row, and a
 * timer of an older generation finds out when it wakes and ends without doing anything. Finishing a run also changes
 * the row first (the next run, a new generation, and the day marked as done), and only then is the successor timer
 * created; if that fails the periodic repair creates it, because a job that is on always wants one.
 *
 * A phase reruns from its top after a crash, so what it does is safe to do twice: the request or card has an id made of
 * the job and the day (it is written once), the facts are a durable memo (the first attempt's decision stands), and a
 * push is at least once (one tag, so a duplicate replaces the banner).
 */
export function createDailyTask(
	deps: DailyTaskDeps,
	providers: () => readonly DailyFactsProvider[],
	conversationOf: ConversationOf,
	scheduler: () => TimerScheduler | undefined,
) {
	const { db, timezone } = deps;

	/** The row this timer still serves, or undefined after it ended itself as superseded. */
	async function current(
		task: { input: DailyInput },
		runtime: Runtime,
		context: Context,
	): Promise<{ row: store.ScheduleRow; job: DailyJob } | undefined> {
		const row = store.getSchedule(db, task.input.job);
		const job = jobOf(task.input.job);
		if (store.isCurrent(row, task.input) && job !== undefined) return { row, job };
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

	/** The next run goes into the row first; then its timer is created. A failure is left to the periodic repair. */
	async function startNext(
		row: store.ScheduleRow,
		job: DailyJob,
		gen: number,
		runtime: Runtime,
		now: number,
		ran?: { date: string; at: number },
	): Promise<void> {
		const next = nextOccurrence({
			now,
			timezone,
			time: row.localTime,
			lateMinutes: job.lateMinutes,
			lastRunDate: ran?.date ?? row.lastRunDate,
		});
		if (!store.advance(db, row.job, gen, { next, ...(ran === undefined ? {} : { ran }), now })) return;
		try {
			await scheduler()?.ensureScheduled(row.job);
		} catch (error) {
			runtime.report(error);
		}
	}

	return defineTask<DailyInput, DailyState, DailyResult>({
		name: DAILY_TASK_NAME,
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				const live = await current(task, runtime, context);
				if (live === undefined) return;
				await runtime.sleepUntil(live.row.dueAt, { phase: "run" }, context);
			},

			run: async (task, runtime, context) => {
				const live = await current(task, runtime, context);
				if (live === undefined) return;
				const { row, job } = live;
				const now = runtime.now();
				const occurrence = occurrenceOn(row.dueDate, row.localTime, job.lateMinutes, timezone);

				// Past its window (the machine was off or asleep): the day is skipped, not made up.
				if (now > occurrence.deadline) {
					await startNext(row, job, task.input.gen, runtime, now);
					await finish(runtime, { done: false, reason: "missed", date: row.dueDate }, context);
					return;
				}

				const conversationId = conversationOf(job);
				if (conversationId === undefined) {
					throw new Error(
						`The ${job.label.toLowerCase()} has no conversation to post into: agent '${job.agent}' does not exist yet.`,
					);
				}
				// The first attempt's facts stand: a rerun after a crash must say what the first one decided to say.
				const candidate = buildPlan(
					job,
					row.dueDate,
					{ now, dueAt: row.dueAt, timezone },
					providers(),
					(provider, error) =>
						runtime.report(
							new Error(
								`Facts provider '${provider}' failed; its facts are left out of the ${job.label.toLowerCase()}.`,
								{ cause: error },
							),
						),
				);
				const plan = await runtime.memo<DailyPlan>(`plan:${row.dueDate}`, candidate, context);
				const { asked } = await deliver(deps, job, plan, { conversationId, date: row.dueDate, firedAt: row.dueAt });
				await push(runtime, job.push);
				await startNext(row, job, task.input.gen, runtime, now, { date: row.dueDate, at: now });
				await finish(runtime, { done: true, date: row.dueDate, late: plan.late, asked }, context);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

export type DailyTask = ReturnType<typeof createDailyTask>;

function finish(runtime: Runtime, result: DailyResult, context: Context): Promise<void> {
	return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
}
