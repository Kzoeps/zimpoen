import { afterEach, describe, expect, it } from "vitest";
import {
	atLocalTime,
	collectFacts,
	dailyStore,
	dayWindow,
	followupStore,
	peopleStore,
	taskStore,
} from "../src/index.ts";
import { type Fixture, openFixture, TIMEZONE } from "./support.ts";

const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.close().catch(() => {});
		await fixture.dispose();
	}
});
async function open(): Promise<Fixture> {
	const fixture = await openFixture();
	fixtures.push(fixture);
	return fixture;
}

const at = (date: string, time: string): number => atLocalTime(date, time, TIMEZONE);
const TODAY = "2026-10-26";
const conversationOf = (f: Fixture): number => Number(f.conversation.id);

/** What every provider says for a job on `date`, as plain text per section. */
function facts(f: Fixture, job: "briefing" | "wrapup", date = TODAY, now = at(TODAY, "07:30")) {
	const { sections } = collectFacts(f.deps.facts(), job, dayWindow(date, now, TIMEZONE));
	return Object.fromEntries(sections.map((section) => [section.title, section.lines]));
}

function task(f: Fixture, title: string, change: { dueAt?: number; allDay?: boolean; remindAt?: number }) {
	return taskStore.insertTask(
		f.db,
		{
			title,
			notes: "",
			dueAllDay: change.allDay ?? false,
			...(change.dueAt === undefined ? {} : { dueAt: change.dueAt }),
			...(change.remindAt === undefined ? {} : { remindAt: change.remindAt }),
			conversationId: conversationOf(f),
			createdAt: at("2026-10-20", "09:00"),
		},
		`call-${title}`,
	).row;
}

describe("what the tasks say", () => {
	it("lists what is due or has a reminder today, soonest first, and what is overdue", async () => {
		const f = await open();
		const late = task(f, "Call the bank", { dueAt: at(TODAY, "16:00") });
		const early = task(f, "Pay rent", { dueAt: at(TODAY, "09:00"), remindAt: at(TODAY, "08:30") });
		const anyTime = task(f, "Buy milk", { dueAt: at(TODAY, "23:59"), allDay: true });
		const reminderOnly = task(f, "Water plants", { remindAt: at(TODAY, "12:00") });
		const overdue = task(f, "File the form", { dueAt: at("2026-10-23", "09:00") });
		const overdueAllDay = task(f, "Send the report", { dueAt: at("2026-10-24", "23:59"), allDay: true });
		task(f, "Tomorrow's thing", { dueAt: at("2026-10-27", "10:00") });
		task(f, "Someday", {});

		const today = facts(f, "briefing");

		expect(today["Tasks and reminders today"]).toStrictEqual([
			`${early.id} “Pay rent” — due 09:00; reminder 08:30`,
			`${reminderOnly.id} “Water plants” — reminder 12:00`,
			`${late.id} “Call the bank” — due 16:00`,
			`${anyTime.id} “Buy milk” — due today`,
		]);
		expect(today["Overdue tasks"]).toStrictEqual([
			`${overdue.id} “File the form” — was due Fri 23 Oct 2026, 09:00`,
			`${overdueAllDay.id} “Send the report” — was due Sat 24 Oct 2026`,
		]);
	});

	it("leaves out what is done, and reports a done task or a sent reminder only in the evening", async () => {
		const f = await open();
		const done = task(f, "Pay rent", { dueAt: at(TODAY, "09:00") });
		const open1 = task(f, "Call the bank", { dueAt: at(TODAY, "16:00"), remindAt: at(TODAY, "15:00") });
		taskStore.completeTask(f.db, done.id, "call-done", at(TODAY, "10:15"));
		taskStore.markReminded(f.db, open1.id, taskStore.requireTask(f.db, open1.id).remindGen, at(TODAY, "15:00"));

		const morning = facts(f, "briefing");
		expect(Object.values(morning).flat().join("\n")).not.toContain("Pay rent");

		const evening = facts(f, "wrapup", TODAY, at(TODAY, "21:00"));
		expect(evening["Tasks completed today"]).toStrictEqual([`${done.id} “Pay rent” — completed at 10:15`]);
		expect(evening["Reminders that went off today"]).toStrictEqual([
			`${open1.id} “Call the bank” — reminder sent at 15:00, task open`,
		]);
		expect(facts(f, "wrapup", "2026-10-27")).toStrictEqual({});
	});
});

describe("what meetings and commitments say", () => {
	function meeting(
		f: Fixture,
		title: string,
		eventAt: number,
		change: { counterpart?: string; kind?: "meeting" | "commitment" } = {},
	) {
		return followupStore.insertFollowup(
			f.db,
			{
				title,
				counterpart: change.counterpart ?? "",
				context: "",
				kind: change.kind ?? "meeting",
				eventAt,
				askAt: eventAt + 30 * 60_000,
				agendaLeadMinutes: 15,
				conversationId: conversationOf(f),
				createdAt: at("2026-10-20", "09:00"),
			},
			`call-${title}`,
		).row;
	}

	it("lists today's with their agenda counts, and the questions nobody answered as open loops", async () => {
		const f = await open();
		const house = meeting(f, "Meeting about the house", at(TODAY, "10:00"), { counterpart: "Dabtonog Realty" });
		followupStore.addAgendaPoint(f.db, house.id, "Ask about the price", "p1", 1);
		followupStore.addAgendaPoint(f.db, house.id, "Ask about the deposit", "p2", 2);
		const bank = meeting(f, "Call the bank", at(TODAY, "15:00"), { kind: "commitment" });
		const asked = meeting(f, "Lunch with Tashi", at("2026-10-23", "13:00"), { counterpart: "Tashi" });
		followupStore.markAsked(f.db, asked.id, asked.gen, at("2026-10-23", "14:00"));
		const resolved = meeting(f, "Old meeting", at("2026-10-22", "10:00"));
		followupStore.resolveFollowup(f.db, resolved.id, "done", "call-r", at("2026-10-22", "11:00"));
		meeting(f, "Next week", at("2026-11-02", "10:00"));

		const today = facts(f, "briefing");

		expect(today["Meetings and follow-ups today"]).toStrictEqual([
			`${house.id} “Meeting about the house” with Dabtonog Realty at 10:00 (meeting, 2 agenda points)`,
			`${bank.id} “Call the bank” at 15:00 (commitment)`,
		]);
		expect(today["Waiting for an outcome"]).toStrictEqual([
			`${asked.id} “Lunch with Tashi” with Tashi on Fri 23 Oct 2026 — no outcome yet, asked Fri 23 Oct 2026`,
		]);
	});

	it("does not list a meeting twice when it is both today and asked", async () => {
		const f = await open();
		const row = meeting(f, "Early meeting", at(TODAY, "07:00"));
		followupStore.markAsked(f.db, row.id, row.gen, at(TODAY, "07:20"));
		const today = facts(f, "briefing", TODAY, at(TODAY, "07:30"));
		expect(today["Meetings and follow-ups today"]).toHaveLength(1);
		expect(today["Waiting for an outcome"]).toBeUndefined();
	});

	it("tells in the evening what was resolved today and how it went", async () => {
		const f = await open();
		const row = meeting(f, "Meeting about the house", at(TODAY, "10:00"), { counterpart: "Dabtonog Realty" });
		followupStore.recordOutcome(f.db, row.id, { outcome: "They agreed to a viewing" }, "call-o", at(TODAY, "11:00"));
		const other = meeting(f, "Dropped thing", at(TODAY, "12:00"));
		followupStore.resolveFollowup(f.db, other.id, undefined, "call-r", at(TODAY, "12:30"));

		const evening = facts(f, "wrapup", TODAY, at(TODAY, "21:00"));
		expect(evening["Follow-ups resolved today"]).toStrictEqual([
			`${row.id} “Meeting about the house” with Dabtonog Realty — outcome: They agreed to a viewing`,
			`${other.id} “Dropped thing” — closed without an outcome`,
		]);
	});
});

describe("what the address book says", () => {
	function person(f: Fixture, name: string, md: string, change: { relation?: string; year?: number } = {}) {
		return peopleStore.insertPerson(
			f.db,
			{
				name,
				relation: change.relation ?? "",
				birthdayMd: md,
				...(change.year === undefined ? {} : { birthdayYear: change.year }),
				notes: "",
				cycle: { year: 2026, checkAt: at(TODAY, "18:00") },
				conversationId: conversationOf(f),
				createdAt: at("2026-10-01", "09:00"),
			},
			`call-${name}`,
		).row;
	}

	it("names the birthdays of today and of the next three days, not the fourth", async () => {
		const f = await open();
		const today = person(f, "Tashi", "10-26", { relation: "sister", year: 1996 });
		const soon = person(f, "Pema", "10-29");
		person(f, "Karma", "10-30");
		person(f, "Dorji", "01-05");

		const brief = facts(f, "briefing");

		expect(brief.Birthdays).toStrictEqual([
			`${today.id} Tashi (sister) — today, turns 30`,
			`${soon.id} Pema — Thu 29 Oct 2026`,
		]);
	});

	it("says a birthday is already wished, and in the evening lists the wish and the question still open", async () => {
		const f = await open();
		const tashi = person(f, "Tashi", "10-26");
		const pema = person(f, "Pema", "10-26");
		peopleStore.recordWish(f.db, tashi.id, 2026, true, "call-w", at(TODAY, "09:10"));
		peopleStore.markAsked(f.db, pema.id, pema.gen, 2026, at(TODAY, "18:00"));

		expect(facts(f, "briefing").Birthdays).toContain(`${tashi.id} Tashi — today; already wished`);
		const evening = facts(f, "wrapup", TODAY, at(TODAY, "21:00"));
		expect(evening["Birthdays wished today"]).toStrictEqual([`${tashi.id} Tashi — the owner wished them well`]);
		expect(evening["Birthdays still open"]).toStrictEqual([
			`${pema.id} Pema — birthday Mon 26 Oct 2026: the owner has not said whether they wished them well`,
		]);
	});
});

describe("what the journal says", () => {
	it("brings forward what the last answered day carried over, up to three days back", async () => {
		const f = await open();
		dailyStore.saveJournal(
			f.db,
			{ date: "2026-10-23", userLog: "Friday", carriedOver: ["Review the PR"] },
			"c1",
			at("2026-10-23", "21:30"),
		);

		expect(facts(f, "briefing", "2026-10-26")["Carried over from Fri 23 Oct 2026"]).toStrictEqual(["Review the PR"]);
		expect(facts(f, "briefing", "2026-10-24")["Carried over from yesterday"]).toStrictEqual(["Review the PR"]);
		expect(facts(f, "briefing", "2026-10-27")).toStrictEqual({}); // too long ago

		dailyStore.saveJournal(
			f.db,
			{ date: "2026-10-25", userLog: "Sunday", carriedOver: ["Book the dentist"] },
			"c2",
			at("2026-10-25", "21:30"),
		);
		expect(facts(f, "briefing", "2026-10-26")["Carried over from yesterday"]).toStrictEqual(["Book the dentist"]);
	});

	it("lets a later answer that carries nothing clear the list: what the owner reported done does not come back", async () => {
		const f = await open();
		dailyStore.saveJournal(
			f.db,
			{ date: "2026-10-24", userLog: "Invoice still to send", carriedOver: ["Send the invoice"] },
			"c1",
			at("2026-10-24", "21:30"),
		);
		expect(facts(f, "briefing", "2026-10-25")["Carried over from yesterday"]).toStrictEqual(["Send the invoice"]);

		dailyStore.saveJournal(
			f.db,
			{ date: "2026-10-25", userLog: "Sent the invoice. Everything is done.", carriedOver: [] },
			"c2",
			at("2026-10-25", "21:30"),
		);
		expect(facts(f, "briefing", "2026-10-26")).toStrictEqual({});
	});

	it("ignores a wrap-up the owner never answered", async () => {
		const f = await open();
		dailyStore.recordWrapupAsked(f.db, "2026-10-25", "summary", at("2026-10-25", "21:00"));
		expect(facts(f, "briefing", "2026-10-26")).toStrictEqual({});
	});
});

describe("how much a section says", () => {
	it("keeps a section to twelve lines and counts the rest, so a day with sixty tasks is still a briefing", async () => {
		const f = await open();
		for (let i = 1; i <= 15; i++)
			task(f, `Task ${String(i).padStart(2, "0")}`, {
				dueAt: at(TODAY, `${String(8 + (i % 10)).padStart(2, "0")}:00`),
			});
		const lines = facts(f, "briefing")["Tasks and reminders today"] ?? [];
		expect(lines).toHaveLength(13);
		expect(lines.at(-1)).toBe("… and 3 more");
	});

	it("drops a section with nothing in it", async () => {
		const f = await open();
		expect(facts(f, "briefing")).toStrictEqual({});
		expect(facts(f, "wrapup", TODAY, at(TODAY, "21:00"))).toStrictEqual({});
	});
});
