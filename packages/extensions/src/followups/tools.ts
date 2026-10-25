import type { FollowupCard, FollowupCardItem } from "@assistant/shared";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ApprovalAction } from "../approvals/service.ts";
import type { DomainDeps } from "../module.ts";
import { MAX_SCHEDULE_MINUTES, scheduleOf } from "../schedule.ts";
import { formatLocal, isoLocal, parseWhen } from "../time.ts";
import type { TimerScheduler } from "../timers.ts";
import { asDetails, MAX_RELATIVE_MINUTES, oneLine, resolveInstant, TIME_HELP, text } from "../tool-support.ts";
import { matchMeetings } from "./match.ts";
import * as store from "./store.ts";

type Deps = Pick<DomainDeps, "db" | "timezone" | "approvals" | "schedule">;

const MAX_LISTED = 50;
const DEFAULT_LISTED = 20;
/** How many candidates a "which meeting?" answer shows. */
const MAX_CANDIDATES = 8;
/** What a follow-up's title starts with when it came out of an outcome and the owner gave no better one. */
const FOLLOW_UP_PREFIX = "Follow up: ";

export function toCardItem(row: store.FollowupRow, agenda: readonly string[], timezone: string): FollowupCardItem {
	return {
		id: row.id,
		title: row.title,
		...(row.counterpart === "" ? {} : { counterpart: row.counterpart }),
		kind: row.kind,
		status: row.status,
		eventAt: row.eventAt,
		eventText: formatLocal(row.eventAt, timezone),
		...(row.outcome === undefined ? {} : { outcome: row.outcome }),
		agenda: [...agenda],
	};
}

/** One follow-up as the model reads it: ISO times it can pass straight back to the tools. */
export function describeFollowup(row: store.FollowupRow, agenda: readonly string[], timezone: string): string {
	const parts: string[] = [row.status];
	if (row.counterpart !== "") parts.push(`with ${row.counterpart}`);
	parts.push(`${row.kind === "meeting" ? "meeting" : "commitment"} at ${isoLocal(row.eventAt, timezone)}`);
	if (row.timeAssumed && row.status === "waiting") parts.push("time assumed: the owner gave only a date");
	if (row.endsAt !== undefined) parts.push(`ends ${isoLocal(row.endsAt, timezone)}`);
	if (row.status === "waiting") {
		const asked = `asked how it went at ${isoLocal(row.askAt, timezone)}`;
		parts.push(
			`agenda is sent ${isoLocal(row.eventAt - row.agendaLeadMinutes * 60_000, timezone)} if it has points`,
			row.kind === "commitment" ? `the owner is nudged when it is due, and ${asked}` : `the owner is ${asked}`,
		);
	}
	if (agenda.length > 0) parts.push(`agenda: ${agenda.map((point, index) => `${index + 1}. ${point}`).join(" ")}`);
	if (row.context !== "") parts.push(`context: ${row.context}`);
	if (row.outcome !== undefined) parts.push(`outcome: ${row.outcome}`);
	if (row.nextFollowupId !== undefined) parts.push(`next: ${row.nextFollowupId}`);
	if (row.parentId !== undefined) parts.push(`follows ${row.parentId}`);
	return `${row.id} “${row.title}” — ${parts.join("; ")}`;
}

const followupId = Type.String({
	minLength: 1,
	description: "The follow-up's id, as list_followups shows it (f_...).",
});

/**
 * The tools of the PA's meetings and follow-ups. Every tool that changes the tables is replay-safe because it is
 * idempotent by its call id (rule 8): `add_followup` through the row's `source_call_id`, `add_agenda_point` through the
 * point's, the others through the call ledger. A replay looks its call id up before it checks anything else: the checks
 * read the clock, and a call Durable replays after a crash runs later than the first run did.
 */
export function createFollowupTools(deps: Deps, scheduler: TimerScheduler): ToolRegistration[] {
	const { db, timezone, approvals } = deps;
	const schedule = scheduleOf(deps);
	const whenHelp = `${TIME_HELP} A date without a time ("2026-10-27") means ${schedule.followupDefaultTime} that day.`;
	const clockAt = (now: number) => ({ now, timezone, defaultTime: schedule.followupDefaultTime });
	const conversationOf = (api: ToolExecutionApi): number => Number(api.conversationId);

	const agendaOf = (row: store.FollowupRow): string[] => store.agendaOf(db, row.id).map((point) => point.text);
	const itemOf = (row: store.FollowupRow): FollowupCardItem => toCardItem(row, agendaOf(row), timezone);
	const card = (event: FollowupCard["event"], row: store.FollowupRow, next?: store.FollowupRow): JsonValue =>
		asDetails({
			type: "followup",
			event,
			followup: itemOf(row),
			...(next === undefined ? {} : { next: itemOf(next) }),
		});

	const addFollowup = defineTool({
		name: "add_followup",
		description:
			"Keep track of a meeting or a commitment that will need a follow-up, for example 'I emailed a firm about the house and " +
			"meet them on Friday at 10'. After it, the assistant asks the owner how it went and whether it needs a follow-up " +
			"(and once more the next morning if they do not answer); before it, it sends the agenda if the owner added points " +
			"(add_agenda_point). A commitment is something the owner has to do at that time ('call the bank on Monday'): the " +
			"assistant also nudges them when it is due. For a plain to-do or a reminder with nothing to follow up, use add_task. " +
			"Give event_at (an exact time) or event_in_minutes.",
		parameters: Type.Object({
			title: Type.String({
				minLength: 1,
				maxLength: 200,
				description: "What it is, in a few words: 'Meeting with Dabtonog Realty about the house'.",
			}),
			counterpart: Type.Optional(
				Type.String({ maxLength: 200, description: "Who or which firm it is with, if it is with someone." }),
			),
			context: Type.Optional(
				Type.String({
					maxLength: 2000,
					description: "Why it matters or what led to it: 'Emailed them on Monday asking about the plot price'.",
				}),
			),
			kind: Type.Optional(
				Type.Union([Type.Literal("meeting"), Type.Literal("commitment")], {
					description:
						"A meeting (or call) with someone: the owner attends. Or a commitment the owner has to carry out, such as 'call the bank': it is nudged at its time. Default meeting.",
				}),
			),
			event_at: Type.Optional(Type.String({ description: `When it starts. ${whenHelp}` })),
			event_in_minutes: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_RELATIVE_MINUTES,
					description: "It starts this many minutes from now.",
				}),
			),
			ends_at: Type.Optional(
				Type.String({
					description: `When it ends, if the owner said. The owner is asked how it went then; without it, ${schedule.followupAskDelayMinutes} minutes after it starts. ${TIME_HELP}`,
				}),
			),
			agenda_lead_minutes: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_SCHEDULE_MINUTES,
					description: `Send the agenda this many minutes before it starts. Default ${schedule.agendaLeadMinutes}.`,
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findByCallId(db, api.callId);
			if (earlier !== undefined) return await created(earlier.id);

			const title = oneLine(args.title);
			if (title === "") throw new Error("title must not be empty.");
			const now = api.now();
			const when = resolveInstant(
				{ at: args.event_at, inMinutes: args.event_in_minutes },
				{ at: "event_at", inMinutes: "event_in_minutes" },
				clockAt(now),
			);
			if (when === undefined)
				throw new Error("Give event_at (an exact time) or event_in_minutes: when does it happen?");
			const eventAt = when.ms;
			// The same meeting again is a model that retried after an error, not a second meeting.
			const same = store.findDuplicate(db, title, eventAt);
			if (same !== undefined) return await created(same.id, "Already saved, nothing added. ");
			const endsAt = args.ends_at === undefined ? undefined : resolveEnd(args.ends_at, eventAt);

			const { row } = store.insertFollowup(
				db,
				{
					title,
					counterpart: oneLine(args.counterpart ?? ""),
					context: args.context?.trim() ?? "",
					kind: args.kind ?? "meeting",
					eventAt,
					...(endsAt === undefined ? {} : { endsAt }),
					askAt: endsAt ?? eventAt + schedule.followupAskDelayMinutes * 60_000,
					agendaLeadMinutes: args.agenda_lead_minutes ?? schedule.agendaLeadMinutes,
					timeAssumed: when.assumedTime !== undefined,
					conversationId: conversationOf(api),
					createdAt: now,
				},
				api.callId,
			);
			return await created(row.id);
		},
	});

	function resolveEnd(value: string, eventAt: number): number {
		const parsed = parseWhen(value, timezone);
		if (!parsed.ok) throw new Error(`ends_at: ${parsed.error}`);
		if (parsed.dateOnly) throw new Error("ends_at needs a time of day, not only a date.");
		if (parsed.ms <= eventAt) {
			throw new Error(`ends_at ${isoLocal(parsed.ms, timezone)} is not after event_at ${isoLocal(eventAt, timezone)}.`);
		}
		return parsed.ms;
	}

	/** The result of `add_followup`; a replay lands here too, and starts the timer a crash may have kept from starting. */
	async function created(id: string, prefix = "") {
		await scheduler.ensureScheduled(id);
		const saved = store.requireFollowup(db, id);
		return {
			output: text(
				`${prefix}${prefix === "" ? "Saved " : ""}${describeFollowup(saved, agendaOf(saved), timezone)}${assumedNote(saved)}`,
			),
			details: card("created", saved),
		};
	}

	/** Tells the model that a time is ours, not the owner's, so that it says so and can change it. */
	function assumedNote(row: store.FollowupRow): string {
		return row.timeAssumed && row.status === "waiting"
			? ` Note: no time of day was given, so it is set for ${schedule.followupDefaultTime} (the default). Tell the owner, and use update_followup if they meant another time.`
			: "";
	}

	const addAgendaPoint = defineTool({
		name: "add_agenda_point",
		description:
			"Add a point to the agenda of an upcoming meeting. The owner adds points through the day; shortly before the meeting " +
			"the assistant posts the agenda. Name the meeting in the owner's words (meeting), or leave it out when only one " +
			"meeting is coming up. If more than one matches, this saves nothing and lists them: ask the owner which, then call again with followup_id.",
		parameters: Type.Object({
			text: Type.String({ minLength: 1, maxLength: 500, description: "The agenda point, in a few words." }),
			meeting: Type.Optional(
				Type.String({
					maxLength: 200,
					description:
						"Which meeting, in the owner's words: part of its title or who it is with ('Dabtonog', 'the house meeting').",
				}),
			),
			followup_id: Type.Optional(
				Type.String({
					description: "The exact id (f_...), when you know it, for example after the owner chose from a list.",
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findAgendaPointByCall(db, api.callId);
			if (earlier !== undefined) return added(store.requireFollowup(db, earlier.followupId), api.now());

			const point = args.text.trim();
			if (point === "") throw new Error("text must not be empty.");
			const now = api.now();
			const target =
				args.followup_id === undefined ? pickMeeting(args.meeting, now) : exactMeeting(args.followup_id, now);
			if ("answer" in target) return target.answer;

			store.addAgendaPoint(db, target.row.id, point, api.callId, now);
			return added(target.row, now);
		},
	});

	/** The meeting the owner named by id: it must still be to come. */
	function exactMeeting(id: string, now: number): { row: store.FollowupRow } {
		const row = store.requireFollowup(db, id);
		if (row.status !== "waiting" || row.eventAt <= now) {
			const state =
				row.status === "waiting"
					? "already under way"
					: row.status === "asked"
						? "over (the owner was asked how it went)"
						: "resolved";
			throw new Error(
				`${row.id} “${row.title}” is ${state}, so it has no agenda to add to. ` +
					"An agenda point is for a meeting that is still to come.",
			);
		}
		return { row };
	}

	/** The meeting the owner described: one match is the answer, anything else is a question for the owner. */
	function pickMeeting(
		meeting: string | undefined,
		now: number,
	): { row: store.FollowupRow } | { answer: Awaited<ReturnType<typeof ambiguous>> } {
		const upcoming = store.upcomingFollowups(db, now);
		const matches = meeting === undefined ? upcoming : matchMeetings(meeting, upcoming);
		const [only] = matches;
		if (only !== undefined && matches.length === 1) return { row: only };
		return { answer: ambiguous(meeting, matches, upcoming) };
	}

	/** Nothing is saved: the meeting is unknown or unclear, so the model is told what to ask. */
	function ambiguous(
		meeting: string | undefined,
		matches: readonly store.FollowupRow[],
		upcoming: readonly store.FollowupRow[],
	) {
		const shown = (matches.length > 0 ? matches : upcoming).slice(0, MAX_CANDIDATES);
		const lines = shown.map((row) => `- ${describeFollowup(row, agendaOf(row), timezone)}`).join("\n");
		const which = "Ask the owner which one, then call add_agenda_point again with its followup_id:";
		let output: string;
		if (upcoming.length === 0) {
			output = "Not saved: there is no upcoming meeting. Create one with add_followup first, then add the point.";
		} else if (matches.length === 0) {
			output = `Not saved: ‘${meeting}’ matches none of the upcoming meetings. Ask the owner which one they mean, or create it with add_followup. Upcoming:\n${lines}`;
		} else if (meeting === undefined) {
			output = `Not saved: no meeting was named, and ${matches.length} are coming up. ${which}\n${lines}`;
		} else {
			output = `Not saved: ‘${meeting}’ could be ${matches.length} meetings. ${which}\n${lines}`;
		}
		return {
			output: text(output),
			details: asDetails({
				type: "followup_list",
				heading: matches.length === 0 ? "No meeting matches" : "Which meeting?",
				followups: shown.map(itemOf),
				total: shown.length,
			}),
		};
	}

	/** The result of `add_agenda_point` for a saved point. Also after a replay. */
	function added(row: store.FollowupRow, now: number) {
		const saved = store.requireFollowup(db, row.id);
		const agenda = agendaOf(saved);
		// The agenda is posted once, at its time. A point that comes later is kept, and the owner should know it will not be posted.
		const dueAt = saved.eventAt - saved.agendaLeadMinutes * 60_000;
		const late =
			now >= dueAt
				? ` Note: the agenda for this meeting was due at ${isoLocal(dueAt, timezone)} and is not posted again, so this point only shows in list_followups. Tell the owner.`
				: "";
		return {
			output: text(`Added to the agenda. ${describeFollowup(saved, agenda, timezone)}${late}`),
			details: card("agenda_added", saved),
		};
	}

	const listFollowups = defineTool({
		name: "list_followups",
		deferred: true,
		description:
			"List the owner's meetings and follow-ups with their agenda points and outcomes. Shows the ones still open (waiting for their time, or asked about and waiting for an outcome) unless told otherwise.",
		parameters: Type.Object({
			status: Type.Optional(
				Type.Union(
					[
						Type.Literal("active"),
						Type.Literal("waiting"),
						Type.Literal("asked"),
						Type.Literal("resolved"),
						Type.Literal("all"),
					],
					{
						description:
							"active (default) is waiting and asked. waiting: the time has not come or the question is not asked yet. asked: waiting for the owner's outcome.",
					},
				),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_LISTED, description: `At most this many. Default ${DEFAULT_LISTED}.` }),
			),
		}),
		replay: "safe",
		async execute(args) {
			const status = args.status ?? "active";
			const { followups, total } = store.listFollowups(db, { status, limit: args.limit ?? DEFAULT_LISTED });
			const agenda = store.agendaOfMany(
				db,
				followups.map((row) => row.id),
			);
			const heading =
				status === "all" ? "All follow-ups" : status === "active" ? "Open follow-ups" : `Follow-ups: ${status}`;
			const lines = followups.map((row) => `- ${describeFollowup(row, agenda.get(row.id) ?? [], timezone)}`);
			const shown = followups.length < total ? ` (showing ${followups.length} of ${total})` : "";
			return {
				output: text(
					followups.length === 0 ? "No matching follow-ups." : `${heading}: ${total}${shown}\n${lines.join("\n")}`,
				),
				details: asDetails({
					type: "followup_list",
					heading,
					followups: followups.map((row) => toCardItem(row, agenda.get(row.id) ?? [], timezone)),
					total,
				}),
			};
		},
	});

	const recordOutcome = defineTool({
		name: "record_outcome",
		description:
			"Record how a meeting or commitment went, once the owner has told you, and say whether it needs a follow-up. " +
			"If it does, ask when if the owner has not said, and pass next_at (or next_in_minutes): the assistant then " +
			"asks about that follow-up in turn, and so on until something is resolved without one. Use it for the follow-ups " +
			"the assistant asked about and for any other open one.",
		parameters: Type.Object({
			followup_id: followupId,
			outcome: Type.String({
				minLength: 1,
				maxLength: 2000,
				description: "What happened or was agreed, in a sentence or two, in the owner's words.",
			}),
			needs_followup: Type.Boolean({
				description: "Whether something has to be followed up. When true, give next_at or next_in_minutes.",
			}),
			next_at: Type.Optional(Type.String({ description: `When the follow-up happens. ${whenHelp}` })),
			next_in_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RELATIVE_MINUTES })),
			next_step: Type.Optional(
				Type.String({
					maxLength: 200,
					description:
						"What the follow-up is: 'Call the firm to confirm the viewing'. Default: 'Follow up: ' and the original title. The assistant nudges the owner when it is due.",
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findChangedByCall(db, api.callId);
			if (earlier?.tool === "record_outcome") return await outcomeRecorded(earlier.followupId);

			const row = store.requireFollowup(db, args.followup_id);
			const outcome = args.outcome.trim();
			if (outcome === "") throw new Error("outcome must not be empty.");
			const now = api.now();
			const next = nextLink(row, args, outcome, now, conversationOf(api));

			const applied = store.recordOutcome(
				db,
				row.id,
				{ outcome, ...(next === undefined ? {} : { next }) },
				api.callId,
				now,
			);
			await scheduler.cancel(applied.replacedDurableTaskId);
			return await outcomeRecorded(row.id);
		},
	});

	/** The next link of the chain an outcome asks for, checked, or undefined when nothing has to be followed up. */
	function nextLink(
		row: store.FollowupRow,
		args: {
			needs_followup: boolean;
			next_at?: string | undefined;
			next_in_minutes?: number | undefined;
			next_step?: string | undefined;
		},
		outcome: string,
		now: number,
		conversationId: number,
	): store.NewFollowup | undefined {
		const timeGiven = args.next_at !== undefined || args.next_in_minutes !== undefined;
		if (!args.needs_followup) {
			if (timeGiven || args.next_step !== undefined) {
				throw new Error(
					"needs_followup is false, but a follow-up was described (next_at, next_in_minutes or next_step). Send needs_followup true to schedule it, or leave those out.",
				);
			}
			return undefined;
		}
		const when = resolveInstant(
			{ at: args.next_at, inMinutes: args.next_in_minutes },
			{ at: "next_at", inMinutes: "next_in_minutes" },
			clockAt(now),
		);
		if (when === undefined) {
			throw new Error(
				"needs_followup is true, so say when: ask the owner when the follow-up should happen, then call record_outcome again with next_at or next_in_minutes.",
			);
		}
		return {
			title: oneLine(args.next_step?.trim() || followUpTitle(row.title)).slice(0, 200),
			counterpart: row.counterpart,
			context: `Earlier outcome (${row.title}): ${outcome}`.slice(0, 2000),
			kind: "commitment",
			eventAt: when.ms,
			askAt: when.ms + schedule.followupAskDelayMinutes * 60_000,
			agendaLeadMinutes: row.agendaLeadMinutes,
			timeAssumed: when.assumedTime !== undefined,
			conversationId,
			createdAt: now,
		};
	}

	/** The title of a follow-up of `title`: "Follow up: " once, however long the chain gets. */
	function followUpTitle(title: string): string {
		return title.startsWith(FOLLOW_UP_PREFIX) ? title : `${FOLLOW_UP_PREFIX}${title}`;
	}

	/** The result of `record_outcome`; a replay lands here too, and starts the timer a crash may have kept from starting. */
	async function outcomeRecorded(id: string) {
		const saved = store.requireFollowup(db, id);
		const next = saved.nextFollowupId === undefined ? undefined : store.getFollowup(db, saved.nextFollowupId);
		if (next !== undefined) await scheduler.ensureScheduled(next.id);
		const scheduled = next === undefined ? undefined : store.requireFollowup(db, next.id);
		const followed =
			scheduled === undefined
				? "Nothing to follow up: it is resolved."
				: `Follow-up scheduled: ${describeFollowup(scheduled, [], timezone)}${assumedNote(scheduled)}`;
		return {
			output: text(`Outcome recorded for ${saved.id} “${saved.title}” and it is resolved. ${followed}`),
			details: card("outcome", saved, next === undefined ? undefined : store.requireFollowup(db, next.id)),
		};
	}

	const updateFollowup = defineTool({
		name: "update_followup",
		deferred: true,
		description:
			"Change a meeting or follow-up that is not resolved: its title, who it is with, or when it happens (it moved, or the " +
			"owner corrected the time). The agenda points stay. When the time changes, the assistant counts from the new time: the " +
			"agenda, the nudge for a commitment and the question 'how did it go?' (also when the owner had been asked already: they " +
			"are asked after the new time instead).",
		parameters: Type.Object({
			followup_id: followupId,
			title: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "The new title." })),
			counterpart: Type.Optional(
				Type.String({ maxLength: 200, description: "Who or which firm it is with. An empty string clears it." }),
			),
			event_at: Type.Optional(Type.String({ description: `The new start. ${whenHelp}` })),
			event_in_minutes: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_RELATIVE_MINUTES,
					description: "The new start, this many minutes from now.",
				}),
			),
			ends_at: Type.Optional(
				Type.String({
					description: `The new end. A meeting that has an end and moves keeps its length unless you give this. ${TIME_HELP}`,
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findChangedByCall(db, api.callId);
			if (earlier?.tool === "update_followup") return await updated(earlier.followupId);

			const row = store.requireFollowup(db, args.followup_id);
			const now = api.now();
			const title = args.title === undefined ? undefined : oneLine(args.title);
			if (title === "") throw new Error("title must not be empty.");
			const counterpart = args.counterpart === undefined ? undefined : oneLine(args.counterpart);
			const timing = newTiming(row, args, now);
			if (title === undefined && counterpart === undefined && timing === undefined) {
				throw new Error(
					"Nothing to change: give at least one of title, counterpart, event_at, event_in_minutes or ends_at.",
				);
			}
			const applied = store.updateFollowup(
				db,
				row.id,
				{
					...(title === undefined ? {} : { title }),
					...(counterpart === undefined ? {} : { counterpart }),
					...(timing === undefined ? {} : { timing }),
				},
				api.callId,
				now,
			);
			await scheduler.cancel(applied.replacedDurableTaskId);
			return await updated(row.id);
		},
	});

	/** The start, end and question time an `update_followup` call asks for, checked, or undefined when it does not touch the time. */
	function newTiming(
		row: store.FollowupRow,
		args: { event_at?: string | undefined; event_in_minutes?: number | undefined; ends_at?: string | undefined },
		now: number,
	): NonNullable<store.FollowupChange["timing"]> | undefined {
		const moved = resolveInstant(
			{ at: args.event_at, inMinutes: args.event_in_minutes },
			{ at: "event_at", inMinutes: "event_in_minutes" },
			clockAt(now),
		);
		if (moved === undefined && args.ends_at === undefined) return undefined;
		const eventAt = moved?.ms ?? row.eventAt;
		const endsAt =
			args.ends_at !== undefined
				? resolveEnd(args.ends_at, eventAt)
				: moved !== undefined && row.endsAt !== undefined
					? row.endsAt + (eventAt - row.eventAt) // a meeting that moves keeps its length
					: row.endsAt;
		return {
			eventAt,
			endsAt: endsAt ?? null,
			askAt: endsAt ?? eventAt + schedule.followupAskDelayMinutes * 60_000,
			assumed: moved === undefined ? row.timeAssumed : moved.assumedTime !== undefined,
		};
	}

	/** The result of `update_followup`; a replay lands here too, and starts the timer a crash may have kept from starting. */
	async function updated(id: string) {
		await scheduler.ensureScheduled(id);
		const saved = store.requireFollowup(db, id);
		return {
			output: text(`Updated ${describeFollowup(saved, agendaOf(saved), timezone)}${assumedNote(saved)}`),
			details: card("updated", saved),
		};
	}

	const resolveFollowup = defineTool({
		name: "resolve_followup",
		deferred: true,
		description:
			"Close a meeting or follow-up without an outcome: it was cancelled, or the owner says it needs nothing more. Its timers are cancelled. To record how it went, use record_outcome instead.",
		parameters: Type.Object({
			followup_id: followupId,
			note: Type.Optional(Type.String({ maxLength: 2000, description: "Why it was closed, if the owner said." })),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findChangedByCall(db, api.callId);
			if (earlier?.tool === "resolve_followup") return resolved(earlier.followupId);

			const row = store.requireFollowup(db, args.followup_id);
			const applied = store.resolveFollowup(db, row.id, args.note?.trim() || undefined, api.callId, api.now());
			await scheduler.cancel(applied.replacedDurableTaskId);
			return resolved(row.id);
		},
	});

	function resolved(id: string) {
		const saved = store.requireFollowup(db, id);
		return {
			output: text(`Resolved: ${describeFollowup(saved, agendaOf(saved), timezone)}`),
			details: card("resolved", saved),
		};
	}

	const proposeDelete = defineTool({
		name: "propose_delete_followup",
		deferred: true,
		description:
			"Ask the owner to approve deleting a meeting or follow-up, with its agenda, for good. Nothing is deleted until they tap " +
			"Approve or reply YES; never say it is deleted before they have. To close one that is over use resolve_followup instead.",
		parameters: Type.Object({ followup_id: followupId }),
		replay: "safe",
		async execute(args, api) {
			const row = store.requireFollowup(db, args.followup_id);
			const state = approvals.propose({
				conversationId: conversationOf(api),
				tool: "delete_followup",
				args: { followup_id: row.id },
				summary: `Delete follow-up “${row.title}”`,
				callId: api.callId,
			});
			const outcome =
				state.status === "pending"
					? "Nothing is deleted yet. Tell the owner to tap Approve on the card. Do not say it is deleted until they have answered; list_followups shows whether it went through."
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

	const deleteFollowup = defineTool({
		name: "delete_followup",
		deferred: true,
		description:
			"Permanently delete a meeting or follow-up and its agenda. This is blocked unless the owner has approved exactly this deletion: do not call it " +
			"yourself, use propose_delete_followup and wait for their answer. (The assistant normally carries out an approved deletion by itself.)",
		parameters: Type.Object({ followup_id: followupId }),
		replay: "safe",
		async execute(args, api) {
			const result = await approvals.runApproved(conversationOf(api), "delete_followup", {
				followup_id: args.followup_id,
			});
			return { output: text(result) };
		},
	});

	return [
		addFollowup,
		addAgendaPoint,
		recordOutcome,
		listFollowups,
		updateFollowup,
		resolveFollowup,
		proposeDelete,
		deleteFollowup,
	];
}

/** Deleting a follow-up is the one destructive thing the PA can do to its meetings (rule 3). */
export function createDeleteFollowupAction(deps: Pick<DomainDeps, "db">, scheduler: TimerScheduler): ApprovalAction {
	return {
		tool: "delete_followup",
		proposeTool: "propose_delete_followup",
		target: (args) => `followup:${String(args.followup_id)}`,
		run: async (args) => {
			const id = String(args.followup_id);
			const before = store.getFollowup(deps.db, id);
			const { deleted, durableTaskId } = store.deleteFollowup(deps.db, id);
			await scheduler.cancel(durableTaskId);
			return deleted && before !== undefined
				? `Deleted follow-up “${before.title}”.`
				: `Follow-up ${id} was already gone.`;
		},
	};
}
