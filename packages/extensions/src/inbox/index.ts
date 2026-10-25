import { defineExtension, section } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import type { TimerScheduler } from "../timers.ts";
import { type AccountService, createAccountService, type RefreshReport } from "./accounts.ts";
import { createInboxFacts } from "./facts.ts";
import { inboxMigrations } from "./migrations.ts";
import { createInboxScheduler } from "./scheduler.ts";
import * as store from "./store.ts";
import { createSuggestionService, type SuggestionService } from "./suggestions.ts";
import { createInboxSyncTask, type InboxSyncTask } from "./task.ts";
import { createInboxApprovalActions, createInboxTools } from "./tools.ts";

export const INBOX_EXTENSION_NAME = "inbox";

const STATUS_WORDS = {
	connected: "connected",
	needs_reconnect: "needs to be connected again",
	disconnected: "disconnected",
} as const;

/**
 * The prompt section of the Inbox agent: which accounts there are and how mail is classified. It holds no clock and no
 * counts that change with every sync, so it renders the same bytes until an account or the classifier changes.
 */
export function renderInboxSection(deps: Pick<DomainDeps, "db" | "inbox">): string {
	const accounts = store.listAccounts(deps.db);
	const triage =
		deps.inbox?.triage.mode === "jev"
			? "Mail is classified by Jev (TypeSafe)."
			: "Mail is classified by local rules (no Jev key is saved), which is cruder than Jev.";
	if (accounts.length === 0) {
		return [
			"No Google account is connected yet, so there is no mail or calendar to look at. The owner connects one with `pnpm connect:google` (docs/setup-google.md).",
			triage,
		].join("\n");
	}
	return [`Accounts: ${accounts.map((row) => `${row.email} (${STATUS_WORDS[row.status]})`).join(", ")}.`, triage].join(
		"\n",
	);
}

export type InboxStart = {
	accounts: RefreshReport;
	/** Suggestions whose card had never reached the PA's thread, posted now. */
	suggestions: number;
	failures: Array<{ what: string; message: string }>;
};

export type InboxModule = DomainModule & {
	/** The timers of the accounts' syncs, for the server's repair at start and every few minutes. */
	scheduler: (deps: DomainDeps) => TimerScheduler;
	/** The accounts as Settings shows them, and what happens when a sign-in changes. */
	accounts: (deps: DomainDeps) => AccountService;
	/** The queue from the Inbox agent to the PA. */
	suggestions: (deps: DomainDeps) => SuggestionService;
	/** The sync task definition. */
	syncTask: (deps: DomainDeps) => InboxSyncTask;
	/**
	 * At start, before the timers are repaired: give every saved sign-in its account row, and post the cards of suggestions
	 * that never reached the PA's thread. Each part that fails is reported and the others still run.
	 */
	start: (deps: DomainDeps) => Promise<InboxStart>;
};

type Pieces = {
	task: InboxSyncTask;
	scheduler: TimerScheduler;
	accounts: AccountService;
	suggestions: SuggestionService;
};

/** Per-deps instances: the tools, the task, the scheduler and the services must share one task definition and one scheduler. */
const built = new WeakMap<DomainDeps, Pieces>();

function piecesFor(deps: DomainDeps): Pieces {
	let pieces = built.get(deps);
	if (pieces === undefined) {
		// The task finishes by making the next timer, and the scheduler needs the task to make one: each gets the other
		// by name when it runs, which is after both exist.
		let scheduler: TimerScheduler | undefined;
		let accounts: AccountService | undefined;
		const task = createInboxSyncTask(
			deps,
			() => {
				if (accounts === undefined) throw new Error("The inbox accounts were used before they were built.");
				return accounts;
			},
			() => scheduler,
		);
		const timers = createInboxScheduler(deps, task);
		scheduler = timers;
		accounts = createAccountService(deps, deps.inbox, () => timers);
		pieces = { task, scheduler: timers, accounts, suggestions: createSuggestionService(deps) };
		built.set(deps, pieces);
	}
	return pieces;
}

export const inboxModule: InboxModule = {
	name: "inbox",
	migrations: inboxMigrations,
	actions: (deps) => createInboxApprovalActions(deps),
	facts: (deps) => [createInboxFacts(deps)],
	scheduler: (deps) => piecesFor(deps).scheduler,
	accounts: (deps) => piecesFor(deps).accounts,
	suggestions: (deps) => piecesFor(deps).suggestions,
	syncTask: (deps) => piecesFor(deps).task,
	start: async (deps) => {
		const { accounts, suggestions } = piecesFor(deps);
		const report: InboxStart = {
			accounts: { added: [], reconnected: [], revoked: [], disconnected: [] },
			suggestions: 0,
			failures: [],
		};
		const attempt = async <T>(what: string, run: () => Promise<T>): Promise<T | undefined> => {
			try {
				return await run();
			} catch (error) {
				report.failures.push({ what, message: error instanceof Error ? error.message : String(error) });
				return undefined;
			}
		};
		report.accounts = (await attempt("accounts", () => accounts.refresh())) ?? report.accounts;
		report.suggestions = (await attempt("suggestions", () => suggestions.deliver())) ?? 0;
		return report;
	},
	extension: (deps) => {
		const { task, suggestions } = piecesFor(deps);
		return defineExtension({
			name: INBOX_EXTENSION_NAME,
			tools: createInboxTools(deps, suggestions),
			sections: [section("inbox", () => renderInboxSection(deps))],
			tasks: [task],
		});
	},
};

export { type AccountService, type RefreshReport, reconnectText, syncSettingsOf } from "./accounts.ts";
export { MAX_DIGEST_ITEMS, MAX_DIGEST_LOOKBACK_MS, MAX_NEWS_AGE_MS } from "./facts.ts";
export { createFakeGoogle, type FakeGoogle, seedDemoMailbox } from "./fake.ts";
export { mailItem, mailLine } from "./format.ts";
export * as inboxStore from "./store.ts";
export { addRequestText, SuggestionConflict, SuggestionNotFound, type SuggestionService } from "./suggestions.ts";
export { isMailboxMessage, MAX_BODY_CHARS, type SyncRun, syncAccount } from "./sync.ts";
export { backoffMs, INBOX_SYNC_TASK_NAME, type InboxSyncInput, MORE_MAIL_DELAY_MS } from "./task.ts";
export { addressList, clip, parseAddress, safeLine, safeText } from "./text.ts";
export { READ_CHARS, resolveEventWindow } from "./tools.ts";
export {
	classifyByRules,
	classifyMail,
	createJevTriage,
	createRulesTriage,
	JEV_ENDPOINT,
	JEV_HOST,
	JEV_MODEL,
	JevAuthError,
	JevContractError,
	JevPausedError,
	JevUnavailableError,
	jevRequest,
	learnedCategory,
	parseJevResponse,
} from "./triage/index.ts";
export {
	type CalendarClient,
	type CalendarEvent,
	DEFAULT_SYNC,
	type GmailClient,
	type GmailMessage,
	type GoogleGateway,
	type HistoryChange,
	HistoryExpiredError,
	type HistoryPage,
	type InboxDeps,
	type RequestOptions,
	type SyncSettings,
	type TokenAccount,
	type TokenProvider,
	TokenRevokedError,
	type Triage,
	type TriageInput,
} from "./types.ts";
