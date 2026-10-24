import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppDb, coreMigrations, migrate, openAppDb } from "@assistant/db";
import type { PushPayload } from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	type Conversation,
	createRegistry,
	type EntryRecord,
	type Extension,
	Harness,
	type ReportInfo,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	approvalsModule,
	collectMigrations,
	createApprovalService,
	createEntryPoster,
	type DomainDeps,
	type EntryPoster,
	type PostedEntry,
	tasksModule,
} from "../src/index.ts";

export const ctx = BACKGROUND_CONTEXT;

export const TIMEZONE = "Asia/Thimphu";

/** 2026-10-25T08:00:00Z, which is 14:00 in Thimphu. */
export const START = Date.UTC(2026, 9, 25, 8, 0, 0);

export const MINUTE = 60_000;

/** Poll until `check` is truthy: Durable runs tasks in the background. */
export async function waitFor<T>(
	check: () => T | Promise<T>,
	what: string,
	timeoutMs = 10_000,
): Promise<NonNullable<T>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value as NonNullable<T>;
		if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * What a power cut does to Durable's database (synchronous=NORMAL) but not to app.sqlite (synchronous=FULL): `durable.sqlite`
 * comes back from an older sync point. Take a copy while the fixture is closed, put it back later with
 * {@link restoreDurable}, and keep `app.sqlite` as it is.
 */
export async function snapshotDurable(dir: string, to: string): Promise<void> {
	await mkdir(to, { recursive: true });
	for (const name of (await readdir(dir)).filter((entry) => entry.startsWith("durable.sqlite"))) {
		await cp(join(dir, name), join(to, name));
	}
}

/** Replace `durable.sqlite` (and its WAL files) in `dir` by the copy {@link snapshotDurable} made. */
export async function restoreDurable(from: string, dir: string): Promise<void> {
	for (const name of (await readdir(dir)).filter((entry) => entry.startsWith("durable.sqlite"))) {
		await rm(join(dir, name), { force: true });
	}
	for (const name of await readdir(from)) await cp(join(from, name), join(dir, name));
}

export type FixtureOptions = {
	/** Reuse a directory to reopen the same databases. */
	dir?: string;
	clock?: { now: number };
	/** Wraps the poster, for tests that crash or inspect between the write and what follows. */
	wrapPost?: (post: EntryPoster) => EntryPoster;
	/** Make the push throw. */
	failPush?: () => boolean;
};

export type Fixture = {
	dir: string;
	db: AppDb;
	harness: Harness;
	conversation: Conversation;
	clock: { now: number };
	faux: FauxProviderHandle;
	deps: DomainDeps;
	extensions: Extension[];
	pushes: PushPayload[];
	posted: PostedEntry[];
	reports: Array<{ error: unknown; info: ReportInfo }>;
	/** Say something to the model and wait for its answer. The faux model plays whatever was scripted. */
	say(text: string): Promise<void>;
	/**
	 * Run a tool the way Durable does for a call with id `callId`, without a model in between: for the rules that are
	 * about one call (idempotency by call id, validation). A replay is the same `callId` again.
	 */
	callTool(name: string, args: Record<string, unknown>, callId: string): Promise<ToolExecutionResult>;
	/** Entries of the conversation, oldest first. */
	entries(): Promise<EntryRecord[]>;
	/** Entries of one custom kind, oldest first. */
	entriesOfKind(kind: string): Promise<EntryRecord[]>;
	/** Advance the fake clock and let Durable notice (a sleeping task wakes only when the scheduler runs). */
	advance(ms: number): void;
	close(): Promise<void>;
	/** Close and open again over the same files, as a restart does. */
	restart(): Promise<Fixture>;
	/** Remove the temp directory. */
	dispose(): Promise<void>;
};

export const toolCall = (name: string, args: Record<string, unknown>, id: string) =>
	fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });

export const say = (message: string) => fauxAssistantMessage([fauxText(message)]);

const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

/** Everything the domain modules need, over real SQLite files, a fake clock and a scripted model. No network. */
export async function openFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "assistant-ext-")));
	const clock = options.clock ?? { now: START };
	const now = (): number => clock.now;

	const db = openAppDb(join(dir, "app.sqlite"));
	const modules = [tasksModule, approvalsModule];
	migrate(db, [...coreMigrations, ...collectMigrations(modules)]);

	const pushes: PushPayload[] = [];
	const posted: PostedEntry[] = [];
	const reports: Fixture["reports"] = [];
	let harness: Harness | undefined;
	const getHarness = (): Harness => {
		if (harness === undefined) throw new Error("The Harness is not open yet.");
		return harness;
	};
	const basePost = createEntryPoster(getHarness);
	const recordingPost: EntryPoster = async (conversationId, entry) => {
		const result = await basePost(conversationId, entry);
		posted.push(entry);
		return result;
	};
	const post = options.wrapPost === undefined ? recordingPost : options.wrapPost(recordingPost);

	const approvals = createApprovalService({ db, now, post });
	const deps: DomainDeps = {
		db,
		timezone: TIMEZONE,
		now,
		harness: getHarness,
		post,
		notify: async (payload) => {
			if (options.failPush?.() === true) throw new Error("push service unreachable");
			pushes.push(payload);
		},
		approvals,
	};
	for (const module of modules) for (const action of module.actions?.(deps) ?? []) approvals.register(action);
	const extensions = modules.map((module) => module.extension(deps));

	const faux = fauxProvider({
		provider: "faux",
		tokensPerSecond: 1_000_000,
		models: [{ id: "faux-1", name: "Faux", reasoning: false }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);

	const storage = await openNodeSqliteStorage(join(dir, "durable.sqlite"));
	harness = await Harness.open(
		storage,
		{ models, registry, now, onReport: (error, info) => reports.push({ error, info }) },
		ctx,
	);
	const conversation = await harness.root(ctx, { agent: { model: FAUX_MODEL, extensions } });
	// What the server does once everything is in place: continue interrupted work and run sleepers that are due.
	harness.resume();

	const fixture: Fixture = {
		dir,
		db,
		harness,
		conversation,
		clock,
		faux,
		deps,
		extensions,
		pushes,
		posted,
		reports,
		say: async (text) => {
			const submission = await conversation.submit({ type: "input", content: text }, ctx);
			await submission.wait(ctx);
		},
		callTool: async (name, args, callId) => {
			const tool = extensions
				.flatMap((extension) => extension.tools ?? [])
				.find((candidate) => candidate.name === name);
			if (tool === undefined) throw new Error(`No tool '${name}'.`);
			const api = { callId, conversationId: conversation.id, now: () => clock.now } as unknown as ToolExecutionApi;
			return await tool.execute(args as never, api, ctx);
		},
		entries: async () => {
			const page = await conversation.entries({ order: "ascending" }, 500, undefined, ctx);
			return [...page.items];
		},
		entriesOfKind: async (kind) => (await fixture.entries()).filter((entry) => entry.kind === kind),
		advance: (ms) => {
			clock.now += ms;
			getHarness().resume();
		},
		close: async () => {
			await getHarness().close(ctx);
			db.close();
		},
		restart: async () => {
			await fixture.close();
			return openFixture({ ...options, dir, clock });
		},
		dispose: async () => {
			await rm(dir, { recursive: true, force: true });
		},
	};
	return fixture;
}
