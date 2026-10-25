import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppDb, coreMigrations, getAgentRow, insertAgentRow, migrate, openAppDb } from "@assistant/db";
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
	type EnvTarget,
	type Extension,
	Harness,
	type ReportInfo,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	type AccountantDeps,
	type AskedInput,
	approvalsModule,
	type BudgetGate,
	closingYesWindow,
	closingYesWindowOnAsk,
	collectMigrations,
	createApprovalService,
	createEntryPoster,
	createFakeGoogle,
	createInputSubmitter,
	createRulesTriage,
	type DailyFactsProvider,
	type DelegateDeps,
	type DomainDeps,
	dailyModule,
	delegateModule,
	type EntryPoster,
	type FakeGoogle,
	type FilesDeps,
	filesModule,
	followupsModule,
	type HealthDeps,
	healthModule,
	type InboxDeps,
	type InputSubmitter,
	inboxModule,
	invoicesModule,
	ledgerModule,
	memoryModule,
	type PostedEntry,
	peopleModule,
	type ScheduleSettings,
	type SyncSettings,
	splitsModule,
	type Triage,
	tasksModule,
	usageModule,
} from "../src/index.ts";

export const ctx = BACKGROUND_CONTEXT;

export const TIMEZONE = "Asia/Thimphu";

/** 2026-10-25T08:00:00Z, which is 14:00 in Thimphu. */
export const START = Date.UTC(2026, 9, 25, 8, 0, 0);

export const MINUTE = 60_000;

/** The text a tool result tells the model. */
export function textOf(result: ToolExecutionResult): string {
	return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

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
	/** When follow-ups and birthdays fire; the defaults otherwise. */
	schedule?: Partial<ScheduleSettings>;
	/** The owner's time zone. Default Asia/Thimphu; a zone with daylight saving time for the tests about the clock changing. */
	timezone?: string;
	/** Wraps what asks the model something (the daily jobs), for tests that crash or inspect after the question was placed. */
	wrapAsk?: (ask: InputSubmitter) => InputSubmitter;
	/** The file environment tools use. Default: none, so the file tools fail with their "no environment" error. */
	env?: (target: EnvTarget) => ExecutionEnv;
	files?: FilesDeps;
	/** Extra facts providers, read next to the modules' own by the briefing and the wrap-up. */
	providers?: readonly DailyFactsProvider[];
	/** What the Health module is told about the owner (their height, for BMI). Default: nothing. */
	health?: HealthDeps;
	/** What the Accountant's modules are told: the owner's currency and name, where invoices go. Default: the Ngultrum, nothing else. */
	accountant?: AccountantDeps;
	/** More extensions for the registry and the conversation's agent, such as code mode, whose tools reach the modules'. */
	extraExtensions?: readonly Extension[];
	/**
	 * The Inbox agent: a second conversation (the one the daily digests and the sync timers live in, recorded as agent
	 * `inbox`), a scripted Google and, unless given, the local rules. Without it there is no Inbox conversation.
	 */
	inbox?: { google?: FakeGoogle; triage?: Triage; sync?: Partial<SyncSettings> };
	delegate?: DelegateDeps;
	/** The weekly token limits the daily jobs ask. Default: none (nothing degrades); the usage module's own service is `fixture.usage`. */
	budget?: BudgetGate;
};

export type Fixture = {
	dir: string;
	db: AppDb;
	harness: Harness;
	conversation: Conversation;
	clock: { now: number };
	faux: FauxProviderHandle;
	deps: DomainDeps;
	/** The scripted Google of the Inbox agent; undefined without `options.inbox`. */
	google: FakeGoogle | undefined;
	/** The Inbox agent's conversation; undefined without `options.inbox`. */
	inbox: Conversation | undefined;
	extensions: Extension[];
	pushes: PushPayload[];
	posted: PostedEntry[];
	/** What the daily jobs asked the model, in order. */
	asked: AskedInput[];
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
	/** Entries of the Inbox agent's conversation, oldest first. */
	inboxEntries(): Promise<EntryRecord[]>;
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
	const modules = [
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
	migrate(db, [...coreMigrations, ...collectMigrations(modules)]);

	const pushes: PushPayload[] = [];
	const posted: PostedEntry[] = [];
	const asked: AskedInput[] = [];
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
	const plainPost = options.wrapPost === undefined ? recordingPost : options.wrapPost(recordingPost);
	const baseAsk = createInputSubmitter(getHarness);
	const recordingAsk: InputSubmitter = async (conversationId, input) => {
		const result = await baseAsk(conversationId, input);
		asked.push(input);
		return result;
	};
	const plainAsk = options.wrapAsk === undefined ? recordingAsk : options.wrapAsk(recordingAsk);

	// As in the server: the approval service writes its notices with the plain poster, the modules' cards close the YES window.
	const approvals = createApprovalService({ db, now, post: plainPost });
	const post = closingYesWindow(plainPost, approvals);
	const google = options.inbox === undefined ? undefined : (options.inbox.google ?? createFakeGoogle({ now }));
	const inboxDeps: InboxDeps | undefined =
		options.inbox === undefined || google === undefined
			? undefined
			: {
					google,
					triage: options.inbox.triage ?? createRulesTriage(),
					...(options.inbox.sync === undefined ? {} : { sync: options.inbox.sync }),
				};
	let providers: readonly DailyFactsProvider[] = [];
	const deps: DomainDeps = {
		db,
		timezone: options.timezone ?? TIMEZONE,
		now,
		harness: getHarness,
		post,
		ask: closingYesWindowOnAsk(plainAsk, approvals),
		facts: () => providers,
		notify: async (payload) => {
			if (options.failPush?.() === true) throw new Error("push service unreachable");
			pushes.push(payload);
		},
		approvals,
		...(options.schedule === undefined ? {} : { schedule: options.schedule }),
		...(options.files === undefined ? {} : { files: options.files }),
		...(options.health === undefined ? {} : { health: options.health }),
		...(options.accountant === undefined ? {} : { accountant: options.accountant }),
		...(inboxDeps === undefined ? {} : { inbox: inboxDeps }),
		...(options.delegate === undefined ? {} : { delegate: options.delegate }),
		...(options.budget === undefined ? {} : { budget: options.budget }),
	};
	for (const module of modules) for (const action of module.actions?.(deps) ?? []) approvals.register(action);
	providers = [...modules.flatMap((module) => module.facts?.(deps) ?? []), ...(options.providers ?? [])];
	const extensions = [...modules.map((module) => module.extension(deps)), ...(options.extraExtensions ?? [])];

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
		{
			models,
			registry,
			now,
			onReport: (error, info) => reports.push({ error, info }),
			...(options.env === undefined ? {} : { env: options.env }),
		},
		ctx,
	);
	// The PA is offered its everyday tools and finds the rest with `tool_search`. These tests are about what the tools do,
	// so the rarely used ones are loaded up front (the server test "offers the everyday tools" covers the loading).
	const deferred = extensions.flatMap((extension) => extension.tools ?? []).filter((tool) => tool.deferred === true);
	const conversation = await harness.root(ctx, {
		agent: { model: FAUX_MODEL, extensions, modelTools: { add: deferred } },
	});
	// The conversation is the PA's, as far as the daily jobs are concerned (they look it up in `agents`).
	insertAgentRow(db, { id: "pa", conversationId: Number(conversation.id), createdAt: now() });
	// The Inbox agent's conversation selects only its own extension, as the server does: capability is tool presence. Over files
	// that already have one (a restart) it is that conversation: a second one would be an orphan the `agents` row never names.
	const recordedInbox = getAgentRow(db, "inbox")?.conversationId;
	const inbox =
		options.inbox === undefined
			? undefined
			: ((recordedInbox === undefined ? undefined : await harness.conversation(recordedInbox as never, ctx)) ??
				(await harness.createConversation(
					{
						ownership: { kind: "ownerless" },
						agent: { model: FAUX_MODEL, extensions: extensions.filter((extension) => extension.name === "inbox") },
					},
					ctx,
				)));
	if (inbox !== undefined) insertAgentRow(db, { id: "inbox", conversationId: Number(inbox.id), createdAt: now() });
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
		google,
		inbox,
		extensions,
		pushes,
		posted,
		asked,
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
			const api = {
				callId,
				conversationId: conversation.id,
				now: () => clock.now,
				env: options.env?.({ conversationId: conversation.id } as EnvTarget),
			} as unknown as ToolExecutionApi;
			return await tool.execute(args as never, api, ctx);
		},
		entries: async () => {
			const page = await conversation.entries({ order: "ascending" }, 500, undefined, ctx);
			return [...page.items];
		},
		inboxEntries: async () => {
			if (inbox === undefined) throw new Error("This fixture has no Inbox conversation (pass options.inbox).");
			const page = await inbox.entries({ order: "ascending" }, 500, undefined, ctx);
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
