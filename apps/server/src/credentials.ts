import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { withFileLock } from "./file-lock.ts";

/** A refresh runs inside `modify()` while the lock is held, so waiting must outlast a slow token request. */
const LOCK_WAIT_MS = 30_000;

/**
 * pi-ai `CredentialStore` backed by one JSON file, `{ "<providerId>": Credential }`, the shape of pi's `auth.json`.
 *
 * - The file is created with mode 0600 and replaced atomically (write a temp file, fsync it, rename it over the file,
 *   fsync the directory), so a crash never leaves half a token on disk and a power cut cannot lose the rename.
 * - `modify()` and `delete()` run one at a time: through an in-process queue, which stops two concurrent requests from
 *   both refreshing one rotated OAuth token, and through `<file>.lock` between processes, so a login command can run
 *   beside the server. The lock is held for the whole read, refresh and write.
 * - A file that exists but cannot be parsed is an error, never "empty": silently starting from `{}` would overwrite the
 *   user's tokens on the next write.
 */
export class FileCredentialStore implements CredentialStore {
	readonly path: string;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return (await this.#load())[providerId];
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const all = await this.#load();
		return Object.entries(all).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#exclusive(async () => {
			options?.signal?.throwIfAborted();
			const current = (await this.#load())[providerId];
			const next = await fn(current);
			options?.signal?.throwIfAborted();
			if (next === undefined) return current;
			await this.#store((all) => {
				all[providerId] = next;
			});
			return next;
		});
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#exclusive(async () => {
			options?.signal?.throwIfAborted();
			await this.#store((all) => {
				delete all[providerId];
			});
		});
	}

	/**
	 * Remove temp files a crashed write left behind: they hold a copy of the tokens. Call at startup, when no other
	 * write of this server can be in flight. Returns how many were removed.
	 */
	cleanupTempFiles(): Promise<number> {
		return this.#exclusive(async () => {
			const prefix = basename(this.path);
			const leftovers = (await readdir(dirname(this.path)).catch(() => [] as string[])).filter(
				(name) => name.startsWith(`${prefix}.`) && /\.\d+\.[0-9a-f]{8}\.tmp$/.test(name),
			);
			await Promise.all(leftovers.map((name) => rm(join(dirname(this.path), name), { force: true })));
			return leftovers.length;
		});
	}

	/**
	 * Make the file private if it exists with looser permissions (for example copied in by hand).
	 * Returns true when it had to change them, so the caller can warn.
	 */
	async ensurePrivate(): Promise<boolean> {
		try {
			const { mode } = await stat(this.path);
			if ((mode & 0o077) === 0) return false;
			await chmod(this.path, 0o600);
			return true;
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	}

	/** One at a time in this process, then one at a time on this machine. A failed task never blocks the queue. */
	#exclusive<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#queue.catch(() => {}).then(() => this.#withProcessLock(task));
		this.#queue = run;
		return run;
	}

	async #withProcessLock<T>(task: () => Promise<T>): Promise<T> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		return withFileLock(`${this.path}.lock`, { waitMs: LOCK_WAIT_MS }, task);
	}

	/** Read-modify-write of the whole file. The caller holds the lock. */
	async #store(change: (all: Record<string, Credential>) => void): Promise<void> {
		const all = await this.#load();
		change(all);
		await this.#write(all);
	}

	async #load(): Promise<Record<string, Credential>> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if (isMissing(error)) return {};
			throw error;
		}
		return parseCredentials(text, this.path);
	}

	async #write(all: Record<string, Credential>): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			const file = await open(temp, "wx", 0o600);
			try {
				await file.writeFile(`${JSON.stringify(all, null, "\t")}\n`);
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temp, this.path);
			await syncDirectory(dirname(this.path));
		} catch (error) {
			await rm(temp, { force: true });
			throw error;
		}
	}
}

/** Makes a rename durable: without it a power cut can bring the old file back. */
async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

function parseCredentials(text: string, path: string): Record<string, Credential> {
	const fix = `Fix the file, or delete it and sign in again (it holds only login tokens).`;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`Credential file ${path} is not valid JSON (${(error as Error).message}). ${fix}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Credential file ${path} must contain a JSON object keyed by provider id. ${fix}`);
	}
	for (const [providerId, credential] of Object.entries(parsed)) {
		if (!isCredential(credential)) {
			throw new Error(
				`Credential file ${path} has an invalid entry for provider '${providerId}': expected an object with type "oauth" or "api_key". ${fix}`,
			);
		}
	}
	return parsed as Record<string, Credential>;
}

function isCredential(value: unknown): value is Credential {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "oauth" || type === "api_key";
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}
