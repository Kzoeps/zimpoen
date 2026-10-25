import { type DailyFactsProvider, sectionOf } from "../daily/facts.ts";
import type { DomainDeps } from "../module.ts";
import { formatLocalDate, isoLocal } from "../time.ts";
import * as store from "./store.ts";

type Deps = Pick<DomainDeps, "db" | "timezone">;

/**
 * What meetings and commitments can say for the daily jobs. The briefing: what is on today with its agenda points, and the
 * questions the owner was asked and never answered (the open loops: a question is asked twice at most, and then it is the
 * briefing's business). The wrap-up: what was resolved today and how it went.
 */
export function createFollowupFacts(deps: Deps): DailyFactsProvider {
	const { db, timezone } = deps;
	const clock = (ms: number): string => isoLocal(ms, timezone).slice(11, 16);

	return {
		id: "followups",
		briefing: (day) => {
			const today = store.openBetween(db, day.startMs, day.endMs);
			const agenda = store.agendaOfMany(
				db,
				today.map((row) => row.id),
			);
			const todayLines = today.map((row) => {
				const points = agenda.get(row.id)?.length ?? 0;
				const parts = [
					row.kind,
					...(points === 0 ? [] : [`${points} agenda point${points === 1 ? "" : "s"}`]),
					...(row.timeAssumed ? ["time assumed"] : []),
				];
				const who = row.counterpart === "" ? "" : ` with ${row.counterpart}`;
				return `${row.id} “${row.title}”${who} at ${clock(row.eventAt)} (${parts.join(", ")})`;
			});
			const shown = new Set(today.map((row) => row.id));
			const awaiting = store
				.askedUnanswered(db)
				.filter((row) => !shown.has(row.id))
				.map((row) => {
					const who = row.counterpart === "" ? "" : ` with ${row.counterpart}`;
					const asked = row.askedAt === undefined ? "" : `, asked ${formatLocalDate(row.askedAt, timezone)}`;
					return `${row.id} “${row.title}”${who} on ${formatLocalDate(row.eventAt, timezone)} — no outcome yet${asked}`;
				});
			return [
				...sectionOf("Meetings and follow-ups today", todayLines),
				...sectionOf("Waiting for an outcome", awaiting),
			];
		},
		wrapup: (day) => {
			const resolved = store.resolvedBetween(db, day.startMs, day.endMs).map((row) => {
				const who = row.counterpart === "" ? "" : ` with ${row.counterpart}`;
				return `${row.id} “${row.title}”${who} — ${row.outcome === undefined ? "closed without an outcome" : `outcome: ${row.outcome}`}`;
			});
			return sectionOf("Follow-ups resolved today", resolved);
		},
	};
}
