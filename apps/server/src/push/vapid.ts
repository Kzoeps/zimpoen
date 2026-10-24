import { chmod, readFile, stat } from "node:fs/promises";
import webPush from "web-push";
import { writeFileAtomic } from "../atomic-file.ts";

/** The server's identity towards push services (RFC 8292). The public half goes to browsers; the private half never leaves. */
export type VapidKeys = { publicKey: string; privateKey: string };

type Logger = Pick<Console, "info" | "warn">;

/**
 * Read the key pair from `path`, or create it on the first start (mode 0600, written atomically).
 *
 * A browser's subscription is bound to the public key it subscribed with, so losing this file does not just rotate a
 * secret: every subscribed device goes quiet until its owner enables notifications again. The error for a damaged file
 * says so instead of silently making new keys.
 */
export async function loadOrCreateVapidKeys(path: string, logger: Logger = console): Promise<VapidKeys> {
	let text: string | undefined;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (text === undefined) {
		const keys = webPush.generateVAPIDKeys();
		await writeFileAtomic(
			path,
			`${JSON.stringify({ ...keys, createdAt: new Date().toISOString() }, null, "\t")}\n`,
			0o600,
		);
		logger.info(`[push] generated a new Web Push key pair in ${path}`);
		return keys;
	}
	const keys = parseKeys(text, path);
	if (((await stat(path)).mode & 0o077) !== 0) {
		await chmod(path, 0o600);
		logger.warn(`[push] ${path} was readable by other users; restricted it to its owner (0600).`);
	}
	return keys;
}

function parseKeys(text: string, path: string): VapidKeys {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	const { publicKey, privateKey } = (parsed ?? {}) as Partial<VapidKeys>;
	if (typeof publicKey !== "string" || publicKey === "" || typeof privateKey !== "string" || privateKey === "") {
		throw new Error(
			`${path} is not a Web Push key file (it needs "publicKey" and "privateKey"). Restore it from a backup. ` +
				"If it is lost, delete it and the server creates a new pair at the next start, but every device that " +
				"enabled notifications must then enable them again.",
		);
	}
	return { publicKey, privateKey };
}
