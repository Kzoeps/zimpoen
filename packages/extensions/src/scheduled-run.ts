import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { DAILY_JOBS } from "./daily/jobs.ts";

/** Request id prefix of a routine run: `routine:<id>:<slot ISO>`. */
export const ROUTINE_REQUEST_PREFIX = "routine:";

/**
 * Whether a submission's request id belongs to a scheduled run rather than to the owner: a routine
 * (`routine:<id>:<slot>`) or a daily job (`<job>:<date>`, e.g. `briefing:2026-10-26`).
 */
export function isScheduledRequestId(requestId: string | undefined): boolean {
	if (requestId === undefined) return false;
	if (requestId.startsWith(ROUTINE_REQUEST_PREFIX)) return true;
	return DAILY_JOBS.some((job) => requestId.startsWith(`${job.id}:`));
}

/**
 * Rule 13: whether the conversation is running for a scheduled run right now, i.e. one of the inputs placed in its
 * active run is a routine or daily request. Tools that create self-propagating things (routines, bots, broker actions)
 * call this and refuse when it is true, so a routine can never create or cancel routines.
 *
 * Conservative on purpose: an owner message steered into a scheduled run counts as scheduled too.
 */
export async function isScheduledRun(harness: Harness, conversationId: number): Promise<boolean> {
	const { submissions } = await harness.inspect(BACKGROUND_CONTEXT);
	return submissions.some(
		(submission) =>
			Number(submission.conversationId) === conversationId &&
			submission.type === "input" &&
			submission.status === "placed" &&
			isScheduledRequestId(submission.requestId),
	);
}

/** The refusal text tools return under rule 13. */
export const SCHEDULED_RUN_REFUSAL =
	"Refused: this run was started by a routine or a daily job, and scheduled runs may not create or change routines, " +
	"bots or broker actions (rule 13). Tell the owner what you wanted to set up; they can ask for it in a normal message.";
