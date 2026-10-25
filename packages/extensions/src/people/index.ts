import { defineExtension, section } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { addDays, localDate } from "../time.ts";
import type { TimerScheduler } from "../timers.ts";
import { dayText, nextOccurrence, occurrenceDate, turnsIn } from "./birthdays.ts";
import { peopleMigrations } from "./migrations.ts";
import { type CardRecovery, recoverCards } from "./recovery.ts";
import { createBirthdayScheduler } from "./scheduler.ts";
import * as store from "./store.ts";
import { type BirthdayTask, createBirthdayTask } from "./task.ts";
import { createDeletePersonAction, createPeopleTools } from "./tools.ts";

export const PEOPLE_EXTENSION_NAME = "people";

/** How far ahead the prompt section lists birthdays. */
const UPCOMING_DAYS = 7;

/** How many local days an evening question that nobody answered stays in the prompt section. */
const QUESTION_DAYS = 3;

/**
 * The prompt section: how many people are saved, whose birthday falls in the next week, and the evening questions that are
 * still open. It reads the Harness clock for the owner's local *date* and nothing finer, and it prints absolute dates, so
 * it renders the same bytes all day and changes when a birthday enters or leaves the week, when the evening question is
 * asked or answered, or when people change. That keeps it as cache-friendly as a window that moves with the calendar can be.
 *
 * The open questions are here because the question card is display-only (a write that carries model text can start a
 * run, see `post.ts`): this is how "yes, I did" finds out whose birthday it answers.
 */
export function renderPeopleSection(deps: Pick<DomainDeps, "db" | "timezone" | "now">): string {
	const people = store.listPeople(deps.db);
	if (people.length === 0) return "No people saved.";
	const today = localDate(deps.now(), deps.timezone);
	const until = addDays(today, UPCOMING_DAYS - 1); // seven days, today included, like list_people upcoming_days
	const soon = people
		.map((row) => ({ row, next: nextOccurrence(row.birthdayMd, today) }))
		.filter(({ next }) => next.date <= until)
		.sort((a, b) => a.next.date.localeCompare(b.next.date) || a.row.name.localeCompare(b.row.name));

	const lines = [`People saved: ${people.length}.`];
	if (soon.length === 0) lines.push(`No birthdays in the next ${UPCOMING_DAYS} days.`);
	else {
		lines.push(`Birthdays in the next ${UPCOMING_DAYS} days (dates are the owner's local dates, today included):`);
		for (const { row, next } of soon) {
			const turns = turnsIn(row.birthdayYear, next.year);
			const relation = row.relation === "" ? "" : ` (${row.relation})`;
			lines.push(
				`- ${row.id} ${row.name}${relation}, ${dayText(next.date, deps.timezone)}${turns === undefined ? "" : `, turns ${turns}`}`,
			);
		}
	}

	const since = addDays(today, 1 - QUESTION_DAYS);
	const open = store
		.unansweredQuestions(deps.db)
		.filter((row) => row.askedAt !== undefined && localDate(row.askedAt, deps.timezone) >= since);
	if (open.length > 0) {
		lines.push(
			"The owner was asked whether they wished these people well and has not answered (record_wish records the answer):",
		);
		for (const row of open) {
			const date = occurrenceDate(row.birthdayMd, row.askedYear ?? row.cycleYear);
			lines.push(`- ${row.id} ${row.name}, birthday ${dayText(date, deps.timezone)}`);
		}
	}
	return lines.join("\n");
}

export type PeopleModule = DomainModule & {
	/** The timer machinery, for the server's startup repair and for tests. Built from the same deps as the extension. */
	scheduler: (deps: DomainDeps) => TimerScheduler;
	birthdayTask: (deps: DomainDeps) => BirthdayTask;
	/** Start-up: post again the birthday cards the database may have lost in a power cut. See `recoverCards`. */
	recover: (deps: DomainDeps) => Promise<CardRecovery>;
};

/** Per-deps instances: the tools, the task and the scheduler must share one task definition and one scheduler. */
const built = new WeakMap<DomainDeps, { task: BirthdayTask; scheduler: TimerScheduler }>();

function piecesFor(deps: DomainDeps): { task: BirthdayTask; scheduler: TimerScheduler } {
	let pieces = built.get(deps);
	if (pieces === undefined) {
		// The task starts next year's timer when this year's is done, and the scheduler needs the task to create one:
		// the task gets the scheduler by name when it runs, which is after both exist.
		let scheduler: TimerScheduler | undefined;
		const task = createBirthdayTask(deps, () => scheduler);
		scheduler = createBirthdayScheduler(deps, task);
		pieces = { task, scheduler };
		built.set(deps, pieces);
	}
	return pieces;
}

export const peopleModule: PeopleModule = {
	name: "people",
	migrations: peopleMigrations,
	scheduler: (deps) => piecesFor(deps).scheduler,
	birthdayTask: (deps) => piecesFor(deps).task,
	recover: recoverCards,
	extension: (deps) => {
		const { task, scheduler } = piecesFor(deps);
		return defineExtension({
			name: PEOPLE_EXTENSION_NAME,
			tools: createPeopleTools(deps, scheduler),
			sections: [section("people", () => renderPeopleSection(deps))],
			tasks: [task],
		});
	},
	actions: (deps) => [createDeletePersonAction(deps, piecesFor(deps).scheduler)],
};

export * as birthdays from "./birthdays.ts";
export type { CardRecovery } from "./recovery.ts";
export * as peopleStore from "./store.ts";
export {
	BIRTHDAY_CHECK_PUSH,
	BIRTHDAY_PUSH,
	BIRTHDAY_TASK_NAME,
	BIRTHDAY_URL,
	type BirthdayInput,
} from "./task.ts";
export { describePerson, toCardItem } from "./tools.ts";
