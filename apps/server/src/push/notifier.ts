import { type AppDb, deletePushSubscription, listPushSubscriptions } from "@assistant/db";
import type { PushPayload } from "@assistant/shared";
import { PushGoneError, type PushSender } from "./sender.ts";

export type NotifyReport = { sent: number; removed: number; failed: number };

export type Notifier = {
	/** Send `payload` to every subscribed device. Never rejects: a failed push must not fail the work that caused it. */
	notify(payload: PushPayload): Promise<NotifyReport>;
};

type Logger = Pick<Console, "info" | "warn">;

/**
 * Fan a payload out to every subscription in `push_subscriptions`, in parallel. A subscription the push service says is
 * gone (404/410) is deleted on the spot, so a phone that was wiped does not cost a failed request for ever. Any other
 * failure is logged without the payload and kept for next time: it may be a service outage, not a dead subscription.
 */
export function createNotifier(db: AppDb, sender: PushSender, logger: Logger = console): Notifier {
	return {
		async notify(payload) {
			const report: NotifyReport = { sent: 0, removed: 0, failed: 0 };
			const subscriptions = listPushSubscriptions(db);
			await Promise.all(
				subscriptions.map(async (subscription) => {
					try {
						await sender.send(subscription, payload);
						report.sent++;
					} catch (error) {
						if (error instanceof PushGoneError) {
							deletePushSubscription(db, subscription.endpoint);
							report.removed++;
							logger.info(`[push] removed a subscription that no longer exists (${hostOf(subscription.endpoint)}).`);
						} else {
							report.failed++;
							logger.warn(
								`[push] could not reach ${hostOf(subscription.endpoint)}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
				}),
			);
			return report;
		},
	};
}

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return "an invalid endpoint";
	}
}
