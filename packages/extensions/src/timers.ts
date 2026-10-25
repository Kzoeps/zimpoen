import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId, Tx } from "@earendil-works/pi-durable";
import { conversationIdOf, type DomainDeps } from "./module.ts";

const context = BACKGROUND_CONTEXT;

/**
 * How every timer of the assistant is created: owned by the conversation and in the background. The user's Stop button
 * (a conversation abort) must not kill a timer that is only waiting for its time, and it must not keep the conversation
 * "busy" for days.
 */
export const TIMER_TASK_OPTIONS = { ownership: { kind: "conversation" }, background: true } as const;

/** What {@link TimerScheduler.reconcile} did. */
export type ReconcileReport = {
	/** The rows that got a new timer. */
	rescheduled: string[];
	/** The rows it could not repair, and why. It carries on with the others instead of stopping the server. */
	failures: Array<{ itemId: string; conversationId: number; message: string }>;
};

export type TimerScheduler = {
	/**
	 * Make sure a row that wants a timer has a live Durable task, creating one if it has none. Does nothing for a row
	 * that does not want one (done, deleted, nothing left to wait for) or already has one, so it is safe to call after
	 * every change, and again after a crash.
	 */
	ensureScheduled(id: string): Promise<void>;
	/** Abort the timer of a row that was replaced, finished or deleted. Best effort: a stale timer ends itself. */
	cancel(durableTaskId: number | undefined): Promise<void>;
	/**
	 * Repair, at start and then every few minutes. The row is in a database that syncs every commit and Durable's is not,
	 * so after a power cut a row can want a timer that was lost; a crash can leave a timer the row does not point at; and a
	 * timer that Durable ended (faulted, aborted) leaves the row pointing at a task that will never wake. Re-create the
	 * first and the last, re-link the second. Touches only rows that still want a timer, one at a time: a row that cannot
	 * be repaired is reported and the rest are still done.
	 */
	reconcile(): Promise<ReconcileReport>;
};

/** A row that wants a timer, as far as scheduling is concerned. */
export type TimerRow = { id: string; gen: number; conversationId: number; durableTaskId?: number };

/**
 * What a module tells the scheduler about its rows and its Durable task (PLAN §5.4: the row is the truth, the Durable
 * task is a timer). `Claim` is whatever the module needs, besides the generation, to build the task's input.
 */
export type TimerKind<Claim extends { gen: number; conversationId: number }> = {
	/** What the rows are called in messages: "Task", "Follow-up", "Person". */
	label: string;
	/** Durable task kind, stored in task records: how live timers are recognised. */
	taskName: string;
	/** Every row that wants a timer now. */
	pending(): TimerRow[];
	/**
	 * Take the next generation for a row that wants a timer and has none, in `app.sqlite`, right before the Durable
	 * task is created; undefined when the row needs none. A rerun of the call that creates a row after a crash takes a
	 * newer generation, which makes the orphan stale: nothing has to go looking for it.
	 */
	claim(id: string): Claim | undefined;
	/** Remember which Durable task serves generation `gen`. False when the row moved on meanwhile (the task is stale). */
	attach(id: string, gen: number, durableTaskId: number): boolean;
	/** Forget a Durable task that is gone, so that a new one can be made. */
	detach(id: string, durableTaskId: number): void;
	/** Create the Durable task for a claim, inside the commit the scheduler opens on the row's conversation. */
	create(tx: Tx, id: string, claim: Claim): Promise<unknown>;
	/** The row and generation a live task of this kind was made for, read from its stored input. Undefined for anything else. */
	identify(input: unknown): { id: string; gen: number } | undefined;
};

/**
 * The scheduling code shared by every module that keeps a row and a Durable timer for it: create the timer after a
 * change, abort a replaced one, and repair the pairing at start. A module supplies its rows and its task as a
 * {@link TimerKind}; the two databases never have to agree atomically, because a row that wants a timer and has none is
 * found and given one.
 */
export function createTimerScheduler<Claim extends { gen: number; conversationId: number }>(
	deps: Pick<DomainDeps, "harness">,
	kind: TimerKind<Claim>,
): TimerScheduler {
	async function ensureScheduled(id: string): Promise<void> {
		const claim = kind.claim(id);
		if (claim === undefined) return;

		const conversation = await deps.harness().conversation(conversationIdOf(claim.conversationId), context);
		if (conversation === undefined) {
			throw new Error(
				`${kind.label} ${id} belongs to conversation ${claim.conversationId}, which durable.sqlite does not have. ` +
					"The two databases are out of sync.",
			);
		}
		const durableId = await conversation.commit((tx) => kind.create(tx, id, claim), context);
		if (!kind.attach(id, claim.gen, Number(durableId))) {
			// The row moved on while the task was being created (rescheduled, finished, deleted): this timer is stale.
			await cancel(Number(durableId));
		}
	}

	async function cancel(durableTaskId: number | undefined): Promise<void> {
		if (durableTaskId === undefined) return;
		try {
			await deps.harness().abortTask(durableTaskId as TaskId, context);
		} catch {
			// Unknown or already finished. Either way nothing is waiting any more, and a stale timer ends itself when it wakes.
		}
	}

	async function liveTimers(): Promise<Array<{ id: number; row: string; gen: number }>> {
		const { tasks } = await deps.harness().inspect(context);
		const timers: Array<{ id: number; row: string; gen: number }> = [];
		for (const { record } of tasks) {
			if (record.kind !== kind.taskName || record.abortRequested) continue;
			const identity = kind.identify(record.input);
			if (identity !== undefined) timers.push({ id: Number(record.id), row: identity.id, gen: identity.gen });
		}
		return timers;
	}

	async function reconcile(): Promise<ReconcileReport> {
		const report: ReconcileReport = { rescheduled: [], failures: [] };
		const rows = kind.pending();
		// Reading every task of the Harness is the expensive part, and the sweep does it for every kind of timer.
		if (rows.length === 0) return report;
		const timers = await liveTimers();
		for (const row of rows) {
			try {
				const timer = timers.find((candidate) => candidate.row === row.id && candidate.gen === row.gen);
				if (timer !== undefined) {
					// A crash between creating the timer and recording it leaves the row without the link; restore it.
					if (row.durableTaskId === undefined) kind.attach(row.id, row.gen, timer.id);
					continue;
				}
				// No live timer of this generation. If the row still points at one, Durable ended it (a power cut took it,
				// it faulted, it was aborted): forget it, so that a new one can be made.
				if (row.durableTaskId !== undefined) kind.detach(row.id, row.durableTaskId);
				await ensureScheduled(row.id);
				report.rescheduled.push(row.id);
			} catch (error) {
				report.failures.push({
					itemId: row.id,
					conversationId: row.conversationId,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return report;
	}

	return { ensureScheduled, cancel, reconcile };
}
