import type { PersonCard, PersonCardItem } from "@assistant/shared";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ApprovalAction } from "../approvals/service.ts";
import type { DomainDeps } from "../module.ts";
import { scheduleOf } from "../schedule.ts";
import { addDays, localDate } from "../time.ts";
import type { TimerScheduler } from "../timers.ts";
import { asDetails, oneLine, text } from "../tool-support.ts";
import {
	birthdayLabel,
	dayText,
	lastOccurrenceYear,
	nextCycle,
	nextOccurrence,
	occurrenceDate,
	parseBirthday,
	startCycle,
	turnsIn,
} from "./birthdays.ts";
import * as store from "./store.ts";

type Deps = Pick<DomainDeps, "db" | "timezone" | "approvals" | "schedule">;

const MAX_LISTED = 100;
const DEFAULT_LISTED = 50;
const MAX_UPCOMING_DAYS = 366;

/** A person as the cards show them: the next birthday is the first one on or after the owner's `today`. */
export function toCardItem(row: store.PersonRow, today: string, timezone: string): PersonCardItem {
	const next = nextOccurrence(row.birthdayMd, today);
	const turns = turnsIn(row.birthdayYear, next.year);
	return {
		id: row.id,
		name: row.name,
		...(row.relation === "" ? {} : { relation: row.relation }),
		birthdayText: birthdayLabel(row.birthdayMd, row.birthdayYear),
		nextText: dayText(next.date, timezone),
		...(turns === undefined ? {} : { turns }),
		...(row.notes === "" ? {} : { notes: row.notes }),
	};
}

/** One person as the model reads it. */
export function describePerson(row: store.PersonRow, today: string, timezone: string): string {
	const item = toCardItem(row, today, timezone);
	const parts = [
		`birthday ${item.birthdayText}`,
		`next ${item.nextText}${item.turns === undefined ? "" : ` (turns ${item.turns})`}`,
	];
	if (row.notes !== "") parts.push(`notes: ${row.notes}`);
	return `${row.id} ${row.name}${row.relation === "" ? "" : ` (${row.relation})`} — ${parts.join("; ")}`;
}

const personId = Type.String({ minLength: 1, description: "The person's id, as list_people shows it (p_...)." });

const BIRTHDAY_HELP =
	"MM-DD (03-05) when the birth year is not known, or YYYY-MM-DD (1990-03-05) when it is. 29 February is allowed; " +
	"in a year without one the reminder falls on 28 February.";

/**
 * The tools of the PA's address book of birthdays. Every tool that changes the tables is replay-safe because it is
 * idempotent by its call id (rule 8): `add_person` through the row's `source_call_id`, the others through the call
 * ledger, looked up before anything that reads the clock is checked.
 */
export function createPeopleTools(deps: Deps, scheduler: TimerScheduler): ToolRegistration[] {
	const { db, timezone, approvals } = deps;
	const settings = scheduleOf(deps);
	const times = { remind: settings.birthdayRemindTime, check: settings.birthdayCheckTime };
	const conversationOf = (api: ToolExecutionApi): number => Number(api.conversationId);
	const todayAt = (now: number): string => localDate(now, timezone);
	const yearAt = (now: number): number => Number(todayAt(now).slice(0, 4));

	const card = (
		event: PersonCard["event"],
		row: store.PersonRow,
		now: number,
		extra: Partial<PersonCard> = {},
	): JsonValue => asDetails({ type: "person", event, person: toCardItem(row, todayAt(now), timezone), ...extra });

	const addPerson = defineTool({
		name: "add_person",
		description:
			"Save a friend's or family member's birthday. On the day the assistant reminds the owner in the morning to wish them " +
			"well, and in the evening asks whether they did (record_wish).",
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: 100, description: "Their name, as the owner says it." }),
			relation: Type.Optional(
				Type.String({ maxLength: 60, description: "How the owner knows them: friend, sister, colleague." }),
			),
			birthday: Type.String({ description: BIRTHDAY_HELP }),
			notes: Type.Optional(Type.String({ maxLength: 1000, description: "Anything worth remembering about them." })),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findByCallId(db, api.callId);
			if (earlier !== undefined) return await saved("created", earlier, api.now());

			const name = oneLine(args.name);
			if (name === "") throw new Error("name must not be empty.");
			const now = api.now();
			const birthday = parseBirthday(args.birthday, yearAt(now));
			if (!birthday.ok) throw new Error(`birthday: ${birthday.error}`);
			const same = store.findDuplicate(db, name, birthday.md);
			if (same !== undefined) return await saved("created", same, now, `Already saved, nothing added. `);

			const { row } = store.insertPerson(
				db,
				{
					name,
					relation: oneLine(args.relation ?? ""),
					birthdayMd: birthday.md,
					...(birthday.year === undefined ? {} : { birthdayYear: birthday.year }),
					notes: args.notes?.trim() ?? "",
					cycle: startCycle(nextCycle(birthday.md, now, timezone, times), now),
					conversationId: conversationOf(api),
					createdAt: now,
				},
				api.callId,
			);
			return await saved("created", row, now);
		},
	});

	/** The result of `add_person` and `update_person`; a replay lands here too, and starts the timer a crash may have kept from starting. */
	async function saved(event: "created" | "updated", row: store.PersonRow, now: number, prefix = "") {
		await scheduler.ensureScheduled(row.id);
		const fresh = store.requirePerson(db, row.id);
		const verb = event === "created" ? "Saved" : "Updated";
		return {
			output: text(`${prefix}${prefix === "" ? `${verb} ` : ""}${describePerson(fresh, todayAt(now), timezone)}`),
			details: card(event, fresh, now),
		};
	}

	const updatePerson = defineTool({
		name: "update_person",
		deferred: true,
		description:
			"Change a saved person's name, relation, birthday or notes. A new birthday starts the yearly reminders over. " +
			"A birthday without a year keeps the birth year that is saved.",
		parameters: Type.Object({
			person_id: personId,
			name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
			relation: Type.Optional(
				Type.String({ maxLength: 60, description: "Replaces the relation. An empty string clears it." }),
			),
			birthday: Type.Optional(Type.String({ description: BIRTHDAY_HELP })),
			notes: Type.Optional(
				Type.String({ maxLength: 1000, description: "Replaces the notes. An empty string clears them." }),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findChangedByCall(db, api.callId);
			if (earlier?.tool === "update_person")
				return await saved("updated", store.requirePerson(db, earlier.personId), api.now());

			const row = store.requirePerson(db, args.person_id);
			const now = api.now();
			const change = changeFrom(row, args, now);
			const applied = store.applyChange(db, row.id, change, api.callId, now);
			await scheduler.cancel(applied.replacedDurableTaskId);
			return await saved("updated", row, now);
		},
	});

	/** What an `update_person` call asks to change, checked. Throws what to fix. */
	function changeFrom(
		row: store.PersonRow,
		args: {
			name?: string | undefined;
			relation?: string | undefined;
			birthday?: string | undefined;
			notes?: string | undefined;
		},
		now: number,
	): store.PersonChange {
		const change: store.PersonChange = {};
		if (args.name !== undefined) {
			change.name = oneLine(args.name);
			if (change.name === "") throw new Error("name must not be empty.");
		}
		if (args.relation !== undefined) change.relation = oneLine(args.relation);
		if (args.notes !== undefined) change.notes = args.notes.trim();
		if (args.birthday !== undefined) {
			const parsed = parseBirthday(args.birthday, yearAt(now));
			if (!parsed.ok) throw new Error(`birthday: ${parsed.error}`);
			const unchanged = parsed.md === row.birthdayMd;
			change.birthday = {
				md: parsed.md,
				year: parsed.year ?? row.birthdayYear ?? null,
				// The cycle that is waiting stays as it is unless the day itself changed.
				cycle: unchanged
					? {
							year: row.cycleYear,
							...(row.remindAt === undefined ? {} : { remindAt: row.remindAt }),
							checkAt: row.checkAt,
						}
					: startCycle(nextCycle(parsed.md, now, timezone, times), now),
			};
		}
		if (Object.keys(change).length === 0) throw new Error("Nothing to change: give at least one field to update.");
		return change;
	}

	const listPeople = defineTool({
		name: "list_people",
		deferred: true,
		description:
			"List the saved people with their next birthday, soonest first. Use upcoming_days for 'whose birthday is coming up'.",
		parameters: Type.Object({
			upcoming_days: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_UPCOMING_DAYS,
					description: "Only birthdays that come within this many days, today included.",
				}),
			),
			query: Type.Optional(
				Type.String({ maxLength: 100, description: "Only people whose name or relation contains this." }),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_LISTED, description: `At most this many. Default ${DEFAULT_LISTED}.` }),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const today = todayAt(api.now());
			const until = args.upcoming_days === undefined ? undefined : addDays(today, args.upcoming_days - 1);
			const upcoming = store
				.listPeople(db, args.query)
				.map((row) => ({ row, next: nextOccurrence(row.birthdayMd, today) }))
				.filter(({ next }) => until === undefined || next.date <= until)
				.sort((a, b) => a.next.date.localeCompare(b.next.date) || a.row.name.localeCompare(b.row.name));
			const shown = upcoming.slice(0, args.limit ?? DEFAULT_LISTED);
			const heading = args.upcoming_days === undefined ? "People" : `Birthdays in the next ${args.upcoming_days} days`;
			const more = shown.length < upcoming.length ? ` (showing ${shown.length} of ${upcoming.length})` : "";
			return {
				output: text(
					shown.length === 0
						? "Nobody matches."
						: `${heading}: ${upcoming.length}${more}\n${shown.map(({ row }) => `- ${describePerson(row, today, timezone)}`).join("\n")}`,
				),
				details: asDetails({
					type: "people_list",
					heading,
					people: shown.map(({ row }) => toCardItem(row, today, timezone)),
					total: upcoming.length,
				}),
			};
		},
	});

	const recordWish = defineTool({
		name: "record_wish",
		description:
			"Record whether the owner wished a person a happy birthday: after the evening question, or when the owner says " +
			"they did (or did not) wish them. The year is that of the birthday; leave it out for the latest one.",
		parameters: Type.Object({
			person_id: personId,
			wished: Type.Boolean({ description: "true if the owner wished them, false if not (yet)." }),
			year: Type.Optional(
				Type.Integer({
					minimum: 1900,
					description: "The year of the birthday this is about. Default: the latest one.",
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findChangedByCall(db, api.callId);
			if (earlier?.tool === "record_wish") return wishRecorded(earlier.personId, api.now());

			const row = store.requirePerson(db, args.person_id);
			const now = api.now();
			const year = args.year ?? lastOccurrenceYear(row.birthdayMd, todayAt(now));
			if (year > yearAt(now) + 1) throw new Error(`year ${year} is too far ahead; it is ${yearAt(now)}.`);
			store.recordWish(db, row.id, year, args.wished, api.callId, now);
			return wishRecorded(row.id, now);
		},
	});

	/** The result of `record_wish`; a replay lands here too, and reports what the first call saved. */
	function wishRecorded(id: string, now: number) {
		const row = store.requirePerson(db, id);
		const latest = store.latestWish(db, id);
		const wished = latest?.wished === true;
		const year = latest?.year ?? lastOccurrenceYear(row.birthdayMd, todayAt(now));
		return {
			output: text(
				`Noted: ${wished ? "the owner wished" : "the owner has not wished"} ${row.name} a happy birthday (${dayText(occurrenceDate(row.birthdayMd, year), timezone)}).`,
			),
			details: card("wish", row, now, { wished, year }),
		};
	}

	const proposeDelete = defineTool({
		name: "propose_delete_person",
		deferred: true,
		description:
			"Ask the owner to approve deleting a saved person, with their birthday reminders, for good. Nothing is deleted until " +
			"they tap Approve or reply YES; never say they are deleted before they have.",
		parameters: Type.Object({ person_id: personId }),
		replay: "safe",
		async execute(args, api) {
			const row = store.requirePerson(db, args.person_id);
			const state = approvals.propose({
				conversationId: conversationOf(api),
				tool: "delete_person",
				args: { person_id: row.id },
				summary: `Delete ${row.name} and their birthday reminders`,
				callId: api.callId,
			});
			const outcome =
				state.status === "pending"
					? "Nothing is deleted yet. Tell the owner to tap Approve on the card. Do not say it is deleted until they have answered; list_people shows whether it went through."
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

	const deletePerson = defineTool({
		name: "delete_person",
		deferred: true,
		description:
			"Permanently delete a saved person. This is blocked unless the owner has approved exactly this deletion: do not call it " +
			"yourself, use propose_delete_person and wait for their answer. (The assistant normally carries out an approved deletion by itself.)",
		parameters: Type.Object({ person_id: personId }),
		replay: "safe",
		async execute(args, api) {
			const result = await approvals.runApproved(conversationOf(api), "delete_person", { person_id: args.person_id });
			return { output: text(result) };
		},
	});

	return [addPerson, updatePerson, listPeople, recordWish, proposeDelete, deletePerson];
}

/** Deleting a person is the one destructive thing the PA can do to its address book (rule 3). */
export function createDeletePersonAction(deps: Pick<DomainDeps, "db">, scheduler: TimerScheduler): ApprovalAction {
	return {
		tool: "delete_person",
		proposeTool: "propose_delete_person",
		target: (args) => `person:${String(args.person_id)}`,
		run: async (args) => {
			const id = String(args.person_id);
			const before = store.getPerson(deps.db, id);
			const { deleted, durableTaskId } = store.deletePerson(deps.db, id);
			await scheduler.cancel(durableTaskId);
			return deleted && before !== undefined ? `Deleted ${before.name}.` : `Person ${id} was already gone.`;
		},
	};
}
