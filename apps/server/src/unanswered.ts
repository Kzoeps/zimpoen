import { isSelfExplanatoryReason, SNAPSHOT_UNANSWERED_LIMIT, type UnansweredInput } from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Storage, SubmissionRecord } from "@earendil-works/pi-durable";

/** Reads the recent messages of a conversation that got no answer, newest first, with Durable's reason for each. */
export type UnansweredReader = (conversationId: ConversationId) => Promise<UnansweredInput[]>;

/** How many submissions to look at; the owner's own stops (`aborted`) are skipped and can be many. */
const SCAN_LIMIT = 100;

/**
 * Durable's snapshot does not carry settled submissions, so the reason a message was never answered (no model,
 * provider error) would be lost on reload. The submission records hold it durably: read them from storage.
 */
export function createUnansweredReader(storage: Storage): UnansweredReader {
	return async (conversationId) => {
		const page = await storage.scanSubmissions(
			{ conversationId, status: "unanswered", order: "descending" },
			SCAN_LIMIT,
			undefined,
			BACKGROUND_CONTEXT,
		);
		return page.items.flatMap(toUnanswered).slice(0, SNAPSHOT_UNANSWERED_LIMIT);
	};
}

export function toUnanswered(record: SubmissionRecord): UnansweredInput[] {
	if (record.type !== "input" || record.status !== "unanswered" || isSelfExplanatoryReason(record.reason)) return [];
	return [
		{
			submissionId: record.id,
			...(record.entry === undefined ? {} : { entry: record.entry }),
			reason: record.reason,
			...(record.detail === undefined ? {} : { detail: record.detail }),
		},
	];
}
