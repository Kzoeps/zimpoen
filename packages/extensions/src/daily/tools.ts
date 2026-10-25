import type { JournalCard, JournalCardItem } from "@assistant/shared";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { DomainDeps } from "../module.ts";
import { addDays, localDate, parseWhen } from "../time.ts";
import { asDetails, oneLine, text } from "../tool-support.ts";
import { dateText } from "./run.ts";
import * as store from "./store.ts";

type Deps = Pick<DomainDeps, "db" | "timezone">;

const MAX_LOG_CHARS = 4000;
const MAX_CARRIED = 20;
const MAX_CARRIED_CHARS = 200;
/** The longest span `get_journal` shows at once. */
const MAX_RANGE_DAYS = 31;
const DEFAULT_RANGE_DAYS = 7;

export function toJournalItem(row: store.JournalRow, timezone: string): JournalCardItem {
	return {
		date: row.date,
		dateText: dateText(row.date, timezone),
		...(row.userLog === undefined ? {} : { userLog: row.userLog }),
		...(row.autoSummary === "" ? {} : { autoSummary: row.autoSummary }),
		carriedOver: row.carriedOver,
	};
}

/** One journal day as the model reads it. */
export function describeJournal(row: store.JournalRow, timezone: string): string {
	const lines = [`${row.date} (${dateText(row.date, timezone)})`];
	lines.push(
		row.userLog === undefined
			? "The owner has not answered the wrap-up of this day yet."
			: `The owner said: ${row.userLog}`,
	);
	if (row.carriedOver.length > 0) lines.push(`Carried over: ${row.carriedOver.join("; ")}`);
	if (row.autoSummary !== "") lines.push(`What the assistant recorded:\n${row.autoSummary}`);
	return lines.join("\n");
}

/** A local day the model named, as `YYYY-MM-DD`, or what to fix. */
function readDay(value: string, name: string): string {
	const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? parseWhen(value.trim(), "UTC") : undefined;
	if (parsed === undefined || !parsed.ok) {
		throw new Error(
			`${name} must be a calendar day written YYYY-MM-DD, for example 2026-10-26; got '${value.slice(0, 40)}'.`,
		);
	}
	return value.trim();
}

/**
 * The tools of the journal. `save_journal` is replay-safe by the call ledger (rule 8): the same call id changes nothing
 * the second time. `get_journal` is deferred: it is rarely needed, and the PA's instructions name it.
 */
export function createJournalTools(deps: Deps & Pick<DomainDeps, "now">): ToolRegistration[] {
	const { db, timezone } = deps;
	const card = (event: JournalCard["event"], entries: JournalCardItem[]): JsonValue =>
		asDetails({ type: "journal", event, entries });

	const saveJournal = defineTool({
		name: "save_journal",
		description:
			"Save what the owner said they got done on a day, and what carries over to the next day. Call it when the owner " +
			"answers the evening wrap-up, with the date from the wrap-up request. Saving the same day again replaces the earlier " +
			"answer, so include everything the owner said about that day. Tomorrow's briefing brings the carried-over items forward.",
		parameters: Type.Object({
			date: Type.String({
				description: "The local day the answer is about, YYYY-MM-DD: the date in the wrap-up request.",
			}),
			user_log: Type.String({
				minLength: 1,
				maxLength: MAX_LOG_CHARS,
				description: "What the owner got done, in their words and a few sentences.",
			}),
			carried_over: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: MAX_CARRIED_CHARS }), {
					maxItems: MAX_CARRIED,
					description:
						"What was not finished and carries over to tomorrow, one short item each. Leave it out when nothing does.",
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			// Rule 8: a replay finds what its first run saved before it checks anything (the checks read the clock).
			const earlier = store.findSavedByCall(db, api.callId);
			if (earlier !== undefined) {
				const row = store.getJournal(db, earlier);
				if (row !== undefined) return saved(row, false);
			}
			const date = readDay(args.date, "date");
			const today = localDate(api.now(), timezone);
			if (date > today) {
				throw new Error(
					`date ${date} is in the future; today is ${today}. Use the date of the day the owner is talking about.`,
				);
			}
			const userLog = args.user_log.trim();
			if (userLog === "") throw new Error("user_log must not be empty. Write what the owner said they got done.");
			const carriedOver = (args.carried_over ?? []).map(oneLine).filter((item) => item !== "");
			const result = store.saveJournal(db, { date, userLog, carriedOver }, api.callId, api.now());
			return saved(result.row, result.replaced);
		},
	});

	function saved(row: store.JournalRow, replaced: boolean) {
		const carried =
			row.carriedOver.length === 0 ? "nothing carries over" : `carried over to tomorrow: ${row.carriedOver.join("; ")}`;
		return {
			output: text(
				`Saved the journal of ${row.date} (${dateText(row.date, timezone)}): ${carried}.${replaced ? " It replaced the owner's earlier answer for that day." : ""}`,
			),
			details: card("saved", [toJournalItem(row, timezone)]),
		};
	}

	const getJournal = defineTool({
		name: "get_journal",
		deferred: true,
		description:
			"Read the journal: what the owner said they got done on past days, what carried over, and what the assistant recorded. " +
			`Give date for one day, or from and to for a range of at most ${MAX_RANGE_DAYS} days. With nothing it shows the last ${DEFAULT_RANGE_DAYS} days.`,
		parameters: Type.Object({
			date: Type.Optional(Type.String({ description: "One local day, YYYY-MM-DD." })),
			from: Type.Optional(Type.String({ description: "First day of a range, YYYY-MM-DD." })),
			to: Type.Optional(Type.String({ description: "Last day of a range, YYYY-MM-DD. Default: today." })),
		}),
		replay: "safe",
		async execute(args, api) {
			const today = localDate(api.now(), timezone);
			if (args.date !== undefined && (args.from !== undefined || args.to !== undefined)) {
				throw new Error("Give either date or from/to, not both.");
			}
			const day = args.date === undefined ? undefined : readDay(args.date, "date");
			const from =
				day ?? (args.from === undefined ? addDays(today, 1 - DEFAULT_RANGE_DAYS) : readDay(args.from, "from"));
			const to = day ?? (args.to === undefined ? today : readDay(args.to, "to"));
			if (to < from) throw new Error(`to (${to}) is before from (${from}).`);
			if (addDays(from, MAX_RANGE_DAYS) <= to) {
				throw new Error(`The range ${from} to ${to} is longer than ${MAX_RANGE_DAYS} days. Ask for a shorter one.`);
			}
			const rows = store.journalBetween(db, from, to);
			const where = from === to ? from : `${from} to ${to}`;
			return {
				output: text(
					rows.length === 0
						? `No journal entries for ${where}.`
						: `Journal, ${where}: ${rows.length} day(s)\n\n${rows.map((row) => describeJournal(row, timezone)).join("\n\n")}`,
				),
				details: card(
					"shown",
					rows.map((row) => toJournalItem(row, timezone)),
				),
			};
		},
	});

	return [saveJournal, getJournal];
}
