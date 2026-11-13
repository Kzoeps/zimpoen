import type { AppDb } from "@assistant/db";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { DAILY_JOBS } from "./daily/jobs.ts";

/** Request id prefix of a routine run: `routine:<id>:<slot ISO>`. */
export const ROUTINE_REQUEST_PREFIX = "routine:";

const DAILY_JOB_IDS: ReadonlySet<string> = new Set(DAILY_JOBS.map((job) => job.id));
const DAILY_REQUEST = /^([a-z_]+):(\d{4}-\d{2}-\d{2})(:empty)?$/;
const ROUTINE_REQUEST = /^routine:(r_[0-9a-f]+):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/** What started a scheduled run, read from its request id; undefined for anything else (the owner, an approval, …). */
export type ScheduledRequest =
	| { kind: "routine"; routine: string; slot: string }
	| { kind: "daily"; job: string; date: string };

/**
 * The one parser of scheduled request ids: a routine (`routine:<id>:<slot ISO>`, built by `routineRequestId`) or a
 * daily job (`<job>:<YYYY-MM-DD>[:empty]`, built by `dailyRequestId`). Exact match on a known job id, so a new id that
 * happens to share a prefix cannot slip through or in; tests check every DAILY_JOBS id round-trips.
 */
export function parseScheduledRequestId(requestId: string | undefined): ScheduledRequest | undefined {
	if (requestId === undefined) return undefined;
	const routine = ROUTINE_REQUEST.exec(requestId);
	if (routine !== null) return { kind: "routine", routine: routine[1] ?? "", slot: routine[2] ?? "" };
	const daily = DAILY_REQUEST.exec(requestId);
	if (daily !== null && DAILY_JOB_IDS.has(daily[1] ?? ""))
		return { kind: "daily", job: daily[1] ?? "", date: daily[2] ?? "" };
	return undefined;
}

/**
 * Whether a submission's request id belongs to a scheduled run rather than to the owner. Anything under the `routine:` or
 * reserved `daily:` prefix counts even when malformed: refusing is the safe side.
 */
export const isScheduledRequestId = (requestId: string | undefined): boolean =>
	parseScheduledRequestId(requestId) !== undefined ||
	(requestId !== undefined && (requestId.startsWith(ROUTINE_REQUEST_PREFIX) || requestId.startsWith("daily:")));

/**
 * The request ids of the inputs placed in the conversation's current run (`""` for an input without one, an ordinary
 * owner message). Empty when the conversation has no placed input: a caller that must fail closed treats that as unknown.
 */
export async function currentRunRequestIds(harness: Harness, conversationId: number): Promise<string[]> {
	const { submissions } = await harness.inspect(BACKGROUND_CONTEXT);
	return submissions
		.filter(
			(submission) =>
				Number(submission.conversationId) === conversationId &&
				submission.type === "input" &&
				submission.status === "placed",
		)
		.map((submission) => submission.requestId ?? "");
}

/** Request id prefix of the question `ask_agent` puts into the asked agent's thread: `ask:<call id>`. */
export const ASK_REQUEST_PREFIX = "ask:";

/** Request id prefix of a run that posts an `ask_agent` answer into the asking thread: `agent-answer:<ask id>`. */
export const AGENT_ANSWER_REQUEST_PREFIX = "agent-answer:";

/**
 * Whether one request id belongs to a scheduled run: a routine or daily request, or an `ask_agent` question (in the asked
 * agent's thread) or its answer (in the PA's) that was asked inside a scheduled run (the `delegate_ask` row says so). One
 * whose ask row is gone counts as scheduled: refusing is the safe side.
 */
export function isScheduledRequest(db: AppDb, requestId: string): boolean {
	if (isScheduledRequestId(requestId)) return true;
	if (requestId.startsWith(ASK_REQUEST_PREFIX)) {
		// The asked agent's run (a bot, the CTO): scheduled when the PA asked from a scheduled run, or when the row is gone.
		const ask = db.get<{ scheduled: number }>("SELECT scheduled FROM delegate_ask WHERE request_id = ?", requestId);
		return ask === undefined || ask.scheduled === 1;
	}
	if (!requestId.startsWith(AGENT_ANSWER_REQUEST_PREFIX)) return false;
	const row = db.get<{ scheduled: number }>(
		"SELECT scheduled FROM delegate_ask WHERE id = ?",
		requestId.slice(AGENT_ANSWER_REQUEST_PREFIX.length),
	);
	return row === undefined || row.scheduled === 1;
}

/**
 * Rule 13 over a run's request ids (from {@link currentRunRequestIds}): true when any is scheduled, and true when there are
 * none, since then nobody can tell what started the run. The one check every guarded tool uses.
 */
export const isScheduledRunIds = (db: AppDb, requestIds: readonly string[]): boolean =>
	requestIds.length === 0 || requestIds.some((id) => isScheduledRequest(db, id));

/**
 * Rule 13: whether the conversation is running for a scheduled run right now, or cannot be told apart from one. Tools that
 * create self-propagating things (routines, bots, broker actions) refuse when it is true, so a routine can never create or
 * cancel routines, directly or through an `ask_agent` answer.
 *
 * Conservative on purpose: an owner message steered into a scheduled run counts as scheduled too.
 */
export async function isScheduledRun(harness: Harness, db: AppDb, conversationId: number): Promise<boolean> {
	return isScheduledRunIds(db, await currentRunRequestIds(harness, conversationId));
}

/**
 * Rule 13 for a tool: {@link isScheduledRunIds} over the run's request ids, read through `deps.runRequestIds` when set.
 * Bots, routines, the broker and `ask_agent` all decide through this, so they agree on an unknown run (refused).
 */
export async function runIsScheduled(
	deps: { db: AppDb; harness: () => Harness; runRequestIds?: (conversationId: number) => Promise<readonly string[]> },
	conversationId: number,
): Promise<boolean> {
	const ids = await (deps.runRequestIds ?? ((id) => currentRunRequestIds(deps.harness(), id)))(conversationId);
	return isScheduledRunIds(deps.db, ids);
}

/** The refusal text tools return under rule 13. */
export const SCHEDULED_RUN_REFUSAL =
	"Refused: this run was started by a routine or a daily job, and scheduled runs may not create or change routines, " +
	"bots or broker actions (rule 13). Tell the owner what you wanted to set up; they can ask for it in a normal message.";
