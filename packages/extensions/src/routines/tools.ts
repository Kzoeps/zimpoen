import { getAgentRowByConversation } from "@assistant/db";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ActionArgs, ApprovalAction } from "../approvals/service.ts";
import { TIME_OF_DAY } from "../daily/occurrence.ts";
import type { DomainDeps } from "../module.ts";
import { isScheduledRun, SCHEDULED_RUN_REFUSAL } from "../scheduled-run.ts";
import { formatLocal } from "../time.ts";
import type { TimerScheduler } from "../timers.ts";
import { asDetails, oneLine, text } from "../tool-support.ts";
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

/**
 * A routine's message is an instruction the agent follows on every run, so it is a standing instruction: a run started by
 * untrusted text (mail, a web page, another agent's answer) must not be able to leave one behind. The model only
 * proposes; the owner approves (Approve or YES, as for `propose_daily_schedule`), and the server then creates it.
 */
const CREATE_TOOL = "create_routine";
const PROPOSE_TOOL = "propose_routine";

type Deps = Pick<DomainDeps, "db" | "timezone" | "harness" | "approvals">;

/** One routine as the model reads it. */
export function describeRoutine(row: store.RoutineRow, timezone: string): string {
	const state = row.status === "cancelled" ? "cancelled" : `next ${formatLocal(row.dueAt, timezone)}`;
	const last = row.lastRunAt === undefined ? "" : `, last ran ${formatLocal(row.lastRunAt, timezone)}`;
	return `${row.id} “${row.title}”: ${describeSchedule(row.schedule)} (${timezone}), ${state}${last}, ${row.runs} run(s).\n  Message: ${row.message}`;
}

/** What a proposal stores and the approved action receives: everything needed to create the routine, nothing more. */
type RoutineRequest = {
	conversation_id: number;
	/** The proposing call's id: it becomes the routine's `source_call_id`, so running the approved action twice creates one. */
	proposal: string;
	title: string;
	message: string;
	schedule: "daily" | "weekly" | "every_hours";
	time?: string;
	days?: number[];
	every_hours?: number;
};

function requestOf(args: ActionArgs): RoutineRequest {
	return {
		conversation_id: Number(args.conversation_id),
		proposal: String(args.proposal),
		title: String(args.title),
		message: String(args.message),
		schedule: args.schedule as RoutineRequest["schedule"],
		...(typeof args.time === "string" ? { time: args.time } : {}),
		...(Array.isArray(args.days) ? { days: args.days.map(Number) } : {}),
		...(typeof args.every_hours === "number" ? { every_hours: args.every_hours } : {}),
	};
}

/** The schedule a request asks for; "every N hours" counts from `now`, the moment the routine is created. */
function scheduleOf(request: RoutineRequest, now: number): RoutineSchedule {
	if (request.schedule === "every_hours") {
		return { kind: "hourly", everyHours: request.every_hours ?? MIN_EVERY_HOURS, anchorAt: now };
	}
	const time = request.time ?? "00:00";
	return request.schedule === "daily" ? { kind: "daily", time } : { kind: "weekly", time, days: request.days ?? [] };
}

/** Check what the model sent and turn it into a request. Throws with what to fix. */
function readRequest(
	args: {
		title: string;
		message: string;
		schedule: RoutineRequest["schedule"];
		time?: string | undefined;
		days?: string[] | undefined;
		every_hours?: number | undefined;
	},
	conversationId: number,
	callId: string,
): RoutineRequest {
	const title = oneLine(args.title).slice(0, MAX_TITLE_CHARS);
	const message = args.message.replace(/\r\n?/g, "\n").trim();
	if (title === "") throw new Error("title must not be empty.");
	if (message === "") throw new Error("message must not be empty: say what to do on each run.");
	const base = { conversation_id: conversationId, proposal: callId, title, message, schedule: args.schedule };
	if (args.schedule === "every_hours") {
		const hours = args.every_hours;
		if (hours === undefined || !Number.isInteger(hours) || hours < MIN_EVERY_HOURS || hours > MAX_EVERY_HOURS) {
			throw new Error(
				`every_hours must be a whole number from ${MIN_EVERY_HOURS} to ${MAX_EVERY_HOURS} for schedule every_hours.`,
			);
		}
		return { ...base, every_hours: hours };
	}
	const time = args.time?.trim();
	if (time === undefined || !TIME_OF_DAY.test(time)) {
		throw new Error(`time must be a 24-hour HH:MM such as 07:30 for schedule ${args.schedule}.`);
	}
	return args.schedule === "daily" ? { ...base, time } : { ...base, time, days: parseDays(args.days ?? []) };
}

const fullMessage = `There are already ${MAX_ACTIVE_ROUTINES} active routines, the limit. Cancel one with cancel_routine first.`;

/** The approved creation, run by the server. Safe to run twice: the proposal's call id finds the routine it made. */
export function createRoutineAction(
	deps: Pick<DomainDeps, "db" | "timezone" | "now">,
	scheduler: () => TimerScheduler,
): ApprovalAction {
	const { db, timezone } = deps;
	return {
		tool: CREATE_TOOL,
		proposeTool: PROPOSE_TOOL,
		target: (args) => `routine:new:${String(args.proposal)}`,
		run: async (args) => {
			const request = requestOf(args);
			const now = deps.now();
			const schedule = scheduleOf(request, now);
			const result = store.insertRoutine(
				db,
				{
					conversationId: request.conversation_id,
					// The agent whose weekly token limit the runs count against.
					agent: getAgentRowByConversation(db, request.conversation_id)?.id ?? "pa",
					title: request.title,
					message: request.message,
					schedule,
					dueAt: nextSlotAfter(schedule, now, timezone),
				},
				request.proposal,
				now,
				MAX_ACTIVE_ROUTINES,
			);
			if ("full" in result) throw new Error(fullMessage);
			await scheduler().ensureScheduled(result.row.id);
			return `Routine created: ${describeRoutine(result.row, timezone)}`;
		},
	};
}

/**
 * `propose_routine` (asks the owner), `create_routine` (guarded by the approval hook), `list_routines`,
 * `cancel_routine`. Proposing and cancelling refuse during a scheduled run (rule 13). List and cancel see only the
 * routines of the calling conversation, so one agent cannot touch another's.
 */
export function createRoutineTools(deps: Deps, scheduler: () => TimerScheduler): ToolRegistration[] {
	const { db, timezone } = deps;

	const refusal = async (conversationId: number) =>
		(await isScheduledRun(deps.harness(), conversationId))
			? { output: text(SCHEDULED_RUN_REFUSAL), isError: true }
			: undefined;

	const scheduleParams = {
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
		every_hours: Type.Optional(Type.Integer({ minimum: MIN_EVERY_HOURS, maximum: MAX_EVERY_HOURS })),
	};

	const propose = defineTool({
		name: PROPOSE_TOOL,
		description:
			"Ask the owner to approve a recurring routine: on a schedule, the message is sent to you in this chat as a request, " +
			"and you act on it (for example 'every weekday at 08:00: check my open tasks and tell me the three most urgent'). " +
			`Only when the owner asks for something recurring. Times are in ${timezone}. At most ${MAX_ACTIVE_ROUTINES} active ` +
			"routines. A run more than 6 hours late (the server was off) is skipped. Nothing is set up until the owner taps " +
			"Approve or replies YES; never say it is set up before they have.",
		parameters: Type.Object({
			...scheduleParams,
			days: Type.Optional(
				Type.Array(Type.String(), { maxItems: 7, description: "For weekly: mon … sun, or weekdays / weekends." }),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const conversationId = Number(api.conversationId);
			const refused = await refusal(conversationId);
			if (refused !== undefined) return refused;
			const request = readRequest(args, conversationId, api.callId);
			if (store.countActive(db) >= MAX_ACTIVE_ROUTINES) throw new Error(fullMessage);
			const preview = describeSchedule(scheduleOf(request, api.now()));
			const state = deps.approvals.propose({
				conversationId,
				tool: CREATE_TOOL,
				args: request as unknown as ActionArgs,
				summary: `Set up routine “${request.title}”, ${preview}: ${oneLine(request.message).slice(0, 200)}`,
				callId: api.callId,
			});
			const outcome =
				state.status === "pending"
					? "Nothing is set up yet. Tell the owner to tap Approve on the card or reply YES."
					: `That request is already ${state.status}.`;
			return {
				output: text(`Approval requested (${state.id}): ${state.summary}. ${outcome}`),
				details: asDetails({
					type: "approval",
					actionId: state.id,
					summary: state.summary,
					expiresAt: state.expiresAt,
				}),
			};
		},
	});

	const create = defineTool({
		name: CREATE_TOOL,
		deferred: true,
		description:
			`Create an approved routine. Blocked unless the owner approved exactly this request: use ${PROPOSE_TOOL} instead. ` +
			"(The assistant normally creates an approved routine by itself.)",
		parameters: Type.Object({
			...scheduleParams,
			conversation_id: Type.Integer(),
			proposal: Type.String(),
			days: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { maxItems: 7 })),
		}),
		replay: "safe",
		async execute(args, api) {
			return {
				output: text(await deps.approvals.runApproved(Number(api.conversationId), CREATE_TOOL, args as ActionArgs)),
			};
		},
	});

	const listRoutines = defineTool({
		name: "list_routines",
		description: "List the recurring routines of this chat: id, schedule, next run and message.",
		parameters: Type.Object({
			include_cancelled: Type.Optional(Type.Boolean({ description: "Also show cancelled ones. Default false." })),
		}),
		replay: "safe",
		async execute(args, api) {
			const rows = store.listRoutines(db, {
				conversationId: Number(api.conversationId),
				includeCancelled: args.include_cancelled === true,
			});
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
		description:
			"Stop a recurring routine of this chat for good, by its id from list_routines. A run already started finishes.",
		parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 40 }) }),
		replay: "safe",
		async execute(args, api) {
			const id = args.id.trim();
			const conversationId = Number(api.conversationId);
			const known = store.getRoutine(db, id);
			if (known === undefined || known.conversationId !== conversationId) {
				throw new Error(`No routine '${id.slice(0, 40)}' in this chat. list_routines shows the ids.`);
			}
			const replayed = db.get("SELECT 1 AS x FROM routines_call WHERE source_call_id = ?", api.callId) !== undefined;
			if (!replayed) {
				const refused = await refusal(conversationId);
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

	return [propose, create, listRoutines, cancelRoutine];
}
