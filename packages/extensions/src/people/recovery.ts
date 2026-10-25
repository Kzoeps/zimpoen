import type { DomainDeps, PostedEntry } from "../module.ts";
import { isDayOver, occurrenceDate } from "./birthdays.ts";
import { birthdayCard } from "./cards.ts";
import * as store from "./store.ts";

/** How far back start-up asks again whether an evening question is in the thread. Beyond a day it is too old to matter. */
export const QUESTION_RECHECK_MS = 24 * 60 * 60 * 1000;

export type CardRecovery = {
	/** The people whose cards could not be posted again, and why. It carries on with the others. */
	failures: Array<{ itemId: string; conversationId: number; message: string }>;
};

/**
 * Start-up repair of the birthday cards. A timer posts a card and then moves the row on to next year's cycle in the
 * database that syncs every commit, while the card sits in Durable's, which does not: after a power cut the row can be a
 * cycle ahead of a thread that never got the card, and then nothing remembers it (the timer that would have posted it
 * again is gone with the cycle). So the cards the row still remembers are posted again, with the same `requestId`: a
 * thread that has the card keeps the one it has, one that lost it gets it back. No push: that went out when the card was
 * first posted, and the owner was nudged then.
 *
 * What is posted again: the evening question of the last 24 hours that the owner has not answered, and the morning
 * card while its day is not over (after the day, "wish them well" is no use). Both only while the owner has not said
 * they wished. A person whose conversation Durable does not have is reported, and the others are still done.
 */
export async function recoverCards(deps: Pick<DomainDeps, "db" | "timezone" | "now" | "post">): Promise<CardRecovery> {
	const now = deps.now();
	const open = new Set(store.unansweredQuestions(deps.db).map((row) => row.id));
	const failures: CardRecovery["failures"] = [];
	for (const row of store.listPeople(deps.db)) {
		try {
			for (const card of missingCards(deps, row, open.has(row.id), now)) await deps.post(row.conversationId, card);
		} catch (error) {
			failures.push({
				itemId: row.id,
				conversationId: row.conversationId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { failures };
}

/** The cards of a person that the thread should have, oldest first, so a thread that lost both gets them in order. */
function missingCards(
	deps: Pick<DomainDeps, "db" | "timezone">,
	row: store.PersonRow,
	questionOpen: boolean,
	now: number,
): PostedEntry[] {
	const { db, timezone } = deps;
	const cards: PostedEntry[] = [];
	const { remindedYear, remindedAt, askedYear, askedAt } = row;
	if (
		remindedYear !== undefined &&
		remindedAt !== undefined &&
		store.wishOf(db, row.id, remindedYear) !== true &&
		!isDayOver(occurrenceDate(row.birthdayMd, remindedYear), now, timezone)
	) {
		cards.push(birthdayCard(row, "remind", remindedYear, remindedAt, timezone));
	}
	if (questionOpen && askedYear !== undefined && askedAt !== undefined && askedAt > now - QUESTION_RECHECK_MS) {
		cards.push(birthdayCard(row, "check", askedYear, askedAt, timezone));
	}
	return cards;
}
