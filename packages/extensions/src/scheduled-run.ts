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

/**
 * Rule 13: whether the conversation is running for a scheduled run right now, i.e. one of the inputs placed in its
 * active run is a routine or daily request. Tools that create self-propagating things (routines, bots, broker actions)
 * call this and refuse when it is true, so a routine can never create or cancel routines.
 *
 * Conservative on purpose: an owner message steered into a scheduled run counts as scheduled too.
 */
export async function isScheduledRun(harness: Harness, conversationId: number): Promise<boolean> {
	return (await currentRunRequestIds(harness, conversationId)).some(isScheduledRequestId);
}

/** The refusal text tools return under rule 13. */
export const SCHEDULED_RUN_REFUSAL =
	"Refused: this run was started by a routine or a daily job, and scheduled runs may not create or change routines, " +
	"bots or broker actions (rule 13). Tell the owner what you wanted to set up; they can ask for it in a normal message.";
