import type { AppDb, Migration } from "@assistant/db";
import {
	type ApprovalService,
	approvalsModule,
	collectMigrations,
	createApprovalService,
	createEntryPoster,
	type DomainDeps,
	type DomainModule,
	type ReconcileReport,
	type RecoveryReport,
	tasksModule,
} from "@assistant/extensions";
import type { PushPayload } from "@assistant/shared";
import type { Extension, Harness } from "@earendil-works/pi-durable";

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
	/** What the PA selects: its tools, prompt sections and hooks. Other agents get none of them. */
	paExtensions: Extension[];
	approvals: ApprovalService;
	/** Hand over the open Harness. Until then anything that needs one throws, which only a bug can trigger. */
	bind(harness: Harness): void;
	/** Start-up repair of what a crash or a power cut can leave inconsistent between the two databases. */
	repair(): Promise<RepairReport>;
	/**
	 * The same kind of repair, for a server that has been running for a while: a reminder timer that Durable ended
	 * (faulted) or lost leaves the reminder waiting for the next start otherwise. Cheap, and safe to run while the server
	 * works: it touches only requests past their deadline and reminders that want a timer and have none.
	 */
	sweep(): Promise<SweepReport>;
};

export type RepairReport = {
	reminders: ReconcileReport;
	approvals: RecoveryReport;
};

export type SweepReport = {
	/** Requests closed because their 24 hours were up. */
	expiredApprovals: number;
	reminders: ReconcileReport;
};

export type DomainOptions = {
	db: AppDb;
	timezone: string;
	/** The Harness clock. */
	now: () => number;
	notify: (payload: PushPayload) => Promise<unknown>;
};

/** The modules in the order their migrations and extensions are installed. */
export const MODULES: readonly DomainModule[] = [tasksModule, approvalsModule];

export function createDomain(options: DomainOptions): Domain {
	let harness: Harness | undefined;
	const getHarness = (): Harness => {
		if (harness === undefined) throw new Error("A domain module used the Harness before it was opened.");
		return harness;
	};
	const post = createEntryPoster(getHarness);
	const approvals = createApprovalService({ db: options.db, now: options.now, post });
	const deps: DomainDeps = {
		db: options.db,
		timezone: options.timezone,
		now: options.now,
		harness: getHarness,
		post,
		notify: async (payload) => void (await options.notify(payload)),
		approvals,
	};
	for (const module of MODULES) for (const action of module.actions?.(deps) ?? []) approvals.register(action);

	const tasks = tasksModule.extension(deps);
	const guard = approvalsModule.extension(deps);
	return {
		migrations: collectMigrations(MODULES),
		extensions: [tasks, guard],
		paExtensions: [tasks, guard],
		approvals,
		bind: (open) => {
			harness = open;
		},
		repair: async () => ({
			reminders: await tasksModule.scheduler(deps).reconcile(),
			approvals: await approvals.recover(),
		}),
		sweep: async () => ({
			expiredApprovals: approvals.expire(),
			reminders: await tasksModule.scheduler(deps).reconcile(),
		}),
	};
}
