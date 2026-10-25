import { HistoryExpiredError, type TokenProvider } from "@assistant/extensions";
import { describe, expect, it } from "vitest";
import { CALENDAR_BASE, createCalendarClient } from "../src/google/calendar.ts";
import { createGmailClient, GMAIL_BASE } from "../src/google/gmail.ts";
import { GoogleApiError } from "../src/google/http.ts";
import { bodyText, decodeMimeWords, htmlToText, parseGmailMessage, type RawGmailMessage } from "../src/google/mime.ts";

const b64 = (value: string | Buffer): string => Buffer.from(value).toString("base64url");
type Header = { name: string; value: string };
const headers = (pairs: Record<string, string>): Header[] =>
	Object.entries(pairs).map(([name, value]) => ({ name, value }));
const textPart = (mimeType: string, text: string | Buffer, extra: Record<string, unknown> = {}) => ({
	mimeType,
	body: { data: b64(text) },
	...extra,
});

/** Time a call; the point of the hostile-input tests is that none of them is slow, so the limit is generous and the inputs are large. */
function within<T>(ms: number, run: () => T): T {
	const started = performance.now();
	const result = run();
	const took = performance.now() - started;
	expect(took, `took ${Math.round(took)} ms`).toBeLessThan(ms);
	return result;
}

describe("encoded words in headers", () => {
	it("decodes B and Q words in any charset, and joins words that touch without the space between them", () => {
		expect(decodeMimeWords(`=?UTF-8?B?${Buffer.from("Hello 👋 world").toString("base64")}?=`)).toBe("Hello 👋 world");
		expect(decodeMimeWords("=?ISO-8859-1?Q?Caf=E9_cr=E8me?=")).toBe("Café crème");
		expect(decodeMimeWords("=?UTF-8?B?SGVs?= =?UTF-8?B?bG8=?=")).toBe("Hello");
		expect(decodeMimeWords("Re: =?UTF-8?Q?caf=C3=A9?= (urgent)")).toBe("Re: café (urgent)");
		expect(decodeMimeWords("Plain subject")).toBe("Plain subject");
	});

	it("leaves what is not an encoded word as it is, and falls back to UTF-8 for a charset it does not know", () => {
		expect(decodeMimeWords("=?broken")).toBe("=?broken");
		expect(decodeMimeWords("a =?UTF-8?X?abc?= b")).toBe("a =?UTF-8?X?abc?= b");
		expect(decodeMimeWords("=?no-such-charset?B?SGk=?=")).toBe("Hi");
	});

	it("reads a hostile header in bounded time", () => {
		const header = "=?".repeat(2_000_000);

		const decoded = within(250, () => decodeMimeWords(header));

		expect(decoded.length).toBeLessThanOrEqual(4000);
	});
});

describe("HTML turned into text", () => {
	it("reads what a person would read: blocks break lines, entities are decoded, scripts, styles and comments are gone", () => {
		const text = htmlToText(
			"<html><head><title>T</title></head><body><p>Hello&nbsp;&amp; welcome</p><script>alert(1)</script>" +
				"<style>p{color:red}</style><!-- hidden --><div>Next &#8364; &#x41; &unknown;</div>line<br>two</body></html>",
		);

		expect(text).toContain("Hello & welcome");
		expect(text).toContain("Next € A &unknown;");
		expect(text).toContain("line\ntwo");
		for (const gone of ["alert", "color:red", "hidden", "<p>", "T\n"]) expect(text).not.toContain(gone);
	});

	it("does not run away on input made to hurt: 100,000 tags, 3 million ampersands, a 5 MB unterminated tag", () => {
		within(150, () => htmlToText("<div>".repeat(100_000)));
		// A part of nothing but `&` once took ~290 ms (a search for `;` to the end of the text for every one of them).
		within(150, () => htmlToText("&".repeat(3_000_000)));
		const huge = within(150, () => htmlToText(`<a ${"x".repeat(5 * 1024 * 1024)}`));
		expect(huge).toBe("");
		// Only the first 256 KB of a part is read at all.
		const long = within(150, () => htmlToText(`${"word ".repeat(2_000_000)}`));
		expect(long.length).toBeLessThanOrEqual(256 * 1024);
	});

	it("still reads an entity that is next to a run of ampersands", () => {
		expect(htmlToText(`${"&".repeat(50)}amp;&amp;&lt;b&gt;`)).toBe(`${"&".repeat(50)}amp;&<b>`);
		expect(htmlToText("&toolongtobeanentity; &amp")).toBe("&toolongtobeanentity; &amp");
	});
});

describe("the readable text of a message", () => {
	it("prefers the text/plain part of an alternative and drops the HTML twin", () => {
		const payload = {
			mimeType: "multipart/alternative",
			parts: [textPart("text/plain", "Plain words"), textPart("text/html", "<p>HTML words</p>")],
		};

		expect(bodyText(payload)).toBe("Plain words");
	});

	it("falls back to the HTML as text when there is no plain part, and skips attachments, however they are marked", () => {
		const payload = {
			mimeType: "multipart/mixed",
			parts: [
				textPart("text/html", "<p>Only <b>HTML</b></p>"),
				textPart("text/plain", "secret notes", { filename: "notes.txt" }),
				textPart("text/plain", "more notes", { headers: headers({ "Content-Disposition": "attachment; filename=x" }) }),
				{ mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "att1", size: 1000 } },
			],
		};

		const text = bodyText(payload);

		expect(text.trim()).toBe("Only HTML");
		expect(text).not.toContain("notes");
	});

	it("decodes the charset the part says it has, and base64url bodies", () => {
		const latin1 = Buffer.from([0x43, 0x61, 0x66, 0xe9]); // "Café" in ISO-8859-1
		const payload = textPart("text/plain", latin1, {
			headers: headers({ "Content-Type": 'text/plain; charset="ISO-8859-1"' }),
		});

		expect(bodyText(payload)).toBe("Café");
	});

	it("reads a 5 MB part and 300 nested parts in bounded time and size", () => {
		const hostile = textPart("text/plain", "A".repeat(5 * 1024 * 1024));
		const text = within(250, () => bodyText(hostile));
		expect(text.length).toBeLessThanOrEqual(256 * 1024);

		const wide = {
			mimeType: "multipart/mixed",
			parts: Array.from({ length: 300 }, (_, index) => textPart("text/plain", `part ${index}`)),
		};
		const read = within(250, () => bodyText(wide));
		expect(read).toContain("part 0");
		expect(read).not.toContain("part 250");
	});
});

describe("one message as the Inbox keeps it", () => {
	const raw = (over: Partial<RawGmailMessage> = {}, extraHeaders: Record<string, string> = {}): RawGmailMessage => ({
		id: "m1",
		threadId: "t1",
		labelIds: ["INBOX", "UNREAD"],
		snippet: "Don&#39;t forget &amp; confirm",
		internalDate: "1761390000000",
		payload: {
			mimeType: "text/plain",
			headers: headers({
				From: "=?UTF-8?Q?Pema_Dorji?= <pema@x.example>",
				To: "me@x.example",
				Cc: "a@x.example, b@x.example",
				Subject: "=?UTF-8?B?UGxvdCDigJMgdmlld2luZw==?=",
				...extraHeaders,
			}),
			body: { data: b64("See you Thursday.") },
		},
		...over,
	});

	it("decodes the headers and the snippet, joins To and Cc, and takes the text and the arrival time", () => {
		expect(parseGmailMessage(raw())).toStrictEqual({
			id: "m1",
			threadId: "t1",
			labelIds: ["INBOX", "UNREAD"],
			snippet: "Don't forget & confirm",
			internalDate: 1_761_390_000_000,
			from: "Pema Dorji <pema@x.example>",
			to: "me@x.example, a@x.example, b@x.example",
			subject: "Plot – viewing",
			bulk: false,
			text: "See you Thursday.",
		});
	});

	it.each([
		["a List-Unsubscribe header", { "List-Unsubscribe": "<mailto:u@x.example>" }, true],
		["Precedence: bulk", { Precedence: "bulk" }, true],
		["Precedence: list", { Precedence: "List" }, true],
		["Auto-Submitted: auto-generated", { "Auto-Submitted": "auto-generated" }, true],
		["Auto-Submitted: no", { "Auto-Submitted": "no" }, false],
		["none of them", {}, false],
	])("knows bulk mail by %s", (_name, extra, bulk) => {
		expect(parseGmailMessage(raw({}, extra))?.bulk).toBe(bulk);
	});

	it("is not a message without an id, and uses now for one without a date", () => {
		expect(parseGmailMessage({ ...raw(), id: undefined })).toBeUndefined();
		const before = Date.now();
		const undated = parseGmailMessage({ ...raw(), internalDate: undefined });
		expect(undated?.internalDate).toBeGreaterThanOrEqual(before);
		expect(parseGmailMessage({ id: "m2" })).toMatchObject({ id: "m2", threadId: "m2", subject: "", text: "" });
	});
});

// ----- the HTTP clients ----------------------------------------------------------------------------------------------------------------

type Recorded = { url: URL; method: string; headers: Record<string, string>; body: unknown };

/** A Google that answers from a script, and remembers every request it was sent. */
function fakeGoogle(handler: (request: Recorded, index: number) => Response | Promise<Response>) {
	const requests: Recorded[] = [];
	const send = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
		const recorded: Recorded = {
			url,
			method: init?.method ?? "GET",
			headers: Object.fromEntries(
				Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
					key.toLowerCase(),
					value,
				]),
			),
			body: init?.body,
		};
		requests.push(recorded);
		return handler(recorded, requests.length - 1);
	}) as typeof fetch;
	return { requests, fetch: send };
}

function tokenProvider(): TokenProvider & { asked: Array<{ email: string; refresh: boolean }> } {
	const asked: Array<{ email: string; refresh: boolean }> = [];
	return {
		asked,
		accounts: async () => [],
		accessToken: async (email, options) => {
			asked.push({ email, refresh: options?.refresh === true });
			return options?.refresh === true ? "tok-fresh" : "tok-1";
		},
		remove: async () => {},
	};
}

const gmailWith = (handler: Parameters<typeof fakeGoogle>[0], retryDelaysMs: readonly number[] = []) => {
	const google = fakeGoogle(handler);
	const tokens = tokenProvider();
	return { ...google, tokens, gmail: createGmailClient({ tokens, fetch: google.fetch, retryDelaysMs }) };
};

describe("what the Gmail and Calendar clients can do", () => {
	it("is read, and only read: there is no method that sends, replies, labels or deletes", () => {
		const { gmail } = gmailWith(() => Response.json({}));
		const calendar = createCalendarClient({
			tokens: tokenProvider(),
			fetch: fakeGoogle(() => Response.json({})).fetch,
			timezone: "Asia/Thimphu",
		});

		expect(Object.keys(gmail).sort()).toStrictEqual(["getMessage", "listHistory", "listMessageIds", "profile"]);
		expect(Object.keys(calendar)).toStrictEqual(["listEvents"]);
	});

	it("sends only GET requests, without a body, to Google's two API hosts, each with the account's bearer token", async () => {
		const google = fakeGoogle((request) =>
			request.url.pathname.endsWith("/profile")
				? Response.json({ emailAddress: "me@x.example", historyId: "10" })
				: request.url.host === "www.googleapis.com"
					? Response.json({ items: [] })
					: Response.json({ messages: [{ id: "m1" }], historyId: "11", history: [], id: "m1", payload: {} }),
		);
		const tokens = tokenProvider();
		const gmail = createGmailClient({ tokens, fetch: google.fetch, retryDelaysMs: [] });
		const calendar = createCalendarClient({ tokens, fetch: google.fetch, timezone: "Asia/Thimphu" });

		await gmail.profile("me@x.example");
		await gmail.listMessageIds("me@x.example", { q: "newer_than:14d" });
		await gmail.getMessage("me@x.example", "m1");
		await gmail.listHistory("me@x.example", "10", undefined);
		await calendar.listEvents("me@x.example", { from: Date.UTC(2026, 9, 26), to: Date.UTC(2026, 10, 9) });

		expect(google.requests).toHaveLength(5);
		for (const request of google.requests) {
			expect(request.method).toBe("GET");
			expect(request.body).toBeUndefined();
			expect(["gmail.googleapis.com", "www.googleapis.com"]).toContain(request.url.host);
			expect(request.url.protocol).toBe("https:");
			expect(request.headers.authorization).toBe("Bearer tok-1");
		}
		expect(google.requests.map((request) => request.url.origin + request.url.pathname)).toStrictEqual([
			`${GMAIL_BASE}/profile`,
			`${GMAIL_BASE}/messages`,
			`${GMAIL_BASE}/messages/m1`,
			`${GMAIL_BASE}/history`,
			CALENDAR_BASE,
		]);
	});

	it("asks for the listing, one message in full, and the four kinds of history the sync understands", async () => {
		const { gmail, requests } = gmailWith(() => Response.json({ messages: [], history: [], historyId: "9", id: "m1" }));

		await gmail.listMessageIds("a@x.example", { q: "newer_than:14d", pageToken: "p2" });
		await gmail.getMessage("a@x.example", "m/1");
		await gmail.listHistory("a@x.example", "5", "tok");

		const [list, one, history] = requests.map((request) => request.url.searchParams);
		expect([list?.get("q"), list?.get("maxResults"), list?.get("pageToken")]).toStrictEqual([
			"newer_than:14d",
			"100",
			"p2",
		]);
		expect(requests[1]?.url.pathname).toBe("/gmail/v1/users/me/messages/m%2F1");
		expect(one?.get("format")).toBe("full");
		expect(history?.get("startHistoryId")).toBe("5");
		expect(history?.getAll("historyTypes")).toStrictEqual([
			"messageAdded",
			"messageDeleted",
			"labelAdded",
			"labelRemoved",
		]);
		expect(history?.get("pageToken")).toBe("tok");
	});
});

describe("Gmail's history", () => {
	it("becomes one change per message: added, deleted, and which labels came and went", async () => {
		const { gmail } = gmailWith(() =>
			Response.json({
				historyId: "30",
				nextPageToken: "more",
				history: [
					{ messagesAdded: [{ message: { id: "a", labelIds: ["INBOX", "UNREAD"] } }] },
					{ messagesDeleted: [{ message: { id: "b" } }] },
					{
						labelsAdded: [{ message: { id: "c" }, labelIds: ["STARRED", "IMPORTANT"] }],
						labelsRemoved: [
							{ message: { id: "c" }, labelIds: ["UNREAD"] },
							{ message: { id: "d" }, labelIds: ["INBOX"] },
						],
					},
					{ messagesAdded: [{ message: {} }, {}] },
				],
			}),
		);

		const page = await gmail.listHistory("a@x.example", "10", undefined);

		expect(page).toStrictEqual({
			historyId: "30",
			nextPageToken: "more",
			changes: [
				{ type: "added", id: "a", labelIds: ["INBOX", "UNREAD"] },
				{ type: "deleted", id: "b" },
				{ type: "labels", id: "c", added: ["STARRED", "IMPORTANT"], removed: ["UNREAD"] },
				{ type: "labels", id: "d", added: [], removed: ["INBOX"] },
			],
		});
	});

	it("keeps the history id it was given when Google sends none, and an empty history is no changes", async () => {
		const { gmail } = gmailWith(() => Response.json({}));

		expect(await gmail.listHistory("a@x.example", "10", undefined)).toStrictEqual({ changes: [], historyId: "10" });
	});

	it("is HistoryExpiredError when Google no longer has it (404), and any other refusal is an error with Google's words", async () => {
		const expired = gmailWith(() =>
			Response.json({ error: { message: "Requested entity was not found." } }, { status: 404 }),
		);
		await expect(expired.gmail.listHistory("a@x.example", "10", undefined)).rejects.toBeInstanceOf(HistoryExpiredError);

		const forbidden = gmailWith(() =>
			Response.json({ error: { message: "Insufficient Permission" } }, { status: 403 }),
		);
		const failure = await forbidden.gmail.listHistory("a@x.example", "10", undefined).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(GoogleApiError);
		expect(failure).toMatchObject({ status: 403, message: "Google answered 403: Insufficient Permission" });
	});

	it("is no message, not an error, when a mail was deleted between the listing and the read", async () => {
		const { gmail } = gmailWith(() => Response.json({}, { status: 404 }));

		expect(await gmail.getMessage("a@x.example", "gone")).toBeUndefined();
	});
});

describe("when Google is slow, refuses a token or is unreachable", () => {
	it("asks for a fresh token once on a 401 and gives up on a second one", async () => {
		const first = gmailWith((_request, index) =>
			index === 0 ? new Response("", { status: 401 }) : Response.json({ emailAddress: "a@x.example", historyId: "1" }),
		);
		await expect(first.gmail.profile("a@x.example")).resolves.toMatchObject({ historyId: "1" });
		expect(first.tokens.asked.map((call) => call.refresh)).toStrictEqual([false, true]);
		expect(first.requests.map((request) => request.headers.authorization)).toStrictEqual([
			"Bearer tok-1",
			"Bearer tok-fresh",
		]);

		const second = gmailWith(() => new Response("", { status: 401 }));
		await expect(second.gmail.profile("a@x.example")).rejects.toMatchObject({ status: 401 });
		expect(second.requests).toHaveLength(2);
	});

	it("tries a 429 or a 5xx again after the waits it was given, and then says what Google answered", async () => {
		const recovering = gmailWith(
			(_request, index) =>
				index < 2
					? new Response("", { status: index === 0 ? 429 : 503 })
					: Response.json({ emailAddress: "a@x.example", historyId: "1" }),
			[0, 0],
		);
		await expect(recovering.gmail.profile("a@x.example")).resolves.toMatchObject({ historyId: "1" });
		expect(recovering.requests).toHaveLength(3);

		const down = gmailWith(() => new Response("oops", { status: 500 }), [0]);
		await expect(down.gmail.profile("a@x.example")).rejects.toMatchObject({
			status: 500,
			message: "Google answered 500.",
		});
		expect(down.requests).toHaveLength(2);
	});

	it("does not retry what will not change: a 400 or a 403", async () => {
		const { gmail, requests } = gmailWith(() => Response.json({ error: { message: "Bad" } }, { status: 400 }), [0, 0]);

		await expect(gmail.profile("a@x.example")).rejects.toMatchObject({ status: 400 });
		expect(requests).toHaveLength(1);
	});

	it("says Google could not be reached after the network failed on every try", async () => {
		const { gmail, requests } = gmailWith(() => Promise.reject(new TypeError("fetch failed")), [0]);

		await expect(gmail.profile("a@x.example")).rejects.toThrow(/Google could not be reached \(fetch failed\)/);
		expect(requests).toHaveLength(2);
	});

	it("does not read an answer larger than 8 MB", async () => {
		const { gmail } = gmailWith(() => new Response("x".repeat(9 * 1024 * 1024)));

		await expect(gmail.profile("a@x.example")).rejects.toThrow(/larger than this program reads/);
	});

	it("stops at once when it is aborted, whether the request was running or the retry was waiting", async () => {
		// A real fetch rejects with the signal's reason when it is aborted; this one also fails by itself when it is not.
		const failing = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			throw init?.signal?.reason ?? new TypeError("fetch failed");
		}) as typeof fetch;
		const client = createGmailClient({ tokens: tokenProvider(), fetch: failing, retryDelaysMs: [60_000] });

		const running = new AbortController();
		running.abort(new Error("shutting down"));
		await expect(client.profile("a@x.example", { signal: running.signal })).rejects.toThrow(/shutting down/);

		const waiting = new AbortController();
		const pending = client.profile("a@x.example", { signal: waiting.signal });
		setTimeout(() => waiting.abort(new Error("stopped while waiting")), 20);
		await expect(pending).rejects.toThrow(/stopped while waiting/);
	});
});

describe("calendar events", () => {
	const calendarWith = (handler: Parameters<typeof fakeGoogle>[0]) => {
		const google = fakeGoogle(handler);
		return {
			...google,
			calendar: createCalendarClient({
				tokens: tokenProvider(),
				fetch: google.fetch,
				timezone: "Asia/Thimphu",
				retryDelaysMs: [],
			}),
		};
	};
	const range = { from: Date.UTC(2026, 9, 25, 18), to: Date.UTC(2026, 10, 8, 18) };

	it("asks for the window with repeating events expanded and in order", async () => {
		const { calendar, requests } = calendarWith(() => Response.json({ items: [] }));

		await calendar.listEvents("a@x.example", range);

		const params = requests[0]?.url.searchParams;
		expect(params?.get("timeMin")).toBe("2026-10-25T18:00:00.000Z");
		expect(params?.get("timeMax")).toBe("2026-11-08T18:00:00.000Z");
		expect(params?.get("singleEvents")).toBe("true");
		expect(params?.get("orderBy")).toBe("startTime");
	});

	it("starts an all-day event at the owner's local midnight, not at UTC's", async () => {
		const { calendar } = calendarWith(() =>
			Response.json({
				items: [
					{
						id: "e1",
						summary: "Losar",
						start: { date: "2026-10-26" },
						end: { date: "2026-10-27" },
						updated: "2026-10-20T00:00:00Z",
					},
				],
			}),
		);

		const [event] = await calendar.listEvents("a@x.example", range);

		expect(event).toStrictEqual({
			id: "e1",
			title: "Losar",
			start: Date.UTC(2026, 9, 25, 18),
			end: Date.UTC(2026, 9, 26, 18),
			allDay: true,
			attendees: [],
			location: "",
			updated: Date.UTC(2026, 9, 20),
		});
	});

	it("leaves out cancelled events, events the owner declined, and ones it cannot place; drops the owner and rooms from the attendees", async () => {
		const at = { dateTime: "2026-10-29T15:00:00+06:00" };
		const end = { dateTime: "2026-10-29T16:00:00+06:00" };
		const { calendar } = calendarWith(() =>
			Response.json({
				items: [
					{
						id: "keep",
						summary: "Plot viewing",
						location: "Dabtonog",
						start: at,
						end,
						attendees: [
							{ email: "me@x.example", self: true, responseStatus: "accepted" },
							{ email: "room@resource.calendar.google.com", resource: true },
							{ email: "pema@x.example" },
							{ displayName: "No address" },
						],
					},
					{ id: "cancelled", status: "cancelled", start: at, end },
					{
						id: "declined",
						start: at,
						end,
						attendees: [{ email: "me@x.example", self: true, responseStatus: "declined" }],
					},
					{ id: "no-end", start: at },
					{ summary: "no id", start: at, end },
					{ id: "bad-date", start: { date: "26/10/2026" }, end: { date: "27/10/2026" } },
				],
			}),
		);

		const events = await calendar.listEvents("a@x.example", range);

		expect(events.map((event) => event.id)).toStrictEqual(["keep"]);
		expect(events[0]).toMatchObject({
			title: "Plot viewing",
			location: "Dabtonog",
			attendees: ["pema@x.example"],
			allDay: false,
			start: Date.UTC(2026, 9, 29, 9),
		});
	});

	it("reads every page of a long listing", async () => {
		const { calendar, requests } = calendarWith((request) =>
			request.url.searchParams.get("pageToken") === "p2"
				? Response.json({
						items: [
							{ id: "b", start: { dateTime: "2026-10-30T09:00:00Z" }, end: { dateTime: "2026-10-30T10:00:00Z" } },
						],
					})
				: Response.json({
						nextPageToken: "p2",
						items: [
							{ id: "a", start: { dateTime: "2026-10-29T09:00:00Z" }, end: { dateTime: "2026-10-29T10:00:00Z" } },
						],
					}),
		);

		const events = await calendar.listEvents("a@x.example", range);

		expect(events.map((event) => event.id)).toStrictEqual(["a", "b"]);
		expect(requests).toHaveLength(2);
	});
});
