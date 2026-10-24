import { describe, expect, it, vi } from "vitest";
import {
	createPushController,
	type PushApi,
	type PushEnv,
	type PushSubscriptionLike,
	SERVICE_WORKER_URL,
	toSubscribeRequest,
	urlBase64ToBytes,
} from "../src/lib/push.ts";

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

/** What the server's key looked like before it was made again. */
const OLD_KEY = "BEl63iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

/** A browser subscription; `boundTo` is the server key it was made with (omit it for a browser that does not say). */
function subscription(
	endpoint = "https://push.example/abc",
	boundTo?: string,
): PushSubscriptionLike & { unsubscribed: boolean } {
	return {
		endpoint,
		unsubscribed: false,
		...(boundTo === undefined ? {} : { options: { applicationServerKey: urlBase64ToBytes(boundTo).buffer } }),
		toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-secret" } }),
		async unsubscribe() {
			this.unsubscribed = true;
			return true;
		},
	};
}

/** A browser with everything supported; each test changes the one thing it is about. */
function browser(overrides: Partial<PushEnv> = {}, existing: PushSubscriptionLike | null = null) {
	const created = subscription();
	const subscribe = vi.fn(async (_options: unknown) => created);
	const register = vi.fn(async () => undefined);
	let current = existing;
	if (existing !== null) {
		// Once the browser has unsubscribed it, it has no subscription any more.
		const unsubscribe = existing.unsubscribe.bind(existing);
		existing.unsubscribe = async () => {
			current = null;
			return await unsubscribe();
		};
	}
	const env: PushEnv = {
		isSecureContext: true,
		notification: { permission: "default", requestPermission: vi.fn(async () => "granted" as const) },
		serviceWorker: {
			register,
			ready: Promise.resolve({
				pushManager: {
					getSubscription: async () => current,
					subscribe: async (options) => {
						current = await subscribe(options);
						return current;
					},
				},
			}),
		},
		...overrides,
	};
	const api: PushApi = {
		publicKey: vi.fn(async () => KEY),
		subscribe: vi.fn(async () => ({ ok: true })),
		unsubscribe: vi.fn(async () => ({ removed: true })),
	};
	return { env, api, register, subscribe, created };
}

describe("urlBase64ToBytes", () => {
	it("decodes the server's base64url key into the 65 bytes of an uncompressed P-256 point", () => {
		const bytes = urlBase64ToBytes(KEY);

		expect(bytes).toHaveLength(65);
		expect(bytes[0]).toBe(0x04);
	});
});

describe("toSubscribeRequest", () => {
	it("takes the endpoint and keys the server needs, and refuses a subscription without keys", () => {
		expect(toSubscribeRequest(subscription())).toStrictEqual({
			endpoint: "https://push.example/abc",
			keys: { p256dh: "p256dh-key", auth: "auth-secret" },
		});
		expect(
			toSubscribeRequest({ ...subscription(), toJSON: () => ({ endpoint: "https://x.example" }) }),
		).toBeUndefined();
	});
});

describe("notifications controller", () => {
	it("enables: asks permission, registers the worker, subscribes with the server's key and tells the server", async () => {
		const { env, api, register, subscribe, created } = browser();

		const status = await createPushController(env, api).enable();

		expect(status).toStrictEqual({ kind: "on" });
		expect(env.notification?.requestPermission).toHaveBeenCalledOnce();
		expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL);
		const [options] = subscribe.mock.calls[0] as unknown as [
			{ userVisibleOnly: boolean; applicationServerKey: Uint8Array },
		];
		expect(options.userVisibleOnly).toBe(true);
		expect(Array.from(options.applicationServerKey)).toStrictEqual(Array.from(urlBase64ToBytes(KEY)));
		expect(api.subscribe).toHaveBeenCalledWith(toSubscribeRequest(created));
	});

	it("reuses a subscription the browser already has instead of making another", async () => {
		const { env, api, subscribe } = browser({}, subscription("https://push.example/existing"));

		await createPushController(env, api).enable();

		expect(subscribe).not.toHaveBeenCalled();
		expect(api.subscribe).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "https://push.example/existing" }));
	});

	it("keeps a subscription made with the server's current key", async () => {
		const { env, api, subscribe } = browser({}, subscription("https://push.example/current", KEY));

		await createPushController(env, api).enable();

		expect(subscribe).not.toHaveBeenCalled();
		expect(api.unsubscribe).not.toHaveBeenCalled();
	});

	it("replaces a subscription made with another key, in the browser and on the server (the key was made again)", async () => {
		const stale = subscription("https://push.example/stale", OLD_KEY);
		const { env, api, subscribe, created } = browser({}, stale);

		const status = await createPushController(env, api).enable();

		expect(status).toStrictEqual({ kind: "on" });
		expect(stale.unsubscribed).toBe(true); // subscribing again with another key would throw InvalidStateError otherwise
		expect(api.unsubscribe).toHaveBeenCalledWith("https://push.example/stale");
		const [options] = subscribe.mock.calls[0] as unknown as [{ applicationServerKey: Uint8Array }];
		expect(Array.from(options.applicationServerKey)).toStrictEqual(Array.from(urlBase64ToBytes(KEY)));
		expect(api.subscribe).toHaveBeenCalledWith(toSubscribeRequest(created));
	});

	it("says blocked, and tells the server nothing, when the user refuses the permission prompt", async () => {
		const { env, api, register } = browser({
			notification: { permission: "default", requestPermission: async () => "denied" },
		});

		expect(await createPushController(env, api).enable()).toStrictEqual({ kind: "blocked" });
		expect(api.subscribe).not.toHaveBeenCalled();
		expect(register).not.toHaveBeenCalled();
	});

	it("reports where it stands without asking for anything: blocked, off, or on", async () => {
		const denied = browser({ notification: { permission: "denied", requestPermission: async () => "denied" } });
		const granted = browser(
			{ notification: { permission: "granted", requestPermission: async () => "granted" } },
			subscription(),
		);
		const grantedWithout = browser({
			notification: { permission: "granted", requestPermission: async () => "granted" },
		});
		const asked = browser();

		expect(await createPushController(denied.env, denied.api).status()).toStrictEqual({ kind: "blocked" });
		expect(await createPushController(granted.env, granted.api).status()).toStrictEqual({ kind: "on" });
		expect(await createPushController(grantedWithout.env, grantedWithout.api).status()).toStrictEqual({ kind: "off" });
		expect(await createPushController(asked.env, asked.api).status()).toStrictEqual({ kind: "off" });
		expect(asked.env.notification?.requestPermission).not.toHaveBeenCalled();
	});

	describe("sync, when the app opens", () => {
		const granted = {
			notification: { permission: "granted", requestPermission: async () => "granted" as const },
		} satisfies Partial<PushEnv>;

		it("tells the server about the subscription the browser has, which keeps it if it already knows it", async () => {
			const existing = subscription("https://push.example/mine", KEY);
			const { env, api, subscribe } = browser(granted, existing);

			const status = await createPushController(env, api).sync();

			expect(status).toStrictEqual({ kind: "on" });
			expect(api.subscribe).toHaveBeenCalledWith(toSubscribeRequest(existing));
			expect(subscribe).not.toHaveBeenCalled();
		});

		it("makes the subscription again when it is bound to an old key, and drops the old one on the server", async () => {
			const stale = subscription("https://push.example/stale", OLD_KEY);
			const { env, api, subscribe, created } = browser(granted, stale);

			await createPushController(env, api).sync();

			expect(stale.unsubscribed).toBe(true);
			expect(api.unsubscribe).toHaveBeenCalledWith("https://push.example/stale");
			expect(subscribe).toHaveBeenCalledOnce();
			expect(api.subscribe).toHaveBeenCalledWith(toSubscribeRequest(created));
		});

		it("creates nothing when the device has no subscription: turning notifications off stays off", async () => {
			const { env, api, subscribe } = browser(granted, null);

			expect(await createPushController(env, api).sync()).toStrictEqual({ kind: "off" });
			expect(subscribe).not.toHaveBeenCalled();
			expect(api.subscribe).not.toHaveBeenCalled();
			expect(api.publicKey).not.toHaveBeenCalled();
		});

		it("never asks for permission and leaves a device alone that did not grant it", async () => {
			const asked = browser({}, null);
			const denied = browser({ notification: { permission: "denied", requestPermission: async () => "denied" } }, null);

			expect(await createPushController(asked.env, asked.api).sync()).toStrictEqual({ kind: "off" });
			expect(await createPushController(denied.env, denied.api).sync()).toStrictEqual({ kind: "blocked" });
			expect(asked.env.notification?.requestPermission).not.toHaveBeenCalled();
			expect(asked.api.subscribe).not.toHaveBeenCalled();
		});

		it("fails when the server cannot be reached, so the caller can try again on the next visit", async () => {
			const { env, api } = browser(granted, subscription("https://push.example/mine", KEY));
			api.subscribe = vi.fn(async () => {
				throw new Error("offline");
			});

			await expect(createPushController(env, api).sync()).rejects.toThrow("offline");
		});
	});

	it("disables: removes the subscription on the server and in the browser", async () => {
		const existing = subscription("https://push.example/bye");
		const { env, api } = browser({}, existing);

		const status = await createPushController(env, api).disable();

		expect(status).toStrictEqual({ kind: "off" });
		expect(api.unsubscribe).toHaveBeenCalledWith("https://push.example/bye");
		expect(existing.unsubscribed).toBe(true);
	});

	it.each([
		["a page that is not secure", { isSecureContext: false }, /https address/],
		[
			"a browser without a service worker (an iPhone outside the Home Screen app)",
			{ serviceWorker: undefined },
			/Home Screen/,
		],
		["a browser without notifications", { notification: undefined }, /cannot show notifications/],
	])("explains what to do on %s, and does nothing", async (_name, change, reason) => {
		const { env, api, register } = browser(change);
		const controller = createPushController(env, api);

		const status = await controller.enable();

		expect(status).toMatchObject({ kind: "unsupported", reason: expect.stringMatching(reason) });
		expect(await controller.status()).toMatchObject({ kind: "unsupported" });
		expect(register).not.toHaveBeenCalled();
		expect(api.publicKey).not.toHaveBeenCalled();
	});
});
