import { getAgentRow } from "@assistant/db";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { conversationIdOf, type DomainDeps, type DomainModule } from "../module.ts";
import { addDays, localDate } from "../time.ts";
import type { TimerScheduler } from "../timers.ts";
import { type DailyFactsProvider, sectionOf } from "./facts.ts";
import { DAILY_JOBS, type DailyJob } from "./jobs.ts";
import { dailyMigrations } from "./migrations.ts";
import { buildPlan, dateText, deliver, endsWithDailyRequest } from "./run.ts";
import { createDailyScheduler } from "./scheduler.ts";
import { createDailyService, type DailyService } from "./service.ts";
import * as store from "./store.ts";
import { createDailyTask, type DailyTask } from "./task.ts";
import { createJournalTools } from "./tools.ts";

export const DAILY_EXTENSION_NAME = "daily";

/** How many days back the briefing looks for something carried over: Monday's brings forward Friday's, not only Sunday's. */
const CARRY_OVER_DAYS = 3;

/** How many days an unanswered wrap-up stays in the prompt section. */
const UNANSWERED_DAYS = 2;

type Deps = Pick<DomainDeps, "db" | "timezone" | "now">;

/**
 * The daily module's own facts for the morning briefing: what the owner said yesterday carries over. It is the one thing
 * the other modules cannot know, since it lives in the journal.
 */
export function createJournalFacts(deps: Deps): DailyFactsProvider {
	const { db, timezone } = deps;
	return {
		id: "journal",
		briefing: (day) => {
			const yesterday = addDays(day.date, -1);
			const row = store.latestCarryOver(db, addDays(day.date, -CARRY_OVER_DAYS), yesterday);
			if (row === undefined) return [];
			const when = row.date === yesterday ? "yesterday" : dateText(row.date, timezone);
			return sectionOf(`Carried over from ${when}`, row.carriedOver);
		},
	};
}

/**
 * The prompt section: the wrap-ups the owner has not answered yet. The request that asked is in the conversation, but a
 * compaction can drop it, and the owner may answer the next morning; this is how "I got the report done" finds the day
 * it is about. It reads the Harness clock for the local *date* only, so it renders the same bytes all day, and changes
 * when a wrap-up is asked or answered.
 */
export function renderJournalSection(deps: Deps): string | undefined {
	const today = localDate(deps.now(), deps.timezone);
	const open = store.unansweredWrapups(deps.db, addDays(today, -UNANSWERED_DAYS));
	if (open.length === 0) return undefined;
	return [
		"Evening wrap-ups the owner has not answered yet. When they say what they got done, call save_journal with that date:",
		...open.map((row) => `- ${row.date} (${dateText(row.date, deps.timezone)})`),
	].join("\n");
}

export type DailyModule = DomainModule & {
	/** The timer machinery, for the server's startup repair and for tests. */
	scheduler: (deps: DomainDeps) => TimerScheduler;
	/** The task definition. */
	dailyTask: (deps: DomainDeps) => DailyTask;
	/** The settings of the jobs: list and change. */
	service: (deps: DomainDeps) => DailyService;
	/**
	 * At start, before the repair of timers: give every job a row. Then post again what a power cut may have taken from
	 * Durable's database. See {@link recoverRuns}.
	 */
	start: (deps: DomainDeps) => Promise<DailyStart>;
};

/** Per-deps instances: the tools, the task, the scheduler and the service must share one task definition and one scheduler. */
const built = new WeakMap<DomainDeps, { task: DailyTask; scheduler: TimerScheduler; service: DailyService }>();

/** The conversation of the agent a job writes to, from `agents`. Undefined before `ensureAgents` has run. */
const conversationFor =
	(deps: Pick<DomainDeps, "db">) =>
	(job: DailyJob): number | undefined =>
		getAgentRow(deps.db, job.agent)?.conversationId;

function piecesFor(deps: DomainDeps): { task: DailyTask; scheduler: TimerScheduler; service: DailyService } {
	let pieces = built.get(deps);
	if (pieces === undefined) {
		// The task starts the next run's timer when this one is done, and the scheduler needs the task to create one:
		// the task gets the scheduler by name when it runs, which is after both exist.
		let scheduler: TimerScheduler | undefined;
		const task = createDailyTask(
			deps,
			() => deps.facts(),
			conversationFor(deps),
			() => scheduler,
		);
		scheduler = createDailyScheduler(deps, task, conversationFor(deps));
		const ready = scheduler;
		pieces = { task, scheduler, service: createDailyService(deps, () => ready) };
		built.set(deps, pieces);
	}
	return pieces;
}

/** What {@link recoverRuns} posted again. */
export type RunRecovery = {
	/** Jobs whose run of today was written again because Durable's database had lost it. Normally empty. */
	redelivered: string[];
	failures: Array<{ job: string; message: string }>;
};

/** What starting the daily jobs did. */
export type DailyStart = RunRecovery & {
	/**
	 * Jobs that got their first row at this start (a new data directory, or a job this version added). Their first timer is
	 * being set up, not repaired: the server's log must not say a power cut took it.
	 */
	created: string[];
};

/** The request ids a run of `job` on `date` can have: it asks the model, or (for a briefing with nothing to say) posts a card. */
const requestIdsOf = (job: DailyJob, date: string): string[] => [`${job.id}:${date}`, `${job.id}:${date}:empty`];

/** Whether Durable's database has a run of `job` on `date`, whichever of its two shapes it took (placed in the thread or still queued). */
async function hasRun(deps: DomainDeps, job: DailyJob, date: string, conversationId: number): Promise<boolean> {
	const harness = deps.harness();
	for (const requestId of requestIdsOf(job, date)) {
		// `Harness.submissionByRequest` is declared by Durable 1.4.0 but missing at runtime; the transaction has it.
		const found = await harness.commit(
			(tx) => tx.submissionByRequest(conversationIdOf(conversationId), requestId),
			BACKGROUND_CONTEXT,
		);
		if (found !== undefined) return true;
	}
	return false;
}

/**
 * A run is written to Durable's database (which can lose its last writes in a power cut) and recorded in `app.sqlite` (which
 * cannot): after a power cut the row can say that today's briefing ran while Durable has nothing of it. So at start, for a
 * job that ran today, Durable is asked whether it has the run under either of its two request ids. It has it: nothing was
 * lost, and nothing is done (the facts may have changed since, and a run is decided once: a restart at 10:00 must not turn
 * the 07:30 "nothing today" card into a model run, or a briefing into a second card). It does not: the run is written again
 * from today's facts as they are now, which is what a briefing read late should say anyway. No push: the owner was told
 * once, or never; a second banner for something old is noise.
 */
export async function recoverRuns(deps: DomainDeps): Promise<RunRecovery> {
	const report: RunRecovery = { redelivered: [], failures: [] };
	const today = localDate(deps.now(), deps.timezone);
	for (const row of store.listSchedules(deps.db)) {
		const job = DAILY_JOBS.find((known) => known.id === row.job);
		if (job === undefined || row.lastRunDate !== today || row.lastRunAt === undefined) continue;
		try {
			const conversationId = conversationFor(deps)(job);
			if (conversationId === undefined || (await hasRun(deps, job, today, conversationId))) continue;
			const now = deps.now();
			const plan = buildPlan(job, today, { now, dueAt: now, timezone: deps.timezone }, deps.facts(), () => {});
			await deliver(deps, job, plan, { conversationId, date: today, firedAt: row.lastRunAt });
			report.redelivered.push(job.id);
		} catch (error) {
			report.failures.push({ job: job.id, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return report;
}

export const dailyModule: DailyModule = {
	name: "daily",
	migrations: dailyMigrations,
	facts: (deps) => [createJournalFacts(deps)],
	scheduler: (deps) => piecesFor(deps).scheduler,
	dailyTask: (deps) => piecesFor(deps).task,
	service: (deps) => piecesFor(deps).service,
	start: async (deps) => {
		const created = piecesFor(deps).service.ensureRows();
		return { ...(await recoverRuns(deps)), created };
	},
	extension: (deps) => {
		const { task } = piecesFor(deps);
		return defineExtension({
			name: DAILY_EXTENSION_NAME,
			tools: createJournalTools(deps),
			sections: [section("journal", () => renderJournalSection(deps))],
			tasks: [task],
			hooks: [
				hook(GenerationTask, {
					// `ask` closes the YES window when it is *submitted*, but a request that waits behind a running answer is placed
					// when that run ends: a deletion proposed in the meantime is a request from after the window closed. Closing again
					// when the model starts reading the briefing (or the wrap-up) keeps a yes to its question from approving it.
					beforeRequest: (request, api) => {
						if (endsWithDailyRequest(request.messages)) deps.approvals.closeYesWindow(Number(api.conversationId));
						return undefined;
					},
				}),
			],
		});
	},
};

export type { DailyFactsProvider, DayWindow } from "./facts.ts";
export { collectFacts, dayWindow } from "./facts.ts";
export { BRIEFING_JOB, BRIEFING_PUSH, DAILY_JOBS, DAILY_URL, type DailyJob, WRAPUP_JOB, WRAPUP_PUSH } from "./jobs.ts";
export { nextOccurrence, occurrenceOn, TIME_OF_DAY } from "./occurrence.ts";
export { endsWithDailyRequest, renderRequest, renderSections } from "./run.ts";
export { type DailyService, InvalidDailyTime, UnknownDailyJob } from "./service.ts";
export * as dailyStore from "./store.ts";
export { DAILY_TASK_NAME, type DailyInput } from "./task.ts";
export { describeJournal, toJournalItem } from "./tools.ts";
