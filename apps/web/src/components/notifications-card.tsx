"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiRequestError } from "../lib/api.ts";
import { createBrowserPushController } from "../lib/browser-push.ts";
import type { PushController, PushStatus } from "../lib/push.ts";

/** Turn Web Push on or off for this device: reminders reach the phone even when the app is closed. */
export function NotificationsCard() {
	const [status, setStatus] = useState<PushStatus>({ kind: "checking" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const controller = useMemo<PushController | undefined>(() => createBrowserPushController(), []);

	useEffect(() => {
		controller?.status().then(setStatus, () => setStatus({ kind: "off" }));
	}, [controller]);

	const change = async (action: "enable" | "disable"): Promise<void> => {
		if (controller === undefined) return;
		setBusy(true);
		setError(undefined);
		try {
			setStatus(await controller[action]());
		} catch (failure) {
			setError(
				failure instanceof ApiRequestError
					? failure.message
					: failure instanceof Error
						? failure.message
						: "Something went wrong.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="settings-card" aria-labelledby="notifications-title">
			<h2 className="settings-card__title" id="notifications-title">
				<span aria-hidden="true">🔔</span> Notifications
			</h2>
			<p className="settings-card__hint">
				Reminders reach this device even when the assistant is closed. The notification only says that a reminder is
				due; what it is about stays in the chat.
			</p>
			{status.kind === "unsupported" ? <p className="settings-card__hint">{status.reason}</p> : null}
			{status.kind === "blocked" ? (
				<p className="settings-card__hint">
					Notifications are blocked for this site. Allow them in the browser's site settings, then come back.
				</p>
			) : null}
			<div className="settings-card__actions">
				{status.kind === "off" ? (
					<button type="button" className="settings-card__save" disabled={busy} onClick={() => void change("enable")}>
						{busy ? "Enabling…" : "Enable notifications"}
					</button>
				) : null}
				{status.kind === "on" ? (
					<>
						<span className="settings-card__result" role="status">
							Notifications are on for this device.
						</span>
						<button
							type="button"
							className="settings-card__save"
							disabled={busy}
							onClick={() => void change("disable")}
						>
							{busy ? "Turning off…" : "Turn off"}
						</button>
					</>
				) : null}
				{error !== undefined ? (
					<span className="settings-card__result settings-card__result--error" role="alert">
						{error}
					</span>
				) : null}
			</div>
		</section>
	);
}
