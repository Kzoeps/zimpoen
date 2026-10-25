import { type AttachmentRef, splitAttachments, type UploadResponse, withAttachments } from "@assistant/shared";
import { describe, expect, it, vi } from "vitest";
import {
	captureUrl,
	handleShare,
	MAX_SHARED_TEXT_CHARS,
	readCapture,
	type SharedItem,
	shareText,
} from "../src/lib/share.ts";

const API = "http://127.0.0.1:3001";

/** What the Android share sheet sends: a multipart POST made by the browser itself. */
function shareRequest(
	fields: Record<string, string>,
	files: File[] = [],
	headers: Record<string, string> = { "sec-fetch-site": "none" },
): Request {
	const form = new FormData();
	for (const [name, value] of Object.entries(fields)) form.set(name, value);
	for (const file of files) form.append("files", file, file.name);
	return new Request("https://assistant.example/share", { method: "POST", body: form, headers });
}

const png = (name = "photo.png"): File =>
	new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });

const storedAs = (id: string, name: string, mime = "image/png"): Response =>
	Response.json(
		{ file: { id, name, mime, kind: "image", size: 4, source: "upload", addedAt: 1 } } satisfies UploadResponse,
		{ status: 201 },
	);

const refused = (status: number, message: string): Response =>
	Response.json({ error: { code: "invalid_request", message } }, { status });

type Forwarded = { url: string; init: RequestInit };

/** A `fetch` that answers each call from a queue and remembers what it was asked. */
function fakeFetch(...answers: Array<Response | Error>) {
	const calls: Forwarded[] = [];
	const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const next = answers[calls.length - 1];
		if (next === undefined) throw new Error("unexpected extra upload");
		if (next instanceof Error) throw next;
		return next;
	});
	return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

/** Where the browser is sent, read the way the capture page reads it. */
function captured(response: Response): SharedItem {
	const location = response.headers.get("location") ?? "";
	return readCapture(new URL(location, "https://assistant.example").searchParams);
}

describe("who may share", () => {
	it.each([
		["a request with no Sec-Fetch-Site (not a browser)", {}],
		["a page on another site", { "sec-fetch-site": "cross-site" }],
		["a sibling subdomain", { "sec-fetch-site": "same-site" }],
	])("refuses %s before touching the files", async (_name, headers) => {
		const { fetch, calls } = fakeFetch();

		const response = await handleShare(shareRequest({ text: "hi" }, [png()], headers), { apiOrigin: API, fetch });

		expect(response.status).toBe(403);
		expect(await response.text()).toMatch(/only from the Android share sheet or its own page/);
		expect(calls).toHaveLength(0);
	});

	it.each(["none", "same-origin"])("accepts a share the browser itself made (Sec-Fetch-Site: %s)", async (site) => {
		const { fetch } = fakeFetch();

		const response = await handleShare(shareRequest({ text: "hi" }, [], { "sec-fetch-site": site }), {
			apiOrigin: API,
			fetch,
		});

		expect(response.status).toBe(303);
	});

	it("answers 400, not a crash, when the body is not a form", async () => {
		const { fetch } = fakeFetch();
		const request = new Request("https://assistant.example/share", {
			method: "POST",
			body: "not a form",
			headers: { "sec-fetch-site": "none", "content-type": "text/plain" },
		});

		const response = await handleShare(request, { apiOrigin: API, fetch });

		expect(response.status).toBe(400);
	});
});

describe("sending what was shared to the capture page", () => {
	it("redirects with 303, so the browser opens the capture page with a GET", async () => {
		const { fetch } = fakeFetch();

		const response = await handleShare(
			shareRequest({ title: "Article", text: "Worth a read", url: "https://example.com/a?b=1&c=2" }),
			{ apiOrigin: API, fetch },
		);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toMatch(/^\/capture\?/);
		expect(captured(response)).toStrictEqual({
			title: "Article",
			text: "Worth a read",
			url: "https://example.com/a?b=1&c=2",
			files: [],
			problems: [],
		});
	});

	it("passes the caller, the fetch site and the page's host on to the API, which decides as it would for the browser", async () => {
		const { fetch, calls } = fakeFetch(storedAs("fi_0a1b2c3d", "photo.png"));

		await handleShare(
			shareRequest({}, [png()], {
				"sec-fetch-site": "same-origin",
				"tailscale-user-login": "dorje@example.com",
				host: "assistant.tail1234.ts.net",
				cookie: "must-not-travel=1",
			}),
			{ apiOrigin: API, fetch },
		);

		expect(calls).toHaveLength(1);
		const [{ url, init }] = calls as [Forwarded];
		expect(url).toBe(`${API}/api/uploads`);
		expect(init.method).toBe("POST");
		const headers = new Headers(init.headers);
		expect(headers.get("tailscale-user-login")).toBe("dorje@example.com");
		expect(headers.get("sec-fetch-site")).toBe("same-origin");
		expect(headers.get("x-forwarded-host")).toBe("assistant.tail1234.ts.net");
		expect(headers.has("cookie")).toBe(false);
		const sent = init.body as FormData;
		expect((sent.get("file") as File).name).toBe("photo.png");
	});

	it("prefers the host a proxy in front of the page already named", async () => {
		const { fetch, calls } = fakeFetch(storedAs("fi_0a1b2c3d", "photo.png"));

		await handleShare(
			shareRequest({}, [png()], {
				"sec-fetch-site": "none",
				host: "127.0.0.1:3000",
				"x-forwarded-host": "assistant.tail1234.ts.net",
			}),
			{ apiOrigin: API, fetch },
		);

		expect(new Headers(calls[0]?.init.headers).get("x-forwarded-host")).toBe("assistant.tail1234.ts.net");
	});

	it("stores each shared file with its own upload and lists them in the order they came", async () => {
		const { fetch, calls } = fakeFetch(
			storedAs("fi_aaaaaaaa", "one.png"),
			storedAs("fi_bbbbbbbb", "two.png"),
			storedAs("fi_cccccccc", "notes.txt", "text/plain"),
		);

		const response = await handleShare(
			shareRequest({ text: "three things" }, [png("one.png"), png("two.png"), new File(["hi"], "notes.txt")]),
			{ apiOrigin: API, fetch },
		);

		expect(
			calls.map((call) => (call.init.body as FormData).get("file")).map((file) => (file as File).name),
		).toStrictEqual(["one.png", "two.png", "notes.txt"]);
		expect(captured(response).files).toStrictEqual([
			{ id: "fi_aaaaaaaa", name: "one.png", mime: "image/png", size: 4 },
			{ id: "fi_bbbbbbbb", name: "two.png", mime: "image/png", size: 4 },
			{ id: "fi_cccccccc", name: "notes.txt", mime: "text/plain", size: 4 },
		]);
	});

	it("ignores the empty file part some share sheets send when only text is shared", async () => {
		const { fetch, calls } = fakeFetch();

		const response = await handleShare(shareRequest({ text: "just text" }, [new File([], "")]), {
			apiOrigin: API,
			fetch,
		});

		expect(calls).toHaveLength(0);
		expect(captured(response)).toMatchObject({ text: "just text", files: [], problems: [] });
	});

	it("tells the owner about a file the server refused, and still keeps the ones it took", async () => {
		const { fetch } = fakeFetch(
			storedAs("fi_aaaaaaaa", "good.png"),
			refused(415, "The assistant takes images, PDFs, CSV and text files."),
		);

		const response = await handleShare(shareRequest({}, [png("good.png"), new File(["MZ"], "setup.exe")]), {
			apiOrigin: API,
			fetch,
		});

		expect(response.status).toBe(303);
		expect(captured(response)).toMatchObject({
			files: [{ id: "fi_aaaaaaaa", name: "good.png" }],
			problems: ["setup.exe: The assistant takes images, PDFs, CSV and text files."],
		});
	});

	it("says so when the server cannot be reached or answers without its own error body, instead of failing the share", async () => {
		const { fetch } = fakeFetch(
			new Error("connect ECONNREFUSED"),
			new Response("<h1>Bad gateway</h1>", { status: 502 }),
		);

		const response = await handleShare(shareRequest({}, [png("a.png"), png("b.png")]), { apiOrigin: API, fetch });

		expect(response.status).toBe(303);
		expect(captured(response).problems).toStrictEqual([
			"a.png: the assistant server could not be reached.",
			"b.png: the server answered 502.",
		]);
	});

	it(`keeps a text longer than ${MAX_SHARED_TEXT_CHARS} characters as a file, because an address cannot carry it`, async () => {
		const long = "x".repeat(MAX_SHARED_TEXT_CHARS + 1);
		const { fetch, calls } = fakeFetch(storedAs("fi_0a1b2c3d", "shared-text.txt", "text/plain"));

		const response = await handleShare(shareRequest({ title: "Long read", text: long }), { apiOrigin: API, fetch });

		const [first] = calls as [Forwarded];
		const sent = (first.init.body as FormData).get("file") as File;
		expect(sent.name).toBe("shared-text.txt");
		expect(sent.type).toBe("text/plain");
		expect(await sent.text()).toBe(long);
		const shared = captured(response);
		expect(shared.text).toBe("");
		expect(shared.title).toBe("Long read");
		expect(shared.files).toMatchObject([{ id: "fi_0a1b2c3d", name: "shared-text.txt" }]);
		expect(response.headers.get("location")?.length).toBeLessThan(500);
	});

	it("keeps a text at exactly the limit in the address", async () => {
		const exact = "y".repeat(MAX_SHARED_TEXT_CHARS);
		const { fetch, calls } = fakeFetch();

		const response = await handleShare(shareRequest({ text: exact }), { apiOrigin: API, fetch });

		expect(calls).toHaveLength(0);
		expect(captured(response).text).toBe(exact);
	});

	it("limits the title and the link to what an address can sensibly carry", async () => {
		const { fetch } = fakeFetch();

		const shared = captured(
			await handleShare(shareRequest({ title: "t".repeat(500), url: `https://x.test/${"u".repeat(5000)}` }), {
				apiOrigin: API,
				fetch,
			}),
		);

		expect(shared.title).toHaveLength(200);
		expect(shared.url).toHaveLength(2000);
	});
});

describe("the capture page's address", () => {
	it("goes to the bare page when nothing was shared", () => {
		expect(captureUrl({ title: "", text: "", url: "", files: [], problems: [] })).toBe("/capture");
	});

	it("carries one problem parameter per refused file, each cut to a line", () => {
		const url = captureUrl({ title: "", text: "", url: "", files: [], problems: ["a: no", `b: ${"x".repeat(400)}`] });

		const problems = new URL(url, "https://assistant.example").searchParams.getAll("problem");
		expect(problems).toHaveLength(2);
		expect(problems[0]).toBe("a: no");
		expect(problems[1]).toHaveLength(300);
	});
});

describe("reading the capture page's address back", () => {
	const good = { id: "fi_0a1b2c3d", name: "receipt.png", mime: "image/png", size: 340 };
	const readFiles = (files: unknown) => readCapture(new URLSearchParams({ files: JSON.stringify(files) })).files;

	it("keeps a well-formed file", () => {
		expect(readFiles([good])).toStrictEqual([good]);
	});

	it.each([
		["an id that is not one of ours", { ...good, id: "fi_123" }],
		["an id with upper-case digits", { ...good, id: "fi_0A1B2C3D" }],
		["an id that tries to be more", { ...good, id: "fi_0a1b2c3d/../x" }],
		["a type with a parameter", { ...good, mime: "text/html; charset=utf-8" }],
		["a type that is not one", { ...good, mime: "image" }],
		["a size that is not a number", { ...good, size: "340" }],
		["a name that is not text", { ...good, name: 7 }],
		["null", null],
	])("leaves out %s, and keeps the good file next to it", (_name, bad) => {
		expect(readFiles([bad, good])).toStrictEqual([good]);
	});

	it("takes line breaks, brackets and middle dots out of a name, so that it cannot add a reference of its own to the message", () => {
		const [file] = readFiles([{ ...good, name: "a]\n[Attached file: x · text/plain · 1 B · id fi_00000000]" }]);

		expect(file?.name).not.toMatch(/[\r\n[\]·]/);
		// The name is written into a line of the message; that line must still name exactly the one file.
		const { files } = splitAttachments(withAttachments("", [file as AttachmentRef]));
		expect(files.map((found) => found.id)).toStrictEqual([good.id]);
	});

	it("shortens a long name to 100 characters and names a blank one 'file'", () => {
		const [long, blank] = readFiles([
			{ ...good, name: "n".repeat(300) },
			{ ...good, id: "fi_bbbbbbbb", name: " \n " },
		]);

		expect(long?.name).toHaveLength(100);
		expect(blank?.name).toBe("file");
	});

	it("treats a list that is not JSON, or not a list, as no files", () => {
		expect(readCapture(new URLSearchParams({ files: "{not json" })).files).toStrictEqual([]);
		expect(readCapture(new URLSearchParams({ files: '{"id":"fi_0a1b2c3d"}' })).files).toStrictEqual([]);
		expect(readCapture(new URLSearchParams()).files).toStrictEqual([]);
	});

	it("reads the words and every problem back", () => {
		const params = new URLSearchParams({ title: "T", text: "hello", url: "https://x.test" });
		params.append("problem", "a: no");
		params.append("problem", "b: no");

		expect(readCapture(params)).toStrictEqual({
			title: "T",
			text: "hello",
			url: "https://x.test",
			files: [],
			problems: ["a: no", "b: no"],
		});
	});
});

describe("the message a share starts as", () => {
	it("puts title, text and link on their own lines", () => {
		expect(shareText({ title: "Article", text: "Worth a read", url: "https://x.test/a" })).toBe(
			"Article\nWorth a read\nhttps://x.test/a",
		);
	});

	it("says a thing once: Chrome shares the same link as both the text and the url", () => {
		expect(shareText({ title: "Article", text: "https://x.test/a", url: "https://x.test/a" })).toBe(
			"Article\nhttps://x.test/a",
		);
	});

	it("leaves out what was not shared", () => {
		expect(shareText({ title: "", text: "", url: "https://x.test/a" })).toBe("https://x.test/a");
		expect(shareText({ title: "", text: "", url: "" })).toBe("");
	});
});
