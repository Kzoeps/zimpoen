import type { GoogleAccountStatus, GoogleAccountSummary, GoogleSettingsResponse } from "@assistant/shared";
import type { ReactNode } from "react";

/**
 * Settings → Google accounts, as a plain function of what `GET /api/settings/google` answered: the accounts the Inbox
 * reads (address, state, last sync, why the last sync failed), how mail is being classified (Jev or the local rules) and
 * what to do when something is missing. The buttons that need the browser (Disconnect, Refresh) come in as nodes, so the
 * view renders the same on the server, in the browser and in a test.
 */

export const ACCOUNT_STATUS_LABEL: Record<GoogleAccountStatus, string> = {
	connected: "Connected",
	needs_reconnect: "Needs to be connected again",
	disconnected: "Disconnected",
};

/** The command that connects an account: the only way, because the browser step has to happen on the machine that runs the assistant. */
const CONNECT = <code>pnpm connect:google</code>;

/** When the account was last read, and how much of it is kept. */
export function syncLine(account: Pick<GoogleAccountSummary, "lastSyncText" | "messages">): string {
	const kept = `${account.messages} ${account.messages === 1 ? "mail" : "mails"} kept`;
	return `${account.lastSyncText === undefined ? "Not synced yet" : `Last synced ${account.lastSyncText}`} · ${kept}`;
}

/** What the owner is told about mail Gmail would not hand over: it is missing from search and digests, so it has to be found in Gmail. */
export function skippedText(skipped: NonNullable<GoogleAccountSummary["skipped"]>): string {
	const one = skipped.count === 1;
	return (
		`${skipped.count} ${one ? "mail" : "mails"} could not be read after several tries, so ${one ? "it is" : "they are"} not in ` +
		`search or digests. Look for ${one ? "it" : "them"} in Gmail. Last reason: ${skipped.lastError}`
	);
}

function AccountRow({
	account,
	disconnect,
}: {
	account: GoogleAccountSummary;
	disconnect: (email: string) => ReactNode;
}) {
	return (
		<li className="google-account">
			<div className="google-account__head">
				<span className="google-account__email">{account.email}</span>
				<span className={`badge badge--google badge--google-${account.status}`}>
					{ACCOUNT_STATUS_LABEL[account.status]}
				</span>
			</div>
			<p className="settings-card__hint">{syncLine(account)}</p>
			{account.status === "needs_reconnect" ? (
				<p className="notice notice--error" role="alert">
					Google no longer accepts this sign-in, so no mail is being read. Run {CONNECT} again and choose this account.
				</p>
			) : null}
			{account.status === "disconnected" ? (
				<p className="settings-card__hint">
					No new mail is read. What was read stays. Run {CONNECT} to connect it again.
				</p>
			) : null}
			{account.lastError !== undefined && account.status === "connected" ? (
				<p className="card__error" role="status">
					The last sync failed: {account.lastError} It is tried again by itself.
				</p>
			) : null}
			{account.skipped === undefined ? null : (
				<p className="notice notice--error" role="status">
					{skippedText(account.skipped)}
				</p>
			)}
			{account.status === "disconnected" ? null : disconnect(account.email)}
		</li>
	);
}

/** Which classifier is on: Jev when a key is saved, otherwise the local rules, and why Jev fell back when it did. */
function TriageNote({ triage }: { triage: GoogleSettingsResponse["triage"] }) {
	const paused = triage.mode === "jev" && triage.pausedUntilText !== undefined;
	return (
		<div className="google__triage">
			<p className="settings-card__hint">
				Mail is sorted by{" "}
				{paused ? (
					<span className="badge badge--triage badge--triage-paused">Rules mode (Jev paused)</span>
				) : (
					<span className={`badge badge--triage badge--triage-${triage.mode}`}>
						{triage.mode === "jev" ? "Jev" : "Rules mode"}
					</span>
				)}
			</p>
			<p className="settings-card__hint">
				{paused
					? `Jev failed several times in a row, so it is not asked until ${triage.pausedUntilText}. Until then mail is sorted on this machine by sender, Gmail's own labels and keywords, and Jev looks at it again afterwards.`
					: triage.mode === "jev"
						? "Jev (api.typesafe.ai) gets each mail's sender, subject and the first 1,500 characters of its text, and nothing else."
						: "Rules mode: mail is sorted on this machine by sender, Gmail's own labels and keywords. A Jev key in secrets/jev.json of the data directory switches to Jev (docs/setup-jev.md)."}
			</p>
			{triage.lastError === undefined ? null : (
				<p className="notice notice--error" role="alert">
					Jev could not be used{triage.lastErrorText === undefined ? "" : ` (${triage.lastErrorText})`}:{" "}
					{triage.lastError} Until it works, mail is sorted by the local rules.
				</p>
			)}
		</div>
	);
}

export function GoogleAccountsView({
	data,
	error,
	disconnect,
	refresh,
}: {
	data: GoogleSettingsResponse | undefined;
	error: string | undefined;
	/** The Disconnect control of one account. */
	disconnect: (email: string) => ReactNode;
	refresh: ReactNode;
}) {
	return (
		<section className="settings-card" aria-label="Google accounts">
			<h2 className="settings-card__title">
				<span aria-hidden="true">📥</span> Google accounts
			</h2>
			<p className="settings-card__hint">
				The Inbox agent reads your Gmail and Google Calendar and can only read: it cannot send, reply, label or delete
				anything.
				{data === undefined ? "" : ` Each account is read every ${data.syncMinutes} minutes.`}
			</p>
			{error === undefined ? null : (
				<p className="notice notice--error" role="alert">
					{error}
				</p>
			)}
			{data === undefined && error === undefined ? <p className="placeholder">Loading…</p> : null}
			{data === undefined ? null : (
				<>
					{data.mode === "fake" ? (
						<p className="notice notice--note" role="status">
							Development mode (ASSISTANT_GOOGLE_MODE=fake): this is a scripted demo mailbox. Nothing is read from
							Google.
						</p>
					) : null}
					{data.mode === "real" && !data.clientConfigured ? (
						<p className="notice notice--error" role="alert">
							The Google client file is missing, so no account can be connected. Save the OAuth client you created as
							secrets/google-oauth.json in the data directory, then run {CONNECT} (docs/setup-google.md).
						</p>
					) : null}
					<TriageNote triage={data.triage} />
					{data.accounts.length === 0 ? (
						<p className="settings-card__hint">
							No account is connected yet. On the machine that runs the assistant, run {CONNECT} once for each Gmail
							account and approve the read-only access in the browser it opens (docs/setup-google.md).
						</p>
					) : (
						<ul className="google-accounts">
							{data.accounts.map((account) => (
								<AccountRow key={account.email} account={account} disconnect={disconnect} />
							))}
						</ul>
					)}
					{data.accounts.length === 0 ? null : (
						<p className="settings-card__hint">To connect another account, run {CONNECT} again.</p>
					)}
				</>
			)}
			<div className="settings-card__actions">{refresh}</div>
		</section>
	);
}
