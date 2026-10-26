import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { type Env, resolveDataPaths } from "../config.ts";
import { GoogleAccountStore } from "./accounts.ts";
import { readGoogleClient } from "./client-secret.ts";
import { connectAccount, GOOGLE_SCOPES, type OAuthEndpoints } from "./oauth.ts";

export type ConnectOptions = {
	argv: readonly string[];
	env: Env;
	print: (line: string) => void;
	/** Asks the person at the keyboard (for a pasted redirect address); rejects when `signal` aborts. */
	ask?: (question: string, signal: AbortSignal) => Promise<string>;
	/** Replaces `fetch` and the endpoints for a test that plays Google's token endpoint. */
	fetch?: typeof fetch;
	endpoints?: OAuthEndpoints;
	now?: () => number;
};

const USAGE = `Connect a Google account to the assistant (read-only: Gmail and Calendar).

  pnpm connect:google                     connect an account (run it once per Gmail account)
  pnpm connect:google --list              show the connected accounts and their status
  pnpm connect:google --login-hint a@b.c  preselect an account in the browser
  pnpm connect:google --port 8765         listen on this port (to forward it over SSH instead of pasting)

On a machine without a browser (a cloud server), open the link anywhere, approve, then copy the address the browser
ends on (it fails to load) and paste it into the terminal.

It saves the sign-in in <data>/secrets/google-accounts.json. Set up the Google Cloud project first: docs/setup-google.md.`;

/**
 * `pnpm connect:google`. Returns the exit code. It needs only the data directory (it never reads the server's other
 * settings), and it says which one it saves into, because a production server and a development one have different ones.
 */
export async function runConnectGoogle(options: ConnectOptions): Promise<number> {
	const { print } = options;
	let values: { port?: string; "login-hint"?: string; "timeout-minutes"?: string; list?: boolean; help?: boolean };
	try {
		({ values } = parseArgs({
			args: [...options.argv],
			options: {
				port: { type: "string" },
				"login-hint": { type: "string" },
				"timeout-minutes": { type: "string" },
				list: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			strict: true,
		}));
	} catch (error) {
		print(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}
	if (values.help === true) {
		print(USAGE);
		return 0;
	}
	// A bad flag is reported before anything is read or created: it is the first thing wrong, whatever else is missing.
	const flags = checkFlags(values);
	if ("error" in flags) {
		print(flags.error);
		return 2;
	}
	const { port, minutes } = flags;

	const { paths } = resolveDataPaths(options.env);
	const store = new GoogleAccountStore(paths.googleAccounts);
	try {
		// `<data>/secrets` is private (PLAN rule 9). The owner may have made it by hand, to put the client file in, with the
		// default 0755: mkdir leaves an existing folder as it is, so this closes it.
		await mkdir(dirname(paths.googleAccounts), { recursive: true, mode: 0o700 });
		await chmod(dirname(paths.googleAccounts), 0o700);
		if (values.list === true) return await list(store, paths.googleAccounts, print);

		const client = await readGoogleClient(paths.googleOAuth);
		if (client === undefined) {
			print(
				`There is no Google OAuth client yet: ${paths.googleOAuth} does not exist.\n` +
					"Create a Desktop app client in the Google Cloud console and save its JSON there (docs/setup-google.md).",
			);
			return 1;
		}

		print("Connecting a Google account: read-only access to Gmail and Calendar.");
		print(`The sign-in will be saved in ${paths.googleAccounts}.\n`);
		const connection = await connectAccount({
			client,
			...(port === undefined ? {} : { port }),
			...(values["login-hint"] === undefined ? {} : { loginHint: values["login-hint"] }),
			timeoutMs: minutes * 60_000,
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
			...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
			...(options.ask === undefined ? {} : { ask: options.ask }),
			onConsentUrl: (url, listening) => {
				print("1. Open this link in a browser:\n");
				print(`   ${url}\n`);
				print("2. Sign in with the Gmail account to connect and approve the two read-only permissions.");
				print(
					`   Browser on this computer: the command finishes by itself (waiting on http://127.0.0.1:${listening}/).`,
				);
				if (options.ask !== undefined) {
					print(
						"   Browser on another machine: its last page will not load. Copy that page's whole address\n" +
							`   (it starts with http://127.0.0.1:${listening}/) and paste it below.`,
					);
				}
				print(`   (Up to ${minutes} minutes. Ctrl-C cancels; nothing is saved.)\n`);
			},
		});
		await store.save({
			email: connection.email,
			refreshToken: connection.refreshToken,
			scopes: connection.scopes,
			connectedAt: (options.now ?? Date.now)(),
			status: "ok",
		});
		print(
			`\nConnected ${connection.email}. The assistant notices it within ten minutes, or at once when you open Settings → Google accounts, and then reads it.`,
		);
		print(
			`Permissions given: ${GOOGLE_SCOPES.filter((scope) => scope.startsWith("https"))
				.map((scope) => scope.split("/").pop())
				.join(", ")} (read-only).`,
		);
		return 0;
	} catch (error) {
		print(`\n${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

/** The numbers among the flags, or what is wrong with them. */
function checkFlags(values: {
	port?: string;
	"timeout-minutes"?: string;
}): { port: number | undefined; minutes: number } | { error: string } {
	const port = values.port === undefined ? undefined : Number(values.port);
	if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
		return { error: "--port must be a port number from 1024 to 65535." };
	}
	const minutes = values["timeout-minutes"] === undefined ? 5 : Number(values["timeout-minutes"]);
	if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60)
		return { error: "--timeout-minutes must be from 1 to 60." };
	return { port, minutes };
}

async function list(store: GoogleAccountStore, path: string, print: (line: string) => void): Promise<number> {
	const accounts = await store.list();
	if (accounts.length === 0) {
		print(`No account is connected (${path}). Run pnpm connect:google.`);
		return 0;
	}
	for (const account of accounts) {
		const status = account.status === "ok" ? "connected" : "NEEDS TO BE CONNECTED AGAIN (Google refused the sign-in)";
		print(`${account.email}  ${status}  (approved ${new Date(account.connectedAt).toISOString().slice(0, 10)})`);
	}
	return 0;
}
