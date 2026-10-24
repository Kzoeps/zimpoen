import type { AppDb, Migration } from "@assistant/db";
import type { PushPayload } from "@assistant/shared";
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationId, Extension, Harness } from "@earendil-works/pi-durable";
import type { ApprovalAction, ApprovalService } from "./approvals/service.ts";

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
	approvals: ApprovalService;
};

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
};

/** Every migration of every module, in module order. */
export function collectMigrations(modules: readonly DomainModule[]): Migration[] {
	return modules.flatMap((module) => module.migrations);
}

/** Ids are plain integers in storage; the brand exists only at compile time, so this is the one decoding point here. */
export const conversationIdOf = (value: number): ConversationId => value as ConversationId;
