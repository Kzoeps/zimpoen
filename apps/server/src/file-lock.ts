import { randomBytes } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";

/**
 * A lock between processes on this machine, held as a file that names its owner.
 *
 * - Created atomically with content: the owner's record is written to a temp file, which is then hard-linked to the
 *   lock path. `link` fails when the path exists, so exactly one contender wins and nobody ever sees a half-written lock.
 * - A lock whose owner has died is taken over. "Died" is the owner's pid being gone, or being reused by another
 *   process: a laptop that was power-cycled leaves a lock behind whose pid may belong to something else after the next
 *   boot, so on Linux the owner's start time is recorded and compared too.
 * - Takeover renames the stale file away first, so only one contender removes it. The race between two processes
 *   taking over the same stale lock at the very same instant is narrowed (the loser puts a live lock back), not
 *   eliminated; for one person's laptop that is accepted.
 */

type LockRecord = {
	pid: number;
	/** Field 22 of /proc/<pid>/stat; absent where the OS does not offer it. */
	startTime?: string;
	/** Distinguishes this acquisition from any other by the same process. */
	token: string;
	acquiredAt: number;
};

export class LockHeldError extends Error {
	readonly path: string;
	readonly holderPid: number;

	constructor(path: string, holderPid: number) {
		super(`${path} is held by process ${holderPid}, which is still running.`);
		this.name = "LockHeldError";
		this.path = path;
		this.holderPid = holderPid;
	}
}

export type FileLock = {
	readonly path: string;
	/** Remove the lock if it is still ours. Safe to call more than once. */
	release(): Promise<void>;
};

export type AcquireOptions = {
	/** How long to keep trying while a live process holds the lock. Default 0: fail at once with {@link LockHeldError}. */
	waitMs?: number;
	/** Pause between attempts while waiting. Default 25 ms. */
	pollMs?: number;
};

export async function acquireFileLock(path: string, options: AcquireOptions = {}): Promise<FileLock> {
	const deadline = Date.now() + (options.waitMs ?? 0);
	const mine: LockRecord = {
		pid: process.pid,
		startTime: await processStartTime(process.pid),
		token: randomBytes(8).toString("hex"),
		acquiredAt: Date.now(),
	};

	for (;;) {
		if (await createLock(path, mine)) return lockFor(path, mine);
		const holder = await readRecord(path);
		if (holder !== undefined && (await isRunning(holder))) {
			if (Date.now() >= deadline) throw new LockHeldError(path, holder.pid);
			await sleep(options.pollMs ?? 25);
			continue;
		}
		// The file vanished while we looked (retry at once), is unreadable, or names a dead owner: clear it.
		if (holder !== undefined || (await exists(path))) await removeStale(path, holder);
	}
}

/** Run `work` while holding the lock at `path`, waiting up to `options.waitMs` for it. */
export async function withFileLock<T>(path: string, options: AcquireOptions, work: () => Promise<T>): Promise<T> {
	const lock = await acquireFileLock(path, options);
	try {
		return await work();
	} finally {
		await lock.release();
	}
}

function lockFor(path: string, mine: LockRecord): FileLock {
	return {
		path,
		release: async () => {
			const current = await readRecord(path);
			if (current?.token === mine.token) await unlink(path).catch(ignoreMissing);
		},
	};
}

/** True when this call created the lock; false when it already exists. */
async function createLock(path: string, record: LockRecord): Promise<boolean> {
	const temp = `${path}.${record.pid}.${record.token}.tmp`;
	const file = await open(temp, "wx", 0o600);
	try {
		await file.writeFile(JSON.stringify(record));
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await link(temp, path);
		return true;
	} catch (error) {
		if (codeOf(error) === "EEXIST") return false;
		throw error;
	} finally {
		await unlink(temp).catch(ignoreMissing);
	}
}

async function readRecord(path: string): Promise<LockRecord | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	}
	try {
		const parsed = JSON.parse(text) as Partial<LockRecord>;
		if (typeof parsed.pid === "number" && typeof parsed.token === "string") return parsed as LockRecord;
	} catch {
		// Falls through: a lock nobody can read has no owner to wait for.
	}
	return undefined;
}

async function isRunning(record: LockRecord): Promise<boolean> {
	try {
		process.kill(record.pid, 0);
	} catch (error) {
		if (codeOf(error) === "ESRCH") return false;
		// EPERM: the process exists but belongs to someone else.
	}
	const startTime = await processStartTime(record.pid);
	return !(record.startTime !== undefined && startTime !== undefined && record.startTime !== startTime);
}

/** Move the stale lock out of the way (only one contender's rename succeeds) and discard it. */
async function removeStale(path: string, stale: LockRecord | undefined): Promise<void> {
	const grave = `${path}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
	try {
		await rename(path, grave);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return;
		throw error;
	}
	const moved = await readRecord(grave);
	if (moved !== undefined && moved.token !== stale?.token && (await isRunning(moved))) {
		// Another contender replaced the stale lock between our read and our rename, and we just moved its live one.
		try {
			await link(grave, path);
		} catch (error) {
			if (codeOf(error) !== "EEXIST") throw error;
			await unlink(grave).catch(ignoreMissing);
			throw new LockHeldError(path, moved.pid);
		}
	}
	await unlink(grave).catch(ignoreMissing);
}

async function processStartTime(pid: number): Promise<string | undefined> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		// The command name (field 2) may contain spaces and parentheses, so count fields after the last ')'.
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch (error) {
		return codeOf(error) !== "ENOENT";
	}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ignoreMissing(error: unknown): void {
	if (codeOf(error) !== "ENOENT") throw error;
}

function codeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}
