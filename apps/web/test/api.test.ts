import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ApiRequestError,
	decideApproval,
	decideSuggestion,
	disconnectGoogleAccount,
	fetchAgents,
	fetchGoogleSettings,
	fetchSchedule,
	fileUrl,
	retryTask,
	sendMessage,
	type UploadRequest,
	unsubscribePush,
	updateAgentSettings,
	updateSchedule,
	uploadFile,
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

describe("the daily schedule and file calls", () => {
	const lastCall = (): [string, RequestInit] => {
		const calls = vi.mocked(fetch).mock.calls;
		return calls[calls.length - 1] as unknown as [string, RequestInit];
	};

	it("reads the schedule, and changes one job with a JSON PUT that names the job", async () => {
		stubFetch(() => Response.json({ timezone: "Asia/Thimphu", jobs: [] }));

		await fetchSchedule();
		expect(lastCall()[0]).toBe("/api/settings/schedule");

		await updateSchedule("briefing", { localTime: "07:45", enabled: true });
		const [url, init] = lastCall();
		expect(url).toBe("/api/settings/schedule/briefing");
		expect(init).toMatchObject({ method: "PUT", headers: { "content-type": "application/json" } });
		expect(JSON.parse(init.body as string)).toStrictEqual({ localTime: "07:45", enabled: true });
	});

	it("names a stored file's address by its id, so that an image opens in the page and anything else downloads", () => {
		expect(fileUrl("fi_0a1b2c3d")).toBe("/api/files/fi_0a1b2c3d");
		expect(fileUrl("a/b")).toBe("/api/files/a%2Fb");
	});
});

describe("the Inbox calls", () => {
	const lastCall = (): [string, RequestInit] => {
		const calls = vi.mocked(fetch).mock.calls;
		return calls[calls.length - 1] as unknown as [string, RequestInit];
	};

	it("answers a suggestion with a JSON POST that names the suggestion and the decision", async () => {
		stubFetch(() => Response.json({ id: "sg_ab12cd34", status: "added" }));

		const state = await decideSuggestion("sg_ab12cd34", "add");

		const [url, init] = lastCall();
		expect(url).toBe("/api/suggestions/sg_ab12cd34");
		expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
		expect(JSON.parse(init.body as string)).toStrictEqual({ decision: "add" });
		expect(state).toStrictEqual({ id: "sg_ab12cd34", status: "added" });
		await decideSuggestion("sg_ab12cd34", "dismiss");
		expect(JSON.parse(lastCall()[1].body as string)).toStrictEqual({ decision: "dismiss" });
	});

	it("shows the server's reason when the other answer was recorded first, with the 409 the card goes by", async () => {
		stubFetch(() =>
			Response.json(
				{ error: { code: "conflict", message: "Suggestion sg_ab12cd34 was already dismissed." } },
				{ status: 409 },
			),
		);

		await expect(decideSuggestion("sg_ab12cd34", "add")).rejects.toMatchObject({
			status: 409,
			message: "Suggestion sg_ab12cd34 was already dismissed.",
		});
	});

	it("reads the Google accounts, and disconnects one with a JSON DELETE that carries the address in the body, never in the path", async () => {
		stubFetch(() =>
			Response.json({ mode: "real", clientConfigured: true, triage: { mode: "rules" }, syncMinutes: 10, accounts: [] }),
		);

		await fetchGoogleSettings();
		expect(lastCall()[0]).toBe("/api/settings/google");

		await disconnectGoogleAccount("work@x.example");
		const [url, init] = lastCall();
		expect(url).toBe("/api/settings/google/accounts");
		expect(init).toMatchObject({ method: "DELETE", headers: { "content-type": "application/json" } });
		expect(JSON.parse(init.body as string)).toStrictEqual({ email: "work@x.example" });
	});
});

describe("uploading a file", () => {
	type Handler = ((this: unknown, event: never) => unknown) | null;

	/** Stands in for `XMLHttpRequest`: the test decides what the network does and when. */
	function fakeRequest() {
		const sent: { method?: string; url?: string; body?: FormData } = {};
		const xhr = {
			status: 0,
			responseText: "",
			onload: null as Handler,
			onerror: null as Handler,
			onabort: null as Handler,
			upload: { onprogress: null as Handler },
			open(method: string, url: string) {
				sent.method = method;
				sent.url = url;
			},
			send(body: FormData) {
				sent.body = body;
			},
			abort: vi.fn(() => {
				xhr.onabort?.call(xhr, new Event("abort") as never);
			}),
		};
		return {
			sent,
			xhr,
			create: () => xhr as unknown as UploadRequest,
			progress(loaded: number, total: number, lengthComputable = true) {
				xhr.upload.onprogress?.call(xhr.upload, { loaded, total, lengthComputable } as never);
			},
			answer(status: number, body: string) {
				xhr.status = status;
				xhr.responseText = body;
				xhr.onload?.call(xhr, new Event("load") as never);
			},
			networkError() {
				xhr.onerror?.call(xhr, new Event("error") as never);
			},
		};
	}

	const photo = () => new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });
	const storedBody = JSON.stringify({
		file: {
			id: "fi_0a1b2c3d",
			name: "photo.png",
			mime: "image/png",
			kind: "image",
			size: 3,
			source: "upload",
			addedAt: 1,
		},
	});

	it("posts the file as a multipart form to the upload route and resolves with the stored file", async () => {
		const request = fakeRequest();

		const upload = uploadFile(photo(), () => {}, request.create);
		request.answer(201, storedBody);

		await expect(upload.done).resolves.toMatchObject({ file: { id: "fi_0a1b2c3d", name: "photo.png" } });
		expect(request.sent.method).toBe("POST");
		expect(request.sent.url).toBe("/api/uploads");
		const part = request.sent.body?.get("file") as File;
		expect(part.name).toBe("photo.png");
		expect(part.size).toBe(3);
	});

	it("reports how much of the body has gone as a fraction, never above one, and skips what cannot be measured", () => {
		const request = fakeRequest();
		const seen: number[] = [];

		uploadFile(photo(), (fraction) => seen.push(fraction), request.create);
		request.progress(0, 100);
		request.progress(25, 100);
		request.progress(50, 0); // no total
		request.progress(99, 100, false); // the browser could not tell
		request.progress(130, 100); // multipart framing makes the sent bytes exceed the file's

		expect(seen).toStrictEqual([0, 0.25, 1]);
	});

	it.each([
		[413, { error: { code: "payload_too_large", message: "That file is over 20 MB." } }, "That file is over 20 MB."],
		[
			415,
			{ error: { code: "invalid_request", message: "The assistant takes images, PDFs, CSV and text files." } },
			"The assistant takes images, PDFs, CSV and text files.",
		],
		[
			403,
			{ error: { code: "forbidden", message: "This page is not one the assistant answers." } },
			"This page is not one the assistant answers.",
		],
	])("shows the server's own words for a %d", async (status, body, message) => {
		const request = fakeRequest();

		const upload = uploadFile(photo(), () => {}, request.create);
		request.answer(status, JSON.stringify(body));

		const failure = await upload.done.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ApiRequestError);
		expect(failure).toMatchObject({ status, message });
	});

	it("says the server may be restarting when a proxy answers 5xx with its own page, and plainly for other statuses", async () => {
		const bad = fakeRequest();
		const upload502 = uploadFile(photo(), () => {}, bad.create);
		bad.answer(502, "<h1>Bad gateway</h1>");
		const failure502 = await upload502.done.catch((error: unknown) => error);
		expect(failure502).toMatchObject({ status: 502, code: "http_error" });
		expect((failure502 as Error).message).toMatch(/not answering properly \(HTTP 502\).*restarting/);

		const missing = fakeRequest();
		const upload404 = uploadFile(photo(), () => {}, missing.create);
		missing.answer(404, "");
		await expect(upload404.done).rejects.toMatchObject({ status: 404, message: "The server answered 404." });
	});

	it("tells the owner the upload did not reach the assistant when the network fails", async () => {
		const request = fakeRequest();

		const upload = uploadFile(photo(), () => {}, request.create);
		request.networkError();

		await expect(upload.done).rejects.toMatchObject({
			status: 0,
			code: "network",
			message: expect.stringMatching(/did not reach the assistant/),
		});
	});

	it("stops the upload on abort, and the rejection says it was cancelled so that the composer does not show an error", async () => {
		const request = fakeRequest();

		const upload = uploadFile(photo(), () => {}, request.create);
		upload.abort();

		expect(request.xhr.abort).toHaveBeenCalledOnce();
		await expect(upload.done).rejects.toMatchObject({ code: "aborted" });
	});
});
