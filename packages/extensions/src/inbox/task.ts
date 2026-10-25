import type { Context } from "@earendil-works/chord";
import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { DomainDeps } from "../module.ts";
import type { TimerScheduler } from "../timers.ts";
import { type AccountService, syncSettingsOf, TRIAGE_ERROR_KEY } from "./accounts.ts";
import * as store from "./store.ts";
import { type SyncDeps, syncAccount } from "./sync.ts";
import { clip } from "./text.ts";
import { TokenRevokedError } from "./types.ts";

/** Durable task kind of an account's sync timer. Stored in task records, so renaming it orphans timers that are waiting. */
export const INBOX_SYNC_TASK_NAME = "app.inbox-sync";

export type InboxSyncInput = {
	/** The `inbox_account` row this timer serves: the account's address. */
	account: string;
	/** The row's `gen` when this task was created. The task acts only while the row still has this one. */
	gen: number;
};

export type InboxSyncState = { phase: "wait" } | { phase: "run" };

/** What the run was, or why the timer ended without one. */
export type InboxSyncResult =
	| { done: true; ok: boolean; stored: number }
	| { done: false; reason: "superseded" | "needs_reconnect" };

type Runtime = TaskRuntime<InboxSyncInput, InboxSyncState, InboxSyncResult, object>;
type TaskDeps = Pick<DomainDeps, "db" | "now" | "timezone" | "inbox">;

/** When another sync comes if the last one left mail behind: soon, not after a whole interval. */
export const MORE_MAIL_DELAY_MS = 30_000;

/** The wait after a failed sync: the interval, doubled with every failure in a row, never more than `maxBackoffMs`. */
export function backoffMs(settings: { intervalMs: number; maxBackoffMs: number }, failures: number): number {
	return Math.min(settings.maxBackoffMs, settings.intervalMs * 2 ** Math.max(0, failures - 1));
}

/**
 * One account's sync, again and again (PLAN §5.4): sleep until the row's `next_sync_at`, read what changed, classify what
 * is new, and put the next run into the row first (a new generation, no timer), then create its timer. The row is the
 * truth and the task a timer, exactly as for reminders: a connected account always wants one, and the repair makes it.
 *
 * A sync that fails never faults the task (a faulted task is never retried by Durable): the failure is written to the row
 * and the next attempt waits longer each time. A refused token ends the timer and marks the account `needs_reconnect`. A
 * server that is closing interrupts the sync (its requests are aborted); the phase then reruns after the restart, and the
 * sync is idempotent.
 */
export function createInboxSyncTask(
	deps: TaskDeps,
	accounts: () => AccountService,
	scheduler: () => TimerScheduler | undefined,
) {
	const { db } = deps;

	async function current(
		task: { input: InboxSyncInput },
		runtime: Runtime,
		context: Context,
	): Promise<store.AccountRow | undefined> {
		const row = store.getAccount(db, task.input.account);
		if (store.isCurrent(row, task.input)) return row;
		await finish(runtime, { done: false, reason: "superseded" }, context);
		return undefined;
	}

	return defineTask<InboxSyncInput, InboxSyncState, InboxSyncResult>({
		name: INBOX_SYNC_TASK_NAME,
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				await runtime.sleepUntil(row.nextSyncAt, { phase: "run" }, context);
			},

			run: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				const inbox = deps.inbox;
				if (row === undefined) return;
				const settings = syncSettingsOf(inbox);
				if (inbox === undefined) {
					// Nothing to read Google through: leave the account as it is and look again later.
					store.advance(db, row.email, task.input.gen, {
						outcome: { ok: false, error: "Google is not set up on this server." },
						nextSyncAt: runtime.now() + settings.maxBackoffMs,
						now: runtime.now(),
					});
					await finish(runtime, { done: false, reason: "superseded" }, context);
					return;
				}
				const syncDeps: SyncDeps = {
					db,
					gateway: inbox.google,
					triage: inbox.triage,
					settings,
					now: () => runtime.now(),
					timezone: deps.timezone,
					onTriageError: (error) => {
						if (error === undefined) store.clearState(db, TRIAGE_ERROR_KEY);
						else store.setState(db, TRIAGE_ERROR_KEY, errorText(error), runtime.now());
					},
				};

				let outcome: store.SyncOutcome;
				let more = false;
				let stored = 0;
				try {
					const run = await syncAccount(syncDeps, row.email, context.abortSignal);
					stored = run.stored;
					more = run.more;
					outcome = {
						ok: true,
						...(run.historyId === undefined ? {} : { historyId: run.historyId }),
						...(run.calendar === undefined ? {} : { calendarSynced: true }),
						...(run.warning === undefined ? {} : { warning: run.warning }),
					};
				} catch (error) {
					// The server is closing: this phase is rerun after the restart. It is not a failure of the account.
					if (context.abortSignal?.aborted === true) throw error;
					if (error instanceof TokenRevokedError) {
						await accounts().markNeedsReconnect(row.email, { ownTimer: true });
						await finish(runtime, { done: false, reason: "needs_reconnect" }, context);
						return;
					}
					outcome = { ok: false, error: errorText(error) };
					runtime.report(error);
				}

				const now = runtime.now();
				const nextSyncAt = more
					? now + MORE_MAIL_DELAY_MS
					: now + (outcome.ok ? settings.intervalMs : backoffMs(settings, row.failures + 1));
				if (store.advance(db, row.email, task.input.gen, { outcome, nextSyncAt, now })) {
					try {
						await scheduler()?.ensureScheduled(row.email);
					} catch (error) {
						// The periodic repair makes the timer: a connected account always wants one.
						runtime.report(error);
					}
				}
				await finish(runtime, { done: true, ok: outcome.ok, stored }, context);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

export type InboxSyncTask = ReturnType<typeof createInboxSyncTask>;

function finish(runtime: Runtime, result: InboxSyncResult, context: Context): Promise<void> {
	return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
}

const errorText = (error: unknown): string => clip(error instanceof Error ? error.message : String(error), 300);
