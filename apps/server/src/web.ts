import { chmod, readFile, stat } from "node:fs/promises";
import { brave, duckDuckGo, type HttpClient, publicHttp, type WebDeps } from "@assistant/extensions";

type Logger = Pick<Console, "info" | "warn">;

/**
 * The web tools' setup: Brave when `<data>/secrets/search.json` has a key, DuckDuckGo (no key) otherwise. A file that is
 * there and unusable is said in the log and searches go to DuckDuckGo: a typo in a key must not take search away.
 */
export async function createWebSetup(path: string, logger: Logger, http: HttpClient = publicHttp): Promise<WebDeps> {
	const key = await readSearchKey(path, logger).catch((error: unknown) => {
		logger.warn(`[web] ${error instanceof Error ? error.message : String(error)} Searching with DuckDuckGo instead.`);
		return undefined;
	});
	const search = key === undefined ? duckDuckGo(http) : brave(http, key);
	logger.info(`[web] web search through ${search.name}.`);
	return { search, http };
}

async function readSearchKey(path: string, logger: Logger): Promise<string | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
	const key = (parsed as { BRAVE_API_KEY?: unknown } | null)?.BRAVE_API_KEY;
	if (typeof key !== "string" || key.trim() === "") {
		throw new Error(`${path} has no BRAVE_API_KEY. It should read { "BRAVE_API_KEY": "..." }.`);
	}
	return key.trim();
}
