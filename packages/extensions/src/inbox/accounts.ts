import { getAgentRow } from "@assistant/db";
import {
	type GoogleAccountSummary,
	type GoogleSettingsResponse,
	NOTICE_ENTRY_KIND,
	type NoticeEntryData,
	type TriageMode,
} from "@assistant/shared";
import type { JsonValue } from "@earendil-works/chord";
import type { DomainDeps } from "../module.ts";
import { formatLocal } from "../time.ts";
import type { TimerScheduler } from "../timers.ts";
import * as store from "./store.ts";
import { clip } from "./text.ts";
import { DEFAULT_SYNC, type InboxDeps, type SyncSettings } from "./types.ts";

/** What the sync of the accounts changed when it looked at the saved sign-ins. */
export type RefreshReport = {
	/** Accounts seen for the first time: their first sync is due now. */
	added: string[];
	/** Accounts the owner connected again (or whose sign-in came back): synced again from now. */
	reconnected: string[];
	/** Accounts whose sign-in is saved as refused. */
	revoked: string[];
	/** Accounts that have no saved sign-in any more. */
	disconnected: string[];
};

export type AccountService = {
	/**
	 * Make the accounts match the saved sign-ins (`<data>/secrets/google-accounts.json`, written by `pnpm connect:google`
	 * while the server runs): a new one gets a row and a timer, one connected again starts syncing again, one that lost
	 * its sign-in stops. Cheap: it reads a small file.
	 */
	refresh(): Promise<RefreshReport>;
	/** Stop syncing an account and forget its saved sign-in. Its mail stays. False when there is no such account. */
	disconnect(email: string): Promise<boolean>;
	/**
	 * Google refused the account's token: stop syncing it, say so to the owner (a notice in the PA's thread, a push).
	 * `ownTimer`: the caller is the account's own sync task, which ends by itself; aborting it from inside would wait for itself.
	 */
	markNeedsReconnect(email: string, options?: { ownTimer?: boolean }): Promise<void>;
	summaries(): GoogleAccountSummary[];
	settings(): Promise<GoogleSettingsResponse>;
};

type Deps = Pick<DomainDeps, "db" | "now" | "timezone" | "post" | "notify">;

const DAY_MS = 24 * 60 * 60_000;

export const syncSettingsOf = (inbox: InboxDeps | undefined): SyncSettings => ({ ...DEFAULT_SYNC, ...inbox?.sync });

/** What the owner is told about a refused token, and what to do. */
export const reconnectText = (email: string): string =>
	`Google no longer accepts the saved sign-in of ${email}, so its mail and calendar are not being read. Run \`pnpm connect:google\` on the laptop and approve the account again (docs/setup-google.md). Google may expire a sign-in after 7 days while the app is in testing mode.`;

/** The Settings page's and the Inbox agent's view of the accounts, and what happens when one's sign-in changes. */
export function createAccountService(
	deps: Deps,
	inbox: InboxDeps | undefined,
	scheduler: () => TimerScheduler,
): AccountService {
	const { db } = deps;

	async function ensureTimer(email: string, report: { rescheduled?: string[] } = {}): Promise<void> {
		try {
			await scheduler().ensureScheduled(email);
		} catch (error) {
			// The conversation of the Inbox agent is missing, or Durable is not open: the repair at the next sweep tries again.
			report.rescheduled?.push(`${email}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function refresh(): Promise<RefreshReport> {
		const report: RefreshReport = { added: [], reconnected: [], revoked: [], disconnected: [] };
		if (inbox === undefined) return report;
		const tokens = await inbox.google.tokens.accounts();
		const now = deps.now();
		const seen = new Set<string>();
		for (const token of tokens) {
			seen.add(token.email);
			const row = store.getAccount(db, token.email);
			if (row === undefined) {
				store.insertAccount(db, { email: token.email, connectedAt: token.connectedAt, now });
				if (token.status === "needs_reconnect") {
					store.changeStatus(db, token.email, { status: "needs_reconnect", now, error: "Google refused the sign-in." });
					report.revoked.push(token.email);
				} else {
					report.added.push(token.email);
					await ensureTimer(token.email);
				}
				continue;
			}
			if (token.status === "needs_reconnect") {
				if (row.status === "connected") {
					await markNeedsReconnect(token.email);
					report.revoked.push(token.email);
				}
				continue;
			}
			// A sign-in that is good. The row may be waiting for one (revoked or disconnected), or hold an older one.
			if (row.status !== "connected" || token.connectedAt > row.connectedAt) {
				const changed = store.changeStatus(db, token.email, {
					status: "connected",
					now,
					due: now,
					connectedAt: token.connectedAt,
				});
				await cancel(changed?.replacedDurableTaskId);
				report.reconnected.push(token.email);
				await ensureTimer(token.email);
			}
		}
		for (const row of store.listAccounts(db)) {
			if (seen.has(row.email) || row.status === "disconnected") continue;
			const changed = store.changeStatus(db, row.email, { status: "disconnected", now });
			await cancel(changed?.replacedDurableTaskId);
			report.disconnected.push(row.email);
		}
		return report;
	}

	async function cancel(durableTaskId: number | undefined): Promise<void> {
		await scheduler().cancel(durableTaskId);
	}

	async function disconnect(email: string): Promise<boolean> {
		const row = store.getAccount(db, email);
		if (row === undefined || inbox === undefined) return false;
		await inbox.google.tokens.remove(email);
		const changed = store.changeStatus(db, email, { status: "disconnected", now: deps.now() });
		await cancel(changed?.replacedDurableTaskId);
		return true;
	}

	async function markNeedsReconnect(email: string, options: { ownTimer?: boolean } = {}): Promise<void> {
		const now = deps.now();
		const before = store.getAccount(db, email);
		if (before === undefined || before.status === "needs_reconnect") return;
		const changed = store.changeStatus(db, email, {
			status: "needs_reconnect",
			now,
			error: "Google refused the sign-in.",
		});
		if (options.ownTimer !== true) await cancel(changed?.replacedDurableTaskId);
		await tell(email, now);
	}

	/** A card in the PA's thread and a push: mail stopped coming, and the owner is the only one who can fix it. Never throws. */
	async function tell(email: string, at: number): Promise<void> {
		const pa = getAgentRow(db, "pa")?.conversationId;
		try {
			if (pa !== undefined) {
				const data: NoticeEntryData = { text: reconnectText(email), level: "error" };
				await deps.post(pa, {
					kind: NOTICE_ENTRY_KIND,
					data: data as unknown as JsonValue,
					requestId: `google-reconnect:${email}:${at}`,
				});
			}
			await deps.notify({
				title: "Inbox",
				body: "A Gmail account needs to be connected again",
				url: "/settings",
				tag: "google-reconnect",
			});
		} catch {
			// The row says needs_reconnect and Settings shows it; a notice that could not be written is not worth a failed sync.
		}
	}

	function summaries(): GoogleAccountSummary[] {
		const counts = store.countMessages(db);
		// The sync forgets a failure once it is older than the mail it reads, so this is what is still news.
		const since = deps.now() - syncSettingsOf(inbox).initialDays * DAY_MS;
		return store.listAccounts(db).map((row) => {
			const [latest, ...others] = store.skippedReads(db, row.email, since);
			return {
				email: row.email,
				status: row.status,
				messages: counts.get(row.email) ?? 0,
				...(row.lastOkAt === undefined
					? {}
					: { lastSyncAt: row.lastOkAt, lastSyncText: formatLocal(row.lastOkAt, deps.timezone) }),
				...(row.lastError === undefined ? {} : { lastError: clip(row.lastError, 300) }),
				...(latest === undefined
					? {}
					: { skipped: { count: others.length + 1, lastError: clip(latest.lastError, 300) } }),
			};
		});
	}

	async function settings(): Promise<GoogleSettingsResponse> {
		await refresh().catch(() => undefined);
		const failure = store.getState(db, TRIAGE_ERROR_KEY);
		const mode: TriageMode = inbox?.triage.mode ?? "rules";
		const pausedUntil = inbox?.triage.pausedUntil?.();
		return {
			mode: inbox?.google.mode ?? "fake",
			clientConfigured: inbox?.google.clientConfigured ?? false,
			triage: {
				mode,
				...(failure === undefined
					? {}
					: { lastError: clip(failure.value, 300), lastErrorText: formatLocal(failure.updatedAt, deps.timezone) }),
				...(pausedUntil === undefined ? {} : { pausedUntil, pausedUntilText: formatLocal(pausedUntil, deps.timezone) }),
			},
			syncMinutes: Math.round(syncSettingsOf(inbox).intervalMs / 60_000),
			accounts: summaries(),
		};
	}

	return { refresh, disconnect, markNeedsReconnect, summaries, settings };
}

/** The `inbox_state` key that holds why the last triage fell back to the rules. */
export const TRIAGE_ERROR_KEY = "triage_error";
