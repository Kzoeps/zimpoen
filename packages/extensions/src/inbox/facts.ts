import { ATTENTION_CATEGORIES, type MailItem, type TriageCategory } from "@assistant/shared";
import { type DailyFactsProvider, type DayWindow, sectionOf } from "../daily/facts.ts";
import type { DomainDeps } from "../module.ts";
import { mailItem, mailLine } from "./format.ts";
import * as store from "./store.ts";
import { safeLine } from "./text.ts";

type Deps = Pick<DomainDeps, "db" | "timezone">;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** The most mails one digest lists. More is a line that says how many are left: the rest is a search away. */
export const MAX_DIGEST_ITEMS = 25;

/** A digest never reaches further back than this, however long ago the last one was: the mail is stored, and searchable. */
export const MAX_DIGEST_LOOKBACK_MS = 3 * DAY_MS;

/** Mail that arrived longer ago than this is not news, however late it was classified (the first sync reads two weeks). */
export const MAX_NEWS_AGE_MS = 3 * DAY_MS;

/** The briefing counts what came in since the last digest, and at most this far back. */
const BRIEFING_LOOKBACK_MS = DAY_MS;

const BRIEFING_SUBJECTS = 3;

const WORDS: Record<TriageCategory, [one: string, many: string]> = {
	important: ["important", "important"],
	needs_reply: ["needs a reply", "need a reply"],
	follow_up: ["needs a follow-up", "need a follow-up"],
	newsletter: ["newsletter", "newsletters"],
	notification: ["notification", "notifications"],
	promo: ["promo", "promos"],
	personal: ["personal", "personal"],
	finance: ["money mail", "money mail"],
	other: ["other", "other"],
};

/**
 * The accounts whose mail is not coming in, as lines: silence from a broken sync must not look like a quiet inbox. With a
 * digest's window (`news`) also the mail that was given up on since the last digest: it is not in search or in any digest, so
 * this line is how the owner learns it exists (once; Settings keeps showing it).
 */
function accountProblems(deps: Deps, news?: { since: number; cutoff: number }): string[] {
	const accounts = store.listAccounts(deps.db);
	const lines = accounts
		.filter((row) => row.status === "needs_reconnect")
		.map(
			(row) => `${row.email} needs to be connected again (Google refused its sign-in), so its mail is not being read.`,
		);
	if (news === undefined) return lines;
	for (const row of accounts) {
		const given = store
			.skippedReads(deps.db, row.email, news.since)
			.filter((failure) => (failure.skippedAt ?? 0) > news.since && (failure.skippedAt ?? 0) <= news.cutoff);
		const [latest] = given;
		if (latest === undefined) continue;
		const one = given.length === 1;
		lines.push(
			`${given.length} ${one ? "mail" : "mails"} of ${row.email} could not be read after several tries, so ${one ? "it is" : "they are"} not in search or digests: look for ${one ? "it" : "them"} in Gmail. Last reason: ${safeLine(latest.lastError, 120)}`,
		);
	}
	return lines;
}

/**
 * What the Inbox can say for the daily jobs. The digests: the mail that wants the owner's attention since the last digest
 * (important, needs a reply, needs a follow-up), as lines for the model and as items for the card, and any account whose
 * sign-in Google refused. The morning briefing: one line of counts and the top three subjects, written by code.
 *
 * Subjects, senders and snippets are untrusted text: each is one bounded line (`safeLine`), and the PA's and the Inbox's
 * instructions say that such text is data, never an instruction.
 */
export function createInboxFacts(deps: Deps): DailyFactsProvider {
	const { db, timezone } = deps;

	/**
	 * The window a digest looks at: from where the last digest stopped, never more than three days back, up to now. It is
	 * saved the first time, so a rerun after a crash (and the repair after a power cut) shows the same mails, and the next
	 * digest starts where this one ended.
	 */
	function digestWindow(day: DayWindow): store.DigestWindow {
		const job = day.job ?? "digest";
		const known = store.getDigestWindow(db, job, day.date);
		if (known !== undefined) return known;
		const since = Math.max(store.lastDigestCutoff(db) ?? 0, day.now - MAX_DIGEST_LOOKBACK_MS);
		return store.saveDigestWindow(db, job, day.date, { since: Math.min(since, day.now), cutoff: day.now });
	}

	return {
		id: "inbox",

		digest: (day) => {
			const window = digestWindow(day);
			const { rows, total } = store.attentionMessages(db, {
				since: window.since,
				cutoff: window.cutoff,
				notBefore: window.cutoff - MAX_NEWS_AGE_MS,
				categories: ATTENTION_CATEGORIES,
				limit: MAX_DIGEST_ITEMS,
			});
			const sections = [];
			if (rows.length > 0) {
				const lines = rows.map((row) => mailLine(row, timezone));
				if (total > rows.length) lines.push(`… and ${total - rows.length} more (search_mail finds them)`);
				const mail: MailItem[] = rows.map((row) => mailItem(row, timezone, 100));
				sections.push({ title: "Mail that needs your attention", lines, mail });
			}
			return [...sections, ...sectionOf("Accounts that need attention", accountProblems(deps, window))];
		},

		briefing: (day) => {
			const since = Math.max(store.lastDigestCutoff(db) ?? 0, day.now - BRIEFING_LOOKBACK_MS);
			const window = { since, cutoff: day.now, notBefore: day.now - MAX_NEWS_AGE_MS, categories: ATTENTION_CATEGORIES };
			const counts = store.attentionCounts(db, window);
			const lines: string[] = [];
			const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
			if (total > 0) {
				const parts = ATTENTION_CATEGORIES.flatMap((category) => {
					const count = counts.get(category) ?? 0;
					return count === 0 ? [] : [`${count} ${WORDS[category][count === 1 ? 0 : 1]}`];
				});
				lines.push(
					`${total} ${total === 1 ? "email wants" : "emails want"} your attention since the last digest: ${parts.join(", ")}.`,
				);
				const top = store.attentionMessages(db, { ...window, limit: BRIEFING_SUBJECTS }).rows;
				for (const row of top) {
					lines.push(
						`${safeLine(row.subject === "" ? "(no subject)" : row.subject, 80)} (from ${safeLine(row.fromName === "" ? row.fromAddr : row.fromName, 40)})`,
					);
				}
			}
			return sectionOf("Inbox", [...lines, ...accountProblems(deps)]);
		},
	};
}
