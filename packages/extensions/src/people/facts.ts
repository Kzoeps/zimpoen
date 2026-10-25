import { type DailyFactsProvider, sectionOf } from "../daily/facts.ts";
import type { DomainDeps } from "../module.ts";
import { addDays } from "../time.ts";
import { dayText, nextOccurrence, occurrenceDate, turnsIn } from "./birthdays.ts";
import * as store from "./store.ts";

type Deps = Pick<DomainDeps, "db" | "timezone">;

/** How many days ahead of today the briefing mentions a birthday. */
const BRIEFING_DAYS_AHEAD = 3;

/**
 * What the address book can say for the daily jobs. The briefing: whose birthday is today and in the next three days.
 * The wrap-up: whom the owner wished well today, and the evening question they have not answered.
 */
export function createPeopleFacts(deps: Deps): DailyFactsProvider {
	const { db, timezone } = deps;

	return {
		id: "people",
		briefing: (day) => {
			const until = addDays(day.date, BRIEFING_DAYS_AHEAD);
			const lines = store
				.listPeople(db)
				.map((row) => ({ row, next: nextOccurrence(row.birthdayMd, day.date) }))
				.filter(({ next }) => next.date <= until)
				.sort((a, b) => a.next.date.localeCompare(b.next.date) || a.row.name.localeCompare(b.row.name))
				.map(({ row, next }) => {
					const relation = row.relation === "" ? "" : ` (${row.relation})`;
					const turns = turnsIn(row.birthdayYear, next.year);
					const when = next.date === day.date ? "today" : dayText(next.date, timezone);
					const wished =
						next.date === day.date && store.wishOf(db, row.id, next.year) === true ? "; already wished" : "";
					return `${row.id} ${row.name}${relation} — ${when}${turns === undefined ? "" : `, turns ${turns}`}${wished}`;
				});
			return sectionOf("Birthdays", lines);
		},
		wrapup: (day) => {
			const wished = store
				.wishesBetween(db, day.startMs, day.endMs)
				.filter((wish) => wish.wished)
				.map((wish) => `${wish.person.id} ${wish.person.name} — the owner wished them well`);
			const open = store
				.unansweredQuestions(db)
				.filter((row) => row.askedAt !== undefined && row.askedAt >= day.startMs && row.askedAt < day.endMs)
				.map((row) => {
					const date = occurrenceDate(row.birthdayMd, row.askedYear ?? row.cycleYear);
					return `${row.id} ${row.name} — birthday ${dayText(date, timezone)}: the owner has not said whether they wished them well`;
				});
			return [...sectionOf("Birthdays wished today", wished), ...sectionOf("Birthdays still open", open)];
		},
	};
}
