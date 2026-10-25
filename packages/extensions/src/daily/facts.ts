import type { DailySection } from "@assistant/shared";
import { addDays, atLocalTime } from "../time.ts";

/**
 * One local calendar day of the owner, as a facts provider needs it for its queries: the day is `[startMs, endMs)`, so a
 * day of 23 or 25 hours (a change of the clock) is still the whole day.
 */
export type DayWindow = {
	/** `2026-10-26`. */
	date: string;
	startMs: number;
	/** The first instant of the next day. */
	endMs: number;
	/** The Harness clock when the job runs. */
	now: number;
	timezone: string;
	/**
	 * Which job is asking, when a job is: a provider whose facts are "what came in since the last run" (the inbox digests)
	 * keeps its own window per job and day. Absent when something other than a job reads the facts.
	 */
	job?: string;
};

export function dayWindow(date: string, now: number, timezone: string): DayWindow {
	return {
		date,
		startMs: atLocalTime(date, "00:00", timezone),
		endMs: atLocalTime(addDays(date, 1), "00:00", timezone),
		now,
		timezone,
	};
}

/**
 * What one module can say about a day, for the two daily jobs (see `DomainModule.facts`). Both functions read the
 * database and nothing else: no model, no network, no clock but `day.now`. A module with nothing to say for a job leaves
 * it out, and a section with no lines is dropped, so "nothing today" is the sum of what the providers return.
 *
 * Later milestones add theirs (weight logged, expenses entered) without touching the jobs.
 */
export type DailyFactsProvider = {
	/** Names the provider in logs. */
	id: string;
	/** What is ahead today and what is still open: the morning briefing. */
	briefing?: (day: DayWindow) => readonly DailySection[];
	/** What the system knows happened today: the evening wrap-up. */
	wrapup?: (day: DayWindow) => readonly DailySection[];
	/** What came in since the last digest and wants the owner's attention: the inbox digests. */
	digest?: (day: DayWindow) => readonly DailySection[];
};

/** Most lines of one section. A day with sixty open tasks is not a briefing; the rest is one line that says how many. */
export const MAX_SECTION_LINES = 12;

/** `lines` cut to `max`, with a closing line that counts what was left out. */
export function capLines(lines: readonly string[], max = MAX_SECTION_LINES): string[] {
	if (lines.length <= max) return [...lines];
	return [...lines.slice(0, max), `… and ${lines.length - max} more`];
}

/** A section, or nothing when it has no lines. */
export function sectionOf(title: string, lines: readonly string[], max?: number): DailySection[] {
	return lines.length === 0 ? [] : [{ title, lines: capLines(lines, max) }];
}

export type CollectedFacts = {
	sections: DailySection[];
	/** Providers that threw: their facts are left out, and the others are still told. */
	failures: Array<{ provider: string; error: unknown }>;
};

/** The sections of every provider for one job, in provider order. */
export function collectFacts(
	providers: readonly DailyFactsProvider[],
	job: "briefing" | "wrapup" | "digest",
	day: DayWindow,
): CollectedFacts {
	const collected: CollectedFacts = { sections: [], failures: [] };
	for (const provider of providers) {
		const read = provider[job];
		if (read === undefined) continue;
		try {
			for (const section of read(day)) if (section.lines.length > 0) collected.sections.push(section);
		} catch (error) {
			collected.failures.push({ provider: provider.id, error });
		}
	}
	return collected;
}
