/**
 * The daily rituals of the PA: the morning briefing and the evening wrap-up, and the journal the wrap-up fills.
 *
 * Both start the same way: at the owner's local time a timer gathers facts from the database (no model involved) and
 * either puts them to the PA as a request or, when there is nothing to say, posts a short card. The facts travel as
 * sections of plain lines: the model reads them, and the thread shows them in a collapsible card.
 */

/** Entry kind of the briefing and wrap-up request (and of the "nothing today" card). Its `data` is a {@link DailyEntryData}. */
export const DAILY_ENTRY_KIND = "app.daily";

export const DAILY_JOB_IDS = ["briefing", "wrapup"] as const;

export type DailyJobId = (typeof DAILY_JOB_IDS)[number];

export function isDailyJobId(value: unknown): value is DailyJobId {
	return (DAILY_JOB_IDS as readonly unknown[]).includes(value);
}

/** One group of facts: "Tasks due today" and its lines. Lines are plain text and carry the ids the PA's tools take. */
export type DailySection = { title: string; lines: string[] };

export type DailyEntryData = {
	job: DailyJobId;
	/** The local day the facts are about: `2026-10-26`. */
	date: string;
	/** `Mon 26 Oct 2026`. */
	dateText: string;
	sections: DailySection[];
	/** Nothing to report: the card stands alone and the model was not asked anything (briefing only). */
	empty?: true;
	/** It ran well after its time because the server was down at that time. */
	late?: true;
	firedAt: number;
};

/** One day of the journal. */
export type JournalCardItem = {
	date: string;
	dateText: string;
	/** What the owner said they got done; absent while the wrap-up of that day waits for their answer. */
	userLog?: string;
	/** What the system recorded that day. */
	autoSummary?: string;
	carriedOver: string[];
};

/** The card of `save_journal` and `get_journal`. */
export type JournalCard = {
	type: "journal";
	event: "saved" | "shown";
	entries: JournalCardItem[];
};

/** One daily job as the settings page shows and changes it. */
export type ScheduleJobSettings = {
	job: DailyJobId;
	label: string;
	/** `HH:MM`, 24 hours, in `ScheduleSettingsResponse.timezone`. */
	localTime: string;
	enabled: boolean;
	defaultTime: string;
	/** The next run, when the job is on: epoch ms and the same moment for people. */
	nextRunAt?: number;
	nextRunText?: string;
	/** The latest day it ran for. */
	lastRunDate?: string;
};

export type ScheduleSettingsResponse = { timezone: string; jobs: ScheduleJobSettings[] };

/** At least one field. A new time or switching a job on or off applies at once. */
export type UpdateScheduleRequest = { localTime?: string; enabled?: boolean };
