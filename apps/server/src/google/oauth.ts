import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GoogleClient } from "./client-secret.ts";

/**
 * Google sign-in for an installed app (RFC 8252): the owner approves read-only access in a browser, Google sends the
 * browser back to a listener on 127.0.0.1, and the code in that request is exchanged, with a PKCE verifier only this
 * process knows, for a refresh token. Nothing here sends mail: the scopes are fixed in this file and are all read-only.
 */

/** Hard-coded on purpose: there is no setting that widens what the assistant may ask Google for (PLAN rule 1). */
export const GOOGLE_SCOPES = [
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/calendar.readonly",
	"openid",
	"email",
] as const;

/** The scopes the assistant cannot work without: a sign-in that lacks one is refused with a message. */
export const REQUIRED_SCOPES: readonly string[] = GOOGLE_SCOPES.slice(0, 2);

export type OAuthEndpoints = { authorize: string; token: string };

export const GOOGLE_ENDPOINTS: OAuthEndpoints = {
	authorize: "https://accounts.google.com/o/oauth2/v2/auth",
	token: "https://oauth2.googleapis.com/token",
};

/**
 * The hosts this program talks to. A request to any other is a bug: it is refused, not sent. This is a list of hosts and
 * nothing more: it knows no methods and no paths (`www.googleapis.com` serves Calendar reads and, with another path, writes
 * too), so it is not what keeps the program read-only. That is the clients, which only ever `GET` (`./http.ts`), and the
 * read-only scopes the owner approves ({@link GOOGLE_SCOPES}).
 */
export const GOOGLE_HOSTS: readonly string[] = [
	"accounts.google.com",
	"oauth2.googleapis.com",
	"gmail.googleapis.com",
	"www.googleapis.com",
];

/** `fetch`, but only to Google and only over https (`allow` adds hosts for a test that plays the server). */
export function guardedFetch(base: typeof fetch = fetch, allow: readonly string[] = []): typeof fetch {
	const hosts = new Set([...GOOGLE_HOSTS, ...allow]);
	return (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const local = allow.includes(url.host);
		if (!hosts.has(url.host) || (url.protocol !== "https:" && !local)) {
			throw new Error(`Refusing a request to ${url.origin}: this program only talks to Google's own hosts over https.`);
		}
		return base(input, { ...init, redirect: "error" });
	};
}

/** Google refused a request to the token endpoint. `error` is Google's code (`invalid_grant`, `invalid_client`, ...). */
export class GoogleOAuthError extends Error {
	readonly error: string;
	readonly status: number;

	constructor(error: string, description: string, status: number) {
		super(`Google refused the sign-in (${error}${description === "" ? "" : `: ${description}`}).${hintFor(error)}`);
		this.name = "GoogleOAuthError";
		this.error = error;
		this.status = status;
	}
}

function hintFor(error: string): string {
	switch (error) {
		case "invalid_client":
			return " The client id or secret in google-oauth.json is wrong: download the client's JSON again (docs/setup-google.md).";
		case "invalid_grant":
			return " The code or the saved sign-in is no longer valid: connect the account again.";
		case "redirect_uri_mismatch":
			return ' The OAuth client must be a "Desktop app" (docs/setup-google.md).';
		case "access_denied":
			return " Access was not approved.";
		default:
			return "";
	}
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

/** A PKCE pair (RFC 7636, S256): the challenge goes to Google with the request, the verifier only with the code. */
export function createPkce(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(48));
	return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

export const createState = (): string => base64url(randomBytes(24));

export function buildConsentUrl(input: {
	client: GoogleClient;
	redirectUri: string;
	state: string;
	challenge: string;
	loginHint?: string | undefined;
	endpoints?: OAuthEndpoints;
}): string {
	const url = new URL((input.endpoints ?? GOOGLE_ENDPOINTS).authorize);
	url.search = new URLSearchParams({
		client_id: input.client.clientId,
		redirect_uri: input.redirectUri,
		response_type: "code",
		scope: GOOGLE_SCOPES.join(" "),
		state: input.state,
		code_challenge: input.challenge,
		code_challenge_method: "S256",
		// Without these Google may not return a refresh token at all (a second approval of the same app gets none).
		access_type: "offline",
		prompt: "consent",
		...(input.loginHint === undefined ? {} : { login_hint: input.loginHint }),
	}).toString();
	return url.toString();
}

export type Loopback = {
	/** `http://127.0.0.1:<port>/`: what Google redirects the browser to. */
	redirectUri: string;
	port: number;
	/** Resolves with the code once a request with the right state arrives; rejects on a refusal, the timeout, or `close()`. */
	result: Promise<{ code: string }>;
	close(): void;
};

const PAGE = (title: string, text: string): string =>
	`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3rem auto;max-width:32rem"><h1>${title}</h1><p>${text}</p>`;

/**
 * Listen on 127.0.0.1 (only: never another interface) for the redirect. A request is accepted only for `/`, with the
 * expected `Host`, and with the `state` this run made: anything else gets an error page and the listener keeps waiting,
 * so another tab or a stray request cannot end the sign-in or put a foreign code into it.
 */
export async function startLoopback(options: { state: string; port?: number; timeoutMs: number }): Promise<Loopback> {
	let server: Server | undefined;
	let finish: (outcome: { code: string } | Error) => void = () => {};
	const result = new Promise<{ code: string }>((resolve, reject) => {
		finish = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
	});
	// A rejection nobody awaits yet (the timeout can fire before the caller waits) must not crash the process.
	result.catch(() => {});

	let port = 0;
	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
		const send = (status: number, title: string, text: string): void => {
			response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			response.end(PAGE(title, text));
		};
		if (request.headers.host !== `127.0.0.1:${port}` || url.pathname !== "/" || request.method !== "GET") {
			return send(404, "Not found", "This address only receives Google's sign-in redirect.");
		}
		const error = url.searchParams.get("error");
		if (url.searchParams.get("state") !== options.state) {
			return send(
				400,
				"Wrong request",
				"This request does not belong to the sign-in that is running. Nothing was saved.",
			);
		}
		if (error !== null) {
			send(400, "Sign-in cancelled", "Access was not approved. Nothing was saved. You can close this tab.");
			return finish(new GoogleOAuthError(error, url.searchParams.get("error_description") ?? "", 400));
		}
		const code = url.searchParams.get("code");
		if (code === null || code === "") return send(400, "Wrong request", "Google sent no code. Nothing was saved.");
		send(200, "Connected", "You can close this tab and go back to the terminal.");
		finish({ code });
	});
	await new Promise<void>((resolve, reject) => {
		server?.once("error", reject);
		// 127.0.0.1 and nothing else: the redirect must never be reachable from the network.
		server?.listen(options.port ?? 0, "127.0.0.1", () => resolve());
	});
	port = (server.address() as AddressInfo).port;

	const timer = setTimeout(
		() =>
			finish(
				new Error(
					`Nobody approved the sign-in within ${Math.round(options.timeoutMs / 60_000)} minutes. Run it again when you are ready.`,
				),
			),
		options.timeoutMs,
	);
	const close = (): void => {
		clearTimeout(timer);
		server?.close();
		server?.closeAllConnections();
		finish(new Error("The sign-in was closed before it finished."));
	};
	void result.then(close, close);
	return { redirectUri: `http://127.0.0.1:${port}/`, port, result, close };
}

/**
 * The code from a redirect address the owner pasted, for a sign-in on a machine whose browser cannot reach this one's
 * 127.0.0.1 (a cloud server): the browser's last page fails to load, but its address still holds Google's answer. The
 * same rules as the listener apply: it must be for this run's redirect address and carry this run's `state`.
 * Returns the code, Google's refusal as an error to throw, or a problem with the paste to show before asking again.
 */
export function codeFromPastedRedirect(
	pasted: string,
	expected: { state: string; redirectUri: string },
): { code: string } | { refused: GoogleOAuthError } | { problem: string } {
	let url: URL;
	try {
		url = new URL(pasted.trim());
	} catch {
		return {
			problem: `That is not an address. Copy the whole address from the browser's bar (it starts with ${expected.redirectUri}).`,
		};
	}
	const want = new URL(expected.redirectUri);
	if (url.origin !== want.origin || url.pathname !== want.pathname) {
		return { problem: `That address is not this sign-in's redirect: it must start with ${expected.redirectUri}.` };
	}
	if (url.searchParams.get("state") !== expected.state) {
		return {
			problem: "That address belongs to another sign-in (its state does not match). Use the link printed above.",
		};
	}
	const error = url.searchParams.get("error");
	if (error !== null)
		return { refused: new GoogleOAuthError(error, url.searchParams.get("error_description") ?? "", 400) };
	const code = url.searchParams.get("code");
	if (code === null || code === "") return { problem: "That address has no code in it. Copy the whole address." };
	return { code };
}

/** Ask for a pasted redirect until one is usable; rejects when `signal` aborts (the listener got the redirect first). */
async function codeFromPaste(
	ask: (question: string, signal: AbortSignal) => Promise<string>,
	expected: { state: string; redirectUri: string },
	signal: AbortSignal,
): Promise<{ code: string }> {
	let question = "Paste the redirect address here (or wait if the browser is on this computer):\n> ";
	for (;;) {
		const outcome = codeFromPastedRedirect(await ask(question, signal), expected);
		if ("code" in outcome) return outcome;
		if ("refused" in outcome) throw outcome.refused;
		question = `${outcome.problem}\n> `;
	}
}

async function raceWithPaste(
	loopback: Loopback,
	ask: (question: string, signal: AbortSignal) => Promise<string>,
	expected: { state: string; redirectUri: string },
): Promise<{ code: string }> {
	const controller = new AbortController();
	const pasted = codeFromPaste(ask, expected, controller.signal);
	// The losing side rejects once it is cancelled; that rejection is expected and must not crash the process.
	pasted.catch(() => {});
	try {
		return await Promise.race([loopback.result, pasted]);
	} finally {
		controller.abort();
	}
}

export type TokenResponse = {
	accessToken: string;
	expiresInSec: number;
	refreshToken?: string;
	scope: string;
	idToken?: string;
};

async function postToken(
	endpoints: OAuthEndpoints,
	body: Record<string, string>,
	send: typeof fetch,
): Promise<Record<string, unknown>> {
	const response = await send(endpoints.token, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(body).toString(),
	});
	const text = await response.text();
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// A body that is not JSON is reported by status below.
	}
	if (!response.ok) {
		throw new GoogleOAuthError(
			typeof json.error === "string" ? json.error : `http_${response.status}`,
			typeof json.error_description === "string" ? json.error_description : "",
			response.status,
		);
	}
	return json;
}

const tokenFrom = (json: Record<string, unknown>): TokenResponse => {
	if (typeof json.access_token !== "string") throw new Error("Google's answer has no access token.");
	return {
		accessToken: json.access_token,
		expiresInSec: typeof json.expires_in === "number" ? json.expires_in : 3600,
		scope: typeof json.scope === "string" ? json.scope : "",
		...(typeof json.refresh_token === "string" ? { refreshToken: json.refresh_token } : {}),
		...(typeof json.id_token === "string" ? { idToken: json.id_token } : {}),
	};
};

export async function exchangeCode(input: {
	client: GoogleClient;
	code: string;
	verifier: string;
	redirectUri: string;
	fetch?: typeof fetch;
	endpoints?: OAuthEndpoints;
}): Promise<TokenResponse> {
	const json = await postToken(
		input.endpoints ?? GOOGLE_ENDPOINTS,
		{
			grant_type: "authorization_code",
			code: input.code,
			client_id: input.client.clientId,
			client_secret: input.client.clientSecret,
			redirect_uri: input.redirectUri,
			code_verifier: input.verifier,
		},
		input.fetch ?? guardedFetch(),
	);
	return tokenFrom(json);
}

export async function refreshAccessToken(input: {
	client: GoogleClient;
	refreshToken: string;
	fetch?: typeof fetch;
	endpoints?: OAuthEndpoints;
}): Promise<TokenResponse> {
	const json = await postToken(
		input.endpoints ?? GOOGLE_ENDPOINTS,
		{
			grant_type: "refresh_token",
			refresh_token: input.refreshToken,
			client_id: input.client.clientId,
			client_secret: input.client.clientSecret,
		},
		input.fetch ?? guardedFetch(),
	);
	return tokenFrom(json);
}

/**
 * The address and its verification from an ID token. The token came straight from Google's token endpoint over TLS, which
 * is what OpenID Connect (Core 3.1.3.7) accepts in place of checking its signature; it is checked to be for this client.
 */
export function identityFromIdToken(idToken: string, clientId: string): { email: string } {
	const payload = idToken.split(".")[1];
	let claims: Record<string, unknown>;
	try {
		claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		throw new Error("Google's ID token cannot be read.");
	}
	const issuer = claims.iss;
	if (issuer !== "https://accounts.google.com" && issuer !== "accounts.google.com") {
		throw new Error("Google's ID token is not from Google.");
	}
	if (claims.aud !== clientId) throw new Error("Google's ID token is for another client.");
	if (typeof claims.email !== "string" || claims.email === "")
		throw new Error("Google's ID token has no email address.");
	if (claims.email_verified === false) throw new Error(`Google says ${claims.email} is not a verified address.`);
	return { email: claims.email.toLowerCase() };
}

/** The scopes the owner approved, and the ones the assistant needs that they did not. */
export function missingScopes(granted: string): string[] {
	const have = new Set(granted.split(/\s+/).filter(Boolean));
	return REQUIRED_SCOPES.filter((scope) => !have.has(scope));
}

export type Connection = { email: string; refreshToken: string; scopes: string[] };

/**
 * The whole sign-in: print where to go, wait for the redirect, exchange the code, and check that what came back is usable
 * (a refresh token, both read-only scopes, an address). It saves nothing: the caller decides what to do with the token.
 */
export async function connectAccount(options: {
	client: GoogleClient;
	/** Called once the listener is ready, with the address to open in a browser. */
	onConsentUrl: (url: string, port: number) => void;
	/**
	 * Asks the person at the keyboard for the redirect address, for a browser on another machine. Raced against the
	 * listener: whichever gets the code first wins and the other is cancelled through `signal`.
	 */
	ask?: (question: string, signal: AbortSignal) => Promise<string>;
	port?: number;
	loginHint?: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
	endpoints?: OAuthEndpoints;
}): Promise<Connection> {
	const state = createState();
	const { verifier, challenge } = createPkce();
	const loopback = await startLoopback({
		state,
		...(options.port === undefined ? {} : { port: options.port }),
		timeoutMs: options.timeoutMs ?? 5 * 60_000,
	});
	try {
		options.onConsentUrl(
			buildConsentUrl({
				client: options.client,
				redirectUri: loopback.redirectUri,
				state,
				challenge,
				loginHint: options.loginHint,
				...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
			}),
			loopback.port,
		);
		const { code } = await (options.ask === undefined
			? loopback.result
			: raceWithPaste(loopback, options.ask, { state, redirectUri: loopback.redirectUri }));
		const tokens = await exchangeCode({
			client: options.client,
			code,
			verifier,
			redirectUri: loopback.redirectUri,
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
			...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
		});
		const missing = missingScopes(tokens.scope);
		if (missing.length > 0) {
			throw new Error(
				`Access was approved without ${missing.map((scope) => scope.split("/").pop()).join(" and ")}. The assistant needs read access to both mail and calendar: run it again and leave every box ticked.`,
			);
		}
		if (tokens.refreshToken === undefined) {
			throw new Error(
				"Google did not return a refresh token (it does that only the first time an app is approved). Remove this app at https://myaccount.google.com/permissions and run it again.",
			);
		}
		if (tokens.idToken === undefined) throw new Error("Google did not say which account this is (no ID token).");
		const { email } = identityFromIdToken(tokens.idToken, options.client.clientId);
		return { email, refreshToken: tokens.refreshToken, scopes: tokens.scope.split(/\s+/).filter(Boolean) };
	} finally {
		loopback.close();
	}
}
