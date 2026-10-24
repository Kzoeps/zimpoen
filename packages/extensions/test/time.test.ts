import { describe, expect, it } from "vitest";
import { formatLocal, formatLocalDate, isoLocal, parseWhen } from "../src/time.ts";

const THIMPHU = "Asia/Thimphu";

describe("parseWhen", () => {
	it("reads a wall-clock time in the owner's zone", () => {
		expect(parseWhen("2026-10-27T09:00", THIMPHU)).toStrictEqual({
			ok: true,
			ms: Date.UTC(2026, 9, 27, 3, 0, 0),
			dateOnly: false,
		});
	});

	it("lets an explicit offset or Z win over the zone, in the forms models write", () => {
		const exact = Date.UTC(2026, 9, 27, 3, 0, 0);
		for (const text of [
			"2026-10-27T09:00:00+06:00",
			"2026-10-27T09:00+0600",
			"2026-10-27T03:00:00Z",
			"2026-10-27 09:00:00+06",
		]) {
			expect(parseWhen(text, "Europe/London")).toMatchObject({ ok: true, ms: exact });
		}
	});

	it("means the end of the day for a date without a time", () => {
		const parsed = parseWhen("2026-10-27", THIMPHU);

		expect(parsed).toMatchObject({ ok: true, dateOnly: true });
		// 23:59:59.999 in Thimphu is 17:59:59.999 UTC.
		expect((parsed as { ms: number }).ms).toBe(Date.UTC(2026, 9, 27, 17, 59, 59, 999));
	});

	it("follows daylight saving time of a zone that has it", () => {
		// London left summer time on 2026-10-25: 09:00 is UTC+0 that day, UTC+1 the week before.
		expect(parseWhen("2026-10-25T09:00", "Europe/London")).toMatchObject({ ms: Date.UTC(2026, 9, 25, 9, 0) });
		expect(parseWhen("2026-10-20T09:00", "Europe/London")).toMatchObject({ ms: Date.UTC(2026, 9, 20, 8, 0) });
	});

	describe("when the clock changes (New York, 2026)", () => {
		const NEW_YORK = "America/New_York";

		it("moves a time that never happens to the later instant, the way a calendar does", () => {
			// The clocks jump from 02:00 to 03:00 EST->EDT on 8 March: 02:30 does not exist, 03:30 EDT is 07:30 UTC.
			expect(parseWhen("2026-03-08T02:30", NEW_YORK)).toMatchObject({ ok: true, ms: Date.UTC(2026, 2, 8, 7, 30) });
			expect(parseWhen("2026-03-08T01:30", NEW_YORK)).toMatchObject({ ms: Date.UTC(2026, 2, 8, 6, 30) });
			expect(parseWhen("2026-03-08T03:30", NEW_YORK)).toMatchObject({ ms: Date.UTC(2026, 2, 8, 7, 30) });
		});

		it("takes the first of the two instants of a time that happens twice", () => {
			// The clocks go back from 02:00 EDT to 01:00 EST on 1 November: 01:30 happens at 05:30 UTC and again at 06:30 UTC.
			expect(parseWhen("2026-11-01T01:30", NEW_YORK)).toMatchObject({ ms: Date.UTC(2026, 10, 1, 5, 30) });
			expect(parseWhen("2026-11-01T00:30", NEW_YORK)).toMatchObject({ ms: Date.UTC(2026, 10, 1, 4, 30) });
			expect(parseWhen("2026-11-01T02:30", NEW_YORK)).toMatchObject({ ms: Date.UTC(2026, 10, 1, 7, 30) });
		});

		it("knows that a day can be 23 or 25 hours long: a date without a time starts and ends where the day does", () => {
			const long = parseWhen("2026-11-01", NEW_YORK);
			const short = parseWhen("2026-03-08", NEW_YORK);

			expect(long).toMatchObject({
				dateOnly: true,
				dayStartMs: Date.UTC(2026, 10, 1, 4, 0), // 00:00 EDT
				ms: Date.UTC(2026, 10, 2, 5, 0) - 1, // 23:59:59.999 EST
			});
			expect(short).toMatchObject({
				dayStartMs: Date.UTC(2026, 2, 8, 5, 0), // 00:00 EST
				ms: Date.UTC(2026, 2, 9, 4, 0) - 1, // 23:59:59.999 EDT
			});
		});
	});

	it.each([
		["tomorrow at nine", /not an ISO 8601 date or time/],
		["2026-13-01T09:00", /not a real date or time/],
		["2026-02-30", /not a real date or time/],
		["2026-10-27T25:00", /not a real date or time/],
	])("explains what is wrong with %s", (input, message) => {
		const parsed = parseWhen(input, THIMPHU);

		expect(parsed.ok).toBe(false);
		expect((parsed as { error: string }).error).toMatch(message);
	});
});

describe("formatting", () => {
	const moment = Date.UTC(2026, 9, 27, 3, 0, 0);

	it("writes ISO with the zone's offset for the model, and a fixed human form for the UI", () => {
		expect(isoLocal(moment, THIMPHU)).toBe("2026-10-27T09:00:00+06:00");
		expect(isoLocal(moment, "America/New_York")).toBe("2026-10-26T23:00:00-04:00");
		expect(formatLocal(moment, THIMPHU)).toBe("Tue 27 Oct 2026, 09:00");
		expect(formatLocalDate(moment, THIMPHU)).toBe("Tue 27 Oct 2026");
	});

	it("round-trips: what isoLocal writes, parseWhen reads back", () => {
		for (const zone of [THIMPHU, "Europe/London", "America/New_York", "Pacific/Auckland"]) {
			expect(parseWhen(isoLocal(moment, zone), "UTC")).toMatchObject({ ok: true, ms: moment });
		}
	});
});
