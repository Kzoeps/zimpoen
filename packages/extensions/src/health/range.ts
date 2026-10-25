import { addDays, parseWhen } from "../time.ts";

/** A stretch of local days: `from` is the first day (undefined: from the beginning) and `to` the last, both included. */
export type DayRange = {
	from?: string;
	to: string;
	/** For a heading: `last 30 days`, `all time`, `1 Sep 2026 to 25 Oct 2026`. */
	label: string;
};

/** How the tools ask the model for a stretch of time. */
export const RANGE_HELP =
	"How far back, ending today: a number and d (days), w (weeks), m (months) or y (years), for example 7d, 12w, 6m, 1y; or all. " +
	"Instead of range you may give from (and optionally to) as YYYY-MM-DD dates.";

const RANGE = /^(\d{1,4})\s*([dwmy])$/i;
const UNITS = { d: "day", w: "week", m: "month", y: "year" } as const;

/**
 * The furthest back a count may reach, per unit: a hundred years (days stop at what four digits can say, 27 years). A
 * health log does not go further, and `Date` stops meaning what is written there (`Date.UTC` reads the years 0 to 99 as
 * 1900 to 1999), so `5000y` would answer for the wrong century instead of failing.
 */
const MAX_COUNT = { d: 9_999, w: 5_200, m: 1_200, y: 100 } as const;

/** `date` moved by whole calendar months, with the day kept when it exists and cut to the month's last day when not. */
export function addMonths(date: string, months: number): string {
	const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
	const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
	return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function isoDate(value: string, name: string): string {
	const parsed = parseWhen(value, "UTC");
	if (!parsed.ok || !parsed.dateOnly || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
		throw new Error(`${name} must be a date written YYYY-MM-DD, for example 2026-10-25; got '${value.slice(0, 40)}'.`);
	}
	return value.trim();
}

/**
 * Turn what a tool call asked for into a range ending today at the latest. `range` counts back from `today` (`7d` is
 * today and the six days before it); `from` and `to` name the days themselves. Giving both kinds, a `from` after the
 * `to`, or a range that cannot be read, is an error that says what to send instead.
 */
export function resolveRange(
	args: { range?: string | undefined; from?: string | undefined; to?: string | undefined },
	today: string,
	fallback: string,
): DayRange {
	if (args.from !== undefined || args.to !== undefined) {
		if (args.range !== undefined) throw new Error("Give either range or from/to, not both.");
		const from = args.from === undefined ? undefined : isoDate(args.from, "from");
		const to = args.to === undefined ? today : isoDate(args.to, "to");
		const end = to > today ? today : to;
		if (from !== undefined && from > end) throw new Error(`from ${from} is after to ${end}. Swap them.`);
		return { ...(from === undefined ? {} : { from }), to: end, label: `${from ?? "the beginning"} to ${end}` };
	}
	const text = (args.range ?? fallback).trim().toLowerCase();
	if (text === "all") return { to: today, label: "all time" };
	const match = RANGE.exec(text);
	const count = Number(match?.[1]);
	const unit = (match?.[2] ?? "").toLowerCase() as keyof typeof UNITS;
	if (match === null || count < 1) {
		throw new Error(`range '${text.slice(0, 20)}' is not understood. ${RANGE_HELP}`);
	}
	if (count > MAX_COUNT[unit]) {
		throw new Error(
			`range '${text}' reaches back further than a log can. The most is ${MAX_COUNT[unit]}${unit}; use all for everything.`,
		);
	}
	const label = `last ${count === 1 ? "" : `${count} `}${UNITS[unit]}${count === 1 ? "" : "s"}`;
	const from =
		unit === "d"
			? addDays(today, 1 - count)
			: unit === "w"
				? addDays(today, 1 - count * 7)
				: addDays(addMonths(today, -count * (unit === "y" ? 12 : 1)), 1);
	return { from, to: today, label };
}
