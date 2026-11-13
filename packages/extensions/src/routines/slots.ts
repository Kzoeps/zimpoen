import { addDays, atLocalTime, localDate } from "../time.ts";

/**
 * When a routine runs. Daily and weekly times are wall-clock times in the owner's zone (07:30 stays 07:30 across a change
 * of the clock); "every N hours" is elapsed time from `anchorAt`, the moment the routine was made.
 */
export type RoutineSchedule =
	| { kind: "daily"; time: string }
	/** `days` are ISO weekdays, 1 (Monday) to 7 (Sunday), sorted and unique. */
	| { kind: "weekly"; days: readonly number[]; time: string }
	| { kind: "hourly"; everyHours: number; anchorAt: number };

const HOUR_MS = 60 * 60_000;

/** The shortest gap "every N hours" may ask for. */
export const MIN_EVERY_HOURS = 1;
/** The longest: a week. Anything longer is a weekly routine. */
export const MAX_EVERY_HOURS = 24 * 7;

/** A slot more than this late (the server was down) is skipped, not run. */
export const LATE_LIMIT_MS = 6 * HOUR_MS;

/** ISO weekday of a calendar day `YYYY-MM-DD`: 1 Monday … 7 Sunday. Pure calendar arithmetic, no zone involved. */
export function isoWeekday(date: string): number {
	const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

const runsOn = (schedule: RoutineSchedule & { kind: "daily" | "weekly" }, date: string): boolean =>
	schedule.kind === "daily" || schedule.days.includes(isoWeekday(date));

/** The first slot strictly after `after`. */
export function nextSlotAfter(schedule: RoutineSchedule, after: number, timezone: string): number {
	if (schedule.kind === "hourly") {
		const step = schedule.everyHours * HOUR_MS;
		if (after < schedule.anchorAt) return schedule.anchorAt;
		return schedule.anchorAt + (Math.floor((after - schedule.anchorAt) / step) + 1) * step;
	}
	// Days come from calendar arithmetic, so a 23- or 25-hour day cannot move a slot to another day or time.
	let date = localDate(after, timezone);
	for (let step = 0; step <= 8; step++, date = addDays(date, 1)) {
		if (!runsOn(schedule, date)) continue;
		const at = atLocalTime(date, schedule.time, timezone);
		if (at > after) return at;
	}
	throw new Error("A routine schedule has no slot within a week. A weekly routine needs at least one day.");
}

/** The newest slot at or before `now`, or undefined when there is none yet. */
export function latestSlotAtOrBefore(schedule: RoutineSchedule, now: number, timezone: string): number | undefined {
	if (schedule.kind === "hourly") {
		if (now < schedule.anchorAt) return undefined;
		const step = schedule.everyHours * HOUR_MS;
		return schedule.anchorAt + Math.floor((now - schedule.anchorAt) / step) * step;
	}
	let date = localDate(now, timezone);
	for (let step = 0; step <= 8; step++, date = addDays(date, -1)) {
		if (!runsOn(schedule, date)) continue;
		const at = atLocalTime(date, schedule.time, timezone);
		if (at <= now) return at;
	}
	return undefined;
}

/** What a timer that woke at `now` does: run the newest due slot, or skip it because it is too late. */
export type SlotDecision = { slot: number; action: "run" | "skip"; next: number };

/**
 * After downtime only the newest due slot counts; older ones are never made up. That slot runs unless it is more than
 * {@link LATE_LIMIT_MS} late. Either way the routine moves on to the first slot after `now`.
 */
export function decideSlot(schedule: RoutineSchedule, dueAt: number, now: number, timezone: string): SlotDecision {
	const slot = Math.max(dueAt, latestSlotAtOrBefore(schedule, now, timezone) ?? dueAt);
	return {
		slot,
		action: now - slot > LATE_LIMIT_MS ? "skip" : "run",
		next: nextSlotAfter(schedule, Math.max(now, slot), timezone),
	};
}

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Days from names such as "mon", "weekdays", "weekends" or "daily", as sorted ISO weekdays. Throws with what to fix. */
export function parseDays(names: readonly string[]): number[] {
	const days = new Set<number>();
	for (const raw of names) {
		const name = raw.trim().toLowerCase();
		if (name === "daily" || name === "every day") for (const day of [1, 2, 3, 4, 5, 6, 7]) days.add(day);
		else if (name === "weekdays") for (const day of [1, 2, 3, 4, 5]) days.add(day);
		else if (name === "weekends") for (const day of [6, 7]) days.add(day);
		else {
			const index = DAY_NAMES.findIndex((day) => name.length >= 3 && name.startsWith(day));
			if (index < 0) throw new Error(`'${raw.slice(0, 20)}' is not a day. Use mon … sun, weekdays, weekends or daily.`);
			days.add(index + 1);
		}
	}
	if (days.size === 0) throw new Error("A weekly routine needs at least one day in days.");
	return [...days].sort((a, b) => a - b);
}

/** "daily at 07:30", "Mon, Wed at 08:00", "every 4 hours". */
export function describeSchedule(schedule: RoutineSchedule): string {
	if (schedule.kind === "hourly") {
		return schedule.everyHours === 1 ? "every hour" : `every ${schedule.everyHours} hours`;
	}
	if (schedule.kind === "daily") return `daily at ${schedule.time}`;
	const key = schedule.days.join("");
	const when =
		key === "1234567"
			? "daily"
			: key === "12345"
				? "weekdays"
				: key === "67"
					? "weekends"
					: schedule.days.map((day) => DAY_LABELS[day - 1]).join(", ");
	return `${when} at ${schedule.time}`;
}
