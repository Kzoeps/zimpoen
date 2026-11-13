import { getAgentRowByConversation } from "@assistant/db";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { TIME_OF_DAY } from "../daily/occurrence.ts";
import type { DomainDeps } from "../module.ts";
import { isScheduledRun, SCHEDULED_RUN_REFUSAL } from "../scheduled-run.ts";
import { formatLocal } from "../time.ts";
import type { TimerScheduler } from "../timers.ts";
import { oneLine, text } from "../tool-support.ts";
import {
	describeSchedule,
	MAX_EVERY_HOURS,
	MIN_EVERY_HOURS,
	nextSlotAfter,
	parseDays,
	type RoutineSchedule,
} from "./slots.ts";
import * as store from "./store.ts";

/** At most this many active routines in all. */
export const MAX_ACTIVE_ROUTINES = 20;
const MAX_TITLE_CHARS = 80;
const MAX_MESSAGE_CHARS = 4000;

type Deps = Pick<DomainDeps, "db" | "timezone" | "harness">;

/** One routine as the model reads it. */
export function describeRoutine(row: store.RoutineRow, timezone: string): string {
	const state = row.status === "cancelled" ? "cancelled" : `next ${formatLocal(row.dueAt, timezone)}`;
	const last = row.lastRunAt === undefined ? "" : `, last ran ${formatLocal(row.lastRunAt, timezone)}`;
	return `${row.id} “${row.title}”: ${describeSchedule(row.schedule)} (${timezone}), ${state}${last}, ${row.runs} run(s).\n  Message: ${row.message}`;
}

function readSchedule(
	args: { schedule: string; time?: string | undefined; days?: string[] | undefined; every_hours?: number | undefined },
	now: number,
): RoutineSchedule {
	if (args.schedule === "every_hours") {
		const hours = args.every_hours;
		if (hours === undefined || !Number.isInteger(hours) || hours < MIN_EVERY_HOURS || hours > MAX_EVERY_HOURS) {
			throw new Error(
				`every_hours must be a whole number from ${MIN_EVERY_HOURS} to ${MAX_EVERY_HOURS} for schedule every_hours.`,
			);
		}
		// The first run is one interval from now, not now.
		return { kind: "hourly", everyHours: hours, anchorAt: now };
	}
	const time = args.time?.trim();
	if (time === undefined || !TIME_OF_DAY.test(time)) {
		throw new Error(`time must be a 24-hour HH:MM such as 07:30 for schedule ${args.schedule}.`);
	}
	if (args.schedule === "daily") return { kind: "daily", time };
	return { kind: "weekly", time, days: parseDays(args.days ?? []) };
}

/** `create_routine`, `list_routines`, `cancel_routine`. Create and cancel refuse during a scheduled run (rule 13). */
export function createRoutineTools(deps: Deps, scheduler: () => TimerScheduler): ToolRegistration[] {
	const { db, timezone } = deps;

	const refusal = async (conversationId: number) =>
		(await isScheduledRun(deps.harness(), conversationId))
			? { output: text(SCHEDULED_RUN_REFUSAL), isError: true }
			: undefined;

	const createRoutine = defineTool({
		name: "create_routine",
		description:
			"Set up a recurring routine: on a schedule, the message is sent to you in this chat as a request, and you act on it " +
			"(for example 'every weekday at 08:00: check my open tasks and tell me the three most urgent'). Only when the owner " +
			`asks for something recurring. Times are in ${timezone}. At most ${MAX_ACTIVE_ROUTINES} active routines. ` +
			"A run that was more than 6 hours late (the server was off) is skipped.",
		parameters: Type.Object({
			title: Type.String({
				minLength: 1,
				maxLength: MAX_TITLE_CHARS,
				description: "Short name, e.g. 'Morning tasks check'.",
			}),
			message: Type.String({
				minLength: 1,
				maxLength: MAX_MESSAGE_CHARS,
				description: "What to do on each run, written as an instruction to yourself.",
			}),
			schedule: Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("every_hours")]),
			time: Type.Optional(Type.String({ description: "HH:MM (24 h) for daily and weekly." })),
			days: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: 7,
					description: "For weekly: mon … sun, or weekdays / weekends.",
				}),
			),
			every_hours: Type.Optional(Type.Integer({ minimum: MIN_EVERY_HOURS, maximum: MAX_EVERY_HOURS })),
		}),
		replay: "safe",
		async execute(args, api) {
			const conversationId = Number(api.conversationId);
			// Rule 8 first: a replay returns what the first call made, before any check that reads the clock.
			const earlier = store.findByCall(db, api.callId);
			if (earlier !== undefined) {
				await scheduler().ensureScheduled(earlier.id);
				return created(earlier);
			}
			const refused = await refusal(conversationId);
			if (refused !== undefined) return refused;
			const now = api.now();
			const title = oneLine(args.title).slice(0, MAX_TITLE_CHARS);
			const message = args.message.replace(/\r\n?/g, "\n").trim();
			if (title === "") throw new Error("title must not be empty.");
			if (message === "") throw new Error("message must not be empty: say what to do on each run.");
			const schedule = readSchedule(args, now);
			const result = store.insertRoutine(
				db,
				{
					conversationId,
					// The agent whose weekly token limit the runs count against; the PA when the conversation is not an agent's.
					agent: getAgentRowByConversation(db, conversationId)?.id ?? "pa",
					title,
					message,
					schedule,
					dueAt: nextSlotAfter(schedule, now, timezone),
				},
				api.callId,
				now,
				MAX_ACTIVE_ROUTINES,
			);
			if ("full" in result) {
				throw new Error(
					`There are already ${MAX_ACTIVE_ROUTINES} active routines, the limit. Cancel one with cancel_routine first.`,
				);
			}
			await scheduler().ensureScheduled(result.row.id);
			return created(result.row);
		},
	});

	function created(row: store.RoutineRow) {
		return { output: text(`Routine created.\n${describeRoutine(row, timezone)}`) };
	}

	const listRoutines = defineTool({
		name: "list_routines",
		description: "List the recurring routines: id, schedule, next run and message.",
		parameters: Type.Object({
			include_cancelled: Type.Optional(Type.Boolean({ description: "Also show cancelled ones. Default false." })),
		}),
		replay: "safe",
		async execute(args) {
			const rows = store.listRoutines(db, { includeCancelled: args.include_cancelled === true });
			return {
				output: text(
					rows.length === 0
						? "No routines."
						: `${rows.length} routine(s):\n${rows.map((row) => `- ${describeRoutine(row, timezone)}`).join("\n")}`,
				),
			};
		},
	});

	const cancelRoutine = defineTool({
		name: "cancel_routine",
		description: "Stop a recurring routine for good, by its id from list_routines. A run already started finishes.",
		parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 40 }) }),
		replay: "safe",
		async execute(args, api) {
			const id = args.id.trim();
			const known = store.getRoutine(db, id);
			if (known === undefined) throw new Error(`No routine '${id.slice(0, 40)}'. list_routines shows the ids.`);
			const replayed = db.get("SELECT 1 AS x FROM routines_call WHERE source_call_id = ?", api.callId) !== undefined;
			if (!replayed) {
				const refused = await refusal(Number(api.conversationId));
				if (refused !== undefined) return refused;
			}
			const result = store.cancelRoutine(db, id, api.callId, api.now());
			if (result === undefined) throw new Error(`No routine '${id}'.`);
			await scheduler().cancel(result.replacedDurableTaskId);
			return {
				output: text(
					result.cancelled || replayed
						? `Cancelled routine ${id} “${result.row.title}”.`
						: `Routine ${id} “${result.row.title}” was already cancelled.`,
				),
			};
		},
	});

	return [createRoutine, listRoutines, cancelRoutine];
}
