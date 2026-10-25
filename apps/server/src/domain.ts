import type { AppDb, Migration } from "@assistant/db";
import {
	type AccountantDeps,
	type ApprovalService,
	approvalsModule,
	type CodemodeLimits,
	closingYesWindow,
	closingYesWindowOnAsk,
	collectMigrations,
	createApprovalService,
	createBoundedCodemodeExtension,
	createEntryPoster,
	createInputSubmitter,
	type DailyFactsProvider,
	type DailyService,
	type DailyStart,
	DEFAULT_CODEMODE_LIMITS,
	type DelegateDeps,
	type DelegateService,
	type DomainDeps,
	type DomainModule,
	dailyModule,
	delegateModule,
	type FilesDeps,
	filesModule,
	followupsModule,
	type HealthDeps,
	healthModule,
	type InboxDeps,
	type InboxStart,
	inboxModule,
	invoicesModule,
	ledgerModule,
	memoryModule,
	peopleModule,
	type ReconcileReport,
	type RecoveryReport,
	type RefreshReport,
	type ScheduleSettings,
	splitsModule,
	tasksModule,
	type UsageService,
	usageModule,
} from "@assistant/extensions";
import type { GoogleSettingsResponse, PushPayload, SuggestionDecision, SuggestionState } from "@assistant/shared";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
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
	/**
	 * What the Health agent selects: its tools, prompt section and the approval hook that guards its deletions, and
	 * `tool_search` for the deletion tools it keeps out of its everyday list. The PA does not get the health tools.
	 */
	healthExtensions: Extension[];
	/**
	 * What the Accountant agent selects: the ledger, splits and invoices, the file tools it reads receipts and statements
	 * with, the approval hook, `tool_search` for its rarely used tools, and code mode, where it writes a script over the
	 * ledger's query tools instead of adding up in its head. The PA and the Health agent do not get them.
	 */
	accountantExtensions: Extension[];
	/**
	 * What the Inbox agent selects: its read-only tools (search, read, calendar, mark, propose a rule, suggest) and the account
	 * sync that lives in its conversation. No file tools (PLAN rule 6: it processes untrusted email text), no `ask_agent`, no
	 * approval hook (no tool it has needs one: a lasting rule is only asked for, and the server applies it when the owner taps
	 * Approve): the suggestion queue is its only way to the PA, and server code owns that.
	 */
	inboxExtensions: Extension[];
	/** The Inbox's accounts, as Settings shows and changes them, and the owner's answers to what it suggests. */
	inbox: InboxFacade;
	/** What the agents spent, sampled from Durable into days and weeks, and the weekly token limits the daily jobs obey (M8). */
	usage: UsageService;
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
	/** Release what the domain holds outside the databases: the code mode sandbox. Idempotent. */
	close(): Promise<void>;
};

/** What the HTTP API may ask of the Inbox module (nothing else of it is reachable from a request). */
export type InboxFacade = {
	settings(): Promise<GoogleSettingsResponse>;
	/** Forget an account's sign-in and stop its sync; its mail stays. False when there is no such account. */
	disconnect(email: string): Promise<boolean>;
	decideSuggestion(id: string, decision: SuggestionDecision): Promise<SuggestionState>;
};

export type RepairReport = {
	reminders: ReconcileReport;
	followups: ReconcileReport;
	birthdays: ReconcileReport;
	/** The daily jobs: today's runs written again if a power cut took them, and their timers. */
	daily: { recovery: DailyStart; timers: ReconcileReport };
	approvals: RecoveryReport;
	/** The accounts found in the saved sign-ins, the suggestions posted again, and the sync timers. */
	inbox: { start: InboxStart; timers: ReconcileReport };
	/** Answers that came while nobody waited for them, posted to the PA's thread. */
	delegate: Awaited<ReturnType<DelegateService["recover"]>>;
};

export type SweepReport = {
	/** Requests closed because their 24 hours were up. */
	expiredApprovals: number;
	reminders: ReconcileReport;
	followups: ReconcileReport;
	birthdays: ReconcileReport;
	daily: ReconcileReport;
	inbox: { accounts: RefreshReport; timers: ReconcileReport; suggestions: number };
	delegate: Awaited<ReturnType<DelegateService["recover"]>>;
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
	/** What the Health module is told about the owner: their height, for BMI. */
	health?: HealthDeps;
	/** What the Accountant's modules are told: the owner's currency and name, and where invoices are made. */
	accountant?: AccountantDeps;
	/** How long a code mode script may run. Default: {@link DEFAULT_CODEMODE_LIMITS}; tests shorten it. */
	codemodeLimits?: Partial<CodemodeLimits>;
	/** What the Inbox module reads Google through and how it classifies mail. */
	inbox?: InboxDeps;
	/** How long the PA's `ask_agent` waits for an answer; tests shorten it. */
	delegate?: DelegateDeps;
	/** Where a failure the work goes on without is said (the server's log). */
	warn?: (message: string) => void;
};

/**
 * What a code mode script may use: 256 MiB of memory, and 30 seconds unless it asks for more (at most two minutes: see
 * {@link DEFAULT_CODEMODE_LIMITS}). The sandbox is QuickJS in a worker thread; it has no network and no files. The time limit
 * is applied by the bounded code mode extension: the sandbox's own `timeoutMs` is not read for a script Durable can resume.
 */
const CODEMODE_MEMORY_BYTES = 256 * 1024 * 1024;

/** The modules in the order their migrations and extensions are installed. */
export const MODULES: readonly DomainModule[] = [
	tasksModule,
	followupsModule,
	peopleModule,
	approvalsModule,
	dailyModule,
	filesModule,
	healthModule,
	ledgerModule,
	splitsModule,
	invoicesModule,
	inboxModule,
	delegateModule,
	memoryModule,
	usageModule,
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
		...(options.health === undefined ? {} : { health: options.health }),
		...(options.accountant === undefined ? {} : { accountant: options.accountant }),
		...(options.inbox === undefined ? {} : { inbox: options.inbox }),
		...(options.delegate === undefined ? {} : { delegate: options.delegate }),
		...(options.warn === undefined ? {} : { warn: options.warn }),
		// The daily jobs ask this before they spend tokens; the module is built from `deps`, so it is looked up when asked.
		budget: { check: (agent) => usageModule.service(deps).check(agent) },
	};
	for (const module of MODULES) for (const action of module.actions?.(deps) ?? []) approvals.register(action);
	providers = MODULES.flatMap((module) => module.facts?.(deps) ?? []);

	const tasks = tasksModule.extension(deps);
	const followups = followupsModule.extension(deps);
	const people = peopleModule.extension(deps);
	const daily = dailyModule.extension(deps);
	const files = filesModule.extension(deps);
	const health = healthModule.extension(deps);
	const ledger = ledgerModule.extension(deps);
	const splits = splitsModule.extension(deps);
	const invoices = invoicesModule.extension(deps);
	const inbox = inboxModule.extension(deps);
	const delegate = delegateModule.extension(deps);
	// Every agent is told what is remembered; all but the Inbox may also remember and (with approval) forget. The Inbox reads
	// untrusted email text, and a line it wrote would be in a prompt for good, so it only reads (PLAN rule 6).
	const memory = memoryModule.extension(deps);
	const memoryRead = memoryModule.readOnlyExtension(deps);
	const usage = usageModule.service(deps);
	const guard = approvalsModule.extension(deps);
	const toolSearch = createToolSearchExtension();
	// `models: false` leaves out `models.classify()` and `models.generateImages()`: they are paid calls to a model provider,
	// and the Accountant sends nothing out (PLAN rule 1). A script calls the tools the Accountant itself has (its writes too,
	// each under the same approval hook), and nothing else: no network, no files, no model.
	const codemodeLimits: CodemodeLimits = { ...DEFAULT_CODEMODE_LIMITS, ...options.codemodeLimits };
	const sandbox = new CodemodeSandbox({
		memoryLimitBytes: CODEMODE_MEMORY_BYTES,
		timeoutMs: codemodeLimits.maxTimeoutMs,
	});
	const codemode = createBoundedCodemodeExtension({ sandbox, models: false, limits: codemodeLimits });
	/** A sign-in saved or lost while the server runs, the timers of the accounts, and suggestions that never reached the PA. */
	const sweepInbox = async (): Promise<SweepReport["inbox"]> => ({
		accounts: await inboxModule.accounts(deps).refresh(),
		timers: await inboxModule.scheduler(deps).reconcile(),
		suggestions: await inboxModule.suggestions(deps).deliver(),
	});

	return {
		migrations: collectMigrations(MODULES),
		extensions: [
			tasks,
			followups,
			people,
			daily,
			files,
			health,
			ledger,
			splits,
			invoices,
			inbox,
			delegate,
			memory,
			memoryRead,
			guard,
			toolSearch,
			codemode,
		],
		paExtensions: [tasks, followups, people, daily, files, delegate, guard, toolSearch, memory],
		healthExtensions: [health, guard, toolSearch, memory],
		accountantExtensions: [ledger, splits, invoices, files, guard, toolSearch, codemode, memory],
		inboxExtensions: [inbox, memoryRead],
		usage,
		inbox: {
			settings: () => inboxModule.accounts(deps).settings(),
			disconnect: (email) => inboxModule.accounts(deps).disconnect(email),
			decideSuggestion: (id, decision) => inboxModule.suggestions(deps).decide(id, decision),
		},
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
			const report: RepairReport = {
				reminders: await tasksModule.scheduler(deps).reconcile(),
				followups: await followupsModule.scheduler(deps).reconcile(),
				birthdays,
				// Rows first, then what a power cut took, then the timers: a timer must not post a run the recovery is about to.
				daily: { recovery: await dailyModule.start(deps), timers: await dailyModule.scheduler(deps).reconcile() },
				approvals: await approvals.recover(),
				// The accounts first (a sign-in saved while the server was off), then their timers.
				inbox: { start: await inboxModule.start(deps), timers: await inboxModule.scheduler(deps).reconcile() },
				delegate: await delegateModule.service(deps).recover(),
			};
			// Last, and before Durable runs anything: the first reading of an agent only copies its totals, so it must come
			// before the first run that can spend. A reading that fails skips that agent and says nothing: usage is not worth a start.
			await usage.sample();
			return report;
		},
		sweep: async () => {
			const report: SweepReport = {
				expiredApprovals: approvals.expire(),
				reminders: await tasksModule.scheduler(deps).reconcile(),
				followups: await followupsModule.scheduler(deps).reconcile(),
				birthdays: await peopleModule.scheduler(deps).reconcile(),
				daily: await dailyModule.scheduler(deps).reconcile(),
				inbox: await sweepInbox(),
				delegate: await delegateModule.service(deps).recover(),
			};
			// What was spent since the last reading is dated to the day it is read: every ten minutes keeps a day's edge sharp enough.
			await usage.sample();
			return report;
		},
		close: () => sandbox.close(),
	};
}
