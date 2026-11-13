import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { MIN_SECRET_LENGTH } from "./scrub.ts";

/**
 * Where the broker keeps credential values. Only the broker reads it; nothing returns a value to an agent, a model or
 * the database. A separate `zbroker` process with systemd-creds storage replaces the file store later (plan §9).
 */
export interface SecretStore {
	/** The secret's value. Throws when there is none: the message names the ref, never a value. */
	get(ref: string): Promise<string>;
}

const REF = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/**
 * One file per secret, `<dir>/<ref>`, its whole content (one trailing newline dropped) being the value. The directory is
 * created 0700 and must not be readable by group or others; each file must be 0600 or stricter, or it is refused.
 */
export function createFileSecretStore(dir: string): SecretStore {
	let prepared: Promise<void> | undefined;
	const prepare = async (): Promise<void> => {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(dir, 0o700);
	};
	return {
		async get(ref) {
			if (!REF.test(ref)) throw new Error(`'${ref}' is not a valid secret name.`);
			prepared ??= prepare();
			await prepared;
			const path = join(dir, ref);
			let mode: number;
			try {
				mode = (await stat(path)).mode;
			} catch {
				throw new Error(`Secret '${ref}' is not set. Write it to ${path} (mode 0600).`);
			}
			if ((mode & 0o077) !== 0) {
				throw new Error(`Secret file ${path} is readable by others. Run: chmod 600 ${path}`);
			}
			const value = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
			return checked(ref, value);
		},
	};
}

/**
 * The `zimpoen-broker` unit's store: systemd decrypts each `LoadCredentialEncrypted=<ref>:...` into
 * `$CREDENTIALS_DIRECTORY/<ref>`, readable only by the service. `dir` is that variable's value; a missing variable is an
 * error naming the unit setting, so a broker started outside systemd says why it has no secrets.
 */
export function createSystemdCredsStore(dir: string | undefined): SecretStore {
	if (dir === undefined || dir === "") {
		throw new Error(
			"CREDENTIALS_DIRECTORY is not set: the systemd-creds store only works inside a unit with LoadCredentialEncrypted= " +
				"(ops/systemd/zimpoen-broker.service). For development use ZIMPOEN_BROKER_SECRETS=file.",
		);
	}
	return {
		async get(ref) {
			if (!REF.test(ref)) throw new Error(`'${ref}' is not a valid secret name.`);
			let value: string;
			try {
				value = await readFile(join(dir, ref), "utf8");
			} catch {
				throw new Error(
					`Secret '${ref}' is not loaded. Add LoadCredentialEncrypted=${ref}:/etc/credstore.encrypted/${ref} to zimpoen-broker.service.`,
				);
			}
			return checked(ref, value.replace(/\r?\n$/, ""));
		},
	};
}

/** For tests: secrets held in memory. */
export function createMemorySecretStore(values: Readonly<Record<string, string>>): SecretStore {
	return {
		async get(ref) {
			const value = values[ref];
			if (value === undefined) throw new Error(`Secret '${ref}' is not set.`);
			return checked(ref, value);
		},
	};
}

function checked(ref: string, value: string): string {
	if (value.length < MIN_SECRET_LENGTH) {
		throw new Error(
			`Secret '${ref}' is shorter than ${MIN_SECRET_LENGTH} characters, too short to scrub from output reliably.`,
		);
	}
	return value;
}
