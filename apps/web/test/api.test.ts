import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ApiRequestError,
	decideApproval,
	fetchAgents,
	retryTask,
	sendMessage,
	unsubscribePush,
	updateAgentSettings,
} from "../src/lib/api.ts";

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (response: () => Response) =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => response()),
	);

describe("errors from the server", () => {
	it("uses the message of the server's own error body", async () => {
		stubFetch(() =>
			Response.json(
				{ error: { code: "invalid_request", message: "'content' must be a non-empty string." } },
				{ status: 400 },
			),
		);

		await expect(sendMessage(2, { content: "", requestId: "x" })).rejects.toMatchObject({
			status: 400,
			code: "invalid_request",
			message: "'content' must be a non-empty string.",
		});
	});

	it.each([
		[
			"a proxy's own JSON body",
			() => Response.json({ message: "Bad gateway" }, { status: 502, statusText: "Bad Gateway" }),
		],
		["an HTML error page", () => new Response("<h1>502</h1>", { status: 502, statusText: "Bad Gateway" })],
		[
			"an error object without a code",
			() => Response.json({ error: "nope" }, { status: 502, statusText: "Bad Gateway" }),
		],
	])("turns %s into an ApiRequestError, not a TypeError", async (_name, response) => {
		stubFetch(response);

		const failure = await fetchAgents().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ApiRequestError);
		expect(failure).toMatchObject({ status: 502, code: "http_error" });
		expect((failure as Error).message).toMatch(/not answering properly \(HTTP 502\).*restarting.*try again/);
	});

	it("keeps the plain status for a client error that has no body of ours", async () => {
		stubFetch(() => new Response("", { status: 404, statusText: "Not Found" }));

		await expect(fetchAgents()).rejects.toMatchObject({ status: 404, message: "The server answered 404 Not Found." });
	});

	it("says the server is unreachable when the request cannot be made", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

		await expect(fetchAgents()).rejects.toMatchObject({ status: 0, code: "network" });
	});
});

describe("saving agent settings", () => {
	it("PUTs JSON to the agent's settings route", async () => {
		const fetchMock = vi.fn(async () => Response.json({ agent: {}, models: [] }));
		vi.stubGlobal("fetch", fetchMock);

		await updateAgentSettings("pa", { thinkingLevel: "high" });

		expect(fetchMock).toHaveBeenCalledWith("/api/settings/agents/pa", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ thinkingLevel: "high" }),
		});
	});
});

describe("the M2 calls", () => {
	const lastCall = (): [string, RequestInit] => {
		const calls = vi.mocked(fetch).mock.calls;
		return calls[calls.length - 1] as unknown as [string, RequestInit];
	};

	it("answers an approval with a JSON POST that names the request and the decision", async () => {
		stubFetch(() => Response.json({ id: "ap_1", status: "executed", summary: "x", expiresAt: 1 }));

		const state = await decideApproval("ap_1", "approve");

		const [url, init] = lastCall();
		expect(url).toBe("/api/approvals/ap_1");
		expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
		expect(JSON.parse(init.body as string)).toStrictEqual({ decision: "approve" });
		expect(state.status).toBe("executed");
	});

	it("shows the server's reason when an approval is refused as already answered or expired", async () => {
		stubFetch(() =>
			Response.json(
				{ error: { code: "conflict", message: "This request expired: nothing was changed." } },
				{ status: 409 },
			),
		);

		await expect(decideApproval("ap_1", "approve")).rejects.toMatchObject({
			status: 409,
			code: "conflict",
			message: "This request expired: nothing was changed.",
		});
	});

	it("unsubscribes with DELETE and a JSON body, which the server's guards require for every write", async () => {
		stubFetch(() => Response.json({ removed: true }));

		await unsubscribePush("https://push.example/abc");

		const [url, init] = lastCall();
		expect(url).toBe("/api/push/subscribe");
		expect(init).toMatchObject({ method: "DELETE", headers: { "content-type": "application/json" } });
		expect(JSON.parse(init.body as string)).toStrictEqual({ endpoint: "https://push.example/abc" });
	});

	it("retries a parked task by id", async () => {
		stubFetch(() => Response.json({ ok: true }));

		await retryTask(17);

		const [url, init] = lastCall();
		expect(url).toBe("/api/admin/tasks/17/retry");
		expect(init.method).toBe("POST");
	});
});
