import type { ScheduleJobSettings, UpdateScheduleRequest } from "@assistant/shared";

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * What saving the time field would send, or undefined when there is nothing to save: the time is the one already set, or
 * it is not a time of day (a time input is empty while it is half typed).
 */
export function scheduleChange(
	job: Pick<ScheduleJobSettings, "localTime">,
	draft: { localTime: string },
): UpdateScheduleRequest | undefined {
	if (!TIME_OF_DAY.test(draft.localTime) || draft.localTime === job.localTime) return undefined;
	return { localTime: draft.localTime };
}
