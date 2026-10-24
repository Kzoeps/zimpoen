import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type AppDb, coreMigrations, migrate, openAppDb } from "@assistant/db";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, ReportInfo } from "@earendil-works/pi-durable";
import { serve } from "@hono/node-server";
import { countParkedTasks, type EnsureAgentsResult, ensureAgents } from "./agents.ts";
import type { Config } from "./config.ts";
import type { DevProviderOptions } from "./dev-model.ts";
import { acquireFileLock, type FileLock, LockHeldError } from "./file-lock.ts";
import { createApp } from "./http/app.ts";
import { errorBody } from "./http/errors.ts";
import { createHostPolicy } from "./http/guard.ts";
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
};

export type RunningServer = {
	/** The port actually bound (differs from the configured one when that was 0). */
	port: number;
	harness: Harness;
	db: AppDb;
	runtime: Runtime;
	agents: EnsureAgentsResult;
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
		const migrations = migrate(db, coreMigrations);
		if (migrations.applied.length > 0) logger.info(`[db] applied migrations: ${migrations.applied.join(", ")}`);

		const runtime = await openRuntime(config, {
			onReport: (error, info) => reportDurable(logger, error, info),
			devModel: options.devModel,
			restartLimit: options.restartLimit,
		});
		undo.push(() => runtime.close());
		const { harness, models } = runtime;
		harness.closed.then((end) => {
			if (end.reason === "failed") (options.onStorageFailure ?? exitOnStorageFailure(logger))(end.error);
		});

		await tidyCredentials(logger, config, runtime);

		const agents = await ensureAgents(harness, db, {
			shared: runtime.shared,
			modelMode: config.modelMode,
			isModelAvailable: (ref) => models.getModel(ref.provider, ref.modelId) !== undefined,
		});
		logAgents(logger, agents);
		await warnIfNoOpenAiLogin(logger, config, runtime);
		await warnAboutParkedTasks(logger, harness);

		// Everything that can recover interrupted work is in place: let Durable continue it.
		harness.resume();

		const hosts = createHostPolicy(port, config.http.publicHosts);
		current = createApp({
			harness,
			db,
			models,
			unanswered: runtime.unanswered,
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
			close: () => {
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
