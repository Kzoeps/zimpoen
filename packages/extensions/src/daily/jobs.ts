import type { DailyJobId, PushPayload } from "@assistant/shared";

/**
 * A daily ritual. The engine (`task.ts`) decides when it runs and how often; a job only says what it is: its default
 * time, how late it may still run, which facts it gathers and how it reaches the owner. Adding one (a weekly weigh-in
 * is a daily job that skips most days) means adding an entry here and the facts providers that feed it.
 */
export type DailyJob = {
	id: DailyJobId;
	/** What the settings page and the card call it. */
	label: string;
	/** `HH:MM` in the owner's zone until the owner changes it. */
	defaultTime: string;
	/**
	 * How long after its time a run is still worth making. A server that was down at 07:30 and starts at 10:50 runs the
	 * briefing late, once; one that starts at 11:10 skips the day. Never past the end of the day.
	 */
	lateMinutes: number;
	/** Which facts the providers are asked for. */
	facts: "briefing" | "wrapup";
	/** A day with nothing to say: post a card and spend no tokens (true), or ask the model anyway (false). */
	cardWhenEmpty: boolean;
	/** Generic on purpose: a push passes through Google's or Apple's servers. */
	push: PushPayload;
	/** The conversation it posts into. */
	agent: "pa";
};

/** Where a tap on these notifications goes: the PA's thread. */
export const DAILY_URL = "/chat/pa";

export const BRIEFING_PUSH: PushPayload = {
	title: "Briefing",
	body: "Your morning briefing",
	url: DAILY_URL,
	tag: "briefing",
};

export const WRAPUP_PUSH: PushPayload = {
	title: "Wrap-up",
	body: "Time for your evening wrap-up",
	url: DAILY_URL,
	tag: "wrapup",
};

/** The morning briefing: 07:30, still worth making until 11:00. */
export const BRIEFING_JOB: DailyJob = {
	id: "briefing",
	label: "Morning briefing",
	defaultTime: "07:30",
	lateMinutes: 210,
	facts: "briefing",
	cardWhenEmpty: true,
	push: BRIEFING_PUSH,
	agent: "pa",
};

/**
 * The evening wrap-up: 21:00, still worth asking until midnight. It always asks: even a day the system knows nothing
 * about is a day the owner may have something to say about.
 */
export const WRAPUP_JOB: DailyJob = {
	id: "wrapup",
	label: "Evening wrap-up",
	defaultTime: "21:00",
	lateMinutes: 180,
	facts: "wrapup",
	cardWhenEmpty: false,
	push: WRAPUP_PUSH,
	agent: "pa",
};

export const DAILY_JOBS: readonly DailyJob[] = [BRIEFING_JOB, WRAPUP_JOB];

export function jobOf(id: string): DailyJob | undefined {
	return DAILY_JOBS.find((job) => job.id === id);
}
