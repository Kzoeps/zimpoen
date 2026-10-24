import type { PushSubscribeRequest } from "@assistant/shared";

/** Where the service worker lives. It must be served from the root so that it can show notifications for the whole app. */
export const SERVICE_WORKER_URL = "/sw.js";

/** What the page needs to know about notifications on this device. */
export type PushStatus =
	/** Not asked yet. */
	| { kind: "checking" }
	/** This browser or this way of opening the app cannot do Web Push, and why. */
	| { kind: "unsupported"; reason: string }
	/** The user said no in the browser's permission prompt: only the browser's site settings can undo that. */
	| { kind: "blocked" }
	| { kind: "off" }
	| { kind: "on" };

/** The parts of the browser the controller uses, so it can be driven by a fake in tests. */
export type PushEnv = {
	isSecureContext: boolean;
	notification?: {
		readonly permission: NotificationPermission;
		requestPermission(): Promise<NotificationPermission>;
	};
	serviceWorker?: {
		register(url: string): Promise<unknown>;
		/** Resolves with the registration of the active worker. */
		ready: Promise<PushRegistration>;
	};
};

export type PushRegistration = {
	pushManager?: {
		getSubscription(): Promise<PushSubscriptionLike | null>;
		subscribe(options: { userVisibleOnly: boolean; applicationServerKey: BufferSource }): Promise<PushSubscriptionLike>;
	};
};

export type PushSubscriptionLike = {
	endpoint: string;
	/** The key the subscription was made with. Browsers that do not report it leave this out. */
	options?: { applicationServerKey: ArrayBuffer | null };
	toJSON(): { endpoint?: string; keys?: Record<string, string> };
	unsubscribe(): Promise<boolean>;
};

/** What the controller asks of the assistant server. */
export type PushApi = {
	publicKey(): Promise<string>;
	subscribe(subscription: PushSubscribeRequest): Promise<unknown>;
	unsubscribe(endpoint: string): Promise<unknown>;
};

/** A Web Push `applicationServerKey` is the VAPID public key as bytes; the server hands it over as base64url. */
export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const raw = atob(padded);
	const bytes = new Uint8Array(raw.length);
	for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
	return bytes;
}

/** The request body for a browser subscription, or undefined if the browser gave one without keys. */
export function toSubscribeRequest(subscription: PushSubscriptionLike): PushSubscribeRequest | undefined {
	const { endpoint, keys } = subscription.toJSON();
	const p256dh = keys?.p256dh;
	const auth = keys?.auth;
	if (endpoint === undefined || p256dh === undefined || auth === undefined) return undefined;
	return { endpoint, keys: { p256dh, auth } };
}

/** Is the subscription bound to `key`? A browser that does not say is given the benefit of the doubt: what works stays. */
function usesKey(subscription: PushSubscriptionLike, key: Uint8Array): boolean {
	const bound = subscription.options?.applicationServerKey;
	if (bound === null || bound === undefined) return true;
	const bytes = new Uint8Array(bound);
	return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

export type PushController = {
	status(): Promise<PushStatus>;
	/** Ask permission, register the worker, subscribe with the server's key, tell the server. Returns the new status. */
	enable(): Promise<PushStatus>;
	/**
	 * Run whenever the app opens. A device that has a subscription gets it checked against the server's current key
	 * (replaced if the key changed) and re-registered with the server, which keeps it if it knows it. This heals a
	 * subscription the server pruned, a `POST` that failed while offline, and a key that was made again. It never asks for
	 * permission and never creates a first subscription: turning notifications off stays off.
	 */
	sync(): Promise<PushStatus>;
	/** Unsubscribe the browser and tell the server. Returns the new status. */
	disable(): Promise<PushStatus>;
};

export function createPushController(env: PushEnv, api: PushApi): PushController {
	const unsupported = (): PushStatus | undefined => {
		if (!env.isSecureContext) {
			return {
				kind: "unsupported",
				reason:
					"Notifications need a secure page. Open the assistant through its https address (Tailscale), not by IP.",
			};
		}
		if (env.serviceWorker === undefined || env.notification === undefined) {
			return {
				kind: "unsupported",
				reason:
					"This browser cannot show notifications here. On an iPhone, add the assistant to the Home Screen first and open it from there.",
			};
		}
		return undefined;
	};

	const registration = async (): Promise<PushRegistration & Required<Pick<PushRegistration, "pushManager">>> => {
		await env.serviceWorker?.register(SERVICE_WORKER_URL);
		const ready = await env.serviceWorker?.ready;
		if (ready?.pushManager === undefined) throw new Error("This browser has no push service.");
		return ready as PushRegistration & Required<Pick<PushRegistration, "pushManager">>;
	};

	/**
	 * The browser's subscription, bound to the server's current key. A subscription keeps the key it was made with, and
	 * subscribing again with another one throws `InvalidStateError`, so after the key changed (the server's key file was
	 * lost) the old subscription has to go first, in the browser and on the server, where its endpoint is now useless.
	 */
	async function subscriptionWith(
		pushManager: NonNullable<PushRegistration["pushManager"]>,
		publicKey: string,
	): Promise<PushSubscriptionLike> {
		const key = urlBase64ToBytes(publicKey);
		const existing = await pushManager.getSubscription();
		if (existing !== null && usesKey(existing, key)) return existing;
		if (existing !== null) {
			await existing.unsubscribe();
			await api.unsubscribe(existing.endpoint).catch(() => undefined);
		}
		return await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
	}

	async function tellServer(subscription: PushSubscriptionLike): Promise<void> {
		const request = toSubscribeRequest(subscription);
		if (request === undefined) throw new Error("The browser's subscription has no keys, so it cannot be used.");
		await api.subscribe(request);
	}

	async function status(): Promise<PushStatus> {
		const problem = unsupported();
		if (problem !== undefined) return problem;
		if (env.notification?.permission === "denied") return { kind: "blocked" };
		if (env.notification?.permission !== "granted") return { kind: "off" };
		try {
			return (await (await registration()).pushManager.getSubscription()) === null ? { kind: "off" } : { kind: "on" };
		} catch {
			return { kind: "off" };
		}
	}

	return {
		status,

		async enable() {
			const problem = unsupported();
			if (problem !== undefined) return problem;
			const permission = await env.notification?.requestPermission();
			if (permission === "denied") return { kind: "blocked" };
			if (permission !== "granted") return { kind: "off" };

			const publicKey = await api.publicKey();
			const { pushManager } = await registration();
			await tellServer(await subscriptionWith(pushManager, publicKey));
			return { kind: "on" };
		},

		async sync() {
			const problem = unsupported();
			if (problem !== undefined) return problem;
			if (env.notification?.permission === "denied") return { kind: "blocked" };
			if (env.notification?.permission !== "granted") return { kind: "off" };
			const { pushManager } = await registration();
			if ((await pushManager.getSubscription()) === null) return { kind: "off" };
			await tellServer(await subscriptionWith(pushManager, await api.publicKey()));
			return { kind: "on" };
		},

		async disable() {
			const problem = unsupported();
			if (problem !== undefined) return problem;
			const { pushManager } = await registration();
			const subscription = await pushManager.getSubscription();
			if (subscription !== null) {
				await api.unsubscribe(subscription.endpoint);
				await subscription.unsubscribe();
			}
			return { kind: "off" };
		},
	};
}
