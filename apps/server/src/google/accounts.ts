import { chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type TokenAccount, type TokenProvider, TokenRevokedError } from "@assistant/extensions";
import { writeFileAtomic } from "../atomic-file.ts";
import { withFileLock } from "../file-lock.ts";
import type { GoogleClient } from "./client-secret.ts";
import { GoogleOAuthError, guardedFetch, type OAuthEndpoints, refreshAccessToken } from "./oauth.ts";

/** A refresh runs inside the lock only to record that Google refused it, so waiting must outlast a slow write, not a request. */
const LOCK_WAIT_MS = 10_000;

export type StoredAccount = {
	email: string;
	/** The long-lived secret. Never logged, never shown, never readable through an agent's environment (`<data>/secrets`). */
	refreshToken: string;
	scopes: string[];
	/** When the owner approved this sign-in, epoch ms. */
	connectedAt: number;
	/** `needs_reconnect` once Google refused the refresh token. Connecting the account again writes a fresh `ok` record. */
	status: "ok" | "needs_reconnect";
	revokedAt?: number;
};

type FileShape = { version: 1; accounts: Record<string, StoredAccount> };

/**
 * `google-accounts.json`: one refresh token per connected Google account. Like the credential file it is created 0600 and
 * replaced atomically (a crash never leaves half a token, a power cut cannot bring the old file back), a file that cannot be
 * parsed is an error and never "empty" (starting from `{}` would overwrite the owner's sign-ins on the next write), and
 * changes run one at a time, in this process through a queue and between processes through `<file>.lock`: `pnpm
 * connect:google` runs beside the server.
 */
export class GoogleAccountStore {
	readonly path: string;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
	}

	async list(): Promise<StoredAccount[]> {
		return Object.values((await this.#load()).accounts).sort((a, b) => a.email.localeCompare(b.email));
	}

	async get(email: string): Promise<StoredAccount | undefined> {
		return (await this.#load()).accounts[email];
	}

	/** Save an account's sign-in (new, or replacing the one it had). */
	save(account: StoredAccount): Promise<void> {
		return this.#change((file) => {
			file.accounts[account.email] = account;
		});
	}

	/** Google refused the account's refresh token: keep the record (so Settings can say so) and mark it. */
	markRevoked(email: string, at: number): Promise<void> {
		return this.#change((file) => {
			const account = file.accounts[email];
			if (account !== undefined && account.status !== "needs_reconnect") {
				file.accounts[email] = { ...account, status: "needs_reconnect", revokedAt: at };
			}
		});
	}

	/** Forget the account's sign-in. False when there was none. */
	async remove(email: string): Promise<boolean> {
		let removed = false;
		await this.#change((file) => {
			removed = file.accounts[email] !== undefined;
			delete file.accounts[email];
		});
		return removed;
	}

	/** Make the file private if it was copied in loosely. True when it had to change it, so the caller can warn. */
	async ensurePrivate(): Promise<boolean> {
		try {
			const { mode } = await stat(this.path);
			if ((mode & 0o077) === 0) return false;
			await chmod(this.path, 0o600);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	/** Remove temp files a crashed write left behind: they hold a copy of the tokens. Returns how many. */
	async cleanupTempFiles(): Promise<number> {
		const prefix = basename(this.path);
		const names = (await readdir(dirname(this.path)).catch(() => [] as string[])).filter(
			(name) => name.startsWith(`${prefix}.`) && /\.\d+\.[0-9a-f]{8}\.tmp$/.test(name),
		);
		await Promise.all(names.map((name) => rm(join(dirname(this.path), name), { force: true })));
		return names.length;
	}

	#change(change: (file: FileShape) => void): Promise<void> {
		const run = this.#queue
			.catch(() => {})
			.then(async () => {
				await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
				await withFileLock(`${this.path}.lock`, { waitMs: LOCK_WAIT_MS }, async () => {
					const file = await this.#load();
					change(file);
					await writeFileAtomic(this.path, `${JSON.stringify(file, null, "\t")}\n`, 0o600);
				});
			});
		this.#queue = run;
		return run;
	}

	async #load(): Promise<FileShape> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, accounts: {} };
			throw error;
		}
		return parseAccounts(text, this.path);
	}
}

function parseAccounts(text: string, path: string): FileShape {
	const fix = "Fix the file, or delete it and connect the accounts again (it holds only sign-ins).";
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not valid JSON (${(error as Error).message}). ${fix}`);
	}
	const accounts = (parsed as { accounts?: unknown } | null)?.accounts;
	if (typeof accounts !== "object" || accounts === null || Array.isArray(accounts)) {
		throw new Error(`${path} must hold { "version": 1, "accounts": { ... } }. ${fix}`);
	}
	for (const [email, account] of Object.entries(accounts)) {
		const record = account as Partial<StoredAccount> | null;
		if (
			typeof record?.refreshToken !== "string" ||
			record.refreshToken === "" ||
			typeof record.connectedAt !== "number" ||
			(record.status !== "ok" && record.status !== "needs_reconnect")
		) {
			throw new Error(`${path} has an invalid entry for ${email}. ${fix}`);
		}
	}
	return { version: 1, accounts: accounts as Record<string, StoredAccount> };
}

/** Access tokens live an hour; one is used until this long before it ends. */
const EARLY_MS = 120_000;

export type FileTokenProviderOptions = {
	store: GoogleAccountStore;
	/** The OAuth client; read again each time it is needed, so the owner can save it after the server started. */
	client: () => Promise<GoogleClient | undefined>;
	fetch?: typeof fetch;
	endpoints?: OAuthEndpoints;
	now?: () => number;
};

/**
 * The `TokenProvider` of real mode: refresh tokens from the account file, access tokens made from them when asked and kept
 * in memory only. When Google answers `invalid_grant` the account is marked in the file and {@link TokenRevokedError} is
 * thrown; any other failure (the network, a 5xx) is thrown as it is, so the sync backs off and tries again.
 */
export function createFileTokenProvider(options: FileTokenProviderOptions): TokenProvider {
	const now = options.now ?? Date.now;
	const send = options.fetch ?? guardedFetch();
	const cache = new Map<string, { token: string; expiresAt: number }>();
	const inFlight = new Map<string, Promise<string>>();
	// Bumped when an account is removed: a refresh that began before it must not put its token back after the removal.
	const removals = new Map<string, number>();

	async function refresh(email: string): Promise<string> {
		const removalsBefore = removals.get(email) ?? 0;
		const account = await options.store.get(email);
		if (account === undefined) throw new Error(`${email} is not connected. Run pnpm connect:google.`);
		if (account.status === "needs_reconnect") throw new TokenRevokedError(email);
		const client = await options.client();
		if (client === undefined) {
			throw new Error(
				"google-oauth.json is missing: save the OAuth client's JSON in <data>/secrets (docs/setup-google.md).",
			);
		}
		try {
			const tokens = await refreshAccessToken({
				client,
				refreshToken: account.refreshToken,
				fetch: send,
				...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
			});
			if ((removals.get(email) ?? 0) !== removalsBefore)
				throw new Error(`${email} was disconnected: its access token is not kept.`);
			cache.set(email, { token: tokens.accessToken, expiresAt: now() + tokens.expiresInSec * 1000 - EARLY_MS });
			return tokens.accessToken;
		} catch (error) {
			if (error instanceof GoogleOAuthError && error.error === "invalid_grant") {
				cache.delete(email);
				await options.store.markRevoked(email, now());
				throw new TokenRevokedError(email);
			}
			throw error;
		}
	}

	return {
		async accounts(): Promise<TokenAccount[]> {
			return (await options.store.list()).map((account) => ({
				email: account.email,
				status: account.status,
				connectedAt: account.connectedAt,
			}));
		},

		async accessToken(email, requestOptions) {
			requestOptions?.signal?.throwIfAborted();
			const cached = cache.get(email);
			if (cached !== undefined && cached.expiresAt > now() && requestOptions?.refresh !== true) return cached.token;
			// One refresh at a time per account: two requests that both find the cache empty share it.
			let pending = inFlight.get(email);
			if (pending === undefined) {
				pending = refresh(email).finally(() => inFlight.delete(email));
				inFlight.set(email, pending);
			}
			return await pending;
		},

		async remove(email) {
			removals.set(email, (removals.get(email) ?? 0) + 1);
			cache.delete(email);
			inFlight.delete(email);
			await options.store.remove(email);
		},
	};
}
