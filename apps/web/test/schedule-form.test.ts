import { describe, expect, it } from "vitest";
import { scheduleChange } from "../src/lib/schedule-form.ts";

describe("what saving a job's time would send", () => {
	const job = { localTime: "07:30" };

	it("sends the new time when it differs from the saved one", () => {
		expect(scheduleChange(job, { localTime: "08:15" })).toStrictEqual({ localTime: "08:15" });
		expect(scheduleChange(job, { localTime: "00:00" })).toStrictEqual({ localTime: "00:00" });
		expect(scheduleChange(job, { localTime: "23:59" })).toStrictEqual({ localTime: "23:59" });
	});

	it("sends nothing when the time is the saved one", () => {
		expect(scheduleChange(job, { localTime: "07:30" })).toBeUndefined();
	});

	it.each([
		["a half-typed field", ""],
		["an hour without a leading zero", "7:30"],
		["the 24th hour", "24:00"],
		["the 60th minute", "07:60"],
		["seconds", "07:30:00"],
		["letters", "ab:cd"],
	])("sends nothing for %s, which the server would refuse", (_name, localTime) => {
		expect(scheduleChange(job, { localTime })).toBeUndefined();
	});
});
