import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { ApprovalService } from "./approvals/service.ts";
import { conversationIdOf, type EntryPoster, type InputSubmitter } from "./module.ts";

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

/**
 * The way a timer asks the model something (`DomainDeps.ask`): the briefing and the wrap-up. It places an `input` like
 * the owner's own message, which starts a run and costs tokens, so it is for the few moments a day when that is the
 * point. `whenBusy: "followUp"`: a run that is working when the time comes is not interrupted, the request waits for
 * it. The same `requestId` returns the first submission, which makes asking safe to repeat after a crash.
 *
 * `entry` is how the thread shows the input: as a card of the module's own kind instead of a user bubble. The model
 * still reads `content` as a user message.
 */
export function createInputSubmitter(harness: () => Harness): InputSubmitter {
	return async (conversationId, input) => {
		const conversation = await harness().conversation(conversationIdOf(conversationId), BACKGROUND_CONTEXT);
		if (conversation === undefined) {
			throw new Error(
				`Conversation ${conversationId} does not exist in durable.sqlite, so '${input.requestId}' could not be asked. ` +
					"The two databases are out of sync.",
			);
		}
		const submission = await conversation.submit(
			{
				type: "input",
				content: input.content,
				requestId: input.requestId,
				whenBusy: "followUp",
				...(input.entry === undefined ? {} : { entry: input.entry }),
			},
			BACKGROUND_CONTEXT,
		);
		return { submissionId: Number(submission.id) };
	};
}

/** {@link closingYesWindow} for inputs: a question the assistant asks by itself must not turn a later "yes" into an approval. */
export function closingYesWindowOnAsk(
	ask: InputSubmitter,
	approvals: Pick<ApprovalService, "closeYesWindow">,
): InputSubmitter {
	return async (conversationId, input) => {
		approvals.closeYesWindow(conversationId);
		return await ask(conversationId, input);
	};
}
