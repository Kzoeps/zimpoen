import type { ToolCard } from "@assistant/shared";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { atLocalTime, formatLocalDate, isoLocal, parseWhen, weekdayName } from "./time.ts";

/** A tool result's text content: what the model reads. */
export const text = (value: string) => [{ type: "text" as const, text: value }];

/** `Mon 26 Oct 2026` for a local calendar day, `2026-10-26`: fixed wording, whatever the machine's locale. */
export const dayText = (date: string, timezone: string): string =>
	formatLocalDate(atLocalTime(date, "12:00", timezone), timezone);

/**
 * `current_time` for an agent whose prompt may not carry a clock: the date, time and weekday from the Harness clock, for
 * turning "last Friday" into a date. The tasks and health modules each define their own copy for the agents that have them.
 */
export const currentTimeTool = (timezone: string) =>
	defineTool({
		name: "current_time",
		description:
			"The current date, time and weekday in the owner's time zone. Call it before turning 'yesterday', 'last Friday' or 'this month' into a date.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			const now = api.now();
			return {
				output: text(`Now: ${isoLocal(now, timezone)} (${weekdayName(now, timezone)}), time zone ${timezone}.`),
			};
		},
	});

/** A card as the plain JSON a tool result's `details` must be (drops undefined fields, proves it serializes). */
export const asDetails = (card: ToolCard): JsonValue => JSON.parse(JSON.stringify(card)) as JsonValue;

/** How the tools ask the model for a time. */
export const TIME_HELP =
	"ISO 8601 in the owner's time zone, for example 2026-10-27T09:00 (add an offset like +06:00 to be exact). " +
	"Call current_time first when you must work out what 'tomorrow' or 'next Friday' means.";

/** The longest "in N minutes" a tool accepts: a year. */
export const MAX_RELATIVE_MINUTES = 525_600;

/** A name or title as one line of plain text: no line breaks, and none of the angle brackets that could close a prompt section. */
export const oneLine = (value: string): string => value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

/** A moment a tool call asked for, and the time of day that was filled in when the call gave only a date. */
export type ResolvedInstant = { ms: number; assumedTime?: string };

/**
 * The moment a tool call asks for, as UTC ms: an exact time (`at`, ISO 8601) or minutes from now (`inMinutes`), never
 * both. Undefined when neither is given. A date without a time of day ("2026-10-27") takes `clock.defaultTime` that day,
 * and `assumedTime` says so, for the tool to tell the model. It must be in the future: the error says what time it is
 * now, so the model can correct itself. Names are the tool's parameter names, so the message names what the model sent.
 */
export function resolveInstant(
	args: { at?: string | undefined; inMinutes?: number | undefined },
	names: { at: string; inMinutes: string },
	clock: { now: number; timezone: string; defaultTime: string },
): ResolvedInstant | undefined {
	if (args.at !== undefined && args.inMinutes !== undefined) {
		throw new Error(`Give either ${names.at} or ${names.inMinutes}, not both.`);
	}
	if (args.inMinutes !== undefined) return { ms: clock.now + args.inMinutes * 60_000 };
	if (args.at === undefined) return undefined;
	const parsed = parseWhen(args.at, clock.timezone);
	if (!parsed.ok) throw new Error(`${names.at}: ${parsed.error}`);
	// A date alone is 10 characters, whatever follows is an offset (`2026-10-27Z`).
	const ms = parsed.dateOnly ? atLocalTime(args.at.trim().slice(0, 10), clock.defaultTime, clock.timezone) : parsed.ms;
	if (ms <= clock.now) {
		throw new Error(
			`${names.at} ${isoLocal(ms, clock.timezone)} is in the past; it is ${isoLocal(clock.now, clock.timezone)} now. ` +
				`Pick a time after that, or use ${names.inMinutes}.`,
		);
	}
	return parsed.dateOnly ? { ms, assumedTime: clock.defaultTime } : { ms };
}
