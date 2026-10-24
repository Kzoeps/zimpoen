import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { conversationIdOf, type EntryPoster } from "./module.ts";

/**
 * The zero-token post of PLAN §5.3: a `write` submission appends an entry to a conversation without asking the model
 * anything. The `requestId` makes it safe to repeat: Durable returns the submission the first call made.
 *
 * The write is display-only on purpose: it never carries `model`. Durable treats a write with model text as input for
 * the next run, so for an idle conversation that still has queued messages (a run that failed with the model down, say)
 * it would start a run, which costs tokens and fails the same way. What the model needs to know about a posted entry
 * comes from the database through a prompt section instead (the `tasks` section lists reminders that were sent).
 */
export function createEntryPoster(harness: () => Harness): EntryPoster {
	return async (conversationId, entry) => {
		const conversation = await harness().conversation(conversationIdOf(conversationId), BACKGROUND_CONTEXT);
		if (conversation === undefined) {
			throw new Error(
				`Conversation ${conversationId} does not exist in durable.sqlite, so '${entry.kind}' could not be posted. ` +
					"The two databases are out of sync.",
			);
		}
		const submission = await conversation.submit(
			{ type: "write", requestId: entry.requestId, entry: { kind: entry.kind, data: entry.data } },
			BACKGROUND_CONTEXT,
		);
		return { submissionId: Number(submission.id) };
	};
}
