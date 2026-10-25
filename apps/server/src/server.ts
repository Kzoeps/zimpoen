import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type AppDb, coreMigrations, migrate, openAppDb } from "@assistant/db";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, HarnessOptions, ReportInfo } from "@earendil-works/pi-durable";
import { serve } from "@hono/node-server";
import { buildAgents, countParkedTasks, type EnsureAgentsResult, ensureAgents, listUnrunnableTasks } from "./agents.ts";
import type { Config } from "./config.ts";
import type { DevProviderOptions } from "./dev-model.ts";
import { createDomain, type Domain, type RepairReport, type SweepReport } from "./domain.ts";
import { acquireFileLock, type FileLock, LockHeldError } from "./file-lock.ts";
import { createApp } from "./http/app.ts";
import { errorBody } from "./http/errors.ts";
import { createHostPolicy } from "./http/guard.ts";
import { createFakePushSender } from "./push/dev-sender.ts";
import { createNotifier } from "./push/notifier.ts";
import { createWebPushSender, type PushSender } from "./push/sender.ts";
import { loadOrCreateVapidKeys } from "./push/vapid.ts";
import { openRuntime, type Runtime } from "./runtime.ts";

export type ServerLogger = Pick<Console, "info" | "warn" | "error">;

export type StartServerOptions = {
	logger?: ServerLogger;
	/** Pacing of the scripted model in `faux` mode. */
	devModel?: DevProviderOptions;
	/** Called once if Durable's storage fails, which closes the Harness. Default: log and exit so a supervisor restarts. */
	onStorageFailure?: (error: unknown) => void;
	/** Passed to Durable: crashes in a row before a task is parked. See `RuntimeOptions.restartLimit`. */
	restartLimit?: number;
	/** The clock of the Harness and of everything that stores a deadline. Default `Date.now`; tests pass a fake. */
	now?: () => number;
	/** Timers of the Harness. Default `setTimeout`; tests pass fakes. */
	setTimer?: HarnessOptions["setTimer"];
	/** Replaces the push sender the configuration chooses, so tests can see what would have been sent. */
	pushSender?: PushSender;
	/** How often the running server does its upkeep (see {@link startMaintenance}). The defaults are for real use; tests shorten them. */
	intervals?: { resumeMs?: number; sweepMs?: number };
};

/** How often sleeping tasks that came due are woken. A reminder is at most this late after a suspend or a clock step. */
const RESUME_TICK_MS = 30 * 1000;

/** How often requests past their 24 hours are closed and reminder timers that Durable lost or ended are made again. */
const SWEEP_MS = 10 * 60 * 1000;

export type RunningServer = {
	/** The port actually bound (differs from the configured one when that was 0). */
	port: number;
	harness: Harness;
	db: AppDb;
	runtime: Runtime;
	agents: EnsureAgentsResult;
	domain: Domain;
	/** Stop listening, finish running work's current step, close both databases. Idempotent. */
	close(): Promise<void>;
};

/**
 * Bring the whole server up: the data-directory lock, the listening port, app.sqlite and its migrations, the Durable
 * Harness, the four agents, resumed work, and finally the HTTP API. Resolves once it is serving. Everything opened
 * before a failure is closed again.
 *
 * The lock and the port come first on purpose. Opening Durable is not harmless: `open()` marks every running task as
 * restarted, so a second process on the same data directory would steal the first one's work. Whatever can say "another
 * assistant is already running" must therefore say it before `durable.sqlite` is touched. While Durable opens, the port
 * already answers 503 "starting", which the browser treats like a restart and retries.
 */
export async function startServer(config: Config, options: StartServerOptions = {}): Promise<RunningServer> {
	const logger = options.logger ?? console;
	const undo: Array<() => Promise<void> | void> = [];
	try {
		const lock = await acquireDataDirLock(config);
		undo.push(() => lock.release());

		let current: (request: Request, env?: unknown) => Response | Promise<Response> = startingResponse;
		const server = await listen((request, env) => current(request, env), config);
		undo.push(() => closeHttp(server));
		const port = (server.address() as AddressInfo).port;
		server.on("error", (error) => logger.error("[http] server error:", error));

		const db = openAppDb(config.paths.appDb);
		undo.push(() => db.close());

		const now = options.now ?? Date.now;
		const vapid = await loadOrCreateVapidKeys(config.paths.vapid, logger);
		const sender =
			options.pushSender ??
			(config.push.mode === "fake"
				? createFakePushSender(config.paths.pushOutbox, logger)
				: createWebPushSender(vapid, config.push.subject));
		const notifier = createNotifier(db, sender, logger);
		const domain = createDomain({
			db,
			timezone: config.profile.timezone,
			now,
			notify: notifier.notify,
			schedule: config.schedule,
		});
		const migrations = migrate(db, [...coreMigrations, ...domain.migrations]);
		if (migrations.applied.length > 0) logger.info(`[db] applied migrations: ${migrations.applied.join(", ")}`);

		const runtime = await openRuntime(config, {
			onReport: (error, info) => reportDurable(logger, error, info),
			devModel: options.devModel,
			restartLimit: options.restartLimit,
			extensions: domain.extensions,
			now: options.now,
			setTimer: options.setTimer,
		});
		undo.push(() => runtime.close());
		const { harness, models } = runtime;
		domain.bind(harness);
		harness.closed.then((end) => {
			if (end.reason === "failed") (options.onStorageFailure ?? exitOnStorageFailure(logger))(end.error);
		});

		await tidyCredentials(logger, config, runtime);

		const agentDefs = buildAgents({ pa: domain.paExtensions });
		const agents = await ensureAgents(harness, db, {
			agents: agentDefs,
			shared: runtime.shared,
			modelMode: config.modelMode,
			isModelAvailable: (ref) => models.getModel(ref.provider, ref.modelId) !== undefined,
		});
		logAgents(logger, agents);
		await warnIfNoOpenAiLogin(logger, config, runtime);
		await warnAboutParkedTasks(logger, harness);
		await warnAboutUnrunnableTasks(logger, harness);
		const repairLog = createRepairLogger(logger, config.paths.appDb);
		repairLog.startup(await domain.repair());

		// Everything that can recover interrupted work is in place: let Durable continue it.
		harness.resume();
		const stopMaintenance = startMaintenance({
			harness,
			domain,
			logger,
			repairLog,
			resumeMs: options.intervals?.resumeMs ?? RESUME_TICK_MS,
			sweepMs: options.intervals?.sweepMs ?? SWEEP_MS,
		});
		undo.push(stopMaintenance);

		const hosts = createHostPolicy(port, config.http.publicHosts);
		current = createApp({
			harness,
			db,
			models,
			unanswered: runtime.unanswered,
			approvals: domain.approvals,
			push: { publicKey: vapid.publicKey },
			now,
			agents: agentDefs,
			auth: config.auth,
			hosts,
			logger,
		}).fetch;
		logger.info(`[http] listening on http://${config.http.host}:${port} (model: ${config.modelMode})`);
		logger.info(`[http] answers to Host: ${hosts.list().join(", ")}`);

		let closing: Promise<void> | undefined;
		return {
			port,
			harness,
			db,
			runtime,
			agents,
			domain,
			close: () => {
				stopMaintenance();
				closing ??= shutdown(server, runtime, db, lock, logger);
				return closing;
			},
		};
	} catch (error) {
		await unwind(undo, logger);
		throw error;
	}
}

/** Make the credential file private again if it was copied in loosely, and drop temp files a crashed write left. */
async function tidyCredentials(logger: ServerLogger, config: Config, runtime: Runtime): Promise<void> {
	if (await runtime.credentials.ensurePrivate()) {
		logger.warn(
			`[credentials] ${config.paths.credentials} was readable by other users; restricted it to its owner (0600).`,
		);
	}
	const leftovers = await runtime.credentials.cleanupTempFiles();
	if (leftovers > 0) logger.warn(`[credentials] removed ${leftovers} temp file(s) a crashed write had left behind.`);
}

/** One server per data directory, for as long as it runs. */
async function acquireDataDirLock(config: Config): Promise<FileLock> {
	const path = join(config.dataDir, "server.lock");
	try {
		return await acquireFileLock(path);
	} catch (error) {
		if (!(error instanceof LockHeldError)) throw error;
		throw new Error(
			`Another assistant server (process ${error.holderPid}) is already using the data directory ${config.dataDir}. ` +
				"Stop it first, or give this one its own ASSISTANT_DATA_DIR. " +
				`If you are sure no assistant is running, delete ${path}.`,
		);
	}
}

/** What the port answers while the databases and Durable are still opening. */
function startingResponse(): Response {
	return Response.json(errorBody("unavailable", "The assistant is starting up. Try again in a few seconds."), {
		status: 503,
		headers: { "Retry-After": "2", "Cache-Control": "no-store" },
	});
}

function listen(
	fetch: (request: Request, env?: unknown) => Response | Promise<Response>,
	config: Config,
): Promise<Server> {
	return new Promise((resolve, reject) => {
		// Without `createServer` the adapter returns a plain HTTP/1.1 server; the type is a union that includes HTTP/2.
		const server = serve({ fetch, hostname: config.http.host, port: config.http.port }) as Server;
		server.once("error", (error: NodeJS.ErrnoException) => {
			reject(
				error.code === "EADDRINUSE"
					? new Error(
							`Port ${config.http.port} on ${config.http.host} is already in use. Is another assistant server running? ` +
								"Stop it, or set ASSISTANT_PORT to a free port.",
						)
					: error,
			);
		});
		server.once("listening", () => resolve(server));
	});
}

/**
 * Stop cleanly: refuse new connections, close the Harness (which ends every SSE stream, so browsers see the stream end
 * and reconnect to the next process), wait for the sockets to drain, then close `app.sqlite`.
 */
async function shutdown(
	server: Server,
	runtime: Runtime,
	db: AppDb,
	lock: FileLock,
	logger: ServerLogger,
): Promise<void> {
	const drained = new Promise<void>((resolve) => server.close(() => resolve()));
	server.closeIdleConnections();
	try {
		await runtime.close();
	} catch (error) {
		logger.error("[shutdown] closing the Durable harness failed:", error);
	}
	// Streams end once the Harness closes; this is for a connection that does not, such as a stalled client.
	const force = setTimeout(() => server.closeAllConnections(), 1000);
	await drained;
	clearTimeout(force);
	db.close();
	await lock.release();
}

/** Stop accepting connections and drop the ones still open. Used when a start fails after the port was bound. */
async function closeHttp(server: Server): Promise<void> {
	const closed = new Promise<void>((resolve) => server.close(() => resolve()));
	server.closeAllConnections();
	await closed;
}

/** Undo what a failed start had opened, newest first, always to the end. */
async function unwind(undo: Array<() => Promise<void> | void>, logger: ServerLogger): Promise<void> {
	for (const step of undo.splice(0).reverse()) {
		try {
			await step();
		} catch (error) {
			logger.error("[shutdown] a step failed:", error);
		}
	}
}

function exitOnStorageFailure(logger: ServerLogger): (error: unknown) => void {
	return (error) => {
		logger.error(
			"[durable] storage failed and the Harness closed itself. Exiting so the process supervisor restarts it; " +
				"interrupted work resumes on restart.",
			error,
		);
		process.exit(1);
	};
}

function reportDurable(logger: ServerLogger, error: unknown, info: ReportInfo): void {
	if (info.type === "task_parked") {
		logger.error(
			`[durable] PARKED: ${error instanceof Error ? error.message : String(error)}. The conversation it belongs to will ` +
				"not answer until the task is retried: Durable stopped restarting it because it was cut off by crashes again and " +
				"again. Find out why the process keeps dying (out-of-memory kills, power loss, a bug) before retrying. " +
				"GET /api/agents reports the number of parked tasks.",
		);
		return;
	}
	logger.warn(`[durable] ${info.type}:`, error);
}

/** Parked tasks survive restarts, so say so at every start, not only when they were parked. */
async function warnAboutParkedTasks(logger: ServerLogger, harness: Harness): Promise<void> {
	const parked = await countParkedTasks(harness, BACKGROUND_CONTEXT);
	if (parked === 0) return;
	logger.error(
		`[durable] ${parked} task(s) are parked after repeated crashes and will not run again by themselves. ` +
			"Chats that depended on them stay silent. Nothing retries them automatically: find out why the process died first.",
	);
}

/**
 * A task that no installed definition fits never wakes, and a timer among them would stop a reminder, a meeting or a
 * birthday without a word, so say so at every start.
 */
async function warnAboutUnrunnableTasks(logger: ServerLogger, harness: Harness): Promise<void> {
	const stuck = await listUnrunnableTasks(harness, BACKGROUND_CONTEXT);
	if (stuck.length === 0) return;
	const shown = stuck
		.slice(0, 10)
		.map((task) => `${task.kind} #${task.id} (${task.reason})`)
		.join(", ");
	logger.error(
		`[durable] ${stuck.length} task(s) cannot run, because no installed definition fits them: ${shown}${stuck.length > 10 ? ", ..." : ""}. ` +
			"Whatever they were waiting for (a reminder, a meeting, a birthday) stays silent. A task's phases may change only with a new " +
			"`version` and a `migrate` function (docs/design-notes.md); restoring the code that defined them also helps.",
	);
}

/** An error message as a sentence, so that more text can follow it. */
const sentence = (message: string): string => (/[.!?]$/.test(message) ? message : `${message}.`);

type RepairLogger = {
	startup(report: RepairReport): void;
	sweep(report: SweepReport): void;
};

/**
 * Says what repair did, and for what it could not repair, what to run. A request or row that cannot be repaired
 * (typically a conversation that `DELETE FROM agents` made Durable's side forget) is described once per process, not
 * every ten minutes: it will still be there, and the server works without it.
 */
function createRepairLogger(logger: ServerLogger, appDb: string): RepairLogger {
	const described = new Set<string>();

	/** The SQL that points a row at the PA's current conversation, for rows whose conversation is gone for good. */
	const repoint = (table: string, id: string): string =>
		`sqlite3 "${appDb}" "UPDATE ${table} SET conversation_id = (SELECT conversation_id FROM agents WHERE id = 'pa') WHERE id = '${id}'"`;

	function rescheduled(tag: string, what: string, ids: string[]): void {
		if (ids.length === 0) return;
		logger.warn(
			`[${tag}] ${ids.length} ${what} had no live timer (Durable's database lost it, for example after a power cut, ` +
				`or Durable ended it after an error) and were scheduled again: ${ids.join(", ")}`,
		);
	}

	function unrepaired(
		tag: string,
		failures: RepairReport["reminders"]["failures"],
		subject: (id: string) => string,
		remedy: (id: string) => string,
	): void {
		for (const failure of failures) {
			const key = `${tag}:${failure.itemId}`;
			if (described.has(key)) continue;
			described.add(key);
			logger.error(
				`[${tag}] could not give ${subject(failure.itemId)}: ${sentence(failure.message)} The server keeps running without ` +
					"it and tries again every few minutes. If the conversation is gone for good (after DELETE FROM agents, " +
					`for example), ${remedy(failure.itemId)}`,
			);
		}
	}

	const tasksUnrepaired = (failures: RepairReport["reminders"]["failures"]): void =>
		unrepaired(
			"tasks",
			failures,
			(id) => `task ${id} its reminder timer`,
			(id) => `drop the reminder: sqlite3 "${appDb}" "UPDATE tasks_item SET remind_at = NULL WHERE id = '${id}'"`,
		);
	const followupsUnrepaired = (failures: RepairReport["followups"]["failures"]): void =>
		unrepaired(
			"followups",
			failures,
			(id) => `follow-up ${id} its timer`,
			(id) => `move it to the assistant's new conversation: ${repoint("followups_item", id)}`,
		);
	const birthdaysUnrepaired = (failures: RepairReport["birthdays"]["failures"]): void =>
		unrepaired(
			"people",
			failures,
			(id) => `${id} its birthday timer`,
			(id) => `move it to the assistant's new conversation: ${repoint("people_person", id)}`,
		);

	function unannounced(failures: RepairReport["approvals"]["failures"]): void {
		for (const failure of failures) {
			if (described.has(`approval:${failure.id}`)) continue;
			described.add(`approval:${failure.id}`);
			logger.error(
				`[approvals] could not post the outcome of request ${failure.id} to conversation ${failure.conversationId}: ` +
					`${sentence(failure.message)} The owner's answer itself is saved. To stop trying, mark the notice as posted: ` +
					`sqlite3 "${appDb}" "UPDATE pending_actions SET notified_at = 0 WHERE id = '${failure.id}'"`,
			);
		}
	}

	function timers(report: Pick<RepairReport, "reminders" | "followups" | "birthdays">): void {
		rescheduled("tasks", "reminder(s)", report.reminders.rescheduled);
		tasksUnrepaired(report.reminders.failures);
		rescheduled("followups", "follow-up(s)", report.followups.rescheduled);
		followupsUnrepaired(report.followups.failures);
		rescheduled("people", "birthday timer(s)", report.birthdays.rescheduled);
		birthdaysUnrepaired(report.birthdays.failures);
	}

	return {
		startup(report) {
			timers(report);
			const { expired, executed, notified, failures } = report.approvals;
			if (expired + executed + notified > 0) {
				logger.info(
					`[approvals] closed ${expired} expired request(s), carried out ${executed} approved one(s) a crash had interrupted, ` +
						`posted ${notified} missing outcome notice(s).`,
				);
			}
			unannounced(failures);
		},
		sweep(report) {
			timers(report);
		},
	};
}

type MaintenanceOptions = {
	harness: Harness;
	domain: Domain;
	logger: ServerLogger;
	repairLog: RepairLogger;
	resumeMs: number;
	sweepMs: number;
};

/**
 * The upkeep of a server that stays up for days. Returns the function that stops it.
 *
 * - `resume()` every few seconds: Durable arms one timer for the earliest sleeper, on a clock that does not run while the
 *   machine is suspended and that a step of the wall clock does not move, so a reminder can come due with nothing
 *   noticing until the next wake-up. `resume()` runs every sleeper whose time has passed; it does nothing otherwise.
 * - `sweep()` every few minutes: closes approval requests past their 24 hours, and makes the timer again for a reminder
 *   whose timer Durable lost or ended (a power cut, an error in the task), which would otherwise wait for the next start.
 *
 * Both timers are `unref`ed: they never keep the process alive on their own.
 */
function startMaintenance(options: MaintenanceOptions): () => void {
	const { harness, domain, logger, repairLog } = options;
	let sweeping = false;
	let stopped = false;

	const tick = setInterval(() => {
		try {
			harness.resume();
		} catch (error) {
			logger.error("[durable] waking sleeping tasks failed:", error);
		}
	}, options.resumeMs);

	const sweep = setInterval(() => {
		// A sweep that is still running (Durable is slow to answer) is not started a second time.
		if (sweeping) return;
		sweeping = true;
		domain
			.sweep()
			.then((report) => repairLog.sweep(report))
			.catch((error) => {
				// A sweep that was running when the server shut down finds the Harness closed: not worth a line in the log.
				if (!stopped)
					logger.error(
						"[maintenance] the periodic repair of reminders, meetings, birthdays and approvals failed:",
						error,
					);
			})
			.finally(() => {
				sweeping = false;
			});
	}, options.sweepMs);

	tick.unref();
	sweep.unref();
	return () => {
		stopped = true;
		clearInterval(tick);
		clearInterval(sweep);
	};
}

function logAgents(logger: ServerLogger, result: EnsureAgentsResult): void {
	if (result.created.length > 0) logger.info(`[agents] created: ${result.created.join(", ")}`);
	if (result.adopted.length > 0) {
		logger.warn(
			`[agents] found existing conversations for ${result.adopted.join(", ")} that app.sqlite did not know about ` +
				"(an earlier start crashed between its two databases) and reconnected them.",
		);
	}
	if (result.updated.length > 0) logger.info(`[agents] updated instructions/extensions: ${result.updated.join(", ")}`);
	for (const { agentId, model } of result.unavailableModels) {
		logger.warn(
			`[agents] '${agentId}' is set to ${model.provider}/${model.modelId}, which this server cannot serve in its current ` +
				"model mode, so its messages will fail. Choose another model in the web app's Settings (or PUT /api/settings/agents/:id), " +
				"or switch ASSISTANT_MODEL_MODE.",
		);
	}
}

async function warnIfNoOpenAiLogin(logger: ServerLogger, config: Config, runtime: Runtime): Promise<void> {
	if (config.modelMode !== "openai") return;
	// Reads the local file only: no login, no network.
	const stored = await runtime.credentials.read("openai");
	if (stored === undefined && process.env.OPENAI_API_KEY === undefined) {
		logger.warn(
			`[models] No OpenAI credentials in ${config.paths.credentials} and no OPENAI_API_KEY. The server starts, but ` +
				"every message will fail until you sign in.",
		);
	}
}
