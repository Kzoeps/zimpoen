import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Harness, LiveDoc } from "@earendil-works/pi-durable";
import { conversationIdOf } from "./module.ts";

/**
 * Request id prefixes of runs the owner did not start: the daily jobs (`briefing:`, `wrapup:`, `digest_*:`, keyed by job id
 * and date in daily/run.ts) and routines (`routine:<id>:<slot>`, PLAN upgrade §5). `daily:` is reserved for the same.
 */
export const SCHEDULED_REQUEST_PREFIXES: readonly string[] = [
	"routine:",
	"daily:",
	"briefing:",
	"wrapup:",
	"digest_midday:",
	"digest_evening:",
];

export const isScheduledRequestId = (requestId: string): boolean =>
	SCHEDULED_REQUEST_PREFIXES.some((prefix) => requestId.startsWith(prefix));

/**
 * Rule 13 (nothing self-propagating during scheduled runs): is the conversation's current run answering a scheduled input?
 * Durable gives a tool no request id, so this reads the run's inputs from `LiveDoc` and their request ids from the
 * submissions. A run that batched an owner message with a scheduled one counts as scheduled: refusing is the safe side.
 */
export async function isScheduledRun(harness: Harness, conversationId: number): Promise<boolean> {
	const context = BACKGROUND_CONTEXT;
	const live = await harness.snapshot(LiveDoc, conversationIdOf(conversationId), context);
	for (const id of live?.run?.inputs ?? []) {
		const record = await (await harness.submission(id, context))?.status(context);
		if (record?.requestId !== undefined && isScheduledRequestId(record.requestId)) return true;
	}
	return false;
}
