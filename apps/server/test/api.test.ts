import { type AppDb, coreMigrations, getAgentRow, migrate, openAppDb } from "@assistant/db";
import type { UsageService } from "@assistant/extensions";
import type {
	AgentSettingsResponse,
	AgentsResponse,
	AllAgentSettingsResponse,
	ApiErrorBody,
	MessagesPage,
	SendMessageResponse,
} from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAgents } from "../src/agents.ts";
import type { AuthConfig } from "../src/config.ts";
import { createApp, MAX_REQUEST_BYTES } from "../src/http/app.ts";
import { createHostPolicy } from "../src/http/guard.ts";
import { openRuntime, type Runtime } from "../src/runtime.ts";
import { appDepsFor, createFixture, type Fixture, removeAllFixtures, waitFor } from "./support.ts";

const ctx = BACKGROUND_CONTEXT;

let fixture: Fixture;
let db: AppDb;
let runtime: Runtime;

/** `speed` is the dev model's tokens per second: instant by default, slow when a test needs a run in flight. */
async function setup(speed = 1_000_000): Promise<void> {
	fixture = await createFixture();
	db = openAppDb(fixture.config.paths.appDb);
	migrate(db, coreMigrations);
	runtime = await openRuntime(fixture.config, { devModel: { tokensPerSecond: speed } });
	await ensureAgents(runtime.harness, db, { shared: runtime.shared, modelMode: "faux" });
	runtime.harness.resume();
}

afterEach(async () => {
	await runtime.close();
	db.close();
	await removeAllFixtures();
});

const appWith = (auth: AuthConfig = { mode: "off" }, logger?: Pick<Console, "error">): Hono =>
	createApp(appDepsFor(runtime, db, { auth, logger }));

const conversationOf = (agentId: string): number => getAgentRow(db, agentId)?.conversationId ?? -1;

async function json<T>(response: Response | Promise<Response>): Promise<{ status: number; body: T }> {
	const res = await response;
	return { status: res.status, body: (await res.json()) as T };
}

const post = (app: Hono, path: string, body: unknown, init: RequestInit = {}) =>
	app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...init.headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

async function settle(submissionId: number): Promise<void> {
	const submission = await runtime.harness.submission(submissionId as SubmissionId, ctx);
	await submission?.wait(ctx);
}

describe("GET /api/agents", () => {
	beforeEach(() => setup());

	it("lists the four agents with their conversations, and reports a healthy server", async () => {
		const { status, body } = await json<AgentsResponse>(appWith().request("/api/agents"));

		expect(status).toBe(200);
		expect(body.agents.map((agent) => agent.id)).toStrictEqual(["pa", "inbox", "health", "accountant"]);
		expect(body.agents.every((agent) => typeof agent.conversationId === "number" && agent.busy === false)).toBe(true);
		expect(body.health).toStrictEqual({ parkedTasks: 0, parked: [] });
	});
});

describe("GET /api/agents when the usage ledger cannot be read", () => {
	beforeEach(() => setup());

	it("still lists the agents, with no banner, and says why once in the log: the banner is a decoration, not the list", async () => {
		const logged: unknown[][] = [];
		const usage = {
			alerts: async () => {
				throw new Error("no such table: usage_budget");
			},
		} as unknown as UsageService;
		const app = createApp(
			appDepsFor(runtime, db, { usage, logger: { error: (...args: unknown[]) => void logged.push(args) } }),
		);

		// Every open tab asks every few seconds: a failure that lasts is one line in the log, not one per request.
		for (let request = 0; request < 3; request++) {
			const { status, body } = await json<AgentsResponse>(app.request("/api/agents"));
			expect(status).toBe(200);
			expect(body.agents.map((agent) => agent.id)).toStrictEqual(["pa", "inbox", "health", "accountant"]);
			expect(body.budget).toStrictEqual({ over: [] });
		}
		expect(logged).toHaveLength(1);
		expect(String(logged[0]?.[0])).toContain("no such table: usage_budget");
	});
});

describe("POST /api/conversations/:id/messages", () => {
	beforeEach(() => setup());

	it("accepts a message, and a retry with the same requestId returns the same submission without sending it twice", async () => {
		const app = appWith();
		const path = `/api/conversations/${conversationOf("pa")}/messages`;
		const payload = { content: "hello", requestId: "req-aaaa-1111" };

		const first = await json<SendMessageResponse>(post(app, path, payload));
		const retry = await json<SendMessageResponse>(post(app, path, payload));
		await settle(first.body.submissionId);

		expect(first.status).toBe(202);
		expect(retry.body.submissionId).toBe(first.body.submissionId);
		const history = await json<MessagesPage>(app.request(path));
		const userMessages = history.body.entries.filter((entry) => entry.kind === "pi.user");
		expect(userMessages).toHaveLength(1);
	});

	it.each([
		["a missing content", { requestId: "req-1" }, /'content' must be a non-empty string/],
		["whitespace-only content", { content: "   ", requestId: "req-1" }, /'content' must be a non-empty string/],
		["oversized content", { content: "x".repeat(20_001), requestId: "req-1" }, /limit is 20000/],
		["a missing requestId", { content: "hi" }, /'requestId' is required.*randomUUID/s],
		["a requestId with illegal characters", { content: "hi", requestId: "has space" }, /'requestId' is required/],
		[
			"an unknown whenBusy",
			{ content: "hi", requestId: "req-1", whenBusy: "reject" },
			/'whenBusy' must be 'steer' or 'followUp'/,
		],
	])("rejects %s with an actionable 400", async (_name, payload, message) => {
		const { status, body } = await json<ApiErrorBody>(
			post(appWith(), `/api/conversations/${conversationOf("pa")}/messages`, payload),
		);

		expect(status).toBe(400);
		expect(body.error.code).toBe("invalid_request");
		expect(body.error.message).toMatch(message);
	});

	it("refuses a POST that does not declare JSON, which is what blocks cross-site form posts", async () => {
		const app = appWith();
		const path = `/api/conversations/${conversationOf("pa")}/messages`;
		const body = JSON.stringify({ content: "hi", requestId: "req-csrf-1" });

		for (const headers of [
			{},
			{ "content-type": "text/plain" },
			{ "content-type": "application/x-www-form-urlencoded" },
		]) {
			const { status, body: error } = await json<ApiErrorBody>(app.request(path, { method: "POST", headers, body }));
			expect(status).toBe(415);
			expect(error.error.message).toContain("Content-Type: application/json");
		}
		const aborted = await app.request(`/api/conversations/${conversationOf("pa")}/abort`, { method: "POST" });
		expect(aborted.status).toBe(415);
		const allowed = await app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body,
		});
		expect(allowed.status).toBe(202);
	});

	it("rejects a body that is not a JSON object", async () => {
		const app = appWith();
		const path = `/api/conversations/${conversationOf("pa")}/messages`;

		expect((await json<ApiErrorBody>(post(app, path, "not json"))).body.error.code).toBe("invalid_json");
		expect((await json<ApiErrorBody>(post(app, path, "[1,2]"))).body.error.code).toBe("invalid_request");
	});

	it("answers 404 for a conversation no agent owns, even if Durable has it", async () => {
		const stray = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);

		const { status, body } = await json<ApiErrorBody>(
			post(appWith(), `/api/conversations/${stray.id}/messages`, { content: "hi", requestId: "req-1" }),
		);

		expect(status).toBe(404);
		expect(body.error.message).toContain(`No agent has conversation ${stray.id}`);
	});

	it("rejects a conversation id that is not a positive whole number", async () => {
		const { status, body } = await json<ApiErrorBody>(post(appWith(), "/api/conversations/abc/messages", {}));

		expect(status).toBe(400);
		expect(body.error.message).toContain("conversation id must be a positive whole number, got 'abc'");
	});
});

describe("GET /api/conversations/:id/messages", () => {
	beforeEach(() => setup());

	it("pages backwards through history, oldest first within a page, never exposing system entries", async () => {
		const app = appWith();
		const path = `/api/conversations/${conversationOf("health")}/messages`;
		for (const n of [1, 2, 3]) {
			const sent = await json<SendMessageResponse>(
				post(app, path, { content: `message ${n}`, requestId: `req-page-${n}` }),
			);
			await settle(sent.body.submissionId);
		}

		const newest = await json<MessagesPage>(app.request(`${path}?limit=4`));
		const older = await json<MessagesPage>(app.request(`${path}?limit=4&before=${newest.body.nextBefore}`));

		const ids = (page: MessagesPage) => page.entries.map((entry) => entry.id);
		expect(newest.body.entries).toHaveLength(4);
		expect(ids(newest.body)).toStrictEqual([...ids(newest.body)].sort((a, b) => a - b));
		expect(newest.body.nextBefore).toBe(ids(newest.body)[0]);
		// Six visible entries in all (3 questions, 3 answers): the second page holds the other two.
		expect(older.body.entries).toHaveLength(2);
		expect(older.body.nextBefore).toBeUndefined();
		expect(Math.max(...ids(older.body))).toBeLessThan(Math.min(...ids(newest.body)));
		const kinds = [...older.body.entries, ...newest.body.entries].map((entry) => entry.kind);
		expect(kinds).toStrictEqual(["pi.user", "pi.assistant", "pi.user", "pi.assistant", "pi.user", "pi.assistant"]);
	});

	it("validates paging parameters", async () => {
		const path = `/api/conversations/${conversationOf("pa")}/messages`;
		const app = appWith();

		expect((await json<ApiErrorBody>(app.request(`${path}?limit=0`))).body.error.message).toContain(
			"limit must be a positive whole number",
		);
		expect((await json<ApiErrorBody>(app.request(`${path}?limit=500`))).body.error.message).toContain(
			"limit must be at most 200",
		);
		expect((await json<ApiErrorBody>(app.request(`${path}?before=x`))).body.error.message).toContain(
			"before must be a positive whole number",
		);
	});
});

describe("POST /api/conversations/:id/abort", () => {
	beforeEach(() => setup(25));

	it("stops a run in progress and the agent goes back to idle", async () => {
		const app = appWith();
		const conversationId = conversationOf("pa");
		const sent = await json<SendMessageResponse>(
			post(app, `/api/conversations/${conversationId}/messages`, {
				content: "talk for a while",
				requestId: "req-abort-1",
			}),
		);
		const busy = () =>
			json<AgentsResponse>(app.request("/api/agents")).then(({ body }) => body.agents.find((a) => a.id === "pa")?.busy);
		await waitFor(busy, { what: "the agent to become busy" });

		const aborted = await json<{ ok: boolean }>(post(app, `/api/conversations/${conversationId}/abort`, {}));

		expect(aborted).toStrictEqual({ status: 200, body: { ok: true } });
		expect(await busy()).toBe(false);
		const submission = await runtime.harness.submission(sent.body.submissionId as SubmissionId, ctx);
		expect(await submission?.status(ctx)).toMatchObject({ status: "unanswered", reason: "aborted" });
	});

	it("is harmless when the agent is idle", async () => {
		const aborted = await json<{ ok: boolean }>(
			post(appWith(), `/api/conversations/${conversationOf("inbox")}/abort`, {}),
		);

		expect(aborted.body).toStrictEqual({ ok: true });
	});
});

describe("authentication", () => {
	beforeEach(() => setup());
	const owner: AuthConfig = { mode: "on", ownerLogin: "Dorje@Example.com" };
	const fromAddress = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

	it("lets the owner in, ignoring case, when the request arrives over loopback", async () => {
		const app = appWith(owner);

		for (const login of ["Dorje@Example.com", "dorje@example.com"]) {
			const response = await app.request(
				"/api/agents",
				{ headers: { "Tailscale-User-Login": login } },
				fromAddress("127.0.0.1"),
			);
			expect(response.status).toBe(200);
		}
		const v6 = await app.request(
			"/api/agents",
			{ headers: { "Tailscale-User-Login": "dorje@example.com" } },
			fromAddress("::1"),
		);
		expect(v6.status).toBe(200);
	});

	it("turns away a missing header, another user, and a non-loopback peer, each with its own explanation", async () => {
		const app = appWith(owner);

		const missing = await json<ApiErrorBody>(app.request("/api/agents", {}, fromAddress("127.0.0.1")));
		const other = await json<ApiErrorBody>(
			app.request("/api/agents", { headers: { "Tailscale-User-Login": "eve@example.com" } }, fromAddress("127.0.0.1")),
		);
		const remote = await json<ApiErrorBody>(
			app.request(
				"/api/agents",
				{ headers: { "Tailscale-User-Login": "dorje@example.com" } },
				fromAddress("100.64.0.7"),
			),
		);

		expect([missing.status, other.status, remote.status]).toStrictEqual([401, 401, 401]);
		expect(missing.body.error.message).toContain("Tailscale-User-Login header is missing");
		expect(other.body.error.message).toContain("eve@example.com is not allowed");
		expect(other.body.error.message).not.toContain("dorje");
		expect(remote.body.error.message).toContain("through Tailscale Serve on this machine");
	});

	it("protects every route, not only the listing", async () => {
		const app = appWith(owner);
		const id = conversationOf("pa");

		for (const [method, path] of [
			["GET", `/api/conversations/${id}/messages`],
			["POST", `/api/conversations/${id}/messages`],
			["POST", `/api/conversations/${id}/abort`],
			["GET", `/api/conversations/${id}/stream`],
			["GET", "/api/anything-else"],
		] as const) {
			const response = await app.request(path, { method }, fromAddress("127.0.0.1"));
			expect(response.status, `${method} ${path}`).toBe(401);
		}
	});

	it("allows everything without credentials when authentication is off", async () => {
		expect((await appWith({ mode: "off" }).request("/api/agents")).status).toBe(200);
	});
});

describe("error responses", () => {
	beforeEach(() => setup());

	it("answers unknown routes with the JSON error shape", async () => {
		const { status, body } = await json<ApiErrorBody>(appWith().request("/api/nope"));

		expect(status).toBe(404);
		expect(body.error.code).toBe("not_found");
	});

	it("hides internal details of unexpected failures from the client and logs them", async () => {
		const logged: unknown[][] = [];
		const app = createApp(
			appDepsFor(runtime, db, {
				db: {
					get: () => {
						throw new Error("secret database detail");
					},
				} as unknown as AppDb,
				logger: { error: (...args: unknown[]) => void logged.push(args) },
			}),
		);

		const { status, body } = await json<ApiErrorBody>(app.request("/api/conversations/2/messages"));

		expect(status).toBe(500);
		expect(body.error.code).toBe("internal_error");
		expect(JSON.stringify(body)).not.toContain("secret database detail");
		expect(String(logged[0]?.[1])).toContain("secret database detail");
	});
});

const put = (app: Hono, path: string, body: unknown, init: RequestInit = {}) =>
	app.request(path, {
		method: "PUT",
		headers: { "content-type": "application/json", ...init.headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

describe("who may talk to the API (Host and Sec-Fetch-Site)", () => {
	beforeEach(() => setup());

	const appFor = (publicHosts: string[] = [], auth: AuthConfig = { mode: "off" }) =>
		createApp(appDepsFor(runtime, db, { auth, hosts: createHostPolicy(3001, publicHosts) }));

	it.each([["127.0.0.1:3001"], ["localhost:3001"], ["LOCALHOST:3001"], ["[::1]:3001"]])(
		"answers a request addressed to %s",
		async (host) => {
			expect((await appFor().request("/api/agents", { headers: { host } })).status).toBe(200);
		},
	);

	it.each([["evil.example:3001"], ["127.0.0.1:3000"], ["localhost"], ["rebound.example"]])(
		"refuses Host %s in both authentication modes, naming the fix",
		async (host) => {
			for (const auth of [{ mode: "off" }, { mode: "on", ownerLogin: "me@example.com" }] as AuthConfig[]) {
				const headers = { host, "tailscale-user-login": "me@example.com" };
				const { status, body } = await json<ApiErrorBody>(appFor([], auth).request("/api/agents", { headers }));

				expect(status).toBe(403);
				expect(body.error.code).toBe("forbidden");
				expect(body.error.message).toContain("ASSISTANT_PUBLIC_HOST");
			}
		},
	);

	it("answers the configured tailnet host name, with or without the port it was configured with", async () => {
		const app = appFor(["laptop.tail1234.ts.net", "laptop.tail1234.ts.net:8443"]);

		for (const host of ["laptop.tail1234.ts.net", "laptop.tail1234.ts.net:8443"]) {
			expect((await app.request("/api/agents", { headers: { host } })).status, host).toBe(200);
		}
		expect((await app.request("/api/agents", { headers: { host: "laptop.tail1234.ts.net:9" } })).status).toBe(403);
	});

	it("also checks the host the browser used when a proxy rewrote Host (the Next dev proxy does)", async () => {
		const app = appFor(["laptop.tail1234.ts.net"]);
		const viaProxy = (forwarded: string) =>
			app.request("/api/agents", { headers: { host: "127.0.0.1:3001", "x-forwarded-host": forwarded } });

		expect((await viaProxy("localhost:3000")).status).toBe(200);
		expect((await viaProxy("laptop.tail1234.ts.net")).status).toBe(200);
		expect((await viaProxy("rebound.example:3000")).status).toBe(403);
		expect((await viaProxy("localhost:3000, rebound.example")).status).toBe(403);
	});

	it("refuses a state-changing request the browser marks as cross-site, but not reads, same-origin or non-browser calls", async () => {
		const app = appFor();
		const path = `/api/conversations/${conversationOf("pa")}/abort`;
		const withSite = (site?: string) =>
			post(app, path, {}, { headers: site === undefined ? {} : { "sec-fetch-site": site } });

		for (const site of ["cross-site", "same-site"]) {
			const { status, body } = await json<ApiErrorBody>(withSite(site));
			expect([status, body.error.code], site).toStrictEqual([403, "forbidden"]);
		}
		for (const site of ["same-origin", "none", undefined])
			expect((await withSite(site)).status, String(site)).toBe(200);
		expect((await app.request("/api/agents", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(200);
	});
});

describe("the owner's pages sit behind the same guards as every other route", () => {
	beforeEach(() => setup());

	/** Every route of the owner's pages (profile, memory, activity, usage and the limits), with a body for the writes. */
	const ROUTES: ReadonlyArray<readonly [method: string, path: string, body?: unknown]> = [
		["GET", "/api/profile"],
		["PUT", "/api/profile/preferences", { tone: "Direct." }],
		["GET", "/api/memory"],
		["PATCH", "/api/memory/m_00000000", { pinned: true }],
		["DELETE", "/api/memory/m_00000000", {}],
		["GET", "/api/activity"],
		["GET", "/api/usage"],
		["PUT", "/api/settings/budget/pa", { weeklyTokens: 1000 }],
	];
	const WRITES = ROUTES.filter(([method]) => method !== "GET");
	const OWNER = "me@example.com";
	const appFor = (auth: AuthConfig = { mode: "off" }) =>
		createApp(appDepsFor(runtime, db, { auth, hosts: createHostPolicy(3001, ["laptop.tail1234.ts.net"]) }));
	const fromLoopback = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
	const send = (
		app: Hono,
		[method, path, body]: (typeof ROUTES)[number],
		headers: Record<string, string> = {},
		payload: string | undefined = body === undefined ? undefined : JSON.stringify(body),
	) =>
		app.request(
			path,
			{
				method,
				headers: {
					...(payload === undefined || "content-type" in headers ? {} : { "content-type": "application/json" }),
					...headers,
				},
				...(payload === undefined ? {} : { body: payload }),
			},
			fromLoopback,
		);

	it("answers the owner on the right host (so that the refusals below are the guards' and nothing else's)", async () => {
		const app = appFor({ mode: "on", ownerLogin: OWNER });

		for (const route of ROUTES) {
			const { status } = await send(app, route, { host: "laptop.tail1234.ts.net", "tailscale-user-login": OWNER });
			// 404 is the answer for the line that does not exist: it got past the guards to the route.
			expect([200, 404], route.join(" ")).toContain(status);
		}
	});

	it.each([["evil.example:3001"], ["127.0.0.1:3000"], ["rebound.example"]])(
		"refuses Host %s on every route, in both authentication modes",
		async (host) => {
			for (const auth of [{ mode: "off" }, { mode: "on", ownerLogin: OWNER }] as AuthConfig[]) {
				for (const route of ROUTES) {
					const { status, body } = await json<ApiErrorBody>(
						send(appFor(auth), route, { host, "tailscale-user-login": OWNER }),
					);
					expect([status, body.error.code], `${route.join(" ")} (${auth.mode})`).toStrictEqual([403, "forbidden"]);
				}
			}
		},
	);

	it("refuses a write the browser marks as cross-site or same-site, but answers the same one from the same origin", async () => {
		const app = appFor();

		for (const route of WRITES) {
			for (const site of ["cross-site", "same-site"]) {
				const { status, body } = await json<ApiErrorBody>(send(app, route, { "sec-fetch-site": site }));
				expect([status, body.error.code], `${route.join(" ")} ${site}`).toStrictEqual([403, "forbidden"]);
			}
			expect([200, 404], route.join(" ")).toContain(
				(await send(app, route, { "sec-fetch-site": "same-origin" })).status,
			);
		}
	});

	it("takes JSON and nothing else on a write: a form, plain text or no content type is a 415", async () => {
		const app = appFor();

		for (const route of WRITES) {
			for (const type of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data; boundary=x"]) {
				const { status, body } = await json<ApiErrorBody>(send(app, route, { "content-type": type }, "tone=Direct."));
				expect([status, body.error.code], `${route.join(" ")} ${type}`).toStrictEqual([415, "invalid_request"]);
			}
			expect((await send(app, route, { "content-type": "" }, "{}")).status, `${route.join(" ")} without a type`).toBe(
				415,
			);
		}
	});

	it("refuses a body over the size limit before reading it", async () => {
		const app = appFor();
		const huge = JSON.stringify({ tone: "x".repeat(MAX_REQUEST_BYTES) });

		for (const route of WRITES) {
			const { status, body } = await json<ApiErrorBody>(send(app, route, {}, huge));
			expect([status, body.error.code], route.join(" ")).toStrictEqual([413, "payload_too_large"]);
		}
	});

	it("asks who is calling when authentication is on: no login, or another one, is a 401 on every route", async () => {
		const app = appFor({ mode: "on", ownerLogin: OWNER });

		for (const route of ROUTES) {
			for (const headers of [{}, { "tailscale-user-login": "eve@example.com" }] as Array<Record<string, string>>) {
				expect((await send(app, route, headers)).status, `${route.join(" ")} ${JSON.stringify(headers)}`).toBe(401);
			}
		}
	});

	it("sends no CORS headers and answers no preflight, so another site's page cannot read these either", async () => {
		const app = appFor();

		for (const route of ROUTES) {
			const response = await send(app, route);
			expect(response.headers.get("access-control-allow-origin"), route.join(" ")).toBeNull();
		}
		expect(
			(await app.request("/api/memory", { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status,
		).toBe(404);
	});
});

describe("request limits", () => {
	beforeEach(() => setup());

	it("rejects a body over the size limit before reading it, with a content length or without one", async () => {
		const app = appWith();
		const path = `/api/conversations/${conversationOf("pa")}/messages`;
		const huge = JSON.stringify({ content: "x".repeat(MAX_REQUEST_BYTES), requestId: "req-huge-1" });

		const declared = await json<ApiErrorBody>(post(app, path, huge));
		const chunked = await json<ApiErrorBody>(
			app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(huge));
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit),
		);

		expect([declared.status, declared.body.error.code]).toStrictEqual([413, "payload_too_large"]);
		expect([chunked.status, chunked.body.error.code]).toStrictEqual([413, "payload_too_large"]);
	});

	it("caps the number of open event streams, and frees a slot when one closes", async () => {
		const app = createApp(appDepsFor(runtime, db, { maxStreams: 2 }));
		const path = `/api/conversations/${conversationOf("pa")}/stream`;
		const controllers = [new AbortController(), new AbortController()];
		const open = controllers.map((controller) => app.request(path, { signal: controller.signal }));
		const [first, second] = await Promise.all(open);
		expect([first?.status, second?.status]).toStrictEqual([200, 200]);

		const refused = await json<ApiErrorBody>(app.request(path));
		expect([refused.status, refused.body.error.code]).toStrictEqual([429, "too_many_requests"]);

		controllers[0]?.abort();
		const freed = new AbortController();
		const retry = await waitFor(
			async () => {
				const response = await app.request(path, { signal: freed.signal });
				if (response.status === 200) return response;
				await response.body?.cancel();
				return undefined;
			},
			{ what: "a stream slot to be freed" },
		);
		expect(retry.status).toBe(200);
		controllers[1]?.abort();
		freed.abort();
	});
});

describe("agent settings", () => {
	beforeEach(() => setup());

	const settingsPath = (agentId: string) => `/api/settings/agents/${agentId}`;

	it("lists every agent's model and thinking level with the models this server can serve", async () => {
		const { status, body } = await json<AllAgentSettingsResponse>(appWith().request("/api/settings/agents"));

		expect(status).toBe(200);
		expect(body.agents.map((agent) => agent.id)).toStrictEqual(["pa", "inbox", "health", "accountant"]);
		expect(body.agents[0]).toMatchObject({
			model: { provider: "faux", modelId: "faux-1" },
			thinkingLevel: "medium",
			modelAvailable: true,
		});
		expect(body.models).toHaveLength(1);
		expect(body.models[0]).toMatchObject({ provider: "faux", modelId: "faux-1" });
		expect(body.models[0]?.thinkingLevels).toContain("low");
	});

	it("changes the thinking level, and the change is what the conversation then holds", async () => {
		const app = appWith();

		const { status, body } = await json<AgentSettingsResponse>(
			put(app, settingsPath("health"), { thinkingLevel: "high" }),
		);

		expect(status).toBe(200);
		expect(body.agent).toMatchObject({ id: "health", thinkingLevel: "high", modelAvailable: true });
		const reread = await json<AgentSettingsResponse>(app.request(settingsPath("health")));
		expect(reread.body.agent.thinkingLevel).toBe("high");
		expect((await json<AgentSettingsResponse>(app.request(settingsPath("pa")))).body.agent.thinkingLevel).toBe(
			"medium",
		);
	});

	it("fixes an agent that holds a model this server cannot serve (created in another model mode)", async () => {
		const app = appWith();
		const conversation = await runtime.harness.conversation(conversationOf("inbox") as never, ctx);
		await conversation?.configure(
			{ model: { provider: "openai", modelId: "gpt-6.1-sol" }, thinkingLevel: "xhigh" },
			ctx,
		);
		const broken = await json<AgentSettingsResponse>(app.request(settingsPath("inbox")));
		expect(broken.body.agent).toMatchObject({ model: { provider: "openai" }, modelAvailable: false });

		// A thinking level alone cannot be checked against a model nobody can serve.
		const unfixable = await json<ApiErrorBody>(put(app, settingsPath("inbox"), { thinkingLevel: "low" }));
		expect(unfixable.status).toBe(400);
		expect(unfixable.body.error.message).toContain("faux/faux-1");

		const fixed = await json<AgentSettingsResponse>(
			put(app, settingsPath("inbox"), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "low" }),
		);
		expect(fixed.body.agent).toMatchObject({
			model: { provider: "faux", modelId: "faux-1" },
			thinkingLevel: "low",
			modelAvailable: true,
		});
	});

	it("moves a thinking level the new model does not support to the nearest one it does", async () => {
		const app = appWith();
		const conversation = await runtime.harness.conversation(conversationOf("inbox") as never, ctx);
		await conversation?.configure({ model: { provider: "openai", modelId: "gpt-6.1-sol" }, thinkingLevel: "max" }, ctx);

		const { body } = await json<AgentSettingsResponse>(
			put(app, settingsPath("inbox"), { model: { provider: "faux", modelId: "faux-1" } }),
		);

		const supported =
			(await json<AgentSettingsResponse>(app.request(settingsPath("inbox")))).body.models[0]?.thinkingLevels ?? [];
		expect(supported).toContain(body.agent.thinkingLevel);
	});

	it.each([
		[
			"an unknown model",
			{ model: { provider: "faux", modelId: "gpt-9" } },
			/Unknown model 'faux\/gpt-9'.*faux\/faux-1/,
		],
		[
			"a model of another provider",
			{ model: { provider: "openai", modelId: "gpt-6.1-sol" } },
			/Unknown model 'openai\/gpt-6.1-sol'/,
		],
		[
			"a thinking level that does not exist",
			{ thinkingLevel: "ludicrous" },
			/'thinkingLevel' must be one of: off, minimal/,
		],
		["an empty change", {}, /Send 'model', 'thinkingLevel' or both/],
		["a malformed model", { model: "faux-1" }, /'model' must be an object/],
	])("refuses %s with a message that says what is allowed", async (_name, payload, message) => {
		const { status, body } = await json<ApiErrorBody>(put(appWith(), settingsPath("pa"), payload));

		expect(status).toBe(400);
		expect(body.error.code).toBe("invalid_request");
		expect(body.error.message).toMatch(message);
	});

	it("is a JSON-only, owner-only API like the rest, and unknown agents are 404", async () => {
		const app = appWith({ mode: "on", ownerLogin: "me@example.com" });
		const owner = { "tailscale-user-login": "me@example.com" };
		const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
		const asOwner = (init: RequestInit) =>
			app.request(settingsPath("pa"), { ...init, headers: { ...owner, ...(init.headers as object) } }, peer);

		expect((await app.request(settingsPath("pa"), {}, peer)).status).toBe(401);
		expect((await asOwner({ method: "PUT", body: "{}", headers: { "content-type": "text/plain" } })).status).toBe(415);
		expect((await app.request(settingsPath("nobody"), { headers: owner }, peer)).status).toBe(404);
	});
});
