import { DAILY_ENTRY_KIND, type DailyEntryData, type DailySection } from "@assistant/shared";
import type { JsonValue } from "@earendil-works/chord";
import type { DomainDeps } from "../module.ts";
import { atLocalTime, formatLocalDate } from "../time.ts";
import { collectFacts, type DailyFactsProvider, dayWindow } from "./facts.ts";
import type { DailyJob } from "./jobs.ts";
import * as store from "./store.ts";

/**
 * What one run of a job says, fixed when it first runs: the facts of the day. The task keeps it as a durable memo, so a
 * run that a crash cut short repeats exactly what the first attempt decided, even if a task was added in between (the
 * first attempt may have posted the "nothing today" card, and a repeat must not also ask the model).
 */
export type DailyPlan = {
	sections: DailySection[];
	/** No provider had anything to say. */
	empty: boolean;
	/** It ran well after its time, because the server was down then. */
	late: boolean;
};

/** A run later than this after its time says so on its card. */
export const LATE_AFTER_MS = 5 * 60_000;

/** `Mon 26 Oct 2026` for a local day. */
export const dateText = (date: string, timezone: string): string =>
	formatLocalDate(atLocalTime(date, "12:00", timezone), timezone);

/** Gather the facts of `date` from every provider. A provider that fails is left out and reported. */
export function buildPlan(
	job: DailyJob,
	date: string,
	clock: { now: number; dueAt: number; timezone: string },
	providers: readonly DailyFactsProvider[],
	onFailure: (provider: string, error: unknown) => void,
): DailyPlan {
	const day = dayWindow(date, clock.now, clock.timezone);
	const { sections, failures } = collectFacts(providers, job.facts, day);
	for (const failure of failures) onFailure(failure.provider, failure.error);
	return { sections, empty: sections.length === 0, late: clock.now - clock.dueAt > LATE_AFTER_MS };
}

/** The facts as plain text, for the model and for the journal's `auto_summary`. */
export function renderSections(sections: readonly DailySection[]): string {
	return sections
		.map((section) => `## ${section.title}\n${section.lines.map((line) => `- ${line}`).join("\n")}`)
		.join("\n\n");
}

/** The first words of each job's request. The hook that closes the YES window (see `daily/index.ts`) recognises a daily request by them. */
export const REQUEST_HEADS = {
	briefing: "Morning briefing request for ",
	wrapup: "Evening wrap-up request for ",
} as const;

/** Whether the last message of a request to the model is a daily request: the first round of the run that a briefing or wrap-up starts. */
export function endsWithDailyRequest(messages: readonly { role: string; content: unknown }[]): boolean {
	const last = messages.at(-1);
	if (last?.role !== "user") return false;
	const text =
		typeof last.content === "string"
			? last.content
			: Array.isArray(last.content)
				? last.content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : "")).join("")
				: "";
	return Object.values(REQUEST_HEADS).some((head) => text.startsWith(head));
}

/**
 * What the model reads: one line saying what is wanted and which day, then the facts. How to write a briefing and how
 * to run a wrap-up is in the PA's instructions, which are cached, so a day's request stays the size of its facts.
 */
export function renderRequest(job: DailyJob, date: string, text: string, sections: readonly DailySection[]): string {
	const head =
		job.id === "briefing"
			? `${REQUEST_HEADS.briefing}${text} (${date}). Write the owner's briefing from these facts, as your instructions for the morning briefing say.`
			: `${REQUEST_HEADS.wrapup}${text} (${date}). Ask the owner what they got done today, as your instructions for the evening wrap-up say. When they answer, call save_journal with date ${date}.`;
	const facts =
		sections.length > 0
			? renderSections(sections)
			: "## Recorded today\n- The assistant recorded nothing today (no task done, no follow-up resolved).";
	return `${head}\n\n${facts}`;
}

/** The request of a run as the thread's card shows it. */
export function entryData(
	job: DailyJob,
	date: string,
	plan: DailyPlan,
	deps: Pick<DomainDeps, "timezone">,
	firedAt: number,
): DailyEntryData {
	return {
		job: job.id,
		date,
		dateText: dateText(date, deps.timezone),
		sections: plan.sections,
		// `empty` says the card stands alone (the model was not asked), which a wrap-up never does.
		...(plan.empty && job.cardWhenEmpty ? { empty: true as const } : {}),
		...(plan.late ? { late: true as const } : {}),
		firedAt,
	};
}

type DeliverDeps = Pick<DomainDeps, "db" | "timezone" | "post" | "ask">;

/**
 * Put a run's plan into the conversation: the model is asked (the request is placed as a card of its own kind, which
 * the model reads as a user message), or, when the job has nothing to say and may stay silent, a display-only card is
 * written and no model is called. Both use a request id made of the job and the day, so doing it twice does it once:
 * this is what makes a rerun after a crash, and the recovery after a power cut, safe.
 *
 * `firedAt` is the moment the run was due, not the moment of a rerun, so that a rerun makes the same card data.
 */
export async function deliver(
	deps: DeliverDeps,
	job: DailyJob,
	plan: DailyPlan,
	target: { conversationId: number; date: string; firedAt: number },
): Promise<{ asked: boolean }> {
	const { db, timezone } = deps;
	const data = entryData(job, target.date, plan, deps, target.firedAt);
	if (plan.empty && job.cardWhenEmpty) {
		await deps.post(target.conversationId, {
			kind: DAILY_ENTRY_KIND,
			data: data as unknown as JsonValue,
			requestId: `${job.id}:${target.date}:empty`,
		});
		return { asked: false };
	}
	const content = renderRequest(job, target.date, dateText(target.date, timezone), plan.sections);
	// The wrap-up's journal day exists before the question does, so that the answer has a day to belong to.
	if (job.id === "wrapup") store.recordWrapupAsked(db, target.date, renderSections(plan.sections), target.firedAt);
	await deps.ask(target.conversationId, {
		content,
		requestId: `${job.id}:${target.date}`,
		entry: { kind: DAILY_ENTRY_KIND, data: data as unknown as JsonValue },
	});
	return { asked: true };
}
