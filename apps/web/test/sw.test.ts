import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");

type Listener = (event: unknown) => void;

type FakeWindow = { url: string; focus: ReturnType<typeof vi.fn>; navigate?: ReturnType<typeof vi.fn> };

const PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

type FakeSubscription = {
	endpoint: string;
	toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
};

const subscriptionAt = (endpoint: string): FakeSubscription => ({
	endpoint,
	toJSON: () => ({ endpoint, keys: { p256dh: `p256dh-of-${endpoint}`, auth: `auth-of-${endpoint}` } }),
});

/** Runs the real service worker file against a fake `self` and lets a test fire its events. */
function worker(windows: FakeWindow[] = []) {
	const listeners = new Map<string, Listener>();
	const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
	const opened: string[] = [];
	const calls: Array<{ path: string; method: string; body: unknown }> = [];
	const self = {
		location: { origin: "https://assistant.example" },
		addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
		fetch: vi.fn(async (path: string, init: { method?: string; body?: string } = {}) => {
			calls.push({
				path,
				method: init.method ?? "GET",
				body: init.body === undefined ? undefined : JSON.parse(init.body),
			});
			return Response.json(path === "/api/push/config" ? { publicKey: PUBLIC_KEY } : { ok: true });
		}),
		skipWaiting: vi.fn(),
		clients: {
			claim: vi.fn(async () => undefined),
			matchAll: vi.fn(async () => windows),
			openWindow: vi.fn(async (url: string) => void opened.push(url)),
		},
		registration: {
			showNotification: vi.fn(
				async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }),
			),
			pushManager: { subscribe: vi.fn(async () => subscriptionAt("https://push.example/fresh")) },
		},
	};
	new Function("self", source)(self);

	const pending: Promise<unknown>[] = [];
	const event = (extra: object) => ({ waitUntil: (promise: Promise<unknown>) => pending.push(promise), ...extra });
	return {
		self,
		shown,
		opened,
		calls,
		changeSubscription: async (change: { newSubscription?: FakeSubscription; oldSubscription?: FakeSubscription }) => {
			listeners.get("pushsubscriptionchange")?.(event({ newSubscription: null, oldSubscription: null, ...change }));
			await Promise.all(pending);
		},
		push: async (data: unknown) => {
			listeners.get("push")?.(event({ data: data === undefined ? null : { json: () => data } }));
			await Promise.all(pending);
		},
		pushWithBadJson: async () => {
			listeners.get("push")?.(
				event({
					data: {
						json: () => {
							throw new SyntaxError("not json");
						},
					},
				}),
			);
			await Promise.all(pending);
		},
		click: async (data: unknown) => {
			const notification = { close: vi.fn(), data };
			listeners.get("notificationclick")?.(event({ notification }));
			await Promise.all(pending);
			return notification;
		},
	};
}

describe("service worker: push", () => {
	it("shows the title, body and tag the server sent, with the app's icons, and alerts again for a second reminder", async () => {
		const sw = worker();

		await sw.push({ title: "Reminder", body: "1 reminder", url: "/chat/pa", tag: "reminder" });

		expect(sw.shown).toHaveLength(1);
		expect(sw.shown[0]?.title).toBe("Reminder");
		expect(sw.shown[0]?.options).toMatchObject({
			body: "1 reminder",
			tag: "reminder",
			icon: "/icons/icon-192.png",
			badge: "/icons/badge-96.png",
			data: { url: "/chat/pa" },
			// Same tag as the reminder before it: without this the second replaces the first without a sound.
			renotify: true,
		});
	});

	it.each([
		["a push without data", undefined],
		["a push that is not an object with a title", {}],
	])("still shows a notification for %s, because the browser requires every push to show one", async (_name, data) => {
		const sw = worker();

		await sw.push(data);

		expect(sw.shown).toHaveLength(1);
		expect(sw.shown[0]?.title).toBe("Assistant");
	});

	it("shows a notification for a body that is JSON null, which would make reading its fields throw", async () => {
		const sw = worker();

		await sw.push(null);

		expect(sw.shown.map((item) => item.title)).toStrictEqual(["Assistant"]);
	});

	it("survives a body that is not JSON", async () => {
		const sw = worker();

		await sw.pushWithBadJson();

		expect(sw.shown[0]?.title).toBe("Assistant");
	});

	// The browser parses these as `https://evil.example/...`: `\` counts as `/`, and tabs and newlines are dropped.
	const LEAVING_THE_SITE = [
		"https://evil.example/phish",
		"//evil.example",
		"/\\evil.example",
		"/\t/evil.example",
		"/\n/evil.example",
		"\\\\evil.example",
		"javascript:alert(1)",
		"data:text/html,<p>x</p>",
		"",
		42,
		null,
	];

	it.each(LEAVING_THE_SITE)("never takes the user to another site: %j becomes the app's own page", async (url) => {
		const sw = worker();

		await sw.push({ title: "t", url });

		expect(sw.shown.map((item) => (item.options.data as { url: string }).url)).toStrictEqual(["/chat/pa"]);
	});

	it("keeps a page of the app, also written as an absolute address of the app", async () => {
		const sw = worker();

		await sw.push({ title: "t", url: "/settings?tab=notifications#top" });
		await sw.push({ title: "t", url: "https://assistant.example/chat/health" });

		expect(sw.shown.map((item) => (item.options.data as { url: string }).url)).toStrictEqual([
			"/settings?tab=notifications#top",
			"/chat/health",
		]);
	});
});

describe("service worker: the subscription was replaced by the push service", () => {
	it("registers the new subscription with the server and drops the old one", async () => {
		const sw = worker();

		await sw.changeSubscription({
			newSubscription: subscriptionAt("https://push.example/new"),
			oldSubscription: subscriptionAt("https://push.example/old"),
		});

		expect(sw.calls.map((call) => [call.method, call.path])).toStrictEqual([
			["GET", "/api/push/config"],
			["POST", "/api/push/subscribe"],
			["DELETE", "/api/push/subscribe"],
		]);
		expect(sw.calls[1]?.body).toStrictEqual({
			endpoint: "https://push.example/new",
			keys: { p256dh: "p256dh-of-https://push.example/new", auth: "auth-of-https://push.example/new" },
		});
		expect(sw.calls[2]?.body).toStrictEqual({ endpoint: "https://push.example/old" });
	});

	it("subscribes itself with the server's key when the browser did not (Firefox), then does the same", async () => {
		const sw = worker();

		await sw.changeSubscription({ oldSubscription: subscriptionAt("https://push.example/old") });

		const [{ applicationServerKey, userVisibleOnly }] = sw.self.registration.pushManager.subscribe.mock
			.calls[0] as unknown as [{ applicationServerKey: Uint8Array; userVisibleOnly: boolean }];
		expect(userVisibleOnly).toBe(true);
		expect(applicationServerKey).toHaveLength(65);
		expect(sw.calls.at(1)?.body).toMatchObject({ endpoint: "https://push.example/fresh" });
		expect(sw.calls.at(2)?.body).toStrictEqual({ endpoint: "https://push.example/old" });
	});
});

describe("service worker: tapping a notification", () => {
	it("closes it and opens the app when no window is open", async () => {
		const sw = worker([]);

		const notification = await sw.click({ url: "/chat/pa" });

		expect(notification.close).toHaveBeenCalled();
		expect(sw.opened).toStrictEqual(["https://assistant.example/chat/pa"]);
	});

	it.each(["/\\evil.example", "/\t/evil.example", "//evil.example", "https://evil.example/"])(
		"opens the app, not %j, even if the notification carries it (the check is repeated at the click)",
		async (url) => {
			const sw = worker([]);

			await sw.click({ url });

			expect(sw.opened).toStrictEqual(["https://assistant.example/chat/pa"]);
		},
	);

	it("brings an open window of the app to the front and moves it to the page when it is elsewhere", async () => {
		const window: FakeWindow = {
			url: "https://assistant.example/settings",
			focus: vi.fn(async () => undefined),
			navigate: vi.fn(async () => undefined),
		};
		const sw = worker([window]);

		await sw.click({ url: "/chat/pa" });

		expect(window.navigate).toHaveBeenCalledWith("https://assistant.example/chat/pa");
		expect(window.focus).toHaveBeenCalled();
		expect(sw.opened).toStrictEqual([]);
	});

	it("only focuses a window that is already on the page, and ignores windows of other sites", async () => {
		const here: FakeWindow = {
			url: "https://assistant.example/chat/pa",
			focus: vi.fn(async () => undefined),
			navigate: vi.fn(),
		};
		const elsewhere: FakeWindow = { url: "https://other.example/", focus: vi.fn(async () => undefined) };
		const sw = worker([elsewhere, here]);

		await sw.click({ url: "/chat/pa" });

		expect(here.navigate).not.toHaveBeenCalled();
		expect(here.focus).toHaveBeenCalled();
		expect(elsewhere.focus).not.toHaveBeenCalled();
	});
});
