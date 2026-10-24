import { fetchPushConfig, subscribePush, unsubscribePush } from "./api.ts";
import { createPushController, type PushController, type PushEnv } from "./push.ts";

/** The browser's own objects, adapted to what the controller needs. Only called in the browser. */
function browserEnv(): PushEnv {
	return {
		isSecureContext: window.isSecureContext,
		...("Notification" in window ? { notification: Notification } : {}),
		...("serviceWorker" in navigator && "PushManager" in window ? { serviceWorker: navigator.serviceWorker } : {}),
	};
}

/** The notifications controller wired to this browser and to the assistant's API. Undefined while rendering on the server. */
export function createBrowserPushController(): PushController | undefined {
	if (typeof window === "undefined") return undefined;
	return createPushController(browserEnv(), {
		publicKey: async () => (await fetchPushConfig()).publicKey,
		subscribe: subscribePush,
		unsubscribe: unsubscribePush,
	});
}
