import type { ScheduleJobSettings } from "@assistant/shared";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ActionArgs, ApprovalAction } from "../approvals/service.ts";
import type { DomainDeps } from "../module.ts";
import { asDetails, text } from "../tool-support.ts";
import { DAILY_JOBS, jobOf } from "./jobs.ts";
import { TIME_OF_DAY } from "./occurrence.ts";
import type { DailyService } from "./service.ts";

/**
 * Changing when a daily job runs, from chat. The owner's own Settings page changes it directly; the PA only proposes, and
 * the change is made when the owner approves (the same flow as a deletion), because a wrong time silently moves or stops
 * the briefing, wrap-up or digests.
 */
const SET_TOOL = "set_daily_schedule";
const PROPOSE_TOOL = "propose_daily_schedule";

const jobIds = DAILY_JOBS.map((job) => job.id);
const JOB_HELP = DAILY_JOBS.map((job) => `${job.id} (${job.label}, default ${job.defaultTime})`).join(", ");

const scheduleParams = Type.Object({
	job: Type.Union(
		jobIds.map((id) => Type.Literal(id)),
		{ description: `Which daily job: ${JOB_HELP}.` },
	),
	local_time: Type.Optional(
		Type.String({ description: "The new time, 24-hour HH:MM in the owner's time zone, for example 10:30." }),
	),
	enabled: Type.Optional(Type.Boolean({ description: "false switches the job off, true switches it back on." })),
});

/** The change as the approval stores it: only the fields given, so a proposal and its run agree on the exact arguments. */
type ScheduleChange = { job: string; local_time?: string; enabled?: boolean };

function changeOf(args: ActionArgs): ScheduleChange {
	return {
		job: String(args.job),
		...(typeof args.local_time === "string" ? { local_time: args.local_time } : {}),
		...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
	};
}

/** One job's current setting, in words. */
export function describeSchedule(view: ScheduleJobSettings): string {
	return view.enabled
		? `${view.label} runs at ${view.localTime} (next: ${view.nextRunText ?? "not scheduled"})`
		: `${view.label} is off (its time is ${view.localTime})`;
}

/** What approving would do, for the card; undefined when nothing would change. */
function summaryOf(current: ScheduleJobSettings, change: ScheduleChange): string | undefined {
	const time = change.local_time ?? current.localTime;
	const enabled = change.enabled ?? current.enabled;
	if (time === current.localTime && enabled === current.enabled) return undefined;
	if (!enabled) return `Turn off the ${current.label}`;
	if (!current.enabled) return `Turn on the ${current.label} at ${time}`;
	return `Move the ${current.label} from ${current.localTime} to ${time}`;
}

export function createScheduleTools(
	deps: Pick<DomainDeps, "approvals">,
	service: () => DailyService,
): ToolRegistration[] {
	const conversationOf = (api: ToolExecutionApi): number => Number(api.conversationId);

	const propose = defineTool({
		name: PROPOSE_TOOL,
		description:
			"Ask the owner to approve changing when a daily job runs: the morning briefing, the evening wrap-up or one of the two " +
			"inbox digests. Give a new local_time, or enabled false to switch it off (true to switch it back on). Nothing changes " +
			"until they tap Approve or reply YES; never say it is changed before they have. The result says the current setting.",
		parameters: scheduleParams,
		replay: "safe",
		async execute(args, api) {
			const current = service()
				.list()
				.find((view) => view.job === args.job);
			if (jobOf(args.job) === undefined || current === undefined) {
				throw new Error(`There is no daily job '${args.job}'. The jobs are ${JOB_HELP}.`);
			}
			if (args.local_time === undefined && args.enabled === undefined) {
				throw new Error("Give local_time, enabled or both: there is nothing to change.");
			}
			if (args.local_time !== undefined && !TIME_OF_DAY.test(args.local_time)) {
				throw new Error(
					`'${args.local_time.slice(0, 20)}' is not a time of day. Use 24-hour HH:MM, for example 10:30.`,
				);
			}
			const change = changeOf(args);
			const summary = summaryOf(current, change);
			if (summary === undefined) {
				return { output: text(`Nothing to change: the ${describeSchedule(current)}.`) };
			}
			const state = deps.approvals.propose({
				conversationId: conversationOf(api),
				tool: SET_TOOL,
				args: change,
				summary,
				callId: api.callId,
			});
			const outcome =
				state.status === "pending"
					? "Nothing is changed yet. Tell the owner to tap Approve on the card; do not say it is changed until they have."
					: `That request is already ${state.status}.`;
			return {
				output: text(
					`Approval requested (${state.id}): ${state.summary}. Now the ${describeSchedule(current)}. ${outcome}`,
				),
				details: asDetails({
					type: "approval",
					actionId: state.id,
					summary: state.summary,
					expiresAt: state.expiresAt,
				}),
			};
		},
	});

	const set = defineTool({
		name: SET_TOOL,
		deferred: true,
		description:
			"Change when a daily job runs. This is blocked unless the owner has approved exactly this change: do not call it " +
			`yourself, use ${PROPOSE_TOOL} and wait for their answer. (The assistant normally carries out an approved change by itself.)`,
		parameters: scheduleParams,
		replay: "safe",
		async execute(args, api) {
			return { output: text(await deps.approvals.runApproved(conversationOf(api), SET_TOOL, changeOf(args))) };
		},
	});

	return [propose, set];
}

/** The approved change, carried out by the server. Safe to run twice: the second run finds the job already set. */
export function createScheduleAction(service: () => DailyService): ApprovalAction {
	return {
		tool: SET_TOOL,
		proposeTool: PROPOSE_TOOL,
		target: (args) => `schedule:${String(args.job)}`,
		run: async (args) => {
			const change = changeOf(args);
			const view = await service().update(change.job, {
				...(change.local_time === undefined ? {} : { localTime: change.local_time }),
				...(change.enabled === undefined ? {} : { enabled: change.enabled }),
			});
			return `Done: the ${describeSchedule(view)}.`;
		},
	};
}
