/**
 * When the follow-up and birthday timers fire, relative to the thing they are about. The server reads them from the
 * environment (`ASSISTANT_AGENDA_LEAD_MINUTES` and friends) and a tool call can override the two that belong to one
 * meeting; these are the defaults.
 */
export type ScheduleSettings = {
	/** A meeting's agenda is sent this long before it starts, when it has points. */
	agendaLeadMinutes: number;
	/** The owner is asked how a meeting or commitment went this long after it started, when no end time was given. */
	followupAskDelayMinutes: number;
	/** Local time of day (`HH:MM`, 24 hours) of the birthday reminder: wish them well. */
	birthdayRemindTime: string;
	/** Local time of day (`HH:MM`) of the evening question: did you? */
	birthdayCheckTime: string;
	/** Local time of day (`HH:MM`) of the one re-ask of a follow-up question nobody answered: the morning after it was asked. */
	followupReaskTime: string;
	/** Local time of day (`HH:MM`) of a follow-up the owner gave a date for and no time ("on Monday"). */
	followupDefaultTime: string;
};

export const DEFAULT_SCHEDULE: ScheduleSettings = {
	agendaLeadMinutes: 15,
	followupAskDelayMinutes: 30,
	birthdayRemindTime: "09:00",
	birthdayCheckTime: "18:00",
	followupReaskTime: "09:00",
	followupDefaultTime: "10:00",
};

/** The longest lead or delay a setting or a tool call may ask for: a day. */
export const MAX_SCHEDULE_MINUTES = 24 * 60;

/** The settings a module runs with: what the server configured, and the defaults for the rest. */
export function scheduleOf(deps: { schedule?: Partial<ScheduleSettings> | undefined }): ScheduleSettings {
	return { ...DEFAULT_SCHEDULE, ...deps.schedule };
}
