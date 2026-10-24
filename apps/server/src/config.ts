import { access, chmod, constants, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isInside } from "./paths.ts";

export type ModelMode = "faux" | "openai";

export type AuthConfig = { mode: "off" } | { mode: "on"; ownerLogin: string };

/**
 * How reminders reach the phone. `web-push` sends through the browser vendors' push services (the only outbound
 * call a reminder makes). `fake` sends nothing: it writes what it would have sent to `<data>/dev-push-outbox.jsonl`,
 * which is what development and the tests use.
 */
export type PushMode = "web-push" | "fake";

/** Facts every agent is told about its owner. Rendered into the `profile` prompt section. */
export type ProfileConfig = {
	ownerName: string;
	/** IANA time zone, for example `Asia/Thimphu`. */
	timezone: string;
	/** ISO 4217 code, for example `BTN`. */
	currency: string;
};

export type Config = {
	/**
	 * Absolute and canonical (symlinks resolved) once `loadConfig` has run. Holds every database, upload, generated
	 * file and secret.
	 */
	dataDir: string;
	paths: {
		appDb: string;
		durableDb: string;
		/** Uploads (CSVs, bill photos). Readable by agents. */
		files: string;
		/** Generated files (invoice PDFs, notes). The only place agents may write. */
		workspace: string;
		/** Credentials and keys. Never readable by agents. Mode 0700. */
		secrets: string;
		credentials: string;
		/** The Web Push (VAPID) key pair, generated on first start. Mode 0600, inside `secrets`. */
		vapid: string;
		/** What the fake push sender would have sent, one JSON object per line. Only written in `fake` push mode. */
		pushOutbox: string;
	};
	/** Absolute directories agents may read: `ASSISTANT_READ_PATHS` (or its defaults) plus `<data>/files`. */
	readPaths: readonly string[];
	/** The only directory agents may write to. */
	writePath: string;
	auth: AuthConfig;
	profile: ProfileConfig;
	modelMode: ModelMode;
	push: {
		mode: PushMode;
		/** The VAPID `subject` push services may use to contact the operator: a `mailto:` or `https:` URL. */
		subject: string;
	};
	/**
	 * Bound to loopback only (PLAN rule 10); only the port is configurable. `publicHosts` are the names clients use to
	 * reach the server through Tailscale Serve (`ASSISTANT_PUBLIC_HOST`); the API refuses every other `Host` header.
	 */
	http: { host: "127.0.0.1"; port: number; publicHosts: readonly string[] };
};

export type ConfigProblem = { setting: string; message: string };

/** Everything wrong with the configuration, reported together so one restart fixes all of it. */
export class ConfigError extends Error {
	readonly problems: readonly ConfigProblem[];

	constructor(problems: readonly ConfigProblem[]) {
		const noun = problems.length === 1 ? "problem" : "problems";
		const lines = problems.map((problem) => `  - ${problem.setting}: ${problem.message}`);
		super(`Invalid configuration (${problems.length} ${noun}):\n${lines.join("\n")}`);
		this.name = "ConfigError";
		this.problems = problems;
	}
}

export type Env = Record<string, string | undefined>;

export type ConfigContext = {
	/** Base for a relative `ASSISTANT_DATA_DIR`. */
	cwd: string;
	homeDir: string;
};

const DEFAULT_PORT = 3001;

/**
 * Development and production never share a default data directory: a dev database holds agents on the scripted
 * model, which a production server cannot serve.
 */
function defaultDataDir(env: Env): string {
	return env.NODE_ENV === "production" ? "./data" : "./data-dev";
}
const MODEL_MODES: readonly ModelMode[] = ["faux", "openai"];

/**
 * Read settings from `env`. Pure: touches no files, so every rule here is cheap to test.
 * Use {@link loadConfig} at startup, which also prepares and verifies the directories.
 */
export function parseConfig(env: Env, context: ConfigContext = { cwd: process.cwd(), homeDir: homedir() }): Config {
	const problems: ConfigProblem[] = [];
	const problem = (setting: string, message: string): void => void problems.push({ setting, message });

	const dataDir = resolve(context.cwd, nonEmpty(env.ASSISTANT_DATA_DIR) ?? defaultDataDir(env));
	const paths = {
		appDb: join(dataDir, "app.sqlite"),
		durableDb: join(dataDir, "durable.sqlite"),
		files: join(dataDir, "files"),
		workspace: join(dataDir, "workspace"),
		secrets: join(dataDir, "secrets"),
		credentials: join(dataDir, "secrets", "credentials.json"),
		vapid: join(dataDir, "secrets", "vapid.json"),
		pushOutbox: join(dataDir, "dev-push-outbox.jsonl"),
	};

	const configured = parseReadPaths(env.ASSISTANT_READ_PATHS, context.homeDir, problem);
	const config: Config = {
		dataDir,
		paths,
		readPaths: dedupe([...configured, paths.files]),
		writePath: paths.workspace,
		auth: parseAuth(env, problem),
		profile: {
			ownerName: nonEmpty(env.ASSISTANT_OWNER_NAME) ?? "the owner",
			timezone: parseTimezone(env.ASSISTANT_TIMEZONE, problem),
			currency: parseCurrency(env.ASSISTANT_CURRENCY, problem),
		},
		modelMode: parseModelMode(env, problem),
		push: parsePush(env, problem),
		http: {
			host: "127.0.0.1",
			port: parsePort(env.ASSISTANT_PORT, problem),
			publicHosts: parsePublicHosts(env.ASSISTANT_PUBLIC_HOST, problem),
		},
	};

	if (problems.length > 0) throw new ConfigError(problems);
	return config;
}

/**
 * Load and verify the configuration at startup: parse `env`, create the data directories, resolve every path the file
 * policy depends on through symlinks, and check that every directory agents may read exists and is readable.
 * Throws a {@link ConfigError} naming each bad setting.
 */
export async function loadConfig(env: Env = process.env, context?: ConfigContext): Promise<Config> {
	const config = parseConfig(env, context);
	await prepareDataDirectories(config);
	return await verifyReadPaths(await canonicalizeDataPaths(config));
}

/** Create the data layout. Directories are private to the running user; `secrets` is always exactly 0700. */
export async function prepareDataDirectories(config: Config): Promise<void> {
	const { dataDir, paths } = config;
	try {
		await mkdir(dataDir, { recursive: true, mode: 0o700 });
		for (const dir of [paths.files, paths.workspace, paths.secrets]) {
			await mkdir(dir, { recursive: true, mode: 0o700 });
		}
		// mkdir's mode is masked by the umask and ignored for directories that already exist. The databases inside are
		// created 0644, so this directory is what keeps other local users out of them.
		await chmod(dataDir, 0o700);
		await chmod(paths.secrets, 0o700);
		await access(dataDir, constants.R_OK | constants.W_OK);
	} catch (error) {
		throw new ConfigError([
			{
				setting: "ASSISTANT_DATA_DIR",
				message: `cannot create or write ${dataDir} (${reason(error)}). Point ASSISTANT_DATA_DIR at a directory this user can write.`,
			},
		]);
	}
}

/**
 * Resolve the data directory and the three subdirectories the policy cares about through symlinks.
 *
 * The file environment compares real paths (it resolves every path an agent names before checking it), so the write
 * root and the secrets deny glob must be real paths too. With `data` symlinked to another disk, comparing the symlink
 * text would refuse every workspace write and leave the secrets glob matching nothing.
 */
export async function canonicalizeDataPaths(config: Config): Promise<Config> {
	const dataDir = await realpath(config.dataDir);
	const [files, workspace, secrets] = await Promise.all([
		realpath(config.paths.files),
		realpath(config.paths.workspace),
		realpath(config.paths.secrets),
	]);
	const paths = {
		appDb: join(dataDir, "app.sqlite"),
		durableDb: join(dataDir, "durable.sqlite"),
		files,
		workspace,
		secrets,
		credentials: join(secrets, "credentials.json"),
		vapid: join(secrets, "vapid.json"),
		pushOutbox: join(dataDir, "dev-push-outbox.jsonl"),
	};
	return { ...config, dataDir, paths, writePath: workspace };
}

/**
 * Check each allowed read path against the real file system and return the config with every path resolved through
 * symlinks, so later containment checks compare real locations.
 */
export async function verifyReadPaths(config: Config): Promise<Config> {
	const problems: ConfigProblem[] = [];
	const dataDir = await realpath(config.dataDir);
	const readPaths: string[] = [];

	for (const path of config.readPaths) {
		const real = await checkReadPath(path, problems);
		if (real === undefined) continue;
		const overlap = dataDirOverlap(real, dataDir);
		if (overlap !== undefined) {
			problems.push({ setting: "ASSISTANT_READ_PATHS", message: overlap });
			continue;
		}
		readPaths.push(real);
	}

	if (problems.length > 0) throw new ConfigError(problems);
	return { ...config, readPaths: dedupe(readPaths) };
}

async function checkReadPath(path: string, problems: ConfigProblem[]): Promise<string | undefined> {
	const setting = "ASSISTANT_READ_PATHS";
	const hint = `Create it, or set ${setting} to the folders agents may read (absolute paths separated by '${delimiter}').`;
	try {
		const real = await realpath(path);
		if (!(await stat(real)).isDirectory()) {
			problems.push({ setting, message: `${path} is not a directory. ${hint}` });
			return undefined;
		}
		await access(real, constants.R_OK | constants.X_OK);
		return real;
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		const message = missing
			? `${path} does not exist. ${hint}`
			: `${path} is not readable (${reason(error)}). Fix its permissions, or remove it from ${setting}.`;
		problems.push({ setting, message });
		return undefined;
	}
}

/** A read path may sit inside `<data>/files` or `<data>/workspace`, but must never expose the databases or secrets. */
function dataDirOverlap(readPath: string, dataDir: string): string | undefined {
	if (isInside(readPath, dataDir)) {
		return `${readPath} contains the data directory ${dataDir}, which would expose the databases and secrets to agents. Choose a narrower folder, or move ASSISTANT_DATA_DIR elsewhere.`;
	}
	if (isInside(dataDir, readPath)) {
		const [top] = relative(dataDir, readPath).split(sep);
		if (top !== "files" && top !== "workspace") {
			return `${readPath} is inside the data directory but not under files/ or workspace/. Remove it from ASSISTANT_READ_PATHS.`;
		}
	}
	return undefined;
}

type ReportProblem = (setting: string, message: string) => void;

function parseReadPaths(raw: string | undefined, homeDir: string, problem: ReportProblem): string[] {
	if (raw === undefined) return [join(homeDir, "Documents"), join(homeDir, "Downloads")];
	if (nonEmpty(raw) === undefined) {
		// An allowlist must not widen when its variable is blank, for example from an unset shell variable.
		problem(
			"ASSISTANT_READ_PATHS",
			`is set but empty. Remove it to use the defaults (${join(homeDir, "Documents")} and ${join(homeDir, "Downloads")}), or list the folders agents may read (absolute paths separated by '${delimiter}').`,
		);
		return [];
	}
	const entries = (raw as string).split(delimiter).map((entry) => entry.trim());
	const paths: string[] = [];
	for (const entry of entries) {
		if (entry === "") {
			problem(
				"ASSISTANT_READ_PATHS",
				`contains an empty entry. Separate absolute paths with '${delimiter}' and no spaces.`,
			);
		} else if (!isAbsolute(entry)) {
			problem(
				"ASSISTANT_READ_PATHS",
				`'${entry}' is not an absolute path. Use a full path such as /home/you/Documents.`,
			);
		} else if (resolve(entry) === "/") {
			problem(
				"ASSISTANT_READ_PATHS",
				"'/' would let agents read the whole machine. List the specific folders instead.",
			);
		} else {
			paths.push(resolve(entry));
		}
	}
	return paths;
}

function parseAuth(env: Env, problem: ReportProblem): AuthConfig {
	const mode = nonEmpty(env.ASSISTANT_AUTH) ?? "on";
	if (mode === "off") {
		if (env.NODE_ENV === "production") {
			problem(
				"ASSISTANT_AUTH",
				"'off' is refused when NODE_ENV=production: it would let every device on the tailnet use the assistant. " +
					"Remove ASSISTANT_AUTH (it defaults to 'on') and set ASSISTANT_OWNER_LOGIN to your Tailscale login. " +
					"To try the production build on this machine without Tailscale, run it without NODE_ENV=production (see the README).",
			);
		}
		return { mode: "off" };
	}
	if (mode !== "on") {
		problem("ASSISTANT_AUTH", `'${mode}' is not valid. Use 'on' (default) or 'off' (local development only).`);
		return { mode: "off" };
	}
	const ownerLogin = nonEmpty(env.ASSISTANT_OWNER_LOGIN);
	if (ownerLogin === undefined) {
		problem(
			"ASSISTANT_OWNER_LOGIN",
			"is required while authentication is on. Set it to your Tailscale login (for example you@example.com), or set ASSISTANT_AUTH=off for local development.",
		);
		return { mode: "off" };
	}
	return { mode: "on", ownerLogin };
}

function parseModelMode(env: Env, problem: ReportProblem): ModelMode {
	const fallback: ModelMode = env.NODE_ENV === "production" ? "openai" : "faux";
	const raw = nonEmpty(env.ASSISTANT_MODEL_MODE);
	if (raw === undefined) return fallback;
	if ((MODEL_MODES as readonly string[]).includes(raw)) return raw as ModelMode;
	problem("ASSISTANT_MODEL_MODE", `'${raw}' is not valid. Use 'faux' (scripted dev model, no network) or 'openai'.`);
	return fallback;
}

const PUSH_MODES: readonly PushMode[] = ["web-push", "fake"];
const DEFAULT_PUSH_SUBJECT = "mailto:assistant@localhost";

function parsePush(env: Env, problem: ReportProblem): Config["push"] {
	const fallback: PushMode = env.NODE_ENV === "production" ? "web-push" : "fake";
	const raw = nonEmpty(env.ASSISTANT_PUSH_MODE);
	let mode = fallback;
	if (raw !== undefined) {
		if ((PUSH_MODES as readonly string[]).includes(raw)) mode = raw as PushMode;
		else {
			problem(
				"ASSISTANT_PUSH_MODE",
				`'${raw}' is not valid. Use 'web-push' (real notifications) or 'fake' (nothing leaves this machine; for development).`,
			);
		}
	}
	const given = nonEmpty(env.ASSISTANT_PUSH_SUBJECT);
	if (given === undefined && mode === "web-push") {
		// The placeholder is fine while nothing leaves the machine. A real push service reads this claim, and some are
		// reputed to refuse an address that cannot be real, which would mean reminders that never reach the phone.
		problem(
			"ASSISTANT_PUSH_SUBJECT",
			"needs a value when ASSISTANT_PUSH_MODE is 'web-push' (the default in production). Push services use it to reach " +
				"the operator and may refuse a placeholder. Set a mailto: or https: URL you control, for example mailto:you@example.com.",
		);
	}
	const subject = given ?? DEFAULT_PUSH_SUBJECT;
	if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
		problem(
			"ASSISTANT_PUSH_SUBJECT",
			`'${subject}' is not a mailto: or https: URL. Push services want a way to reach the operator, for example mailto:you@example.com.`,
		);
	}
	return { mode, subject };
}

function parsePort(raw: string | undefined, problem: ReportProblem): number {
	const value = nonEmpty(raw);
	if (value === undefined) return DEFAULT_PORT;
	// Digits only: Number() would also accept '0x10' (16) and '1e3' (1000).
	const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		problem(
			"ASSISTANT_PORT",
			`'${value}' is not a port number. Use an integer from 1 to 65535 (default ${DEFAULT_PORT}).`,
		);
		return DEFAULT_PORT;
	}
	return port;
}

/** `ASSISTANT_PUBLIC_HOST`: host names (optionally with a port) the browser reaches the server by, comma-separated. */
function parsePublicHosts(raw: string | undefined, problem: ReportProblem): string[] {
	if (nonEmpty(raw) === undefined) return [];
	const hosts: string[] = [];
	for (const entry of (raw as string).split(",").map((item) => item.trim().toLowerCase())) {
		if (!/^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/.test(entry)) {
			problem(
				"ASSISTANT_PUBLIC_HOST",
				`'${entry}' is not a host name. Use only the name, as the browser's address bar shows it, ` +
					"for example my-laptop.tail1234.ts.net (no https://, no path). Separate several with commas.",
			);
		} else {
			hosts.push(entry);
		}
	}
	return dedupe(hosts);
}

function parseTimezone(raw: string | undefined, problem: ReportProblem): string {
	const timezone = nonEmpty(raw) ?? "Asia/Thimphu";
	try {
		new Intl.DateTimeFormat("en", { timeZone: timezone });
	} catch {
		problem(
			"ASSISTANT_TIMEZONE",
			`'${timezone}' is not an IANA time zone. Use a name such as Asia/Thimphu or Europe/London.`,
		);
	}
	return timezone;
}

function parseCurrency(raw: string | undefined, problem: ReportProblem): string {
	const currency = nonEmpty(raw) ?? "BTN";
	if (!/^[A-Z]{3}$/.test(currency)) {
		problem(
			"ASSISTANT_CURRENCY",
			`'${currency}' is not an ISO 4217 code. Use three capital letters such as BTN or USD.`,
		);
	}
	return currency;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function dedupe<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
