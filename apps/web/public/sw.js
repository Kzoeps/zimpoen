/*
 * The assistant's service worker. Its only job is notifications: no caching, no offline mode.
 *
 * A push carries a small JSON object { title, body, url, tag }. It deliberately holds nothing sensitive (it passed
 * through Google's or Apple's servers), so a notification says that something needs attention, never what it is.
 */

self.addEventListener("install", () => {
	// A new worker takes over at once: there is nothing cached that it could disagree with.
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

const FALLBACK_URL = "/chat/pa";

/**
 * Only paths of this app: a push can never send the user to another site. The value is resolved the way the browser will
 * resolve it when the notification is tapped, and kept only if that lands on this origin. Looking at the first
 * characters is not enough: the URL parser reads `\` as `/` and drops tabs and newlines, so "/\evil.example" and
 * "/\t/evil.example" start with "/" and still leave the site.
 */
function appPath(value) {
	if (typeof value !== "string" || value === "") return FALLBACK_URL;
	try {
		const url = new URL(value, self.location.origin);
		return url.origin === self.location.origin ? url.pathname + url.search + url.hash : FALLBACK_URL;
	} catch {
		return FALLBACK_URL;
	}
}

self.addEventListener("push", (event) => {
	let payload = {};
	try {
		// `null` is valid JSON and would make every property read below throw: a push that shows nothing is penalised.
		payload = (event.data ? event.data.json() : {}) ?? {};
	} catch {
		payload = {};
	}
	const text = (value, fallback) => (typeof value === "string" && value !== "" ? value : fallback);
	// A browser requires every push to show something, so a malformed one still gets a notification.
	event.waitUntil(
		self.registration.showNotification(text(payload.title, "Assistant"), {
			body: text(payload.body, ""),
			tag: text(payload.tag, "assistant"),
			// One tag, so a second reminder replaces the first in the tray; without this it would replace it silently.
			renotify: true,
			icon: "/icons/icon-192.png",
			badge: "/icons/badge-96.png",
			data: { url: appPath(payload.url) },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = new URL(appPath(event.notification.data?.url), self.location.origin);
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
			// Reuse the window that is already open (and bring it to the front) before opening another.
			for (const window of windows) {
				if (new URL(window.url).origin !== self.location.origin) continue;
				if (new URL(window.url).pathname !== target.pathname && "navigate" in window) {
					try {
						await window.navigate(target.href);
					} catch {
						// A window that cannot navigate still comes to the front below.
					}
				}
				return window.focus();
			}
			return self.clients.openWindow(target.href);
		}),
	);
});

/** The VAPID public key as the bytes `pushManager.subscribe` wants (the server hands it over as base64url). */
function keyBytes(value) {
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

/**
 * A push service may replace a subscription (it rotates or expires one), and then the old endpoint stops working
 * without anyone being told. The browser tells only the worker, so the worker registers the new subscription with the
 * server, and drops the old one there. The page does the same check every time it opens (`sync` in lib/push.ts).
 */
async function renewSubscription(event) {
	const call = (path, init) =>
		self.fetch(path, { ...init, headers: { "content-type": "application/json" }, credentials: "same-origin" });
	const config = await (await call("/api/push/config")).json();
	const subscription =
		event.newSubscription ??
		(await self.registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: keyBytes(config.publicKey),
		}));
	const { endpoint, keys } = subscription.toJSON();
	await call("/api/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint, keys }) });
	const previous = event.oldSubscription?.endpoint;
	if (previous !== undefined && previous !== endpoint) {
		await call("/api/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint: previous }) });
	}
}

self.addEventListener("pushsubscriptionchange", (event) => {
	event.waitUntil(renewSubscription(event));
});
