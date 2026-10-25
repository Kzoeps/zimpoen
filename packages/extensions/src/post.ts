import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { ApprovalService } from "./approvals/service.ts";
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

/**
 * The poster the feature modules get: it writes like `post`, and first closes the YES window of the conversation (see
 * `ApprovalService.closeYesWindow`). A timer can ask the owner a yes/no question at any moment ("did you wish Tashi a
 * happy birthday?"), and a bare "yes" typed to it must not approve a deletion that is waiting in the same conversation.
 * The window closes before the write, so a card is never visible while a YES can still approve something.
 *
 * Not for the approval service's own notices: they report how a request ended, and are written by the service with the
 * plain poster.
 */
export function closingYesWindow(post: EntryPoster, approvals: Pick<ApprovalService, "closeYesWindow">): EntryPoster {
	return async (conversationId, entry) => {
		approvals.closeYesWindow(conversationId);
		return await post(conversationId, entry);
	};
}
