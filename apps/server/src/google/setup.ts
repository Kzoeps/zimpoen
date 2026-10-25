import { existsSync } from "node:fs";
import { chmod, readFile, stat } from "node:fs/promises";
import {
	createFakeGoogle,
	createJevTriage,
	createRulesTriage,
	type FakeGoogle,
	type GoogleGateway,
	seedDemoMailbox,
	type Triage,
} from "@assistant/extensions";
import type { Config } from "../config.ts";
import { createFileTokenProvider, GoogleAccountStore } from "./accounts.ts";
import { createCalendarClient } from "./calendar.ts";
import { readGoogleClient } from "./client-secret.ts";
import { createGmailClient } from "./gmail.ts";
import { guardedFetch } from "./oauth.ts";

type Logger = Pick<Console, "info" | "warn">;

export type GoogleSetup = {
	gateway: GoogleGateway;
	/** The scripted Google, in `fake` mode: development's mailbox, which a test or the browser check can add to. */
	fake?: FakeGoogle;
};

export type GoogleSetupOptions = {
	logger?: Logger;
	now?: () => number;
	/** Replaces `fetch` in `real` mode, so that a test can play Google. Only Google's own hosts (and `allowHosts`) are reachable through it. */
	fetch?: typeof fetch;
	allowHosts?: readonly string[];
	/** Replaces the scripted Google of `fake` mode. */
	fake?: FakeGoogle;
};

/**
 * What the Inbox module reads Google through, for the configured mode. `fake`: a scripted mailbox with a few believable mails
 * and events, in memory, no network. `real`: Gmail and Calendar over their REST APIs with the sign-ins `pnpm connect:google`
 * saved; the HTTP clients can only `GET`, only to Google's hosts, and only with the two read-only scopes.
 */
export async function createGoogleSetup(config: Config, options: GoogleSetupOptions = {}): Promise<GoogleSetup> {
	const logger = options.logger ?? console;
	const now = options.now ?? Date.now;
	if (config.google.mode === "fake") {
		const fake = options.fake ?? createFakeGoogle({ now });
		if (options.fake === undefined) seedDemoMailbox(fake, now());
		logger.info("[google] ASSISTANT_GOOGLE_MODE=fake: a scripted mailbox, nothing is read from Google.");
		return { gateway: fake, fake };
	}

	const store = new GoogleAccountStore(config.paths.googleAccounts);
	if (await store.ensurePrivate()) {
		logger.warn(
			`[google] ${config.paths.googleAccounts} was readable by other users; restricted it to its owner (0600).`,
		);
	}
	const leftovers = await store.cleanupTempFiles();
	if (leftovers > 0) logger.warn(`[google] removed ${leftovers} temp file(s) a crashed write had left behind.`);
	if (!existsSync(config.paths.googleOAuth)) {
		logger.info(
			`[google] no OAuth client file at ${config.paths.googleOAuth}: no account can be connected yet (docs/setup-google.md).`,
		);
	}

	const send = guardedFetch(options.fetch, options.allowHosts);
	const tokens = createFileTokenProvider({
		store,
		client: () => readGoogleClient(config.paths.googleOAuth),
		fetch: send,
		now,
	});
	const http = { tokens, fetch: send };
	return {
		gateway: {
			mode: "real",
			get clientConfigured() {
				return existsSync(config.paths.googleOAuth);
			},
			gmail: createGmailClient(http),
			calendar: createCalendarClient({ ...http, timezone: config.profile.timezone }),
			tokens,
		},
	};
}

export type TriageSetup = {
	triage: Triage;
	/** Why the key could not be used, when there is a file and it is no good: the server records it and falls back to the rules. */
	problem?: string;
};

/** Read `JEV_API_KEY` from `<data>/secrets/jev.json`. Undefined when the file is not there. A file that is there and no good is an error. */
export async function readJevKey(path: string, logger: Logger = console): Promise<string | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (((await stat(path)).mode & 0o077) !== 0) {
		await chmod(path, 0o600);
		logger.warn(`[jev] ${path} was readable by other users; restricted it to its owner (0600).`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`${path} is not valid JSON. It should read { "JEV_API_KEY": "..." } (docs/setup-jev.md).`);
	}
	const key = (parsed as { JEV_API_KEY?: unknown } | null)?.JEV_API_KEY;
	if (typeof key !== "string" || key.trim() === "") {
		throw new Error(`${path} has no JEV_API_KEY. It should read { "JEV_API_KEY": "..." } (docs/setup-jev.md).`);
	}
	return key.trim();
}

/** Jev when a key is saved, the local rules when not (or when the file is unusable: that is said, not fatal). */
export async function createTriageSetup(
	config: Config,
	options: { logger?: Logger; fetch?: typeof fetch } = {},
): Promise<TriageSetup> {
	const logger = options.logger ?? console;
	try {
		const key = await readJevKey(config.paths.jev, logger);
		if (key === undefined) {
			logger.info("[jev] no key in <data>/secrets/jev.json: mail is classified by local rules (docs/setup-jev.md).");
			return { triage: createRulesTriage() };
		}
		logger.info("[jev] a key is saved: mail is classified by Jev (api.typesafe.ai).");
		return {
			triage: createJevTriage({ apiKey: key, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) }),
		};
	} catch (error) {
		const problem = error instanceof Error ? error.message : String(error);
		logger.warn(`[jev] ${problem} Mail is classified by local rules until it is fixed.`);
		return { triage: createRulesTriage(), problem };
	}
}
