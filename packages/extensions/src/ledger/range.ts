import { type DayRange, resolveRange } from "../health/range.ts";
import { addDays } from "../time.ts";

/** How the Accountant's tools ask the model for a stretch of days. */
export const SPEND_RANGE_HELP =
	"this_month (the 1st to today), last_month, a month as YYYY-MM, a year as YYYY, or how far back ending today: 7d, 30d, 12w, 6m, 1y, all. " +
	"Instead of range you may give from (and optionally to) as YYYY-MM-DD dates.";

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** `October 2026` for `2026-10` or any day of it. */
export const monthName = (yearMonth: string): string => {
	const [year = "", month = "1"] = yearMonth.split("-");
	return `${MONTH_NAMES[Number(month) - 1] ?? "?"} ${year}`;
};

const lastDayOf = (year: number, month: number): string =>
	new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

/** The first day, the last day and the name of a calendar month (`2026-10`). */
export function monthSpan(yearMonth: string): { from: string; to: string; label: string } {
	const [year = 0, month = 1] = yearMonth.split("-").map(Number);
	return { from: `${yearMonth}-01`, to: lastDayOf(year, month), label: monthName(yearMonth) };
}

/** The month before the one `date` is in, as `YYYY-MM`. */
export function previousMonth(date: string): string {
	return addDays(`${date.slice(0, 7)}-01`, -1).slice(0, 7);
}

/**
 * The days a spending question is about. Calendar months and years are what people mean by "this month" and "last
 * month"; counts back from today (`30d`, `6m`) and explicit days are health's {@link resolveRange}. A month in the
 * future is fine (it is empty), the end of this one is today.
 */
export function resolveSpendRange(
	args: { range?: string | undefined; from?: string | undefined; to?: string | undefined },
	today: string,
	fallback: string,
): DayRange {
	if (args.from !== undefined || args.to !== undefined) return resolveRange(args, today, fallback);
	const text = (args.range ?? fallback).trim().toLowerCase();
	if (/^this[ _]month$/.test(text))
		return { from: `${today.slice(0, 7)}-01`, to: today, label: `${monthName(today)} so far` };
	if (/^last[ _]month$/.test(text)) {
		const span = monthSpan(previousMonth(today));
		return { from: span.from, to: span.to, label: span.label };
	}
	if (/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) {
		const span = monthSpan(text);
		return { from: span.from, to: span.to > today && span.from <= today ? today : span.to, label: span.label };
	}
	if (/^\d{4}$/.test(text)) {
		const end = `${text}-12-31`;
		return { from: `${text}-01-01`, to: end > today && `${text}-01-01` <= today ? today : end, label: text };
	}
	return resolveRange({ range: text }, today, fallback);
}

/** The Monday of the week a day is in. */
export function weekStart(date: string): string {
	const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
	return addDays(date, -((weekday + 6) % 7));
}
