import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireFileLock, LockHeldError, withFileLock } from "../src/file-lock.ts";

let dir: string;
let lockPath: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "assistant-lock-"));
	lockPath = join(dir, "test.lock");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A pid that certainly belonged to a process and no longer does. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid as number;
	await new Promise((resolve) => child.once("exit", resolve));
	return pid;
}

describe("acquireFileLock", () => {
	it("is exclusive: a second acquire fails at once, naming the holder, until the first releases", async () => {
		const first = await acquireFileLock(lockPath);

		await expect(acquireFileLock(lockPath)).rejects.toThrow(LockHeldError);
		await expect(acquireFileLock(lockPath)).rejects.toMatchObject({ holderPid: process.pid });

		await first.release();
		const second = await acquireFileLock(lockPath);
		await second.release();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("takes over a lock whose owner is dead", async () => {
		const pid = await deadPid();
		await writeFile(lockPath, JSON.stringify({ pid, token: "stale", acquiredAt: 1 }));

		const lock = await acquireFileLock(lockPath);

		expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
		await lock.release();
	});

	it("takes over a lock nobody can read", async () => {
		await writeFile(lockPath, "not json");

		const lock = await acquireFileLock(lockPath);
		await lock.release();

		expect(existsSync(lockPath)).toBe(false);
	});

	it.skipIf(!existsSync("/proc/self/stat"))(
		"treats a lock whose pid was reused by another process (another start time) as stale",
		async () => {
			// This very process is running, but it did not write this record: the recorded start time is not ours.
			await writeFile(lockPath, JSON.stringify({ pid: process.pid, startTime: "1", token: "old-boot", acquiredAt: 1 }));

			const lock = await acquireFileLock(lockPath);

			expect(JSON.parse(await readFile(lockPath, "utf8")).token).not.toBe("old-boot");
			await lock.release();
		},
	);

	it("waits for a live holder to release when asked to", async () => {
		const first = await acquireFileLock(lockPath);
		setTimeout(() => void first.release(), 80);

		const started = Date.now();
		const second = await acquireFileLock(lockPath, { waitMs: 5000, pollMs: 10 });

		expect(Date.now() - started).toBeGreaterThanOrEqual(60);
		await second.release();
	});

	it("gives up after waitMs with the holder's pid", async () => {
		const first = await acquireFileLock(lockPath);

		await expect(acquireFileLock(lockPath, { waitMs: 60, pollMs: 10 })).rejects.toThrow(LockHeldError);

		await first.release();
	});

	it("never removes a lock somebody else holds now", async () => {
		const first = await acquireFileLock(lockPath);
		await rm(lockPath);
		const second = await acquireFileLock(lockPath);

		await first.release(); // stale handle: its token no longer matches
		expect(existsSync(lockPath)).toBe(true);

		await second.release();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("serializes critical sections of many contenders and leaves no temp files behind", async () => {
		let inside = 0;
		let overlaps = 0;
		const work = async (): Promise<void> => {
			await withFileLock(lockPath, { waitMs: 10_000, pollMs: 5 }, async () => {
				inside++;
				if (inside > 1) overlaps++;
				await new Promise((resolve) => setTimeout(resolve, 3));
				inside--;
			});
		};

		await Promise.all(Array.from({ length: 12 }, work));

		expect(overlaps).toBe(0);
		expect(await readdir(dir)).toStrictEqual([]);
	});
});
