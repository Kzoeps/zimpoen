import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { type AddressInfo, Server as NetServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { TokenRevokedError } from "@assistant/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileTokenProvider, GoogleAccountStore, type StoredAccount } from "../src/google/accounts.ts";
import { parseGoogleClient } from "../src/google/client-secret.ts";
import { runConnectGoogle } from "../src/google/connect.ts";
import {
	connectAccount,
	GOOGLE_HOSTS,
	GOOGLE_SCOPES,
	GoogleOAuthError,
	guardedFetch,
	identityFromIdToken,
	startLoopback,
} from "../src/google/oauth.ts";

const CLIENT = { clientId: "cid.apps.googleusercontent.com", clientSecret: "csecret-never-printed" };
const SCOPES = [
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/calendar.readonly",
	"openid",
	"email",
];

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
/** What Google's token endpoint puts in `id_token`: header.claims.signature. This program checks the claims, not the signature. */
const idToken = (claims: Record<string, unknown> = {}): string =>
	`${b64({ alg: "RS256" })}.${b64({ iss: "https://accounts.google.com", aud: CLIENT.clientId, email: "Owner@X.example", email_verified: true, ...claims })}.sig`;

type TokenCall = { path: string; form: Record<string, string> };
type Reply = { status?: number; body: unknown };

/** A token endpoint on 127.0.0.1 that plays Google: records every call and answers as the script says. */
async function tokenEndpoint(script: (call: TokenCall, index: number) => Reply) {
	const calls: TokenCall[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const call = {
				path: req.url ?? "",
				form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())),
			};
			calls.push(call);
			const reply = script(call, calls.length - 1);
			res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
			res.end(JSON.stringify(reply.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const host = `127.0.0.1:${port}`;
	return {
		calls,
		host,
		endpoints: { authorize: `http://${host}/authorize`, token: `http://${host}/token` },
		fetch: guardedFetch(undefined, [host]),
		close: () => closeServer(server),
	};
}

type Endpoint = Awaited<ReturnType<typeof tokenEndpoint>>;

const closeServer = (server: Server): Promise<void> =>
	new Promise((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});

const goodTokens = (over: Record<string, unknown> = {}): Reply => ({
	body: {
		access_token: "at-1",
		expires_in: 3600,
		refresh_token: "rt-1",
		scope: SCOPES.join(" "),
		id_token: idToken(),
		...over,
	},
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "assistant-google-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function endpoint(script: (call: TokenCall, index: number) => Reply): Promise<Endpoint> {
	const server = await tokenEndpoint(script);
	cleanups.push(server.close);
	return server;
}

/** Start a sign-in and wait until it has printed where to go. Nothing happens until the "browser" is sent to `redirectUri`. */
async function startSignIn(google: Endpoint, options: { timeoutMs?: number } = {}) {
	let announce: (value: { url: URL; port: number }) => void = () => {};
	const announced = new Promise<{ url: URL; port: number }>((resolve) => {
		announce = resolve;
	});
	const result = connectAccount({
		client: CLIENT,
		endpoints: google.endpoints,
		fetch: google.fetch,
		timeoutMs: options.timeoutMs ?? 30_000,
		onConsentUrl: (url, port) => announce({ url: new URL(url), port }),
	});
	result.catch(() => {});
	const { url, port } = await announced;
	return {
		result,
		url,
		port,
		state: url.searchParams.get("state") ?? "",
		redirectUri: url.searchParams.get("redirect_uri") ?? "",
	};
}

/** What the browser does after the owner approves (or refuses): a GET to the redirect address with Google's parameters. */
const browser = (redirectUri: string, params: Record<string, string>): Promise<Response> =>
	fetch(`${redirectUri}?${new URLSearchParams(params)}`);

/** A request with a `Host` header of the caller's choosing (`fetch` does not let a script set one). */
function rawGet(port: number, path: string, headers: Record<string, string>, method = "GET"): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		req.on("error", reject);
		req.end();
	});
}

describe("the consent link", () => {
	it("asks for exactly the two read-only scopes and the identity scopes, with PKCE (S256), a state and an offline refresh token", async () => {
		const google = await endpoint(() => goodTokens());
		const flow = await startSignIn(google);

		const { searchParams } = flow.url;
		expect(flow.url.origin + flow.url.pathname).toBe(google.endpoints.authorize);
		expect(searchParams.get("scope")?.split(" ")).toStrictEqual(SCOPES);
		expect([...GOOGLE_SCOPES]).toStrictEqual(SCOPES);
		// Nothing that can change a mailbox or a calendar is ever asked for.
		for (const scope of SCOPES)
			expect(scope).not.toMatch(
				/modify|send|compose|insert|settings|labels|full|auth\/mail\.google|calendar$|calendar\.events$/,
			);
		expect(searchParams.get("code_challenge_method")).toBe("S256");
		expect(searchParams.get("code_challenge")?.length).toBeGreaterThanOrEqual(43);
		expect(searchParams.get("response_type")).toBe("code");
		expect(searchParams.get("access_type")).toBe("offline");
		expect(searchParams.get("prompt")).toBe("consent");
		expect(searchParams.get("client_id")).toBe(CLIENT.clientId);
		expect(flow.state.length).toBeGreaterThanOrEqual(24);
		expect(flow.redirectUri).toBe(`http://127.0.0.1:${flow.port}/`);
		// The client secret never travels in the link the owner opens.
		expect(flow.url.toString()).not.toContain(CLIENT.clientSecret);

		await browser(flow.redirectUri, { code: "c1", state: flow.state });
		await flow.result;
	});

	it("makes a different state and challenge for every sign-in", async () => {
		const google = await endpoint(() => goodTokens());
		const first = await startSignIn(google);
		const second = await startSignIn(google);

		expect(first.state).not.toBe(second.state);
		expect(first.url.searchParams.get("code_challenge")).not.toBe(second.url.searchParams.get("code_challenge"));
		await browser(first.redirectUri, { code: "c", state: first.state });
		await browser(second.redirectUri, { code: "c", state: second.state });
		await Promise.all([first.result, second.result]);
	});
});

describe("the sign-in", () => {
	it("trades the code and the PKCE verifier for a refresh token, and names the account from the ID token", async () => {
		const google = await endpoint(() => goodTokens());
		const flow = await startSignIn(google);

		const page = await browser(flow.redirectUri, { code: "the-code", state: flow.state });
		const connection = await flow.result;

		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Connected");
		expect(connection).toStrictEqual({ email: "owner@x.example", refreshToken: "rt-1", scopes: SCOPES });
		expect(google.calls).toHaveLength(1);
		const [call] = google.calls;
		expect(call?.path).toBe("/token");
		expect(call?.form).toMatchObject({
			grant_type: "authorization_code",
			code: "the-code",
			client_id: CLIENT.clientId,
			client_secret: CLIENT.clientSecret,
			redirect_uri: flow.redirectUri,
		});
		// The verifier that went to the token endpoint is the one whose hash went in the link: only this process could send it.
		const verifier = call?.form.code_verifier ?? "";
		expect(verifier.length).toBeGreaterThanOrEqual(43);
		expect(createHash("sha256").update(verifier).digest("base64url")).toBe(flow.url.searchParams.get("code_challenge"));
	});

	it("refuses a request with the wrong state and keeps waiting: a stray request cannot end the sign-in or put its own code into it", async () => {
		const google = await endpoint(() => goodTokens());
		const flow = await startSignIn(google);

		const wrong = await browser(flow.redirectUri, { code: "evil-code", state: "not-the-state" });
		const missing = await browser(flow.redirectUri, { code: "evil-code" });
		// A refusal with the wrong state is not the owner's refusal either.
		const foreignError = await browser(flow.redirectUri, { error: "access_denied", state: "not-the-state" });

		expect([wrong.status, missing.status, foreignError.status]).toStrictEqual([400, 400, 400]);
		expect(await wrong.text()).toContain("Nothing was saved");
		expect(google.calls).toHaveLength(0);

		await browser(flow.redirectUri, { code: "good-code", state: flow.state });
		await expect(flow.result).resolves.toMatchObject({ email: "owner@x.example" });
		expect(google.calls.map((call) => call.form.code)).toStrictEqual(["good-code"]);
	});

	it("answers 404 to another path, another method and a foreign Host header, and keeps waiting", async () => {
		const google = await endpoint(() => goodTokens());
		const flow = await startSignIn(google);
		const query = `?code=evil&state=${flow.state}`;

		expect(await rawGet(flow.port, `/other${query}`, { host: `127.0.0.1:${flow.port}` })).toBe(404);
		expect(await rawGet(flow.port, `/${query}`, { host: `127.0.0.1:${flow.port}` }, "POST")).toBe(404);
		expect(await rawGet(flow.port, `/${query}`, { host: "evil.example" })).toBe(404);
		expect(await rawGet(flow.port, `/${query}`, { host: `localhost:${flow.port}` })).toBe(404);
		expect(await rawGet(flow.port, `/${query}`, { host: `127.0.0.1:${flow.port + 1}` })).toBe(404);
		expect(google.calls).toHaveLength(0);

		await browser(flow.redirectUri, { code: "good", state: flow.state });
		await expect(flow.result).resolves.toMatchObject({ refreshToken: "rt-1" });
		expect(google.calls.map((call) => call.form.code)).toStrictEqual(["good"]);
	});

	it("ends with Google's reason when the owner refuses, and exchanges nothing", async () => {
		const google = await endpoint(() => goodTokens());
		const flow = await startSignIn(google);

		const page = await browser(flow.redirectUri, { error: "access_denied", state: flow.state });

		expect(page.status).toBe(400);
		await expect(flow.result).rejects.toMatchObject({ name: "GoogleOAuthError", error: "access_denied" });
		await expect(flow.result).rejects.toThrow(/Access was not approved/);
		expect(google.calls).toHaveLength(0);
	});

	it("says what to do when Google refuses the code or the client, and does not repeat the secret", async () => {
		const google = await endpoint(() => ({
			status: 401,
			body: { error: "invalid_client", error_description: "Unauthorized" },
		}));
		const flow = await startSignIn(google);

		await browser(flow.redirectUri, { code: "c", state: flow.state });

		await expect(flow.result).rejects.toThrow(/invalid_client.*download the client's JSON again/);
		await expect(flow.result.catch((error: Error) => error.message)).resolves.not.toContain(CLIENT.clientSecret);
	});

	it("gives up after the time it was given, and frees the port", async () => {
		const google = await endpoint(() => goodTokens());
		const flow = await startSignIn(google, { timeoutMs: 60 });

		await expect(flow.result).rejects.toThrow(/Nobody approved the sign-in/);
		await expect(rawGet(flow.port, "/", { host: `127.0.0.1:${flow.port}` })).rejects.toMatchObject({
			code: "ECONNREFUSED",
		});
	});

	it("listens on 127.0.0.1 and on no other address", async () => {
		const listen = vi.spyOn(NetServer.prototype, "listen");
		const loopback = await startLoopback({ state: "s", timeoutMs: 30_000 });
		cleanups.push(() => loopback.close());

		const [, host] = listen.mock.calls[0] as unknown as [number, string];
		expect(host).toBe("127.0.0.1");
		expect(loopback.redirectUri).toBe(`http://127.0.0.1:${loopback.port}/`);
		// Where this machine has another address, the port is not open on it.
		const outside = Object.values(networkInterfaces())
			.flat()
			.find((address) => address?.family === "IPv4" && !address.internal);
		if (outside !== undefined) {
			await expect(
				new Promise((resolve, reject) => {
					const req = httpRequest({ host: outside.address, port: loopback.port, timeout: 2000 }, resolve);
					req.on("error", reject);
					req.end();
				}),
			).rejects.toMatchObject({ code: "ECONNREFUSED" });
		}
	});
});

describe("a sign-in that cannot be used is refused and nothing is saved", () => {
	async function runCli(
		reply: Reply,
		browserParams: (state: string, redirectUri: string) => Record<string, string> = (state) => ({ code: "c", state }),
	) {
		const data = await tempDir();
		const google = await endpoint(() => reply);
		await mkdir(join(data, "secrets"), { recursive: true, mode: 0o700 });
		await writeFile(
			join(data, "secrets", "google-oauth.json"),
			JSON.stringify({ installed: { client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret } }),
		);
		const lines: string[] = [];
		const code = await runConnectGoogle({
			argv: [],
			env: { ASSISTANT_DATA_DIR: data },
			endpoints: google.endpoints,
			fetch: google.fetch,
			now: () => 1_700_000_000_000,
			print: (line) => {
				lines.push(line);
				const link = line.match(/https?:\/\/\S+authorize\S*/)?.[0];
				if (link === undefined) return;
				const url = new URL(link);
				void browser(
					url.searchParams.get("redirect_uri") ?? "",
					browserParams(url.searchParams.get("state") ?? "", url.searchParams.get("redirect_uri") ?? ""),
				);
			},
		});
		return { code, text: lines.join("\n"), data, accountsFile: join(data, "secrets", "google-accounts.json") };
	}

	it.each([
		[
			"the owner left the calendar box unticked",
			goodTokens({ scope: `${SCOPES[0]} openid email` }),
			/without calendar\.readonly/,
		],
		[
			"the owner left the mail box unticked",
			goodTokens({ scope: `${SCOPES[1]} openid email` }),
			/without gmail\.readonly/,
		],
		["Google sent no refresh token", goodTokens({ refresh_token: undefined }), /did not return a refresh token/],
		["Google sent no ID token", goodTokens({ id_token: undefined }), /did not say which account/],
		[
			"the ID token is for another client",
			goodTokens({ id_token: idToken({ aud: "someone-else" }) }),
			/for another client/,
		],
		[
			"the ID token is not from Google",
			goodTokens({ id_token: idToken({ iss: "https://evil.example" }) }),
			/not from Google/,
		],
		[
			"the address is not verified",
			goodTokens({ id_token: idToken({ email_verified: false }) }),
			/not a verified address/,
		],
		["the ID token has no address", goodTokens({ id_token: idToken({ email: undefined }) }), /no email address/],
	])("%s", async (_name, reply, message) => {
		const { code, text, accountsFile } = await runCli(reply);

		expect(code).toBe(1);
		expect(text).toMatch(message);
		await expect(stat(accountsFile)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("saves nothing when the owner refuses in the browser either", async () => {
		const { code, text, accountsFile } = await runCli(goodTokens(), (state) => ({ error: "access_denied", state }));

		expect(code).toBe(1);
		expect(text).toMatch(/Access was not approved/);
		await expect(stat(accountsFile)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("leaves the accounts that were already connected as they were", async () => {
		const data = await tempDir();
		const store = new GoogleAccountStore(join(data, "secrets", "google-accounts.json"));
		await store.save({ email: "old@x.example", refreshToken: "old-rt", scopes: SCOPES, connectedAt: 1, status: "ok" });
		const before = await readFile(store.path, "utf8");
		const google = await endpoint(() => goodTokens({ refresh_token: undefined }));
		await writeFile(
			join(data, "secrets", "google-oauth.json"),
			JSON.stringify({ client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret }),
		);

		const code = await runConnectGoogle({
			argv: [],
			env: { ASSISTANT_DATA_DIR: data },
			endpoints: google.endpoints,
			fetch: google.fetch,
			print: (line) => {
				const link = line.match(/https?:\/\/\S+authorize\S*/)?.[0];
				if (link === undefined) return;
				const url = new URL(link);
				void browser(url.searchParams.get("redirect_uri") ?? "", {
					code: "c",
					state: url.searchParams.get("state") ?? "",
				});
			},
		});

		expect(code).toBe(1);
		expect(await readFile(store.path, "utf8")).toBe(before);
	});
});

describe("pnpm connect:google, start to finish", () => {
	it("saves the sign-in in a file only its owner can read, in a folder only its owner can enter, and prints neither secret", async () => {
		const data = await tempDir();
		await mkdir(join(data, "secrets"), { recursive: true });
		await chmod(join(data, "secrets"), 0o755);
		// The file as the Google Cloud console downloads it.
		await writeFile(
			join(data, "secrets", "google-oauth.json"),
			JSON.stringify({
				installed: {
					client_id: CLIENT.clientId,
					client_secret: CLIENT.clientSecret,
					redirect_uris: ["http://localhost"],
				},
			}),
		);
		const google = await endpoint(() => goodTokens());
		const lines: string[] = [];

		const code = await runConnectGoogle({
			argv: ["--login-hint", "owner@x.example"],
			env: { ASSISTANT_DATA_DIR: data },
			endpoints: google.endpoints,
			fetch: google.fetch,
			now: () => 1_700_000_000_000,
			print: (line) => {
				lines.push(line);
				const link = line.match(/https?:\/\/\S+authorize\S*/)?.[0];
				if (link === undefined) return;
				const url = new URL(link);
				expect(url.searchParams.get("login_hint")).toBe("owner@x.example");
				void browser(url.searchParams.get("redirect_uri") ?? "", {
					code: "c",
					state: url.searchParams.get("state") ?? "",
				});
			},
		});

		const file = join(data, "secrets", "google-accounts.json");
		expect(code).toBe(0);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		// The folder the owner made by hand (0755) is closed to others too: the plan keeps secrets in a 0700 folder.
		expect((await stat(join(data, "secrets"))).mode & 0o777).toBe(0o700);
		expect(JSON.parse(await readFile(file, "utf8"))).toStrictEqual({
			version: 1,
			accounts: {
				"owner@x.example": {
					email: "owner@x.example",
					refreshToken: "rt-1",
					scopes: SCOPES,
					connectedAt: 1_700_000_000_000,
					status: "ok",
				},
			},
		});
		const output = lines.join("\n");
		expect(output).toContain("Connected owner@x.example");
		expect(output).toContain(file);
		expect(output).not.toContain("rt-1");
		expect(output).not.toContain(CLIENT.clientSecret);
		expect(output).toContain("gmail.readonly, calendar.readonly (read-only)");
		// Only the files of this program are left behind: no temp copy of the token.
		expect((await readdir(join(data, "secrets"))).sort()).toStrictEqual(["google-accounts.json", "google-oauth.json"]);

		// A second approval of the same address replaces its record, in the same private file; the first account stays.
		const store = new GoogleAccountStore(file);
		await store.save({ email: "other@x.example", refreshToken: "rt-2", scopes: SCOPES, connectedAt: 2, status: "ok" });
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await store.list()).map((account) => account.email)).toStrictEqual(["other@x.example", "owner@x.example"]);
	});

	it("says where to put the client file when there is none, and lists what is connected", async () => {
		const data = await tempDir();
		const lines: string[] = [];
		const print = (line: string) => void lines.push(line);

		expect(await runConnectGoogle({ argv: [], env: { ASSISTANT_DATA_DIR: data }, print })).toBe(1);
		expect(lines.join("\n")).toContain(join(data, "secrets", "google-oauth.json"));
		expect(lines.join("\n")).toContain("docs/setup-google.md");

		lines.length = 0;
		expect(await runConnectGoogle({ argv: ["--list"], env: { ASSISTANT_DATA_DIR: data }, print })).toBe(0);
		expect(lines.join("\n")).toMatch(/No account is connected/);

		const store = new GoogleAccountStore(join(data, "secrets", "google-accounts.json"));
		await store.save({
			email: "a@x.example",
			refreshToken: "rt-a",
			scopes: SCOPES,
			connectedAt: Date.UTC(2026, 9, 1),
			status: "ok",
		});
		await store.save({
			email: "b@x.example",
			refreshToken: "rt-b",
			scopes: SCOPES,
			connectedAt: Date.UTC(2026, 9, 2),
			status: "needs_reconnect",
		});
		lines.length = 0;
		expect(await runConnectGoogle({ argv: ["--list"], env: { ASSISTANT_DATA_DIR: data }, print })).toBe(0);
		expect(lines).toStrictEqual([
			"a@x.example  connected  (approved 2026-10-01)",
			"b@x.example  NEEDS TO BE CONNECTED AGAIN (Google refused the sign-in)  (approved 2026-10-02)",
		]);
		expect(lines.join("\n")).not.toContain("rt-");
	});

	it("refuses options it does not understand and ports it cannot use, before it opens anything", async () => {
		const data = await tempDir();
		await mkdir(join(data, "secrets"), { recursive: true });
		await writeFile(join(data, "secrets", "google-oauth.json"), JSON.stringify({ client_id: "x", client_secret: "y" }));
		const lines: string[] = [];
		const run = (argv: string[]) =>
			runConnectGoogle({ argv, env: { ASSISTANT_DATA_DIR: data }, print: (line) => void lines.push(line) });

		expect(await run(["--scope", "gmail.modify"])).toBe(2);
		expect(await run(["--port", "80"])).toBe(2);
		expect(await run(["--port", "abc"])).toBe(2);
		expect(await run(["--timeout-minutes", "0"])).toBe(2);
		expect(await run(["--help"])).toBe(0);
		expect(lines.join("\n")).toContain("read-only");
	});

	it("reports a bad flag before it looks for the client file or touches the data directory", async () => {
		const data = await tempDir();
		const lines: string[] = [];
		const run = (argv: string[]) =>
			runConnectGoogle({ argv, env: { ASSISTANT_DATA_DIR: data }, print: (line) => void lines.push(line) });

		expect(await run(["--port", "80"])).toBe(2);
		expect(await run(["--timeout-minutes", "999"])).toBe(2);

		expect(lines).toStrictEqual([
			"--port must be a port number from 1024 to 65535.",
			"--timeout-minutes must be from 1 to 60.",
		]);
		await expect(stat(join(data, "secrets"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("the OAuth client file", () => {
	it("reads the file the console downloads, or a flat one, and refuses a Web application client with the way out", () => {
		expect(
			parseGoogleClient(JSON.stringify({ installed: { client_id: " id ", client_secret: " s " } }), "f"),
		).toStrictEqual({ clientId: "id", clientSecret: "s" });
		expect(parseGoogleClient(JSON.stringify({ client_id: "id", client_secret: "s" }), "f")).toStrictEqual({
			clientId: "id",
			clientSecret: "s",
		});
		expect(() => parseGoogleClient(JSON.stringify({ web: { client_id: "id", client_secret: "s" } }), "f")).toThrow(
			/Desktop app/,
		);
		expect(() => parseGoogleClient("{", "f")).toThrow(/not valid JSON/);
		expect(() => parseGoogleClient(JSON.stringify({ installed: { client_id: "id" } }), "f")).toThrow(
			/no client_id and client_secret/,
		);
	});
});

describe("the ID token", () => {
	it("is trusted for the address only when it is Google's, for this client, and verified", () => {
		expect(identityFromIdToken(idToken(), CLIENT.clientId)).toStrictEqual({ email: "owner@x.example" });
		expect(identityFromIdToken(idToken({ iss: "accounts.google.com" }), CLIENT.clientId).email).toBe("owner@x.example");
		expect(() => identityFromIdToken("not-a-token", CLIENT.clientId)).toThrow(/cannot be read/);
		expect(() => identityFromIdToken(idToken({ aud: "other" }), CLIENT.clientId)).toThrow(/another client/);
	});
});

describe("the access token", () => {
	const account = (over: Partial<StoredAccount> = {}): StoredAccount => ({
		email: "owner@x.example",
		refreshToken: "rt-1",
		scopes: SCOPES,
		connectedAt: 1,
		status: "ok",
		...over,
	});

	async function provider(
		script: (call: TokenCall, index: number) => Reply,
		saved: StoredAccount[] = [account()],
		clock = { now: 1_000_000 },
	) {
		const data = await tempDir();
		const store = new GoogleAccountStore(join(data, "secrets", "google-accounts.json"));
		for (const one of saved) await store.save(one);
		const google = await endpoint(script);
		const tokens = createFileTokenProvider({
			store,
			client: async () => CLIENT,
			fetch: google.fetch,
			endpoints: google.endpoints,
			now: () => clock.now,
		});
		return { tokens, store, google, clock };
	}

	const refreshed = (token: string): Reply => ({
		body: { access_token: token, expires_in: 3600, scope: SCOPES.join(" ") },
	});

	it("makes one access token from the refresh token and keeps it in memory until shortly before it ends", async () => {
		const { tokens, google, clock, store } = await provider((_call, index) => refreshed(`at-${index}`));

		expect(await tokens.accessToken("owner@x.example")).toBe("at-0");
		expect(await tokens.accessToken("owner@x.example")).toBe("at-0");
		expect(google.calls).toHaveLength(1);
		expect(google.calls[0]?.form).toMatchObject({
			grant_type: "refresh_token",
			refresh_token: "rt-1",
			client_id: CLIENT.clientId,
		});

		clock.now += 3600 * 1000 - 60_000; // inside the two minutes it is replaced before the end
		expect(await tokens.accessToken("owner@x.example")).toBe("at-1");
		expect(await tokens.accessToken("owner@x.example", { refresh: true })).toBe("at-2");
		// An access token is never written down.
		expect(await readFile(store.path, "utf8")).not.toMatch(/at-\d/);
	});

	it("makes one refresh for requests that arrive together", async () => {
		const { tokens, google } = await provider((_call, index) => refreshed(`at-${index}`));

		const all = await Promise.all(Array.from({ length: 8 }, () => tokens.accessToken("owner@x.example")));

		expect(new Set(all)).toStrictEqual(new Set(["at-0"]));
		expect(google.calls).toHaveLength(1);
	});

	it("marks the account in the file and stops asking when Google refuses the refresh token (invalid_grant)", async () => {
		const { tokens, google, store } = await provider(() => ({
			status: 400,
			body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
		}));

		await expect(tokens.accessToken("owner@x.example")).rejects.toBeInstanceOf(TokenRevokedError);

		expect((await store.get("owner@x.example"))?.status).toBe("needs_reconnect");
		expect(typeof (await store.get("owner@x.example"))?.revokedAt).toBe("number");
		expect(await tokens.accounts()).toMatchObject([{ email: "owner@x.example", status: "needs_reconnect" }]);
		// Further requests do not hammer Google with a token it already refused.
		await expect(tokens.accessToken("owner@x.example")).rejects.toBeInstanceOf(TokenRevokedError);
		expect(google.calls).toHaveLength(1);
	});

	it("does not call a Google outage a revoked sign-in: the account stays connected and the failure is thrown as it is", async () => {
		const { tokens, store } = await provider(() => ({ status: 503, body: { error: "backend_error" } }));

		const failure = await tokens.accessToken("owner@x.example").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(GoogleOAuthError);
		expect(failure).not.toBeInstanceOf(TokenRevokedError);
		expect((await store.get("owner@x.example"))?.status).toBe("ok");
	});

	it("says what is wrong for an account that was never connected and for a missing client file", async () => {
		const { tokens } = await provider(() => refreshed("x"));
		await expect(tokens.accessToken("nobody@x.example")).rejects.toThrow(/not connected.*pnpm connect:google/);

		const data = await tempDir();
		const store = new GoogleAccountStore(join(data, "google-accounts.json"));
		await store.save(account());
		const missing = createFileTokenProvider({ store, client: async () => undefined });
		await expect(missing.accessToken("owner@x.example")).rejects.toThrow(/google-oauth\.json is missing/);
	});

	it("forgets an account's sign-in and its access token when it is removed", async () => {
		const { tokens, store, google } = await provider((_call, index) => refreshed(`at-${index}`));
		await tokens.accessToken("owner@x.example");

		await tokens.remove("owner@x.example");

		expect(await store.list()).toStrictEqual([]);
		await expect(tokens.accessToken("owner@x.example")).rejects.toThrow(/not connected/);
		expect(google.calls).toHaveLength(1);
	});
});

describe("an account removed while its access token is being renewed", () => {
	it("does not get the token kept: when the account is connected again, a new one is asked for", async () => {
		const data = await tempDir();
		const store = new GoogleAccountStore(join(data, "secrets", "google-accounts.json"));
		const saved: StoredAccount = {
			email: "owner@x.example",
			refreshToken: "rt-1",
			scopes: SCOPES,
			connectedAt: 1,
			status: "ok",
		};
		await store.save(saved);
		const google = await endpoint((_call, index) => ({
			body: { access_token: `at-${index}`, expires_in: 3600, scope: SCOPES.join(" ") },
		}));
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tokens = createFileTokenProvider({
			store,
			client: async () => CLIENT,
			// The first answer of Google's token endpoint is held back until the account has been removed.
			fetch: (async (...args: Parameters<typeof fetch>) => {
				if (google.calls.length === 0) await gate;
				return google.fetch(...args);
			}) as typeof fetch,
			endpoints: google.endpoints,
			now: () => 1_000_000,
		});

		const renewing = tokens.accessToken("owner@x.example").catch((error: unknown) => error);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await tokens.remove("owner@x.example");
		release();

		expect(await renewing).toBeInstanceOf(Error);
		await store.save({ ...saved, connectedAt: 2 });
		// Nothing of the removed account's token is left: this one is made from the refresh token again.
		expect(await tokens.accessToken("owner@x.example")).toBe("at-1");
		expect(google.calls).toHaveLength(2);
	});
});

describe("the account file", () => {
	async function fileWith(content: string) {
		const data = await tempDir();
		const path = join(data, "google-accounts.json");
		await writeFile(path, content, { mode: 0o600 });
		return new GoogleAccountStore(path);
	}

	it("refuses a file it cannot read instead of treating it as empty, and does not overwrite it", async () => {
		const store = await fileWith("{ this is not json");

		await expect(store.list()).rejects.toThrow(/not valid JSON.*connect the accounts again/);
		await expect(
			store.save({ email: "a@x.example", refreshToken: "r", scopes: [], connectedAt: 1, status: "ok" }),
		).rejects.toThrow(/not valid JSON/);
		expect(await readFile(store.path, "utf8")).toBe("{ this is not json");
	});

	it.each([
		["a file that is not an object of accounts", JSON.stringify({ version: 1, accounts: [] })],
		[
			"an account without a refresh token",
			JSON.stringify({ version: 1, accounts: { "a@x.example": { connectedAt: 1, status: "ok" } } }),
		],
		[
			"an account with a status it does not know",
			JSON.stringify({
				version: 1,
				accounts: { "a@x.example": { refreshToken: "r", connectedAt: 1, status: "fine" } },
			}),
		],
	])("refuses %s", async (_name, content) => {
		const store = await fileWith(content);

		await expect(store.list()).rejects.toThrow(/must hold|invalid entry/);
	});

	it("makes a file that was copied in readable by others private again, and says it did", async () => {
		const store = await fileWith(JSON.stringify({ version: 1, accounts: {} }));
		await chmod(store.path, 0o644);

		expect(await store.ensurePrivate()).toBe(true);
		expect((await stat(store.path)).mode & 0o777).toBe(0o600);
		expect(await store.ensurePrivate()).toBe(false);
	});

	it("removes the temp copies of tokens a crashed write left behind, and nothing else", async () => {
		const store = await fileWith(JSON.stringify({ version: 1, accounts: {} }));
		const dir = join(store.path, "..");
		await writeFile(join(dir, "google-accounts.json.4242.0a1b2c3d.tmp"), "rt-secret");
		await writeFile(join(dir, "google-oauth.json"), "{}");

		expect(await store.cleanupTempFiles()).toBe(1);
		expect((await readdir(dir)).sort()).toStrictEqual(["google-accounts.json", "google-oauth.json"]);
	});

	it("keeps every account when saves arrive together", async () => {
		const data = await tempDir();
		const store = new GoogleAccountStore(join(data, "secrets", "google-accounts.json"));

		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				store.save({
					email: `u${String(index).padStart(2, "0")}@x.example`,
					refreshToken: `rt-${index}`,
					scopes: SCOPES,
					connectedAt: index,
					status: "ok",
				}),
			),
		);

		expect(await store.list()).toHaveLength(12);
	});
});

describe("where this program may send a request", () => {
	const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
	const base = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		seen.push({ url: String(input), init });
		return new Response("{}");
	}) as typeof fetch;

	it("allows Google's own hosts over https, and refuses anything else before a byte is sent", () => {
		seen.length = 0;
		const send = guardedFetch(base);

		for (const host of GOOGLE_HOSTS) expect(() => send(`https://${host}/x`)).not.toThrow();
		for (const refused of [
			"https://evil.example/x",
			"https://accounts.google.com.evil.example/x",
			"http://accounts.google.com/x",
			"https://gmail.googleapis.com:8443/x",
			"http://127.0.0.1:9/x",
		]) {
			expect(() => send(refused), refused).toThrow(/only talks to Google's own hosts over https/);
		}
		expect(seen.map((call) => new URL(call.url).host)).toStrictEqual([...GOOGLE_HOSTS]);
	});

	it("never follows a redirect: a Google host cannot send the token anywhere else", async () => {
		seen.length = 0;
		await guardedFetch(base)("https://oauth2.googleapis.com/token", { method: "POST" });

		expect(seen[0]?.init?.redirect).toBe("error");
	});
});
