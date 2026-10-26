import type { AppDb, Migration } from "@assistant/db";
import type { PushPayload } from "@assistant/shared";
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationId, Extension, Harness } from "@earendil-works/pi-durable";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import type { ApprovalAction, ApprovalService } from "./approvals/service.ts";
import type { DailyFactsProvider } from "./daily/facts.ts";
import type { InboxDeps } from "./inbox/types.ts";
import type { ScheduleSettings } from "./schedule.ts";
import type { WebDeps } from "./web/index.ts";

/** What a domain module may ask of the server it runs in. Built once by the server and shared by every module. */
export type DomainDeps = {
	db: AppDb;
	/** IANA time zone of the owner: what "tomorrow at 9" means. */
	timezone: string;
	/**
	 * The clock. It is the Harness clock: a reminder's deadline is stored on it, so anything that compares against a
	 * deadline must read the same one (tests give both a fake).
	 */
	now: () => number;
	/**
	 * The open Harness. A function because extensions are built before the Harness is opened (it needs them in its
	 * registry); it throws a clear error if called earlier, which can only happen if a module does work at construction.
	 */
	harness: () => Harness;
	/** Write an entry into a conversation without calling the model (PLAN §5.3). Writing the same `requestId` twice writes once. */
	post: EntryPoster;
	/** Send a Web Push to every subscribed device. Never throws: a failed push must not fail the work that triggered it. */
	notify: (payload: PushPayload) => Promise<void>;
	/**
	 * Put a message to the model in a conversation, as the owner's message would be placed, and start a run (PLAN §5.3
	 * is the zero-token `post`; this is the one that costs tokens: the daily briefing and wrap-up). Writing the same
	 * `requestId` twice asks once.
	 */
	ask: InputSubmitter;
	/**
	 * What every module can say for the daily briefing and wrap-up, read when a job runs: the providers modules
	 * contribute with `DomainModule.facts`. A function because the modules need `deps` to build theirs.
	 */
	facts: () => readonly DailyFactsProvider[];
	approvals: ApprovalService;
	/** When follow-ups and birthdays fire, where the server configured it; anything left out takes {@link DEFAULT_SCHEDULE}. */
	schedule?: Partial<ScheduleSettings>;
	/** What the file tools need from the server. Omitted: no folder is offered to the model and images pass through as they are. */
	files?: FilesDeps;
	/** Web search and page reading. Omitted: the web extension has no tools. */
	web?: WebDeps;
	/** What the Health module needs of the owner's profile. Omitted: nothing that depends on it (BMI) is shown. */
	health?: HealthDeps;
	/** What the Accountant's modules need: the owner's currency and name, and where invoices are made. Omitted: the Ngultrum, no name, no invoices. */
	accountant?: AccountantDeps;
	/** What the Inbox module reads Google through, and how it classifies mail. Omitted: its tools say that Google is not set up, and nothing syncs. */
	inbox?: InboxDeps;
	/** How the PA's `ask_agent` waits. Omitted: {@link DEFAULT_ASK_TIMEOUT_MS}. */
	delegate?: DelegateDeps;
	/** The weekly token limits (M8). Omitted: no agent has one, and every daily job asks the model as it always did. */
	budget?: BudgetGate;
	/** Say that something failed which the work goes on without (the server logs it). Omitted: nothing is said. Never throws. */
	warn?: (message: string) => void;
};

/** An agent's standing against the weekly token limit the owner set for it. */
export type BudgetCheck = {
	agent: string;
	/** Tokens used this week (Monday to today in the owner's zone), as the provider counts them. */
	used: number;
	limit: number;
	/** `used` has reached `limit`: background model work for this agent degrades to a card that costs nothing. */
	over: boolean;
	/** The Monday the week began. */
	weekStart: string;
};

/**
 * What the daily jobs ask before they spend tokens (M8): has this agent used up its weekly limit? It is a soft limit. A
 * job that would ask the model posts a plain card instead; what the owner types still goes through, and nothing is
 * checked on a request. Resolves to undefined for an agent that has no limit.
 */
export type BudgetGate = {
	check(agentId: string): Promise<BudgetCheck | undefined>;
};

export type DelegateDeps = {
	/** How long `ask_agent` waits for the other agent's answer before it tells the PA that the agent is still working. */
	timeoutMs?: number;
};

export const DEFAULT_ASK_TIMEOUT_MS = 90_000;

export type AccountantDeps = {
	/** ISO 4217 code of the owner's currency (`ASSISTANT_CURRENCY`, BTN by default): what an account, an entry or an invoice is in unless said otherwise. */
	currency: string;
	/** The owner's name as bills and invoices should say it. Absent when the owner never configured one. */
	ownerName?: string;
	/** Where invoices are made. Absent: the invoice tools say that invoices are not set up. */
	invoices?: InvoiceDeps;
};

export type InvoiceDeps = {
	/** `<data>/workspace/invoices`: where the PDFs are written. Absolute, links resolved. */
	outDir: string;
	/** `<data>/templates`: where `invoice.html` and the images it uses live. Absolute, links resolved. */
	templatesDir: string;
};

export type HealthDeps = {
	/** The owner's height in centimetres, for BMI. */
	heightCm?: number;
};

export type FilesDeps = {
	/** The folders the model may read (`ASSISTANT_READ_PATHS` and the uploads folder), absolute: told to it in a prompt section. */
	readPaths: readonly string[];
	/** Resizes and turns images upright for the model. Without one, an image within the limits passes as it is. */
	images?: ImageProcessor;
};

export type AskedInput = {
	/** What the model reads as the user's message. */
	content: string;
	/** Deduplication key, scoped to the conversation: derive it from what is asked, so a rerun asks nothing new. */
	requestId: string;
	/** How the thread shows the input instead of a user bubble: a custom kind (not `pi.*`) and the data its card renders. */
	entry?: { kind: string; data: JsonValue };
};

export type InputSubmitter = (conversationId: number, input: AskedInput) => Promise<{ submissionId: number }>;

export type PostedEntry = {
	/** The custom entry kind, for example `app.reminder`. */
	kind: string;
	/** What the thread shows. Entries are for the UI only: the model never reads them (see `createEntryPoster`). */
	data: JsonValue;
	/** Deduplication key, scoped to the conversation. Derive it from what is being posted, so a rerun posts nothing new. */
	requestId: string;
};

export type EntryPoster = (conversationId: number, entry: PostedEntry) => Promise<{ submissionId: number }>;

/**
 * One feature area of the assistant (PLAN §5.2): its tables, and the Durable extension that gives an agent its tools,
 * prompt sections, hooks and tasks. The server collects `migrations` from every module, installs every `extension`
 * in the registry, and gives each agent the ones it is meant to have.
 */
export type DomainModule = {
	/** Also the prefix of its migration ids and tables: `tasks` owns `tasks/001_items` and `tasks_item`. */
	name: string;
	migrations: readonly Migration[];
	extension: (deps: DomainDeps) => Extension;
	/** Destructive actions this module owns: its tools that need the owner's approval, and how to carry them out. */
	actions?: (deps: DomainDeps) => readonly ApprovalAction[];
	/** What this module can say for the morning briefing and the evening wrap-up (see `DailyFactsProvider`). */
	facts?: (deps: DomainDeps) => readonly DailyFactsProvider[];
};

/** Every migration of every module, in module order. */
export function collectMigrations(modules: readonly DomainModule[]): Migration[] {
	return modules.flatMap((module) => module.migrations);
}

/** Ids are plain integers in storage; the brand exists only at compile time, so this is the one decoding point here. */
export const conversationIdOf = (value: number): ConversationId => value as ConversationId;
