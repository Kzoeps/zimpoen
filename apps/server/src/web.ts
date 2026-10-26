import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { WebCallResult, WebContent, WebDeps } from "@assistant/extensions";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Logger = Pick<Console, "info" | "warn">;

/**
 * The web tools run in pi-web-access's own MCP server (`pi-web-access-mcp`), a child process of this one. A child keeps
 * its dependencies, its in-memory result store and any crash away from the server, and it gets only what it needs: a
 * clean environment, its own config directory under the data directory (never the owner's `~/.pi`) and the search keys
 * from `<data>/secrets/search.json`. It is started on the first call and started again after it dies.
 */

/** How long one web call may take before it is given up. A search with page content can take a while. */
const CALL_TIMEOUT_MS = 120_000;

/** Search providers tried in order, each falling back to the next on a transient, quota, network or bad answer. */
const KEYLESS_ROUTE = ["exa", "duckduckgo"];
/** Keys (env var names, as pi-web-access reads them) that put a provider ahead of the keyless ones. */
const KEYED_PROVIDERS: ReadonlyArray<[env: string, provider: string]> = [
	["BRAVE_API_KEY", "brave"],
	["TAVILY_API_KEY", "tavily"],
	["EXA_API_KEY", "exa"],
	["PERPLEXITY_API_KEY", "perplexity"],
	["KAGI_API_KEY", "kagi"],
];
const KEY_NAME = /^[A-Z][A-Z0-9_]*_(API_KEY|KEY|TOKEN)$/;

export type WebSetupOptions = {
	/** `<data>/web`: the child's home and config directory. */
	dir: string;
	/** `<data>/secrets/search.json`: `{ "BRAVE_API_KEY": "..." }` and the like. Optional. */
	keysPath: string;
	logger: Logger;
};

export type WebService = WebDeps & { close(): Promise<void> };

export async function createWebSetup(options: WebSetupOptions): Promise<WebService> {
	const { dir, logger } = options;
	const keys: Record<string, string> = await readSearchKeys(options.keysPath, logger).catch((error: unknown) => {
		logger.warn(`[web] ${error instanceof Error ? error.message : String(error)} Searching without keys.`);
		return {};
	});
	const keyed = KEYED_PROVIDERS.filter(([env]) => keys[env] !== undefined).map(([, provider]) => provider);
	const providers = [...new Set([...keyed, ...KEYLESS_ROUTE])];
	await mkdir(dir, { recursive: true, mode: 0o700 });
	// Written at every start, so the route follows the keys. Browser cookies stay off (they are pi-web-access's default too).
	await writeFile(
		join(dir, "web-search.json"),
		`${JSON.stringify(
			{
				searchRouting: { providers, fallbackOn: ["transient", "quota", "network", "invalid-response"] },
				allowBrowserCookies: false,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	logger.info(`[web] web tools through pi-web-access; search tries ${providers.join(", then ")}.`);
	return createWebClient({
		command: process.execPath,
		args: [mcpCliPath()],
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: dir,
			PI_CODING_AGENT_DIR: dir,
			LANG: process.env.LANG ?? "C.UTF-8",
			...keys,
		},
		cwd: dir,
		logger,
	});
}

/** The bundled MCP server of the installed pi-web-access. */
function mcpCliPath(): string {
	const pkg = createRequire(import.meta.url).resolve("pi-web-access/package.json");
	return join(dirname(pkg), "dist", "mcp-cli.js");
}

async function readSearchKeys(path: string, logger: Logger): Promise<Record<string, string>> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	if (((await stat(path)).mode & 0o077) !== 0) {
		await chmod(path, 0o600);
		logger.warn(`[web] ${path} was readable by other users; restricted it to its owner (0600).`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`${path} is not valid JSON. It should read { "BRAVE_API_KEY": "..." }.`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${path} should be an object of keys, like { "BRAVE_API_KEY": "..." }.`);
	}
	const keys: Record<string, string> = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (!KEY_NAME.test(name) || typeof value !== "string" || value.trim() === "") {
			logger.warn(`[web] ignored '${name.slice(0, 40)}' in ${path}: only NAME_API_KEY entries with a value are used.`);
			continue;
		}
		keys[name] = value.trim();
	}
	return keys;
}

export type WebClientOptions = {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	logger: Logger;
	timeoutMs?: number;
};

/** An MCP client to the child, connected on first use and again after the child has died. */
export function createWebClient(options: WebClientOptions): WebService {
	let connecting: Promise<Client> | undefined;
	let closed = false;

	const connect = (): Promise<Client> => {
		if (connecting !== undefined) return connecting;
		const attempt = (async () => {
			const transport = new StdioClientTransport({
				command: options.command,
				args: options.args,
				env: options.env,
				cwd: options.cwd,
				stderr: "pipe",
			});
			transport.stderr?.on("data", (chunk: Buffer) => {
				const line = chunk.toString("utf8").trim();
				if (line !== "") options.logger.warn(`[web] ${line.slice(0, 500)}`);
			});
			const client = new Client({ name: "zimpoen", version: "0.0.0" });
			client.onclose = () => {
				// The child exited: the next call starts a new one.
				if (connecting === attempt) connecting = undefined;
			};
			await client.connect(transport);
			return client;
		})();
		connecting = attempt;
		attempt.catch(() => {
			if (connecting === attempt) connecting = undefined;
		});
		return attempt;
	};

	return {
		async call(tool, args, signal): Promise<WebCallResult> {
			if (closed) throw new Error("The web tools have been shut down with the server.");
			let client: Client;
			try {
				client = await connect();
			} catch (error) {
				throw new Error(
					`The web tools could not start (${error instanceof Error ? error.message : String(error)}). The server log says more.`,
				);
			}
			const result = await client.callTool({ name: tool, arguments: args }, undefined, {
				timeout: options.timeoutMs ?? CALL_TIMEOUT_MS,
				...(signal === undefined ? {} : { signal }),
			});
			return { content: contentOf(result.content), isError: result.isError === true };
		},
		async close() {
			closed = true;
			const pending = connecting;
			connecting = undefined;
			if (pending !== undefined) await (await pending.catch(() => undefined))?.close();
		},
	};
}

/** Text and images pass; anything else MCP can carry (resources, audio) is named, not passed on. */
function contentOf(content: unknown): WebContent[] {
	if (!Array.isArray(content)) return [];
	return content.map((part: { type?: string; text?: string; data?: string; mimeType?: string }): WebContent => {
		if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			return { type: "image", data: part.data, mimeType: part.mimeType };
		}
		return { type: "text", text: `(a ${String(part.type)} part was left out)` };
	});
}
