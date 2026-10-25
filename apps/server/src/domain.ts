import type { AppDb, Migration } from "@assistant/db";
import {
	type ApprovalService,
	approvalsModule,
	closingYesWindow,
	closingYesWindowOnAsk,
	collectMigrations,
	createApprovalService,
	createEntryPoster,
	createInputSubmitter,
	type DailyFactsProvider,
	type DailyService,
	type DailyStart,
	type DomainDeps,
	type DomainModule,
	dailyModule,
	type FilesDeps,
	filesModule,
	followupsModule,
	peopleModule,
	type ReconcileReport,
	type RecoveryReport,
	type ScheduleSettings,
	tasksModule,
} from "@assistant/extensions";
import type { PushPayload } from "@assistant/shared";
import type { Extension, Harness } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";

/**
 * The feature modules of the assistant (PLAN §5.2) and what it takes to run them: their migrations, their extensions,
 * the one approval service they share, and the repair they do at start. Everything a module needs from the server comes
 * in through {@link DomainDeps}, so a module never imports server code.
 */
export type Domain = {
	/** Every module's migrations, in module order; the server adds them to the core ones. */
	migrations: Migration[];
	/** Every extension, for the Harness's registry: tasks resolve by name for any conversation, whoever selects them. */
	extensions: Extension[];
	/**
	 * What the PA selects: its tools, prompt sections and hooks, and `tool_search`, how it finds the tools the modules mark
	 * `deferred` (the rarely used ones, which would otherwise ride along in every request). Other agents get none of them.
	 */
	paExtensions: Extension[];
	approvals: ApprovalService;
	/** The morning briefing and the evening wrap-up: their times and whether they run. */
	daily: DailyService;
	/** Hand over the open Harness. Until then anything that needs one throws, which only a bug can trigger. */
	bind(harness: Harness): void;
	/** Start-up repair of what a crash or a power cut can leave inconsistent between the two databases. */
	repair(): Promise<RepairReport>;
	/**
	 * The same kind of repair, for a server that has been running for a while: a timer that Durable ended (faulted) or
	 * lost leaves a reminder, a meeting or a birthday waiting for the next start otherwise. Cheap, and safe to run while
	 * the server works: it touches only requests past their deadline and rows that want a timer and have none.
	 */
	sweep(): Promise<SweepReport>;
};

export type RepairReport = {
	reminders: ReconcileReport;
	followups: ReconcileReport;
	birthdays: ReconcileReport;
	/** The daily jobs: today's runs written again if a power cut took them, and their timers. */
	daily: { recovery: DailyStart; timers: ReconcileReport };
	approvals: RecoveryReport;
};

export type SweepReport = {
	/** Requests closed because their 24 hours were up. */
	expiredApprovals: number;
	reminders: ReconcileReport;
	followups: ReconcileReport;
	birthdays: ReconcileReport;
	daily: ReconcileReport;
};

export type DomainOptions = {
	db: AppDb;
	timezone: string;
	/** The Harness clock. */
	now: () => number;
	notify: (payload: PushPayload) => Promise<unknown>;
	/** When follow-ups and birthdays fire (`ASSISTANT_AGENDA_LEAD_MINUTES` and friends). Omitted: the defaults. */
	schedule?: Partial<ScheduleSettings>;
	/** The folders the PA may read and the image processor, for the file tools. */
	files?: FilesDeps;
};

/** The modules in the order their migrations and extensions are installed. */
export const MODULES: readonly DomainModule[] = [
	tasksModule,
	followupsModule,
	peopleModule,
	approvalsModule,
	dailyModule,
	filesModule,
];

export function createDomain(options: DomainOptions): Domain {
	let harness: Harness | undefined;
	const getHarness = (): Harness => {
		if (harness === undefined) throw new Error("A domain module used the Harness before it was opened.");
		return harness;
	};
	const plainPost = createEntryPoster(getHarness);
	// The approval service writes its own outcome notices with the plain poster; the modules' cards close the YES window,
	// and so do the questions a module asks the model by itself (the briefing, the wrap-up).
	const approvals = createApprovalService({ db: options.db, now: options.now, post: plainPost });
	// What every module can say for the daily jobs. The modules need `deps` to build their providers, and the jobs read
	// them only when they run, so the list is filled in right after `deps` exists.
	let providers: readonly DailyFactsProvider[] = [];
	const deps: DomainDeps = {
		db: options.db,
		timezone: options.timezone,
		now: options.now,
		harness: getHarness,
		post: closingYesWindow(plainPost, approvals),
		ask: closingYesWindowOnAsk(createInputSubmitter(getHarness), approvals),
		facts: () => providers,
		notify: async (payload) => void (await options.notify(payload)),
		approvals,
		...(options.schedule === undefined ? {} : { schedule: options.schedule }),
		...(options.files === undefined ? {} : { files: options.files }),
	};
	for (const module of MODULES) for (const action of module.actions?.(deps) ?? []) approvals.register(action);
	providers = MODULES.flatMap((module) => module.facts?.(deps) ?? []);

	const tasks = tasksModule.extension(deps);
	const followups = followupsModule.extension(deps);
	const people = peopleModule.extension(deps);
	const daily = dailyModule.extension(deps);
	const files = filesModule.extension(deps);
	const guard = approvalsModule.extension(deps);
	const toolSearch = createToolSearchExtension();
	return {
		migrations: collectMigrations(MODULES),
		extensions: [tasks, followups, people, daily, files, guard, toolSearch],
		paExtensions: [tasks, followups, people, daily, files, guard, toolSearch],
		approvals,
		daily: dailyModule.service(deps),
		bind: (open) => {
			harness = open;
		},
		repair: async () => {
			// Cards first: they are what the thread should already have, before any timer posts a new one.
			const lostCards = await peopleModule.recover(deps);
			const birthdays = await peopleModule.scheduler(deps).reconcile();
			for (const failure of lostCards.failures) {
				// A person whose conversation is gone fails both repairs for the same reason: say it once.
				if (!birthdays.failures.some((known) => known.itemId === failure.itemId)) birthdays.failures.push(failure);
			}
			return {
				reminders: await tasksModule.scheduler(deps).reconcile(),
				followups: await followupsModule.scheduler(deps).reconcile(),
				birthdays,
				// Rows first, then what a power cut took, then the timers: a timer must not post a run the recovery is about to.
				daily: { recovery: await dailyModule.start(deps), timers: await dailyModule.scheduler(deps).reconcile() },
				approvals: await approvals.recover(),
			};
		},
		sweep: async () => ({
			expiredApprovals: approvals.expire(),
			reminders: await tasksModule.scheduler(deps).reconcile(),
			followups: await followupsModule.scheduler(deps).reconcile(),
			birthdays: await peopleModule.scheduler(deps).reconcile(),
			daily: await dailyModule.scheduler(deps).reconcile(),
		}),
	};
}
