import { getAgentRow } from "@assistant/db";
import {
	NOTICE_ENTRY_KIND,
	type NoticeEntryData,
	SUGGESTION_ENTRY_KIND,
	SUGGESTION_TTL_MS,
	type SuggestionDecision,
	type SuggestionEntryData,
	type SuggestionState,
	type SuggestionSummary,
} from "@assistant/shared";
import type { JsonValue } from "@earendil-works/chord";
import type { DomainDeps } from "../module.ts";
import { formatLocal, isoLocal } from "../time.ts";
import { endTextOf } from "./format.ts";
import * as store from "./store.ts";

/** Asked to decide a suggestion that does not exist. */
export class SuggestionNotFound extends Error {
	constructor(id: string) {
		super(`There is no suggestion '${id.slice(0, 40)}'.`);
		this.name = "SuggestionNotFound";
	}
}

/** The suggestion was already answered the other way, or waited too long to be answered at all. */
export class SuggestionConflict extends Error {
	constructor(id: string, status: string) {
		super(
			status === "expired"
				? `Suggestion ${id} expired: nobody answered within 7 days, so nothing was added. Ask the Inbox again if you still want it.`
				: `Suggestion ${id} was already ${status}.`,
		);
		this.name = "SuggestionConflict";
	}
}

export type SuggestionService = {
	/** Put the card of a suggestion into the PA's thread (once: the request id makes a repeat write nothing) and push. Never throws. */
	post(row: store.SuggestionRow): Promise<void>;
	/** Post the cards of suggestions that never reached the PA's thread (a crash between the row and the post), after {@link SuggestionService.expire}. */
	deliver(): Promise<number>;
	/** Close the suggestions that waited a week for an answer: they are not offered, deduplicated against or answerable any more. Returns how many. */
	expire(): number;
	/**
	 * The owner's answer. Add: the PA is asked to add the follow-up with `add_followup` (it is the PA that does, and the
	 * owner sees the details in the card they pressed); Dismiss: nothing happens but the card says so. The first answer
	 * stands: the other one is a {@link SuggestionConflict}, and the same one again is the same answer. A suggestion that
	 * waited more than {@link SUGGESTION_TTL_MS} is expired and cannot be answered (a {@link SuggestionConflict} too).
	 */
	decide(id: string, decision: SuggestionDecision): Promise<SuggestionState>;
};

type Deps = Pick<DomainDeps, "db" | "now" | "timezone" | "post" | "ask" | "notify">;

export function summaryOf(row: store.SuggestionRow, timezone: string): SuggestionSummary {
	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		at: row.at,
		atText: formatLocal(row.at, timezone),
		source: {
			type: row.sourceType,
			label: row.sourceLabel,
			...(row.sourceUrl === undefined ? {} : { url: row.sourceUrl }),
		},
		...(row.counterpart === "" ? {} : { counterpart: row.counterpart }),
		...(row.context === "" ? {} : { context: row.context }),
		...(row.endsAt === undefined ? {} : { endsAtText: endTextOf(row.at, row.endsAt, timezone) }),
	};
}

/**
 * What the PA is asked, written by this code from the stored suggestion and never by a model: the PA reads it as the owner's
 * message (the owner pressed Add on a card that showed exactly these details), and `add_followup` is the tool that does it.
 */
export function addRequestText(row: store.SuggestionRow, timezone: string): string {
	const lines = [
		`Add this to my follow-ups with add_followup (the Inbox agent suggested it, from ${row.sourceType === "mail" ? "an email" : "a calendar event"}, and I confirmed):`,
		`- title: ${row.title}`,
		`- kind: ${row.kind}`,
		...(row.counterpart === "" ? [] : [`- with: ${row.counterpart}`]),
		`- event_at: ${isoLocal(row.at, timezone)} (${formatLocal(row.at, timezone)})`,
		...(row.endsAt === undefined ? [] : [`- ends_at: ${isoLocal(row.endsAt, timezone)}`]),
		...(row.context === "" ? [] : [`- context: ${row.context}`]),
		"Use exactly these details. Then tell me in one line that it is saved, or why it could not be.",
	];
	return lines.join("\n");
}

export function createSuggestionService(deps: Deps): SuggestionService {
	const { db } = deps;
	const paConversation = (): number | undefined => getAgentRow(db, "pa")?.conversationId;

	async function post(row: store.SuggestionRow): Promise<void> {
		const conversationId = paConversation();
		if (conversationId === undefined) return;
		try {
			const data: SuggestionEntryData = {
				...summaryOf(row, deps.timezone),
				firedAt: deps.now(),
				expiresAt: row.createdAt + SUGGESTION_TTL_MS,
			};
			await deps.post(conversationId, {
				kind: SUGGESTION_ENTRY_KIND,
				data: data as unknown as JsonValue,
				requestId: `suggestion:${row.id}`,
			});
			const first = row.postedAt === undefined;
			store.markSuggestionPosted(db, row.id, deps.now());
			if (first) {
				await deps.notify({
					title: "Suggestion",
					body: "The Inbox has a suggestion",
					url: "/chat/pa",
					tag: "suggestion",
				});
			}
		} catch {
			// The row says it is not posted yet, and the next sweep posts it.
		}
	}

	const expire = (): number => store.expireSuggestions(db, deps.now() - SUGGESTION_TTL_MS, deps.now());

	async function deliver(): Promise<number> {
		expire();
		let posted = 0;
		for (const row of store.unpostedSuggestions(db)) {
			await post(row);
			if (store.getSuggestion(db, row.id)?.postedAt !== undefined) posted += 1;
		}
		return posted;
	}

	async function decide(id: string, decision: SuggestionDecision): Promise<SuggestionState> {
		expire();
		const row = store.getSuggestion(db, id);
		if (row === undefined) throw new SuggestionNotFound(id);
		const status = decision === "add" ? "added" : "dismissed";
		if (row.status !== "pending") {
			if (row.status === status) return { id, status };
			throw new SuggestionConflict(id, row.status);
		}
		const conversationId = paConversation();
		if (conversationId === undefined) throw new Error("The PA has no conversation yet, so there is nobody to ask.");
		// The effects first, each idempotent by its request id; the row last, so that a crash in between is repeated, not lost.
		const notice: NoticeEntryData = {
			text:
				decision === "add"
					? `You asked the assistant to add “${row.title}” to your follow-ups (suggested by the Inbox).`
					: `You dismissed the Inbox's suggestion “${row.title}”.`,
			level: "info",
			suggestion: { suggestionId: id, outcome: status },
		};
		if (decision === "add") {
			await deps.ask(conversationId, {
				content: addRequestText(row, deps.timezone),
				requestId: `suggestion-add:${id}`,
				entry: { kind: NOTICE_ENTRY_KIND, data: notice as unknown as JsonValue },
			});
		} else {
			await deps.post(conversationId, {
				kind: NOTICE_ENTRY_KIND,
				data: notice as unknown as JsonValue,
				requestId: `suggestion-dismiss:${id}`,
			});
		}
		store.decideSuggestion(db, id, status, deps.now());
		return { id, status };
	}

	return { post, deliver, expire, decide };
}
