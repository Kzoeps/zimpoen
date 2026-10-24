import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, fetchAgents, sendMessage, updateAgentSettings } from "../src/lib/api.ts";

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
