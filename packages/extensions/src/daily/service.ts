import type { ScheduleJobSettings, UpdateScheduleRequest } from "@assistant/shared";
import type { DomainDeps } from "../module.ts";
import { formatLocal } from "../time.ts";
import type { TimerScheduler } from "../timers.ts";
import { DAILY_JOBS, jobOf } from "./jobs.ts";
import { nextOccurrence, TIME_OF_DAY } from "./occurrence.ts";
import * as store from "./store.ts";

/** Asked to change a job that does not exist. */
export class UnknownDailyJob extends Error {
	constructor(job: string) {
		super(`There is no daily job '${job}'. The jobs are ${DAILY_JOBS.map((known) => known.id).join(", ")}.`);
		this.name = "UnknownDailyJob";
	}
}

/** Asked for a time that is not `HH:MM`. */
export class InvalidDailyTime extends Error {
	constructor(value: string) {
		super(`'${value.slice(0, 20)}' is not a time of day. Use 24-hour HH:MM, for example 07:30.`);
		this.name = "InvalidDailyTime";
	}
}

export type DailyService = {
	/**
	 * At start: give every job a row (its default time, on) and its first run. A job that has a row is left as it is.
	 * Returns the jobs that got a row now: a new data directory, or a job this version added.
	 */
	ensureRows(): string[];
	/** Every job as the settings page shows it. */
	list(): ScheduleJobSettings[];
	/** Change a job's time or switch it on or off. It takes effect at once: the old timer is stale and a new one is made. */
	update(job: string, change: UpdateScheduleRequest): Promise<ScheduleJobSettings>;
};

type Deps = Pick<DomainDeps, "db" | "timezone" | "now">;

/** The settings of the daily jobs: the one place that turns what the owner chose into the run that is waiting. */
export function createDailyService(deps: Deps, scheduler: () => TimerScheduler): DailyService {
	const { db, timezone } = deps;

	function view(row: store.ScheduleRow): ScheduleJobSettings {
		const job = jobOf(row.job);
		return {
			job: (job?.id ?? row.job) as ScheduleJobSettings["job"],
			label: job?.label ?? row.job,
			localTime: row.localTime,
			enabled: row.enabled,
			defaultTime: job?.defaultTime ?? row.localTime,
			...(row.enabled ? { nextRunAt: row.dueAt, nextRunText: formatLocal(row.dueAt, timezone) } : {}),
			...(row.lastRunDate === undefined ? {} : { lastRunDate: row.lastRunDate }),
		};
	}

	return {
		ensureRows() {
			const now = deps.now();
			const created: string[] = [];
			for (const job of DAILY_JOBS) {
				if (store.getSchedule(db, job.id) !== undefined) continue;
				// A job that never existed was not missed: its first run is the next one, never a late one for today. (The late
				// window is for a server that was down, and a first start has no past.)
				const next = nextOccurrence({ now, timezone, time: job.defaultTime, lateMinutes: 0 });
				store.insertSchedule(db, { job: job.id, localTime: job.defaultTime, enabled: true, next, now });
				created.push(job.id);
			}
			return created;
		},

		list() {
			return store.listSchedules(db).map(view);
		},

		async update(jobId, change) {
			const job = jobOf(jobId);
			const before = job === undefined ? undefined : store.getSchedule(db, job.id);
			if (job === undefined || before === undefined) throw new UnknownDailyJob(jobId);
			if (change.localTime !== undefined && !TIME_OF_DAY.test(change.localTime)) {
				throw new InvalidDailyTime(change.localTime);
			}
			const localTime = change.localTime ?? before.localTime;
			const enabled = change.enabled ?? before.enabled;
			if (localTime === before.localTime && enabled === before.enabled) return view(before);

			const now = deps.now();
			// What the owner asks for here is the next run at the new time, never one for a time that has already passed
			// (setting 07:00 at 07:45 means tomorrow; the late window is for a server that was down, not for an edit). A
			// day that already ran does not run again either.
			const next = nextOccurrence({ now, timezone, time: localTime, lateMinutes: 0, lastRunDate: before.lastRunDate });
			const changed = store.changeSchedule(db, job.id, { localTime, enabled, next }, now);
			await scheduler().cancel(changed.replacedDurableTaskId);
			if (enabled) await scheduler().ensureScheduled(job.id);
			return view(store.requireSchedule(db, job.id));
		},
	};
}
