"use client";

import type { GoogleSettingsResponse } from "@assistant/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, disconnectGoogleAccount, fetchGoogleSettings } from "../lib/api.ts";
import { GoogleAccountsView } from "./google-accounts.tsx";

const messageOf = (error: unknown, fallback: string): string =>
	error instanceof ApiRequestError ? error.message : fallback;

/** The Google accounts the Inbox reads, and the Jev or rules badge. Connecting is done with `pnpm connect:google`; here an account can only be disconnected. */
export function GoogleCard() {
	const [data, setData] = useState<GoogleSettingsResponse>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);

	const load = useCallback(async (): Promise<void> => {
		setLoading(true);
		try {
			setData(await fetchGoogleSettings());
			setError(undefined);
		} catch (failure) {
			setError(messageOf(failure, "Could not load the Google accounts."));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<GoogleAccountsView
			data={data}
			error={error}
			refresh={
				<button type="button" className="settings-card__save" disabled={loading} onClick={() => void load()}>
					{loading ? "Checking…" : "Check again"}
				</button>
			}
			disconnect={(email) => (
				<DisconnectButton
					key={email}
					email={email}
					onDisconnect={async () => {
						setData(await disconnectGoogleAccount(email));
						setError(undefined);
					}}
				/>
			)}
		/>
	);
}

/**
 * Disconnect asks once more, in the page, because it cannot be undone from here: the saved sign-in is forgotten and has to be
 * made again with `pnpm connect:google`. It is the owner's own action (no approval is involved), and it is local: the mail
 * already read stays, and nothing is revoked at Google.
 */
function DisconnectButton({ email, onDisconnect }: { email: string; onDisconnect: () => Promise<void> }) {
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	const confirm = async (): Promise<void> => {
		setBusy(true);
		setError(undefined);
		try {
			await onDisconnect();
		} catch (failure) {
			setError(messageOf(failure, "Could not disconnect the account."));
			setBusy(false);
		}
	};

	if (!asking) {
		return (
			<div className="settings-card__actions">
				<button type="button" className="card__button" onClick={() => setAsking(true)}>
					Disconnect
				</button>
			</div>
		);
	}
	return (
		<fieldset className="google-account__confirm">
			<legend className="visually-hidden">Disconnect {email}</legend>
			<p className="settings-card__hint">
				Disconnect {email}? The Inbox forgets its sign-in and stops reading it. Mail already read stays on this machine.
				Nothing is changed at Google: to take its access away there, open myaccount.google.com/permissions.
			</p>
			<div className="settings-card__actions">
				<button
					type="button"
					className="card__button card__button--danger"
					disabled={busy}
					onClick={() => void confirm()}
				>
					{busy ? "Disconnecting…" : "Disconnect"}
				</button>
				<button type="button" className="card__button" disabled={busy} onClick={() => setAsking(false)}>
					Cancel
				</button>
			</div>
			{error === undefined ? null : (
				<p className="card__error" role="alert">
					{error}
				</p>
			)}
		</fieldset>
	);
}
