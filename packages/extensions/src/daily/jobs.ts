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
	facts: "briefing" | "wrapup" | "digest";
	/** A day with nothing to say: post a card and spend no tokens (true), or ask the model anyway (false). */
	cardWhenEmpty: boolean;
	/** Generic on purpose: a push passes through Google's or Apple's servers. */
	push: PushPayload;
	/**
	 * Whether a run that has nothing to say (its card stands alone and the model is not asked) still pushes. Default true.
	 * False for the inbox digests: twice a day a push that means "nothing" teaches the owner to ignore the one that matters.
	 */
	pushWhenEmpty?: boolean;
	/** The conversation it posts into: the agent that writes the briefing, the wrap-up or the digest. */
	agent: "pa" | "inbox";
	/** The request the model reads when there is something to say. */
	request: {
		/**
		 * The first words of every request of this job. The hook that closes the YES window recognises a daily request by
		 * them, so they must not be words an owner would start a message with.
		 */
		head: string;
		/** The first line of a day's request: what is wanted and which day. `text` is the day for people, `date` is `2026-10-26`. */
		line: (text: string, date: string) => string;
	};
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

/** Where a tap on an inbox digest goes: the Inbox agent's thread. */
export const DIGEST_URL = "/chat/inbox";

/** One tag for both digests: the evening one replaces the midday one in the tray. Generic on purpose, like every push. */
export const DIGEST_PUSH: PushPayload = {
	title: "Inbox",
	body: "Your inbox digest",
	url: DIGEST_URL,
	tag: "digest",
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
	request: {
		head: "Morning briefing request for ",
		line: (text, date) =>
			`Morning briefing request for ${text} (${date}). Write the owner's briefing from these facts, as your instructions for the morning briefing say.`,
	},
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
	request: {
		head: "Evening wrap-up request for ",
		line: (text, date) =>
			`Evening wrap-up request for ${text} (${date}). Ask the owner what they got done today, as your instructions for the evening wrap-up say. When they answer, call save_journal with date ${date}.`,
	},
};

/**
 * The inbox digests (M5): what the Inbox agent found worth the owner's attention since the last one (important, needs a
 * reply, needs a follow-up), written by the Inbox agent. A digest with nothing in it is a card: it costs no tokens and sends no push. Still
 * worth making two hours late, never past the end of the day.
 */
const digestJob = (id: "digest_midday" | "digest_evening", label: string, defaultTime: string): DailyJob => ({
	id,
	label,
	defaultTime,
	lateMinutes: 120,
	facts: "digest",
	cardWhenEmpty: true,
	push: DIGEST_PUSH,
	pushWhenEmpty: false,
	agent: "inbox",
	request: {
		head: "Inbox digest request for ",
		line: (text, date) =>
			`Inbox digest request for ${text} (${date}). Write the owner's inbox digest from these mails, as your instructions for the inbox digest say.`,
	},
});

export const DIGEST_MIDDAY_JOB: DailyJob = digestJob("digest_midday", "Inbox digest (midday)", "12:30");
export const DIGEST_EVENING_JOB: DailyJob = digestJob("digest_evening", "Inbox digest (evening)", "19:00");

export const DAILY_JOBS: readonly DailyJob[] = [BRIEFING_JOB, WRAPUP_JOB, DIGEST_MIDDAY_JOB, DIGEST_EVENING_JOB];

export function jobOf(id: string): DailyJob | undefined {
	return DAILY_JOBS.find((job) => job.id === id);
}
