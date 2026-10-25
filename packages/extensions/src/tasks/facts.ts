import { type DailyFactsProvider, sectionOf } from "../daily/facts.ts";
import type { DomainDeps } from "../module.ts";
import { formatLocal, formatLocalDate, isoLocal } from "../time.ts";
import * as store from "./store.ts";

type Deps = Pick<DomainDeps, "db" | "timezone">;

/**
 * What the task list can say for the daily jobs. The briefing: what is due or has a reminder today, and what is overdue.
 * The wrap-up: what was completed today and which reminders went off. Lines carry the task ids the PA's tools take.
 */
export function createTaskFacts(deps: Deps): DailyFactsProvider {
	const { db, timezone } = deps;
	const clock = (ms: number): string => isoLocal(ms, timezone).slice(11, 16);

	return {
		id: "tasks",
		briefing: (day) => {
			const today = store.openForDay(db, day.startMs, day.endMs).map((row) => {
				const parts: string[] = [];
				if (row.dueAt !== undefined && row.dueAt >= day.startMs && row.dueAt < day.endMs) {
					parts.push(row.dueAllDay ? "due today" : `due ${clock(row.dueAt)}`);
				}
				if (row.remindAt !== undefined && row.remindAt >= day.startMs && row.remindAt < day.endMs) {
					parts.push(`reminder ${clock(row.remindAt)}${row.remindedAt === undefined ? "" : " (already sent)"}`);
				}
				return `${row.id} “${row.title}” — ${parts.join("; ")}`;
			});
			const overdue = store.openOverdue(db, day.startMs).map((row) => {
				const when =
					row.dueAt === undefined
						? ""
						: row.dueAllDay
							? formatLocalDate(row.dueAt, timezone)
							: formatLocal(row.dueAt, timezone);
				return `${row.id} “${row.title}” — was due ${when}`;
			});
			return [...sectionOf("Tasks and reminders today", today), ...sectionOf("Overdue tasks", overdue)];
		},
		wrapup: (day) => {
			const done = store
				.doneBetween(db, day.startMs, day.endMs)
				.map(
					(row) => `${row.id} “${row.title}” — completed${row.doneAt === undefined ? "" : ` at ${clock(row.doneAt)}`}`,
				);
			const reminded = store
				.remindedBetween(db, day.startMs, day.endMs)
				.map(
					(row) =>
						`${row.id} “${row.title}” — reminder sent${row.remindedAt === undefined ? "" : ` at ${clock(row.remindedAt)}`}, task ${row.status}`,
				);
			return [...sectionOf("Tasks completed today", done), ...sectionOf("Reminders that went off today", reminded)];
		},
	};
}
