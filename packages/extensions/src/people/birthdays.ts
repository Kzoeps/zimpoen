import { addDays, atLocalTime, formatLocalDate, localDate } from "../time.ts";

/**
 * Birthday arithmetic: pure functions over `MM-DD` strings and local calendar days (`YYYY-MM-DD`), so every rule about
 * leap days, time zones and "which year's birthday is next" is in one place and testable without a database or a clock.
 */

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

export const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export type ParsedBirthday = { ok: true; md: string; year?: number } | { ok: false; error: string };

const FULL = /^(\d{4})-(\d{2})-(\d{2})$/;
const PARTIAL = /^(?:--)?(\d{2})-(\d{2})$/;
const EARLIEST_BIRTH_YEAR = 1900;

/**
 * Read a birthday: `03-05` (month and day, the birth year unknown), `--03-05` (the ISO 8601 form of the same) or
 * `1990-03-05` (with the birth year). February 29 is a real birthday; with a birth year it must be a leap year.
 */
export function parseBirthday(input: string, currentYear: number): ParsedBirthday {
	const text = input.trim();
	const full = FULL.exec(text);
	const partial = full === null ? PARTIAL.exec(text) : null;
	if (full === null && partial === null) {
		return {
			ok: false,
			error: `'${text.slice(0, 40)}' is not a birthday. Use MM-DD (03-05) when the birth year is unknown, or YYYY-MM-DD (1990-03-05) when it is known.`,
		};
	}
	const year = full === null ? undefined : Number(full[1]);
	const month = Number((full ?? partial)?.[full === null ? 1 : 2]);
	const day = Number((full ?? partial)?.[full === null ? 2 : 3]);
	if (!Number.isInteger(month) || month < 1 || month > 12 || day < 1 || day > (DAYS_IN_MONTH[month - 1] ?? 0)) {
		return { ok: false, error: `'${text}' is not a real day of the year. Check the month and the day.` };
	}
	if (year !== undefined) {
		if (year < EARLIEST_BIRTH_YEAR || year > currentYear) {
			return { ok: false, error: `The birth year ${year} is not plausible. Leave it out if it is not known.` };
		}
		if (month === 2 && day === 29 && !isLeapYear(year)) {
			return { ok: false, error: `${year} has no 29 February. Check the birth year, or leave it out.` };
		}
	}
	return { ok: true, md: `${pad(month)}-${pad(day)}`, ...(year === undefined ? {} : { year }) };
}

/** The calendar day of the birthday in `year`, `2026-03-05`. A 29 February falls on 28 February in a year without one. */
export function occurrenceDate(md: string, year: number): string {
	const [month = 1, day = 1] = md.split("-").map(Number);
	const shown = month === 2 && day === 29 && !isLeapYear(year) ? 28 : day;
	return `${pad(year, 4)}-${pad(month)}-${pad(shown)}`;
}

/** The first birthday on or after the local day `today`. */
export function nextOccurrence(md: string, today: string): { date: string; year: number } {
	const thisYear = Number(today.slice(0, 4));
	for (const year of [thisYear, thisYear + 1]) {
		const date = occurrenceDate(md, year);
		if (date >= today) return { date, year };
	}
	// Unreachable: 29 February moves to 28 February, so one of two consecutive years always has a day on or after today.
	throw new Error(`No birthday on or after ${today} for ${md}.`);
}

/** The year of the latest birthday on or before the local day `today`: the one a question asked now is about. */
export function lastOccurrenceYear(md: string, today: string): number {
	const thisYear = Number(today.slice(0, 4));
	return occurrenceDate(md, thisYear) <= today ? thisYear : thisYear - 1;
}

/** `5 Mar`, or `5 Mar 1990` with the birth year. */
export function birthdayLabel(md: string, birthYear?: number): string {
	const [month = 1, day = 1] = md.split("-").map(Number);
	return `${day} ${MONTHS[month - 1]}${birthYear === undefined ? "" : ` ${birthYear}`}`;
}

/** `Thu 5 Mar 2026`: a local calendar day for people. */
export function dayText(date: string, timezone: string): string {
	return formatLocalDate(atLocalTime(date, "12:00", timezone), timezone);
}

/** The age someone turns in the year of an occurrence, or undefined when their birth year is not known. */
export function turnsIn(birthYear: number | undefined, year: number): number | undefined {
	return birthYear === undefined ? undefined : year - birthYear;
}

/** The two times of day of a yearly cycle, `HH:MM` in the owner's zone. */
export type CycleTimes = { remind: string; check: string };

/** One year's cycle: the reminder in the morning, the question in the evening. */
export type Cycle = { year: number; date: string; remindAt: number; checkAt: number };

/** The cycle of `year`. Times come out right across a change of the clock (see `atLocalTime`). */
export function cycleFor(md: string, year: number, timezone: string, times: CycleTimes): Cycle {
	const date = occurrenceDate(md, year);
	return {
		year,
		date,
		remindAt: atLocalTime(date, times.remind, timezone),
		checkAt: atLocalTime(date, times.check, timezone),
	};
}

/**
 * The cycle to run next: the first whose evening question is still to come at `now`, and later than `after` when a year
 * is given. After a long stop of the server the years in between are skipped, so that starting again does not post a
 * card for every birthday that was missed, only for the one that was being waited for.
 */
export function nextCycle(md: string, now: number, timezone: string, times: CycleTimes, after?: number): Cycle {
	const first = Math.max(Number(localDate(now, timezone).slice(0, 4)), after === undefined ? 0 : after + 1);
	for (let year = first; ; year++) {
		const cycle = cycleFor(md, year, timezone, times);
		if (cycle.checkAt > now) return cycle;
	}
}

/** Is the local calendar day `date` over at `now`? A reminder to wish someone well is left out once their day is. */
export const isDayOver = (date: string, now: number, timezone: string): boolean => date < localDate(now, timezone);

/** How many days after a birthday the evening question is still asked (a server that was off over the evening of the day). */
export const LATE_QUESTION_DAYS = 2;

/** Is the birthday on the local day `date` too long ago to ask whether the owner wished them? A months-old question is noise. */
export const isTooLateToAsk = (date: string, now: number, timezone: string): boolean =>
	date < addDays(localDate(now, timezone), -LATE_QUESTION_DAYS);

/** What a row stores of a cycle: the morning reminder is left out when its moment had already passed as the cycle began. */
export function startCycle(cycle: Cycle, now: number): { year: number; remindAt?: number; checkAt: number } {
	return {
		year: cycle.year,
		checkAt: cycle.checkAt,
		...(cycle.remindAt > now ? { remindAt: cycle.remindAt } : {}),
	};
}
