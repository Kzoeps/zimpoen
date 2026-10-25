import { atLocalTime, type CalendarClient, type CalendarEvent } from "@assistant/extensions";
import { createGoogleGet, type GoogleHttpOptions } from "./http.ts";

export const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

type RawEvent = {
	id?: string;
	status?: string;
	summary?: string;
	location?: string;
	updated?: string;
	start?: { dateTime?: string; date?: string };
	end?: { dateTime?: string; date?: string };
	attendees?: Array<{ email?: string; self?: boolean; resource?: boolean; responseStatus?: string }>;
};

/** The most pages one listing reads: 250 events each, so a calendar this busy has something else wrong with it. */
const MAX_PAGES = 8;

/**
 * Google Calendar's read-only API (`calendar.readonly`): the events of the primary calendar in a window, repeating events
 * expanded, cancelled ones and ones the owner declined left out. `timezone` is the owner's: an all-day event has a date and
 * no time, and starts at midnight of that date for them.
 */
export function createCalendarClient(options: GoogleHttpOptions & { timezone: string }): CalendarClient {
	const get = createGoogleGet(options);

	function toMs(value: { dateTime?: string; date?: string } | undefined): { ms: number; allDay: boolean } | undefined {
		if (value?.dateTime !== undefined) {
			const ms = Date.parse(value.dateTime);
			return Number.isFinite(ms) ? { ms, allDay: false } : undefined;
		}
		if (value?.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
			return { ms: atLocalTime(value.date, "00:00", options.timezone), allDay: true };
		}
		return undefined;
	}

	return {
		async listEvents(account, range, requestOptions) {
			const events: CalendarEvent[] = [];
			let pageToken: string | undefined;
			for (let page = 0; page < MAX_PAGES; page++) {
				const url = new URL(CALENDAR_BASE);
				url.searchParams.set("timeMin", new Date(range.from).toISOString());
				url.searchParams.set("timeMax", new Date(range.to).toISOString());
				url.searchParams.set("singleEvents", "true");
				url.searchParams.set("orderBy", "startTime");
				url.searchParams.set("maxResults", "250");
				if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
				const body = (await get(account, url, requestOptions)) as { items?: RawEvent[]; nextPageToken?: string };
				for (const item of body.items ?? []) {
					const start = toMs(item.start);
					const end = toMs(item.end);
					if (typeof item.id !== "string" || item.status === "cancelled" || start === undefined || end === undefined)
						continue;
					const attendees = item.attendees ?? [];
					if (attendees.some((attendee) => attendee.self === true && attendee.responseStatus === "declined")) continue;
					events.push({
						id: item.id,
						title: item.summary ?? "",
						start: start.ms,
						end: end.ms,
						allDay: start.allDay,
						attendees: attendees.flatMap((attendee) =>
							attendee.self === true || attendee.resource === true || typeof attendee.email !== "string"
								? []
								: [attendee.email],
						),
						location: item.location ?? "",
						updated: Date.parse(item.updated ?? "") || start.ms,
					});
				}
				pageToken = body.nextPageToken;
				if (pageToken === undefined) break;
			}
			return events;
		},
	};
}
