/**
 * Wall-clock time in the owner's IANA time zone, built on `Intl` alone (no date library).
 *
 * The model reads and writes local times as ISO 8601 text; the database stores UTC epoch milliseconds. Everything that
 * crosses between the two goes through this file, so there is one place that knows what "2026-10-27T09:00" means.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(timezone);
	if (formatter === undefined) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hourCycle: "h23",
			weekday: "short",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timezone, formatter);
	}
	return formatter;
}

type WallClock = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	weekday: string;
};

function wallClock(ms: number, timezone: string): WallClock {
	const parts = new Map<string, string>();
	for (const part of formatterFor(timezone).formatToParts(new Date(ms))) parts.set(part.type, part.value);
	const number = (type: string): number => Number(parts.get(type));
	return {
		year: number("year"),
		month: number("month"),
		day: number("day"),
		hour: number("hour"),
		minute: number("minute"),
		second: number("second"),
		weekday: parts.get("weekday") ?? "",
	};
}

/** Milliseconds the zone is ahead of UTC at the instant `ms` (Asia/Thimphu: always 6 h). */
export function offsetMs(ms: number, timezone: string): number {
	const wall = wallClock(ms, timezone);
	const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
	return asUtc - Math.floor(ms / 1000) * 1000;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The UTC instant at which a zone's wall clock shows these fields.
 *
 * Near a change of the clock the zone has two offsets, the one in force a day before and the one a day after, and a
 * wall-clock time can have two instants or none. A time that happens twice (the clock went back) takes the earlier
 * instant. A time that never happens (the clock jumped forward: 02:30 on the night of the change) takes the later
 * one, 03:30, which is where a calendar moves it.
 */
function zonedToUtc(
	fields: { year: number; month: number; day: number; hour: number; minute: number; second: number },
	timezone: string,
): number {
	const naive = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
	const before = naive - offsetMs(naive - DAY_MS, timezone);
	const after = naive - offsetMs(naive + DAY_MS, timezone);
	const shows = (instant: number): boolean => instant + offsetMs(instant, timezone) === naive;
	if (shows(before)) return before;
	if (shows(after)) return after;
	return before;
}

export type ParsedWhen =
	| { ok: true; ms: number; dateOnly: false }
	/** No time of day was given: `ms` is the last moment of that day and `dayStartMs` the first, whatever the day's length. */
	| { ok: true; ms: number; dateOnly: true; dayStartMs: number }
	| { ok: false; error: string };

const ISO =
	/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Read an ISO 8601 date or date-time. Without an offset or `Z` the text is a wall-clock time in `timezone`; with one,
 * the offset wins. A date without a time means the end of that day (what "due Friday" means).
 */
export function parseWhen(input: string, timezone: string): ParsedWhen {
	const match = ISO.exec(input.trim());
	if (match === null) {
		return {
			ok: false,
			error: `'${shorten(input)}' is not an ISO 8601 date or time. Use for example 2026-10-27T09:00 or 2026-10-27, in ${timezone} unless you add an offset such as +06:00.`,
		};
	}
	const [, y, mo, d, h, mi, s, zone] = match;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);
	const dateOnly = h === undefined;
	const hour = Number(h ?? 0);
	const minute = Number(mi ?? 0);
	const second = Number(s ?? 0);

	const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
	const valid =
		month >= 1 &&
		month <= 12 &&
		hour < 24 &&
		minute < 60 &&
		second < 60 &&
		calendar.getUTCFullYear() === year &&
		calendar.getUTCMonth() === month - 1 &&
		calendar.getUTCDate() === day;
	if (!valid)
		return { ok: false, error: `'${shorten(input)}' is not a real date or time. Check the day and the hour.` };

	if (dateOnly) {
		const today = { year, month, day };
		const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
		const nextMidnight = midnight(
			{ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate() },
			timezone,
			zone,
		);
		return { ok: true, ms: nextMidnight - 1, dateOnly: true, dayStartMs: midnight(today, timezone, zone) };
	}
	const fields = { year, month, day, hour, minute, second };
	if (zone !== undefined) {
		return {
			ok: true,
			ms: Date.UTC(year, month - 1, day, hour, minute, second) - explicitOffset(zone),
			dateOnly: false,
		};
	}
	return { ok: true, ms: zonedToUtc(fields, timezone), dateOnly: false };
}

/** The first moment of a calendar day, in `zone` when the text gave one and in the owner's time zone otherwise. */
function midnight(
	date: { year: number; month: number; day: number },
	timezone: string,
	zone: string | undefined,
): number {
	return zone === undefined
		? zonedToUtc({ ...date, hour: 0, minute: 0, second: 0 }, timezone)
		: Date.UTC(date.year, date.month - 1, date.day) - explicitOffset(zone);
}

function explicitOffset(zone: string): number {
	if (zone.toUpperCase() === "Z") return 0;
	const sign = zone.startsWith("-") ? -1 : 1;
	const digits = zone.slice(1).replace(":", "");
	const hours = Number(digits.slice(0, 2));
	const minutes = Number(digits.slice(2) || "0");
	return sign * (hours * 60 + minutes) * 60_000;
}

/** `2026-10-27T09:00:00+06:00`: the form the model reads and writes. */
export function isoLocal(ms: number, timezone: string): string {
	const wall = wallClock(ms, timezone);
	const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
	const offset = offsetMs(ms, timezone) / 60_000;
	const sign = offset < 0 ? "-" : "+";
	const hours = Math.floor(Math.abs(offset) / 60);
	const minutes = Math.abs(offset) % 60;
	return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}${sign}${pad(hours)}:${pad(minutes)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Mon 27 Oct 2026, 17:00`: for people. Fixed wording, so it never depends on the machine's locale. */
export function formatLocal(ms: number, timezone: string): string {
	const wall = wallClock(ms, timezone);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${wall.weekday} ${wall.day} ${MONTHS[wall.month - 1]} ${wall.year}, ${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** `Mon 27 Oct 2026`: a due date that has no time of day worth showing. */
export function formatLocalDate(ms: number, timezone: string): string {
	return formatLocal(ms, timezone).replace(/, \d{2}:\d{2}$/, "");
}

/** The weekday name of a moment in the zone, for example `Monday`. */
export function weekdayName(ms: number, timezone: string): string {
	return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(new Date(ms));
}

const shorten = (value: string): string => (value.length > 60 ? `${value.slice(0, 60)}…` : value);

/** The calendar day of a moment in the zone, `2026-10-27`. */
export function localDate(ms: number, timezone: string): string {
	return isoLocal(ms, timezone).slice(0, 10);
}

/** `2026-10-27` plus `days` (negative for before), by calendar: no time zone, so no daylight saving to get wrong. */
export function addDays(date: string, days: number): string {
	const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * The instant at which the zone's wall clock shows `time` (`HH:MM`) on the calendar day `date`. A time the clock skips
 * that day moves to the later instant and one it shows twice takes the first, as {@link parseWhen} does.
 */
export function atLocalTime(date: string, time: string, timezone: string): number {
	const parsed = parseWhen(`${date}T${time}`, timezone);
	if (!parsed.ok) throw new Error(`Not a date and time of day: ${date} ${time}. ${parsed.error}`);
	return parsed.ms;
}

/** The last moment of the calendar day `date` in the zone, whatever its length (23, 24 or 25 hours). */
export function endOfLocalDay(date: string, timezone: string): number {
	const parsed = parseWhen(date, timezone);
	if (!parsed.ok) throw new Error(`Not a date: ${date}. ${parsed.error}`);
	return parsed.ms;
}
