import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Replace `path` with `text` so that a crash leaves either the old file or the new one, never half of it: write a
 * private temp file next to it, flush it, rename it over the target and flush the directory (without that a power cut can
 * bring the old file back). The temp file is created with `mode` from the start, so a secret is never readable by others,
 * not even briefly.
 */
export async function writeFileAtomic(path: string, text: string, mode: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		const file = await open(temp, "wx", mode);
		try {
			await file.writeFile(text);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temp, path);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}
