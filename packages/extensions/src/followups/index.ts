import { defineExtension, section } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { formatLocal } from "../time.ts";
import type { TimerScheduler } from "../timers.ts";
import { followupsMigrations } from "./migrations.ts";
import { createFollowupScheduler } from "./scheduler.ts";
import * as store from "./store.ts";
import { createFollowupTask, type FollowupTask } from "./task.ts";
import { createDeleteFollowupAction, createFollowupTools } from "./tools.ts";

export const FOLLOWUPS_EXTENSION_NAME = "followups";

/** How many upcoming meetings the prompt section lists, and how many open questions. */
const NEXT_LISTED = 5;
const AWAITING_LISTED = 5;

/**
 * The prompt section: the meetings and commitments still to come (the next few, with how many agenda points each has),
 * and the ones the owner was asked about and has not answered. It holds nothing that changes by itself: no clock, no
 * "overdue", so two requests with the same follow-ups render the same bytes and share the provider's prompt cache.
 *
 * The open questions are here because the question card is display-only (a write that carries model text can start a
 * run, see `post.ts`): this is how "they agreed to a viewing, call them Friday" finds out what it answers.
 */
export function renderFollowupsSection(deps: Pick<DomainDeps, "db" | "timezone">): string {
	const { waiting, next, awaiting, asked } = store.openSummary(deps.db, NEXT_LISTED, AWAITING_LISTED);
	if (waiting === 0 && awaiting === 0) return "No meetings or follow-ups waiting.";
	const when = (ms: number): string => formatLocal(ms, deps.timezone);
	const lines: string[] = [];
	if (waiting > 0) {
		lines.push(
			`Meetings and follow-ups still to come: ${waiting}.${waiting > next.length ? ` The next ${next.length}:` : ""}`,
		);
		for (const row of next) {
			const who = row.counterpart === "" ? "" : ` with ${row.counterpart}`;
			const points =
				row.agendaCount === 0 ? "" : `, ${row.agendaCount} agenda point${row.agendaCount === 1 ? "" : "s"}`;
			lines.push(`- ${row.id} “${row.title}”${who}, ${when(row.eventAt)}${points}`);
		}
	}
	if (awaiting > 0) {
		lines.push(
			`The owner was asked how these went and has not answered (record_outcome records what they say, resolve_followup closes one without an outcome): ${awaiting}.`,
		);
		for (const row of asked) lines.push(`- ${row.id} “${row.title}”, it was ${when(row.eventAt)}`);
		if (awaiting > asked.length) {
			lines.push(`(${awaiting - asked.length} older ones not listed; list_followups with status asked shows them.)`);
		}
	}
	return lines.join("\n");
}

export type FollowupsModule = DomainModule & {
	/** The timer machinery, for the server's startup repair and for tests. Built from the same deps as the extension. */
	scheduler: (deps: DomainDeps) => TimerScheduler;
	followupTask: (deps: DomainDeps) => FollowupTask;
};

/** Per-deps instances: the tools, the task and the scheduler must share one task definition and one scheduler. */
const built = new WeakMap<DomainDeps, { task: FollowupTask; scheduler: TimerScheduler }>();

function piecesFor(deps: DomainDeps): { task: FollowupTask; scheduler: TimerScheduler } {
	let pieces = built.get(deps);
	if (pieces === undefined) {
		const task = createFollowupTask(deps);
		pieces = { task, scheduler: createFollowupScheduler(deps, task) };
		built.set(deps, pieces);
	}
	return pieces;
}

export const followupsModule: FollowupsModule = {
	name: "followups",
	migrations: followupsMigrations,
	scheduler: (deps) => piecesFor(deps).scheduler,
	followupTask: (deps) => piecesFor(deps).task,
	extension: (deps) => {
		const { task, scheduler } = piecesFor(deps);
		return defineExtension({
			name: FOLLOWUPS_EXTENSION_NAME,
			tools: createFollowupTools(deps, scheduler),
			sections: [section("followups", () => renderFollowupsSection(deps))],
			tasks: [task],
		});
	},
	actions: (deps) => [createDeleteFollowupAction(deps, piecesFor(deps).scheduler)],
};

export { matchMeetings, significantWords } from "./match.ts";
export * as followupStore from "./store.ts";
export {
	AGENDA_GRACE_MS,
	AGENDA_PUSH,
	FOLLOWUP_NUDGE_PUSH,
	FOLLOWUP_PUSH,
	FOLLOWUP_REASK_PUSH,
	FOLLOWUP_TASK_NAME,
	FOLLOWUP_URL,
	type FollowupInput,
} from "./task.ts";
export { describeFollowup, toCardItem } from "./tools.ts";
