import type { AppDb } from "@assistant/db";
import { type ApprovalOutcome, type ApprovalState, NOTICE_ENTRY_KIND, type NoticeEntryData } from "@assistant/shared";
import type { EntryPoster } from "../module.ts";
import * as store from "./store.ts";

export type ActionArgs = store.ActionArgs;

/** How long a request waits for an answer. After that it can no longer be approved. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How far back startup recovery asks again whether an outcome notice is in the thread. A power cut can take the last
 * writes from Durable's database while `app.sqlite` remembers them, and without the notice the card keeps saying
 * "waiting" for a request that was answered. A day is far more than the unsynced tail of a database that is written
 * to this rarely; beyond it the card says "expired" anyway.
 */
const NOTICE_RECHECK_MS = APPROVAL_TTL_MS;

/**
 * A destructive operation a module offers: the tool that does it, and what it touches. The tool is guarded by the
 * `beforeTool` hook (it never runs without an approved request for exactly that target), and the server runs `run`
 * itself the moment the owner approves, so the model is not needed to finish the job.
 */
export type ApprovalAction = {
	/** The destructive tool this stands for, for example `delete_task`. The hook guards this name. */
	tool: string;
	/** The tool that asks the owner first, for example `propose_delete_task`. Named in the message the model gets when blocked. */
	proposeTool: string;
	/** Canonical name of what the call touches, for example `task:t_ab12cd34`. A call and its request must agree on it. */
	target(args: ActionArgs): string;
	/**
	 * Carry it out and say what happened, in words for the owner. Must be safe to run twice (a crash can rerun it).
	 * Throw an `Error` whose message tells the owner what went wrong.
	 */
	run(args: ActionArgs): Promise<string> | string;
};

export type ProposeInput = {
	conversationId: number;
	tool: string;
	args: ActionArgs;
	/** What would happen, in words: shown on the card and remembered with the request. */
	summary: string;
	/** The proposing tool call's id: a rerun of that call finds this request instead of making another. */
	callId: string;
};

/** The owner's answer was refused: the request is gone, or no longer waiting. `status` says which. */
export class ApprovalConflict extends Error {
	readonly status: ApprovalState["status"];

	constructor(message: string, status: ApprovalState["status"]) {
		super(message);
		this.name = "ApprovalConflict";
		this.status = status;
	}
}

/** A request that startup recovery could not finish: the owner's answer is safe in the database, the thread lacks the notice. */
export type RecoveryFailure = { id: string; conversationId: number; message: string };

export type RecoveryReport = {
	expired: number;
	executed: number;
	notified: number;
	/** Requests it could not finish. It moves on to the next one instead of stopping the server from starting. */
	failures: RecoveryFailure[];
};

export class ApprovalNotFound extends Error {
	constructor(id: string) {
		super(`There is no approval request '${id}'.`);
		this.name = "ApprovalNotFound";
	}
}

export type ApprovalService = {
	register(action: ApprovalAction): void;
	/** Does this tool need the owner's approval? The hook's first question. */
	isDestructive(tool: string): boolean;
	proposeToolFor(tool: string): string | undefined;
	/** Create the request, or return the one this call (or an identical waiting request) already made. */
	propose(input: ProposeInput): ApprovalState;
	/** Is there an approved request, not yet carried out, for exactly this call? The hook's second question. */
	isApproved(conversationId: number, tool: string, args: ActionArgs): boolean;
	state(id: string): ApprovalState | undefined;
	/** The owner's answer from a button. A repeated identical answer returns the current state. Throws {@link ApprovalConflict}. */
	decide(id: string, decision: "approve" | "deny", via: "button" | "yes", requestId?: string): Promise<ApprovalState>;
	/**
	 * Called with every message the owner sends. A message that is exactly "YES" approves the request waiting in the
	 * conversation, with no model involved, but only when that is plainly what it answers: exactly one request is
	 * waiting, and nothing else was said since it was created (a "yes" typed after another exchange may be an answer to
	 * a different question). Returns the submission of the outcome notice, or undefined when the message is not taken
	 * here, in which case it goes to the model like any other, and from then on no YES approves the requests that were
	 * waiting (the buttons still do). Resending the same `requestId` returns the same notice.
	 */
	tryYes(conversationId: number, text: string, requestId: string): Promise<{ submissionId: number } | undefined>;
	/**
	 * Something other than the approval itself has just appeared in the conversation, so a bare "yes" may be the answer
	 * to that and not to the request that is waiting: no YES approves the requests that are waiting now (the buttons
	 * still do). `tryYes` does this for every message of the owner; {@link closingYesWindow} does it for every card a
	 * module posts by itself, such as a question the assistant asks the owner on a timer.
	 */
	closeYesWindow(conversationId: number): void;
	/** For the destructive tool itself: carry out the approved request for this call. Throws if there is none. */
	runApproved(conversationId: number, tool: string, args: ActionArgs): Promise<string>;
	/**
	 * Startup repair: close requests past their deadline, carry out approved ones a crash interrupted, post the outcome
	 * notices that never made it into the thread, and ask again for the recent ones that may have been lost from
	 * Durable's database in a power cut (idempotent by request id). A request that cannot be finished is reported in
	 * `failures`; the others are still done. Returns what it did.
	 */
	recover(): Promise<RecoveryReport>;
	/** Close requests past their deadline. Returns how many. */
	expire(): number;
};

type Deps = { db: AppDb; now: () => number; post: EntryPoster };

export function createApprovalService(deps: Deps): ApprovalService {
	const { db, now, post } = deps;
	const actions = new Map<string, ApprovalAction>();

	const actionFor = (tool: string): ApprovalAction => {
		const action = actions.get(tool);
		if (action === undefined) {
			throw new Error(
				`'${tool}' is not an action that can be approved. Known: ${[...actions.keys()].join(", ") || "none"}.`,
			);
		}
		return action;
	};

	const toState = (action: store.PendingAction): ApprovalState => ({
		id: action.id,
		status: action.status,
		summary: action.summary,
		expiresAt: action.expiresAt,
		...(action.resultText === undefined ? {} : { resultText: action.resultText }),
	});

	/** Carry out an approved request and record how it went. Never throws: a failure is the request's outcome. */
	async function execute(action: store.PendingAction): Promise<store.PendingAction> {
		let result: { ok: boolean; text: string };
		try {
			result = { ok: true, text: await actionFor(action.tool).run(action.args) };
		} catch (error) {
			result = { ok: false, text: error instanceof Error ? error.message : String(error) };
		}
		store.markExecuted(db, action.id, result, now());
		return store.requireAction(db, action.id);
	}

	/** Write the outcome into the thread (once: the request id is the action id) and remember that it was done. */
	async function announce(action: store.PendingAction): Promise<number | undefined> {
		const outcome = outcomeOf(action);
		if (outcome === undefined) return undefined;
		const { submissionId } = await post(action.conversationId, {
			kind: NOTICE_ENTRY_KIND,
			data: noticeFor(action, outcome),
			requestId: `approval:${action.id}`,
		});
		store.markNotified(db, action.id, submissionId, now());
		return submissionId;
	}

	async function decide(
		id: string,
		decision: "approve" | "deny",
		via: "button" | "yes",
		requestId?: string,
	): Promise<ApprovalState> {
		const found = store.getAction(db, id);
		if (found === undefined) throw new ApprovalNotFound(id);
		store.expirePending(db, now());
		const current = store.requireAction(db, id);

		if (current.status === "pending") {
			const won = store.decide(db, id, decision === "approve" ? "approved" : "denied", via, requestId, now());
			if (won) {
				const decided = store.requireAction(db, id);
				const finished = decision === "approve" ? await execute(decided) : decided;
				await announce(finished);
				return toState(store.requireAction(db, id));
			}
			// Another answer got there first, or the deadline just passed: fall through and say which.
			return await decide(id, decision, via, requestId);
		}
		const sameAnswer =
			(decision === "approve" && ["approved", "executed", "failed"].includes(current.status)) ||
			(decision === "deny" && current.status === "denied");
		if (sameAnswer) return toState(current);
		throw new ApprovalConflict(
			current.status === "expired"
				? "This request expired: nothing was changed. Ask again if you still want it."
				: `This request was already answered (${current.status}). Nothing more to do.`,
			current.status,
		);
	}

	return {
		register(action) {
			actions.set(action.tool, action);
		},
		isDestructive: (tool) => actions.has(tool),
		proposeToolFor: (tool) => actions.get(tool)?.proposeTool,

		propose(input) {
			const action = actionFor(input.tool);
			const created = now();
			return toState(
				store.insertAction(db, {
					conversationId: input.conversationId,
					tool: input.tool,
					target: action.target(input.args),
					args: input.args,
					summary: input.summary,
					callId: input.callId,
					now: created,
					expiresAt: created + APPROVAL_TTL_MS,
				}),
			);
		},

		isApproved: (conversationId, tool, args) => {
			const action = actions.get(tool);
			return action !== undefined && store.hasApproved(db, conversationId, tool, action.target(args));
		},

		state: (id) => {
			store.expirePending(db, now());
			const action = store.getAction(db, id);
			return action === undefined ? undefined : toState(action);
		},

		decide,

		async tryYes(conversationId, text, requestId) {
			if (isYes(text)) {
				const earlier = store.decidedByRequest(db, conversationId, requestId);
				if (earlier !== undefined) {
					// A retry of a message that already approved something: answer with the same notice, never the model.
					const submissionId = earlier.noticeSubmissionId ?? (await announce(store.requireAction(db, earlier.id)));
					return submissionId === undefined ? undefined : { submissionId };
				}
				store.expirePending(db, now());
				const waiting = store.waitingIn(db, conversationId, now());
				const [only] = waiting;
				if (waiting.length === 1 && only?.yesOk) {
					await decide(only.id, "approve", "yes", requestId);
					const submissionId = store.requireAction(db, only.id).noticeSubmissionId;
					if (submissionId !== undefined) return { submissionId };
				}
			}
			store.closeYesWindow(db, conversationId);
			return undefined;
		},

		closeYesWindow: (conversationId) => store.closeYesWindow(db, conversationId),

		async runApproved(conversationId, tool, args) {
			const action = actionFor(tool);
			const approved = store.findApproved(db, conversationId, tool, action.target(args));
			if (approved === undefined) {
				throw new Error(`${tool} was not approved. Call ${action.proposeTool} and wait for the owner to approve it.`);
			}
			const finished = await execute(approved);
			await announce(finished);
			if (finished.status === "failed") throw new Error(finished.resultText ?? `${tool} failed.`);
			return finished.resultText ?? "Done.";
		},

		expire: () => store.expirePending(db, now()),

		async recover() {
			const expired = store.expirePending(db, now());
			const failures: RecoveryFailure[] = [];
			const failed = new Set<string>();
			/** Post an outcome notice; a request whose conversation is gone is reported once and does not stop the others. */
			const announceSafely = async (action: store.PendingAction): Promise<number | undefined> => {
				if (failed.has(action.id)) return undefined;
				try {
					return await announce(action);
				} catch (error) {
					failed.add(action.id);
					failures.push({
						id: action.id,
						conversationId: action.conversationId,
						message: error instanceof Error ? error.message : String(error),
					});
					return undefined;
				}
			};

			// Before anything is posted: these are the notices app.sqlite believes are in the thread.
			for (const action of store.recentlyNotified(db, now() - NOTICE_RECHECK_MS)) await announceSafely(action);

			let executed = 0;
			for (const action of store.approvedUnexecuted(db)) {
				await announceSafely(await execute(action));
				executed++;
			}
			let notified = 0;
			for (const action of store.unnotified(db)) {
				if ((await announceSafely(action)) !== undefined) notified++;
			}
			return { expired, executed, notified, failures };
		},
	};
}

/** A message is a YES when, ignoring case and surrounding space, it is exactly the word. "yes please" is not. */
export function isYes(text: string): boolean {
	return text.trim().toLowerCase() === "yes";
}

function outcomeOf(action: store.PendingAction): ApprovalOutcome | undefined {
	switch (action.status) {
		case "executed":
			return "executed";
		case "failed":
			return "failed";
		case "denied":
			return "denied";
		default:
			return undefined;
	}
}

function noticeFor(action: store.PendingAction, outcome: ApprovalOutcome): NoticeEntryData {
	const via = action.decidedVia ?? "button";
	const replied = via === "yes" ? "You replied YES. " : "";
	const approval = { actionId: action.id, outcome, via };
	switch (outcome) {
		case "executed":
			return { text: `${replied}${action.resultText ?? "Done."}`, level: "info", approval };
		case "failed":
			return {
				text: `${replied}Approved, but it did not work: ${action.resultText ?? "unknown error"}`,
				level: "error",
				approval,
			};
		default:
			return { text: `Denied: ${action.summary}. Nothing was changed.`, level: "info", approval };
	}
}
