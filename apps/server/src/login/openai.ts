import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { writeFileAtomic } from "../atomic-file.ts";
import { type Env, resolveDataPaths } from "../config.ts";
import { FileCredentialStore } from "../credentials.ts";

export type OpenAiAuthOptions = {
	argv: readonly string[];
	env: Env;
	print: (line: string) => void;
	/** Asks the person at the keyboard a question; rejects when `signal` aborts (the browser callback arrived first). */
	ask?: (question: string, signal?: AbortSignal) => Promise<string>;
	/** Replaces the real OpenAI provider, so that a test can play the sign-in. Its id must be `openai`. */
	provider?: Provider;
};

const PROVIDER_ID = "openai";

const LOGIN_USAGE = `Sign the assistant in to OpenAI with your ChatGPT subscription (the model it talks to).

  pnpm login:openai          sign in: prints a link, you approve it in a browser, the sign-in is saved
  pnpm logout:openai         remove the saved sign-in

It saves the sign-in in <data>/secrets/credentials.json (mode 0600); the server reads it when it needs it, so no restart is
needed. Nothing here sends a message or spends anything. Sign in with the account you want the assistant to use, and not
with the same sign-in you use in another program (two programs sharing one refresh token can sign each other out).`;

const LOGOUT_USAGE =
	"Remove the assistant's saved OpenAI sign-in (<data>/secrets/credentials.json).\n\n  pnpm logout:openai";

/**
 * OpenAI asks each installation to identify itself with a stable id, and the same one every time: a random id per login
 * would register a new "agent host" with every sign-in. It is made once and kept next to the credentials (0600).
 */
export async function deviceIdIn(secrets: string): Promise<string> {
	const path = join(secrets, "device-id");
	try {
		const existing = (await readFile(path, "utf8")).trim();
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) return existing;
	} catch {
		// Not made yet.
	}
	const id = randomUUID();
	await writeFileAtomic(path, `${id}\n`, 0o600);
	return id;
}

async function prepare(env: Env): Promise<{ store: FileCredentialStore; credentialsPath: string; secrets: string }> {
	const { paths } = resolveDataPaths(env);
	const secrets = dirname(paths.credentials);
	// `<data>/secrets` is private (PLAN rule 9), whoever made it first.
	await mkdir(secrets, { recursive: true, mode: 0o700 });
	await chmod(secrets, 0o700);
	return { store: new FileCredentialStore(paths.credentials), credentialsPath: paths.credentials, secrets };
}

function withProvider(store: FileCredentialStore, provider: Provider | undefined) {
	const models = createModels({ credentials: store });
	models.setProvider(provider ?? openaiProvider());
	return models;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What the sign-in flow tells the person, in words; the tokens it gets are never printed. */
function notifier(print: (line: string) => void): AuthInteraction["notify"] {
	return (event: AuthEvent) => {
		switch (event.type) {
			case "auth_url":
				print("1. Open this link in a browser on THIS computer and sign in with your ChatGPT account:\n");
				print(`   ${event.url}\n`);
				print("2. Approve the access. The browser then shows a confirmation and this command finishes by itself.");
				print(
					"   Signing in from another machine (over SSH)? Your browser's last page will not load: copy its whole address\n" +
						"   (it starts with http://127.0.0.1:1455/auth/callback) and paste it below.\n",
				);
				break;
			case "device_code":
				print(`Open ${event.verificationUri} and enter the code ${event.userCode}.`);
				break;
			case "info":
			case "progress":
				print(event.message);
				break;
		}
	};
}

/** `pnpm login:openai`. Returns the exit code. */
export async function runLoginOpenAI(options: OpenAiAuthOptions): Promise<number> {
	const { print } = options;
	try {
		const { values } = parseArgs({
			args: [...options.argv],
			options: { help: { type: "boolean", short: "h" } },
			strict: true,
		});
		if (values.help === true) {
			print(LOGIN_USAGE);
			return 0;
		}
	} catch (error) {
		print(`${messageOf(error)}\n\n${LOGIN_USAGE}`);
		return 2;
	}
	try {
		const { store, credentialsPath, secrets } = await prepare(options.env);
		const models = withProvider(store, options.provider);
		const ask = options.ask;
		if (ask === undefined) throw new Error("This command needs a terminal to ask questions in.");
		print("Signing in to OpenAI with ChatGPT (Sign in with ChatGPT).");
		print(`The sign-in will be saved in ${credentialsPath}.\n`);
		const controller = new AbortController();
		const interaction: AuthInteraction = {
			signal: controller.signal,
			notify: notifier(print),
			prompt: (prompt: AuthPrompt) => ask(`${prompt.message}\n> `, prompt.signal),
		};
		const deviceId = await deviceIdIn(secrets);
		await models.login(PROVIDER_ID, "oauth", interaction, { getDeviceId: () => deviceId, agentName: "Assistant" });
		// The store writes the file 0600; say so rather than assume (a file the owner made by hand beforehand may be looser).
		await store.ensurePrivate();
		print(`\nSigned in. The sign-in is saved in ${credentialsPath} (only you can read it).`);
		print("The server reads it when it needs it: no restart is needed. Check everything with ops/check.sh.");
		return 0;
	} catch (error) {
		print(`\nCould not sign in: ${messageOf(error)}`);
		return 1;
	}
}

/** `pnpm logout:openai`. Returns the exit code. */
export async function runLogoutOpenAI(options: OpenAiAuthOptions): Promise<number> {
	const { print } = options;
	try {
		const { values } = parseArgs({
			args: [...options.argv],
			options: { help: { type: "boolean", short: "h" } },
			strict: true,
		});
		if (values.help === true) {
			print(LOGOUT_USAGE);
			return 0;
		}
	} catch (error) {
		print(`${messageOf(error)}\n\n${LOGOUT_USAGE}`);
		return 2;
	}
	try {
		const { store, credentialsPath } = await prepare(options.env);
		const models = withProvider(store, options.provider);
		if ((await store.read(PROVIDER_ID)) === undefined) {
			print(`There is no OpenAI sign-in in ${credentialsPath}: nothing to remove.`);
			return 0;
		}
		await models.logout(PROVIDER_ID);
		print(
			`Removed the OpenAI sign-in from ${credentialsPath}. The assistant cannot answer until you run pnpm login:openai again.`,
		);
		print(
			"This only forgets it on this machine. To revoke the access itself, remove the app under ChatGPT's settings.",
		);
		return 0;
	} catch (error) {
		print(`Could not sign out: ${messageOf(error)}`);
		return 1;
	}
}
