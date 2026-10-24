"use client";

import { useEffect } from "react";
import { createBrowserPushController } from "../lib/browser-push.ts";

/**
 * Keeps this device's push subscription in step with the server every time the app opens: a subscription the push
 * service replaced or the server pruned is registered again, and one made with an old server key is made again. Renders
 * nothing, asks nothing, and stays quiet when the server cannot be reached (the next visit tries again).
 */
export function PushSync() {
	useEffect(() => {
		createBrowserPushController()
			?.sync()
			.catch(() => undefined);
	}, []);
	return null;
}
