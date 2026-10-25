import {
	AGENDA_ENTRY_KIND,
	type AgendaEntryData,
	FOLLOWUP_ENTRY_KIND,
	type FollowupEntryData,
	type PushPayload,
} from "@assistant/shared";
import type { Context } from "@earendil-works/chord";
import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { DomainDeps, PostedEntry } from "../module.ts";
import { scheduleOf } from "../schedule.ts";
import { addDays, atLocalTime, formatLocal, localDate } from "../time.ts";
import * as store from "./store.ts";

/** Durable task kind of a follow-up timer. Stored in task records, so renaming it orphans timers that are waiting. */
export const FOLLOWUP_TASK_NAME = "app.followup";

/** Where a tap on these notifications goes: follow-ups belong to the PA, whose thread is `/chat/pa`. */
export const FOLLOWUP_URL = "/chat/pa";

/** What the phone shows. Minimal on purpose: a push passes through Google's or Apple's servers, so no names, no points. */
export const AGENDA_PUSH: PushPayload = {
	title: "Agenda",
	body: "1 meeting is about to start",
	url: FOLLOWUP_URL,
	tag: "agenda",
};
export const FOLLOWUP_PUSH: PushPayload = {
	title: "Follow-up",
	body: "1 question: how did it go?",
	url: FOLLOWUP_URL,
	tag: "followup",
};
/** The same question the morning after: the same tag, so it replaces the first banner instead of stacking. */
export const FOLLOWUP_REASK_PUSH: PushPayload = {
	title: "Follow-up",
	body: "1 question is still open: how did it go?",
	url: FOLLOWUP_URL,
	tag: "followup",
};
/** A commitment is due. Its own tag: the question that follows half an hour later must not replace it. */
export const FOLLOWUP_NUDGE_PUSH: PushPayload = {
	title: "Follow-up",
	body: "1 follow-up is due now",
	url: FOLLOWUP_URL,
	tag: "followup-due",
};

/** An agenda that comes up later than this after the meeting began is no use to anyone and is not posted. */
export const AGENDA_GRACE_MS = 5 * 60_000;

const MINUTE_MS = 60_000;

export type FollowupInput = {
	/** The `followups_item` row to watch over. */
	itemId: string;
	/** The row's `gen` when this task was created. The task acts only while the row still has this one. */
	gen: number;
	/** The owner had been asked already when this timer was made (a repair): it starts at the wait for the second question. */
	asked?: true;
};

export type FollowupState =
	| { phase: "agenda_wait" }
	| { phase: "agenda_ping" }
	| { phase: "nudge_wait" }
	| { phase: "nudge" }
	| { phase: "ask_wait" }
	| { phase: "ask" }
	| { phase: "reask_wait" }
	| { phase: "reask" };

/**
 * How the timer ended: the owner was asked (and whether a second time), or the row moved on (answered, moved, deleted)
 * before that was done. `asked` says whether the question had been posted by then.
 */
export type FollowupResult = { asked: true; reasked: boolean } | { asked: boolean; reason: "superseded" };

type FollowupDeps = Pick<DomainDeps, "db" | "timezone" | "post" | "notify" | "schedule">;
type Runtime = TaskRuntime<FollowupInput, FollowupState, FollowupResult, object>;

/**
 * The life of one meeting or commitment (PLAN §5.4): wait for the agenda, post it when there are points, nudge the owner
 * when a commitment is due, wait for the end of the meeting, ask how it went, and ask once more the next morning if nobody
 * answered. It costs no model tokens: every card is a display-only write, and the model learns that a question is open
 * from the `followups` prompt section. The owner's answer reaches the row through the `record_outcome` tool, which
 * resolves it (and creates the next link of the chain); the timer then finds the row resolved and ends without posting.
 *
 * The task is a timer; `followups_item` is the truth. Rescheduling, moving, resolving or deleting changes only the row,
 * and a task created for an older generation finds out when it wakes and ends without posting. Aborting it is housekeeping.
 *
 * A phase reruns from its top after a crash, so each effect tolerates that: the cards use a `requestId` made of what
 * they are about (the follow-up, its time and the stage), so a rerun finds the entry already there instead of posting
 * another, and a push is at least once (one tag per kind, so the phone replaces a duplicate banner). Every phase also
 * accepts a row that is already further along (see `current`): Durable's database can come back from before a card.
 */
export function createFollowupTask(deps: FollowupDeps) {
	const { db, timezone } = deps;
	const settings = scheduleOf(deps);

	/**
	 * The row this task still serves, or undefined after it ended itself as superseded. A row that says `asked` with this
	 * task's generation is still its row: the question was posted by this very timer, and the timer is here again because
	 * Durable's database came back from before that (a power cut), or because it is the one that waits to ask again.
	 */
	async function current(
		task: { input: FollowupInput },
		runtime: Runtime,
		context: Context,
	): Promise<store.FollowupRow | undefined> {
		const row = store.getFollowup(db, task.input.itemId);
		if (row !== undefined && store.isCurrent(row, task.input)) return row;
		await finish(runtime, { asked: row?.askedAt !== undefined, reason: "superseded" }, context);
		return undefined;
	}

	async function push(runtime: Runtime, payload: PushPayload): Promise<void> {
		try {
			await deps.notify(payload);
		} catch (error) {
			// The card is already in the thread; a failed push is reported, never a reason to fault the task.
			runtime.report(error);
		}
	}

	const next = (runtime: Runtime, phase: FollowupState["phase"], context: Context): Promise<void> =>
		runtime.commit(() => ({ status: "running", checkpoint: { phase } }), context);

	return defineTask<FollowupInput, FollowupState, FollowupResult>({
		name: FOLLOWUP_TASK_NAME,
		version: 1,
		initial: (input) => ({ phase: input.asked === true ? "reask_wait" : "agenda_wait" }),
		phases: {
			agenda_wait: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				await runtime.sleepUntil(row.eventAt - row.agendaLeadMinutes * MINUTE_MS, { phase: "agenda_ping" }, context);
			},

			agenda_ping: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				const points = store.agendaOf(db, row.id).map((point) => point.text);
				if (points.length > 0 && runtime.now() <= row.eventAt + AGENDA_GRACE_MS) {
					const data: AgendaEntryData = {
						followupId: row.id,
						title: row.title,
						...(row.counterpart === "" ? {} : { counterpart: row.counterpart }),
						eventAt: row.eventAt,
						eventAtText: formatLocal(row.eventAt, timezone),
						today: localDate(row.eventAt, timezone) === localDate(runtime.now(), timezone),
						points,
						firedAt: runtime.now(),
					};
					await deps.post(runtime.conversationId, {
						kind: AGENDA_ENTRY_KIND,
						data,
						requestId: `agenda:${row.id}:${row.eventAt}`,
					});
					store.markAgendaPinged(db, row.id, task.input.gen, runtime.now());
					await push(runtime, AGENDA_PUSH);
				}
				// A meeting is something the owner goes to; a commitment is something they have to do, so it is due at its time.
				await next(runtime, row.kind === "commitment" ? "nudge_wait" : "ask_wait", context);
			},

			nudge_wait: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				await runtime.sleepUntil(row.eventAt, { phase: "nudge" }, context);
			},

			nudge: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				// A nudge that comes after the question it precedes (the server was down) is noise: the question is enough.
				if (runtime.now() < row.askAt) {
					await deps.post(runtime.conversationId, followupCard(row, "nudge", runtime.now(), timezone));
					await push(runtime, FOLLOWUP_NUDGE_PUSH);
				}
				await next(runtime, "ask_wait", context);
			},

			ask_wait: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				await runtime.sleepUntil(row.askAt, { phase: "ask" }, context);
			},

			ask: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				await deps.post(runtime.conversationId, followupCard(row, "ask", runtime.now(), timezone));
				store.markAsked(db, row.id, task.input.gen, runtime.now());
				await push(runtime, FOLLOWUP_PUSH);
				await next(runtime, "reask_wait", context);
			},

			reask_wait: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				// The morning after the question was asked, however late that was: asked at 23:50 it comes about nine hours later.
				const day = addDays(localDate(row.askedAt ?? runtime.now(), timezone), 1);
				await runtime.sleepUntil(atLocalTime(day, settings.followupReaskTime, timezone), { phase: "reask" }, context);
			},

			reask: async (task, runtime, context) => {
				const row = await current(task, runtime, context);
				if (row === undefined) return;
				await deps.post(runtime.conversationId, followupCard(row, "reask", runtime.now(), timezone));
				store.markReasked(db, row.id, task.input.gen, runtime.now());
				await push(runtime, FOLLOWUP_REASK_PUSH);
				await finish(runtime, { asked: true, reasked: true }, context);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

export type FollowupTask = ReturnType<typeof createFollowupTask>;

/**
 * The card of one stage. The `requestId` names the follow-up, the time the stage is about and the stage: a meeting that
 * moves gets new cards, and the same stage twice (a rerun, a repaired timer) is one card.
 */
function followupCard(
	row: store.FollowupRow,
	stage: FollowupEntryData["stage"],
	firedAt: number,
	timezone: string,
): PostedEntry {
	const data: FollowupEntryData = {
		followupId: row.id,
		title: row.title,
		...(row.counterpart === "" ? {} : { counterpart: row.counterpart }),
		...(row.context === "" ? {} : { context: row.context }),
		kind: row.kind,
		stage,
		eventAt: row.eventAt,
		eventAtText: formatLocal(row.eventAt, timezone),
		chained: row.parentId !== undefined,
		firedAt,
	};
	const requestId =
		stage === "nudge"
			? `followup:${row.id}:${row.eventAt}:nudge`
			: stage === "ask"
				? `followup:${row.id}:${row.askAt}`
				: `followup:${row.id}:${row.askAt}:reask`;
	return { kind: FOLLOWUP_ENTRY_KIND, data, requestId };
}

function finish(runtime: Runtime, result: FollowupResult, context: Context): Promise<void> {
	return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
}
