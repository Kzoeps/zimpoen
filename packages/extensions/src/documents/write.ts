import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** Write to a temp file next to `path` and rename it over, so a crash never leaves half a file. */
export async function writeFileAtomicBytes(path: string, bytes: Uint8Array | string): Promise<void> {
	const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(temp, bytes, { mode: 0o600 });
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

export const writeFileAtomicText = (path: string, text: string): Promise<void> => writeFileAtomicBytes(path, text);
