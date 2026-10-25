import { readFile } from "node:fs/promises";

/** The OAuth client the owner made in the Google Cloud console (a "Desktop app"): who this program says it is to Google. */
export type GoogleClient = { clientId: string; clientSecret: string };

const FIX =
	"Download the client's JSON from the Google Cloud console (APIs & Services, Credentials, your Desktop app client) " +
	"and save it there unchanged (docs/setup-google.md).";

/**
 * Read the client from `google-oauth.json`. It is the file the console downloads (`{ "installed": { "client_id", "client_secret",
 * ... } }`), or a plain `{ "client_id", "client_secret" }`. Undefined when the file does not exist (nothing is set up yet); an
 * error that says what is wrong when it exists and cannot be used. A "Web application" client is refused: its redirect
 * addresses are fixed in the console, and the sign-in here comes back to a loopback address on a port chosen at the time.
 */
export async function readGoogleClient(path: string): Promise<GoogleClient | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return parseGoogleClient(text, path);
}

export function parseGoogleClient(text: string, path: string): GoogleClient {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`${path} is not valid JSON. ${FIX}`);
	}
	const root = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
	if ("web" in root && !("installed" in root)) {
		throw new Error(
			`${path} is a "Web application" client. This program signs in on a loopback address, which needs a "Desktop app" client: create one (docs/setup-google.md) and save its JSON here.`,
		);
	}
	const inner = ((root.installed as Record<string, unknown> | undefined) ?? root) as Record<string, unknown>;
	const clientId = inner.client_id ?? inner.clientId;
	const clientSecret = inner.client_secret ?? inner.clientSecret;
	if (
		typeof clientId !== "string" ||
		clientId.trim() === "" ||
		typeof clientSecret !== "string" ||
		clientSecret.trim() === ""
	) {
		throw new Error(`${path} has no client_id and client_secret. ${FIX}`);
	}
	return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}
