import type { PushPayload } from "@assistant/shared";
import webPush from "web-push";
import type { VapidKeys } from "./vapid.ts";

/** Where a push goes: the subscription a browser registered. */
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** The push service says this subscription no longer exists (HTTP 404 or 410): the browser unsubscribed or was wiped. */
export class PushGoneError extends Error {
	constructor(endpoint: string, status: number) {
		super(`The push service answered ${status} for ${new URL(endpoint).host}: the subscription is gone.`);
		this.name = "PushGoneError";
	}
}

/**
 * Delivers one message to one subscription. Behind an interface so that nothing but this file talks to a push service:
 * tests and development use a fake, and the real one is {@link createWebPushSender}.
 */
export type PushSender = {
	/** Resolves once the push service accepted the message. Rejects with {@link PushGoneError} for a dead subscription. */
	send(target: PushTarget, payload: PushPayload): Promise<void>;
};

/** Hold a message for a device that is offline for this long (seconds); a reminder is still worth seeing hours late. */
const TTL_SECONDS = 6 * 60 * 60;
const REQUEST_TIMEOUT_MS = 15_000;

/** The real thing: encrypts the payload for the browser and posts it to the browser vendor's push service. */
export function createWebPushSender(keys: VapidKeys, subject: string): PushSender {
	return {
		async send(target, payload) {
			try {
				await webPush.sendNotification(
					{ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
					JSON.stringify(payload),
					{
						vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
						TTL: TTL_SECONDS,
						urgency: "high",
						timeout: REQUEST_TIMEOUT_MS,
					},
				);
			} catch (error) {
				const status = (error as { statusCode?: number }).statusCode;
				if (status === 404 || status === 410) throw new PushGoneError(target.endpoint, status);
				throw error;
			}
		},
	};
}
