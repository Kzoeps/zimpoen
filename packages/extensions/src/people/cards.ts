import { BIRTHDAY_ENTRY_KIND, type BirthdayEntryData } from "@assistant/shared";
import type { PostedEntry } from "../module.ts";
import { dayText, occurrenceDate, turnsIn } from "./birthdays.ts";
import type { PersonRow } from "./store.ts";

/**
 * The card of one birthday, as the timer posts it and as start-up posts it again after a power cut: the morning reminder
 * (`remind`) or the evening question (`check`) for the birthday of `year`, shown as it was posted at `firedAt`.
 *
 * The `requestId` names the person, the stage and the **day**, not only the year: Durable writes the first entry for a
 * repeated id and nothing for the second, and a birthday that was corrected within the year (`update_person`) must not
 * have its new day's card swallowed by the card of the old day.
 */
export function birthdayCard(
	row: PersonRow,
	stage: BirthdayEntryData["stage"],
	year: number,
	firedAt: number,
	timezone: string,
): PostedEntry {
	const date = occurrenceDate(row.birthdayMd, year);
	const turns = turnsIn(row.birthdayYear, year);
	const data: BirthdayEntryData = {
		personId: row.id,
		name: row.name,
		...(row.relation === "" ? {} : { relation: row.relation }),
		stage,
		year,
		dateText: dayText(date, timezone),
		...(turns === undefined ? {} : { turns }),
		firedAt,
	};
	return { kind: BIRTHDAY_ENTRY_KIND, data, requestId: `birthday:${stage}:${row.id}:${date}` };
}
