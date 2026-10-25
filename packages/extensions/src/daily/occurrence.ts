import { addDays, atLocalTime, endOfLocalDay, localDate } from "../time.ts";

/**
 * One run of a daily job: the local calendar day it is for, the instant that day's wall clock shows the job's time, and
 * the last instant at which it still runs. After that the day is skipped: a morning briefing at 14:00 is no briefing.
 */
export type Occurrence = { date: string; at: number; deadline: number };

/**
 * The run for the local day `date`. `time` is wall-clock time in the owner's zone, so it is 07:30 on both sides of a
 * change of the clock (a time the clock skips moves to the later instant, one it shows twice takes the first: see
 * `atLocalTime`). The deadline is `lateMinutes` after the time, never past the end of the day: the wrap-up of a day is
 * not asked after midnight.
 */
export function occurrenceOn(date: string, time: string, lateMinutes: number, timezone: string): Occurrence {
	const at = atLocalTime(date, time, timezone);
	return { date, at, deadline: Math.min(at + lateMinutes * 60_000, endOfLocalDay(date, timezone)) };
}

export type NextOccurrenceInput = {
	now: number;
	timezone: string;
	/** `HH:MM` in the owner's zone. */
	time: string;
	lateMinutes: number;
	/** The latest day the job ran for. A day runs at most once, so the next run is for a later day. */
	lastRunDate?: string | undefined;
};

/**
 * The run to wait for: the first local day after the last one that ran whose deadline has not passed. That is today
 * when the time is still to come, and also when it has passed but the deadline has not (the server was down at 07:30
 * and starts at 09:00: the briefing runs now, once, late); otherwise a later day. A day that was missed is not
 * made up. The days come from calendar arithmetic (`addDays`), never from adding 24 hours to an instant, so a
 * change of the clock cannot move a run to another day or to another time of day.
 */
export function nextOccurrence(input: NextOccurrenceInput): Occurrence {
	let date = localDate(input.now, input.timezone);
	// A year of days is far more than any real gap needs: the first or second candidate qualifies.
	for (let step = 0; step < 366; step++, date = addDays(date, 1)) {
		if (input.lastRunDate !== undefined && date <= input.lastRunDate) continue;
		const occurrence = occurrenceOn(date, input.time, input.lateMinutes, input.timezone);
		if (input.now <= occurrence.deadline) return occurrence;
	}
	throw new Error(`No run of a daily job at ${input.time} found within a year of now. This should be impossible.`);
}

/** `HH:MM`, 24 hours. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
