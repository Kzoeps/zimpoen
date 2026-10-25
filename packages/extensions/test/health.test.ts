import type {
	ApprovalCard,
	ExerciseChartCard,
	WeightCard,
	WeightChartCard,
	WorkoutCard,
	WorkoutListCard,
} from "@assistant/shared";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	atLocalTime,
	collectFacts,
	dayWindow,
	healthModule,
	healthStore,
	NUDGE_WINDOW_DAYS,
	renderHealthSection,
} from "../src/index.ts";
import { type Fixture, openFixture, say, TIMEZONE, textOf, toolCall } from "./support.ts";

const fixtures: Fixture[] = [];
async function open(...args: Parameters<typeof openFixture>): Promise<Fixture> {
	const fixture = await openFixture(...args);
	fixtures.push(fixture);
	return fixture;
}
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.close().catch(() => {});
		await fixture.dispose();
	}
});

const TODAY = "2026-10-25"; // the fixture's clock: 14:00 on Sunday in Thimphu
const DAY = 24 * 60 * 60_000;

let calls = 0;
const nextCall = (): string => `call-${++calls}`;

/** Log a weight the way the model does; resolves with the tool's result. */
const weigh = (f: Fixture, weight: number, date?: string, extra: Record<string, unknown> = {}, callId = nextCall()) =>
	f.callTool("log_weight", { weight, ...(date === undefined ? {} : { date }), ...extra }, callId);

const workout = (f: Fixture, args: Record<string, unknown>, callId = nextCall()) =>
	f.callTool("log_workout", args, callId);

const squats = (date: string, kg: number, reps = 5, count = 5) => ({
	date,
	exercises: [{ name: "squat", sets: [{ reps, weight: kg, count }] }],
});

const weightCard = (result: { details?: unknown }) => result.details as unknown as WeightCard;
const sessions = (f: Fixture) => healthStore.sessionsBetween(f.db, undefined, "9999-12-31", 100).sessions;
const setCount = (f: Fixture): number => f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM health_set")?.n ?? 0;
const at = (date: string, time: string): number => atLocalTime(date, time, TIMEZONE);

/** The latest tool result in the conversation: what the model was told after a call it made. */
const lastResult = async (f: Fixture): Promise<ToolResultMessage> => {
	const message = (await f.entries())
		.flatMap((entry) => entry.model ?? [])
		.filter((candidate): candidate is ToolResultMessage => candidate.role === "toolResult")
		.at(-1);
	if (message === undefined) throw new Error("no tool result");
	return message;
};
const resultText = (message: ToolResultMessage): string =>
	message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

describe("log_weight", () => {
	it("saves one row however often Durable replays the call, even when the replay comes on another day (rule 8)", async () => {
		const f = await open();

		const first = await weigh(f, 72.4, undefined, {}, "call-A");
		f.clock.now += 2 * DAY; // a replay after a crash comes later: the day it logged must not move
		const replay = await weigh(f, 72.4, undefined, {}, "call-A");

		expect(healthStore.weightsBetween(f.db, undefined, "9999-12-31")).toHaveLength(1);
		expect(healthStore.getWeight(f.db, TODAY)?.kg).toBe(72.4);
		expect(textOf(replay)).toBe(textOf(first));
		expect(weightCard(replay)).toMatchObject({ event: "logged", day: { date: TODAY, dateText: "Sun 25 Oct 2026" } });
	});

	it("takes pounds, converts them once and stores kilograms", async () => {
		const f = await open();

		const result = await weigh(f, 160, undefined, { unit: "lb" });

		expect(healthStore.getWeight(f.db, TODAY)?.kg).toBe(72.57);
		expect(weightCard(result)).toMatchObject({ kg: 72.57, fromLb: 160 });
		expect(textOf(result)).toContain("Logged 72.57 kg for Sun 25 Oct 2026 (160 lb, converted).");
	});

	it("logs today by default, accepts yesterday and a date, and refuses a day that has not happened", async () => {
		const f = await open();

		await weigh(f, 72.4);
		await weigh(f, 72.6, "yesterday");
		await weigh(f, 73, "2026-10-20");

		expect(healthStore.weightsBetween(f.db, undefined, "9999-12-31").map((row) => row.date)).toStrictEqual([
			"2026-10-20",
			"2026-10-24",
			"2026-10-25",
		]);
		await expect(weigh(f, 72, "2026-10-26")).rejects.toThrow(/2026-10-26 is in the future; today is 2026-10-25/);
		await expect(weigh(f, 72, "last tuesday")).rejects.toThrow(/YYYY-MM-DD, or today or yesterday/);
		await expect(weigh(f, 72, "1999-12-31")).rejects.toThrow(/too long ago/);
	});

	it("refuses a weight no scale shows, with a hint about the unit", async () => {
		const f = await open();

		await expect(weigh(f, 7.2)).rejects.toThrow(/7.2 kg \(7.2 kg\) is not a plausible body weight.*the unit/s);
		await expect(weigh(f, 724)).rejects.toThrow(/not a plausible body weight/);
		await expect(weigh(f, 12, undefined, { unit: "lb" })).rejects.toThrow(/5.44 kg.*not a plausible/s);
		expect(healthStore.weightsBetween(f.db, undefined, "9999-12-31")).toHaveLength(0);
	});

	it("keeps one weighing a day: a second one is refused with what to do, and replaces the first only when asked", async () => {
		const f = await open();
		await weigh(f, 72.4, undefined, { note: "after breakfast" });

		await expect(weigh(f, 71.9)).rejects.toThrow(
			/already logged for Sun 25 Oct 2026: 72.4 kg.*one weighing a day.*replace: true/s,
		);
		expect(healthStore.getWeight(f.db, TODAY)?.kg).toBe(72.4);

		const replaced = await weigh(f, 71.9, undefined, { replace: true });

		expect(healthStore.weightsBetween(f.db, undefined, "9999-12-31")).toHaveLength(1);
		expect(weightCard(replaced).event).toBe("updated");
		expect(textOf(replaced)).toContain("Updated the weight of Sun 25 Oct 2026 to 71.9 kg (it was 72.4 kg).");
		// No new note was given: the one that was there stays.
		expect(healthStore.getWeight(f.db, TODAY)).toMatchObject({ kg: 71.9, note: "after breakfast" });
	});

	it("does not undo a later correction when a replaced weighing's call is replayed (rule 8)", async () => {
		const f = await open();
		await weigh(f, 72.4);
		await weigh(f, 72, undefined, { replace: true }, "fix-1");
		await weigh(f, 71.5, undefined, { replace: true }, "fix-2");

		const replay = await weigh(f, 72, undefined, { replace: true }, "fix-1");

		expect(healthStore.getWeight(f.db, TODAY)?.kg).toBe(71.5);
		expect(weightCard(replay).event).toBe("updated");
	});

	it("writes no phantom weighing when a replaced weighing's call is replayed on another day with no date (rule 8)", async () => {
		const f = await open();
		await weigh(f, 72.4);
		await weigh(f, 72, undefined, { replace: true }, "fix-1");
		f.clock.now += 2 * DAY; // the replay comes on the 27th, when "today" is no longer the day that was corrected

		const replay = await weigh(f, 72, undefined, { replace: true }, "fix-1");

		expect(healthStore.weightsBetween(f.db, undefined, "9999-12-31").map((row) => [row.date, row.kg])).toStrictEqual([
			[TODAY, 72],
		]);
		expect(weightCard(replay)).toMatchObject({ event: "updated", day: { date: TODAY } });
	});

	it("shows an average that is exactly half-way between two tenths rounded once: 72.44 and 72.45 average 72.4 kg", async () => {
		const f = await open();
		await weigh(f, 72.44, "2026-10-24");

		const result = await weigh(f, 72.45, "2026-10-25");

		expect(textOf(result)).toContain("7-day average: 72.4 kg (2 entries).");
		expect(weightCard(result).avg7Kg).toBe(72.4);
		// The chart keeps two decimals: 72.445 is 72.45 there, from the same exact mean.
		const chart = (await f.callTool("weight_trend", { range: "7d" }, "t-half")).details as unknown as WeightChartCard;
		expect(chart.points.at(-1)?.avg7).toBe(72.45);
		expect(chart.summary.avg7Kg).toBe(72.4);
	});

	it("says how far the previous entry is without the 0.1 kg error of a floating point difference: 72.57 after 72.42 is +0.2", async () => {
		const f = await open();
		await weigh(f, 72.42, "2026-10-24");

		const result = await weigh(f, 72.57, "2026-10-25");

		expect(weightCard(result).previous).toMatchObject({ kg: 72.42, deltaKg: 0.2 });
		expect(textOf(result)).toContain("Previous entry: 72.42 kg on Sat 24 Oct 2026 (+0.2 kg).");
	});

	it("doubts a jump of exactly 4 kg (up or down) but not 3.9, and only against an entry within 14 days", async () => {
		const f = await open();
		await weigh(f, 70, "2026-10-20");
		const exactlyUp = await weigh(f, 74, "2026-10-21");
		const justUnder = await weigh(f, 77.9, "2026-10-22");
		const exactlyDown = await weigh(f, 73.9, "2026-10-23");

		expect(textOf(exactlyUp)).toMatch(/4 kg more than the previous entry.*Check with the owner/s);
		expect(textOf(justUnder)).not.toMatch(/Check with the owner/);
		expect(textOf(exactlyDown)).toMatch(/4 kg less than the previous entry.*Check with the owner/s);

		const g = await open();
		await weigh(g, 70, "2026-10-01");
		expect(textOf(await weigh(g, 75, "2026-10-15"))).toMatch(/Check with the owner/); // 14 days apart
		const h = await open();
		await weigh(h, 70, "2026-10-01");
		expect(textOf(await weigh(h, 75, "2026-10-16"))).not.toMatch(/Check with the owner/); // 15 days apart
	});

	it("tells the 7-day average and how far it is from the previous entry, and doubts a jump that looks like a typo", async () => {
		const f = await open({ health: { heightCm: 176 } });
		await weigh(f, 72.6, "2026-10-23");

		const next = await weigh(f, 72.4, "2026-10-24");
		const jump = await weigh(f, 78.1, "2026-10-25");

		expect(weightCard(next)).toMatchObject({
			kg: 72.4,
			avg7Kg: 72.5,
			avg7Entries: 2,
			previous: { date: "2026-10-23", kg: 72.6, deltaKg: -0.2 },
			bmi: 23.4,
		});
		expect(textOf(next)).toContain("7-day average: 72.5 kg (2 entries).");
		expect(textOf(next)).toContain("Previous entry: 72.6 kg on Fri 23 Oct 2026 (-0.2 kg).");
		expect(textOf(next)).toContain("BMI: 23.4 (height 176 cm).");
		expect(textOf(next)).not.toMatch(/Check with the owner/);
		expect(textOf(jump)).toMatch(/5.7 kg more than the previous entry.*Check with the owner.*replace: true/s);
		expect(healthStore.getWeight(f.db, "2026-10-25")?.kg).toBe(78.1); // it is saved: the owner decides
	});

	it("has no BMI without a height", async () => {
		const f = await open();

		const result = await weigh(f, 72.4);

		expect(weightCard(result)).not.toHaveProperty("bmi");
		expect(textOf(result)).not.toContain("BMI");
	});
});

describe("weight_trend", () => {
	async function seeded(f: Fixture): Promise<void> {
		for (const [date, kg] of [
			["2026-09-01", 76],
			["2026-10-12", 74],
			["2026-10-14", 73.6],
			["2026-10-16", 73.4],
			["2026-10-18", 73],
			["2026-10-20", 72.8],
			["2026-10-22", 72.6],
			["2026-10-24", 72.2],
			["2026-10-25", 72.4],
		] as const) {
			await weigh(f, kg, date);
		}
	}

	it("reports the change, the extremes, the average and the 7-day trend, and draws the line with its average", async () => {
		const f = await open({ health: { heightCm: 176 } });
		await seeded(f);

		const result = await f.callTool("weight_trend", { range: "14d" }, "t1");

		const text = textOf(result);
		expect(text).toContain("Weight, last 14 days (Mon 12 Oct 2026 to Sun 25 Oct 2026): 8 entries.");
		expect(text).toContain("Latest: 72.4 kg (Sun 25 Oct 2026). 7-day average: 72.5 kg (4 entries).");
		expect(text).toContain("Change over the range: -1.6 kg (74 kg on Mon 12 Oct 2026 to 72.4 kg).");
		expect(text).toContain("Trend (7-day average, first to latest): -1.5 kg.");
		expect(text).toContain("Lowest 72.2 kg (Sat 24 Oct 2026), highest 74 kg (Mon 12 Oct 2026), average 73 kg.");
		expect(text).toContain("BMI at the latest weight: 23.4 (height 176 cm).");
		const card = result.details as unknown as WeightChartCard;
		expect(card).toMatchObject({
			type: "weight_chart",
			heading: "Weight, last 14 days",
			rangeText: "Mon 12 Oct 2026 to Sun 25 Oct 2026",
			summary: {
				entries: 8,
				changeKg: -1.6,
				trendChangeKg: -1.5,
				avg7Kg: 72.5,
				avg7Entries: 4,
				bmi: 23.4,
				latest: { date: "2026-10-25", kg: 72.4, dateText: "Sun 25 Oct 2026" },
				min: { date: "2026-10-24", kg: 72.2 },
				max: { date: "2026-10-12", kg: 74 },
			},
		});
		expect(card.points).toHaveLength(8);
		expect(card.points[0]).toStrictEqual({ date: "2026-10-12", kg: 74, avg7: 74 });
		expect(card.points.at(-1)).toStrictEqual({ date: "2026-10-25", kg: 72.4, avg7: 72.5 });
		expect(card).not.toHaveProperty("thinned");
	});

	it("starts the average of the range where it would be had the range begun earlier", async () => {
		const f = await open();
		await weigh(f, 80, "2026-10-17");
		await weigh(f, 70, "2026-10-20");

		const card = (await f.callTool("weight_trend", { from: "2026-10-19", to: TODAY }, "t1"))
			.details as unknown as WeightChartCard;

		// 17 Oct is outside the range but inside the 7 days before 20 Oct: the first point's average is (80 + 70) / 2.
		expect(card.points).toStrictEqual([{ date: "2026-10-20", kg: 70, avg7: 75 }]);
	});

	it("thins a long history for the chart and keeps its numbers whole", async () => {
		const f = await open();
		for (let day = 0; day < 150; day++) {
			const date = new Date(Date.UTC(2026, 4, 1 + day)).toISOString().slice(0, 10);
			await weigh(f, 80 - day * 0.02, date);
		}

		const card = (await f.callTool("weight_trend", { range: "all" }, "t1")).details as unknown as WeightChartCard;

		expect(card.points).toHaveLength(90);
		expect(card.thinned).toBe(true);
		expect(card.summary.entries).toBe(150);
		expect(card.points[0]?.date).toBe("2026-05-01");
		expect(card.points.at(-1)?.date).toBe("2026-09-27");
	});

	it("says so, without a card, when nothing is logged in the range, and refuses a range it cannot read", async () => {
		const f = await open();
		await weigh(f, 72, "2026-08-01");

		const none = await f.callTool("weight_trend", { range: "7d" }, "t1");

		expect(textOf(none)).toBe("No weight is logged between Mon 19 Oct 2026 and Sun 25 Oct 2026.");
		expect(none.details).toBeUndefined();
		await expect(f.callTool("weight_trend", { range: "a month" }, "t2")).rejects.toThrow(/not understood/);
	});
});

describe("log_workout", () => {
	it("logs several exercises in one call under their canonical names, with 5 x 5 stored as five sets", async () => {
		const f = await open();

		const result = await workout(f, {
			date: "2026-10-23",
			note: "felt strong",
			exercises: [
				{ name: "squats", sets: [{ reps: 5, weight: 100, count: 5 }] },
				{
					name: "Bench-Press",
					sets: [
						{ reps: 8, weight: 60, count: 2 },
						{ reps: 6, weight: 65 },
					],
				},
				{ name: "pull ups", sets: [{ reps: 8, count: 3 }] },
			],
		});

		const card = result.details as unknown as WorkoutCard;
		expect(card).toMatchObject({ type: "workout", event: "logged" });
		expect(card.workout).toMatchObject({
			dateText: "Fri 23 Oct 2026",
			note: "felt strong",
			totalSets: 11,
			volumeKg: 3850,
		});
		expect(card.workout.exercises.map((exercise) => [exercise.name, exercise.kind, exercise.volumeKg])).toStrictEqual([
			["Squat", "weighted", 2500],
			["Bench press", "weighted", 1350],
			["Pull-up", "bodyweight", 0],
		]);
		expect(card.workout.exercises[1]?.groups).toStrictEqual([
			{ sets: 2, reps: 8, kg: 60 },
			{ sets: 1, reps: 6, kg: 65 },
		]);
		expect(card.workout.exercises[0]?.top).toStrictEqual({ kg: 100, reps: 5, e1rm: 116.7 });
		expect(textOf(result)).toBe(
			[
				`Logged workout Fri 23 Oct 2026 (${card.workout.id}): 3 exercises, 11 sets, volume 3,850 kg.`,
				"- Squat 5x5 100 kg",
				"- Bench press 2x8 60 kg, 1x6 65 kg",
				"- Pull-up 3x8",
			].join("\n"),
		);
		expect(setCount(f)).toBe(11);
		// The sets of an exercise are numbered 1.. within the session.
		expect(
			f.db
				.all<{ set_no: number }>(
					"SELECT set_no FROM health_set t JOIN health_exercise e ON e.id = t.exercise_id WHERE e.name = 'Squat' ORDER BY set_no",
				)
				.map((row) => row.set_no),
		).toStrictEqual([1, 2, 3, 4, 5]);
	});

	it("matches the owner's own exercises, their aliases and plurals before it creates anything", async () => {
		const f = await open();
		await workout(f, squats("2026-10-19", 100));

		await workout(f, { date: "2026-10-22", exercises: [{ name: "SQUAT", sets: [{ reps: 5, weight: 102.5 }] }] });
		await workout(f, { date: "2026-10-23", exercises: [{ name: "back squat", sets: [{ reps: 5, weight: 105 }] }] });

		expect(healthStore.listExercises(f.db).map((exercise) => exercise.name)).toStrictEqual(["Squat"]);
		expect(setCount(f)).toBe(7);
	});

	it("creates an exercise it does not know, says so, and takes its kind from the sets", async () => {
		const f = await open();

		const result = await workout(f, {
			exercises: [
				{ name: "CABLE CROSSOVER", sets: [{ reps: 12, weight: 15, count: 3 }] },
				{ name: "ab wheel", sets: [{ reps: 10, count: 3 }] },
			],
		});

		expect(healthStore.listExercises(f.db).map((exercise) => [exercise.name, exercise.kind])).toStrictEqual([
			["Ab wheel", "bodyweight"],
			["Cable crossover", "weighted"],
		]);
		expect(textOf(result)).toContain(
			'New exercise created: "Cable crossover" was not among the owner\'s exercises or the built-in names. Its sets had weights, so its progress is the estimated 1RM. Tell the owner;',
		);
		// The kind it was given is said, so a weight that was left out by mistake does not go unnoticed.
		expect(textOf(result)).toContain(
			'New exercise created: "Ab wheel" was not among the owner\'s exercises or the built-in names. No weight was given, so its progress is repetitions; if it has a load, give the weight',
		);
		expect(textOf(result)).toMatch(/propose_merge_exercises.*rename_exercise/s);
		expect(
			(result.details as unknown as WorkoutCard).workout.exercises.map((exercise) => exercise.created),
		).toStrictEqual([true, true]);
		const again = await workout(f, { exercises: [{ name: "cable crossovers", sets: [{ reps: 12, weight: 17.5 }] }] });
		expect(textOf(again)).not.toContain("New exercise created");
		expect(healthStore.listExercises(f.db)).toHaveLength(2);
	});

	it("does not announce an exercise that came from the built-in list", async () => {
		const f = await open();

		const result = await workout(f, squats("2026-10-23", 100));

		expect(textOf(result)).not.toContain("New exercise");
		expect(healthStore.listExercises(f.db)[0]).toMatchObject({ name: "Squat", kind: "weighted" });
		expect(healthStore.listExercises(f.db)[0]?.aliases).toContain("back squat");
	});

	it("converts pounds for every weight of the call and says it did", async () => {
		const f = await open();

		const result = await workout(f, { unit: "lb", ...squats("2026-10-23", 225, 5, 3) });

		const [squat] = (result.details as unknown as WorkoutCard).workout.exercises;
		expect(squat?.groups).toStrictEqual([{ sets: 3, reps: 5, kg: 102.06 }]);
		expect(textOf(result)).toContain("Weights were converted from lb to kg.");
	});

	it("refuses a weighted exercise with no weight, an impossible weight, and an exercise with no name, and saves nothing", async () => {
		const f = await open();

		await expect(workout(f, { exercises: [{ name: "bench", sets: [{ reps: 8 }] }] })).rejects.toThrow(
			/bench is a weighted exercise: every set needs a weight/,
		);
		await expect(workout(f, { exercises: [{ name: "squat", sets: [{ reps: 5, weight: 5000 }] }] })).rejects.toThrow(
			/5000 kg is not a plausible weight for one set/,
		);
		await expect(workout(f, { exercises: [{ name: "  ", sets: [{ reps: 5 }] }] })).rejects.toThrow(/needs a name/);
		await expect(workout(f, squats("2026-10-26", 100))).rejects.toThrow(/in the future/);

		expect(sessions(f)).toHaveLength(0);
		expect(healthStore.listExercises(f.db)).toHaveLength(0);
	});

	it("writes a session whole or not at all: a bad exercise in the middle leaves nothing behind", async () => {
		const f = await open();

		await expect(
			workout(f, {
				exercises: [
					{ name: "squat", sets: [{ reps: 5, weight: 100 }] },
					{ name: "!!!", sets: [{ reps: 5, weight: 20 }] },
				],
			}),
		).rejects.toThrow(/'!!!' is not an exercise name/);

		expect(sessions(f)).toHaveLength(0);
		expect(setCount(f)).toBe(0);
		expect(healthStore.listExercises(f.db)).toHaveLength(0);
	});

	it("writes once however often the call is replayed, on whatever day, and answers with the same session (rule 8)", async () => {
		const f = await open();
		const args = {
			exercises: [
				{ name: "squat", sets: [{ reps: 5, weight: 100, count: 5 }] },
				{ name: "cable crossover", sets: [{ reps: 12, weight: 15, count: 3 }] },
			],
		};

		const first = await workout(f, args, "call-W");
		f.clock.now += 3 * DAY;
		const replay = await workout(f, args, "call-W");

		expect(sessions(f)).toHaveLength(1);
		expect(sessions(f)[0]?.date).toBe(TODAY);
		expect(setCount(f)).toBe(8);
		expect((replay.details as unknown as WorkoutCard).workout.id).toBe(
			(first.details as unknown as WorkoutCard).workout.id,
		);
		expect(textOf(replay).split("\n")[0]).toBe(textOf(first).split("\n")[0]);
		// Two different calls are two sessions, even with the same sets.
		await workout(f, args, "call-W2");
		expect(sessions(f)).toHaveLength(2);
		expect(setCount(f)).toBe(16);
	});

	it("treats an exercise named twice in one call as one, and carries its set numbers on", async () => {
		const f = await open();

		const result = await workout(f, {
			exercises: [
				{ name: "bench", sets: [{ reps: 8, weight: 60, count: 2 }] },
				{ name: "squat", sets: [{ reps: 5, weight: 100 }] },
				{ name: "Bench press", sets: [{ reps: 6, weight: 65 }] },
			],
		});

		expect(healthStore.listExercises(f.db).map((exercise) => exercise.name)).toStrictEqual(["Bench press", "Squat"]);
		const bench = f.db
			.all<{ set_no: number; reps: number }>(
				"SELECT t.set_no, t.reps FROM health_set t JOIN health_exercise e ON e.id = t.exercise_id WHERE e.name = 'Bench press' ORDER BY t.set_no",
			)
			.map((row) => [row.set_no, row.reps]);
		expect(bench).toStrictEqual([
			[1, 8],
			[2, 8],
			[3, 6],
		]);
		expect(textOf(result)).toContain("- Bench press 2x8 60 kg, 1x6 65 kg");
	});

	it("flags a record only when the session beats every earlier one, and not the first time or an equal one", async () => {
		const f = await open();

		const first = await workout(f, squats("2026-10-19", 100));
		const equal = await workout(f, squats("2026-10-21", 100));
		const better = await workout(f, squats("2026-10-22", 102.5));
		const worse = await workout(f, squats("2026-10-23", 90));

		const prOf = (result: { details?: unknown }) => (result.details as unknown as WorkoutCard).workout.exercises[0]?.pr;
		expect(prOf(first)).toBeUndefined();
		expect(prOf(equal)).toBeUndefined();
		expect(prOf(better)).toStrictEqual({ previous: 116.7 });
		expect(prOf(worse)).toBeUndefined();
		expect(textOf(better)).toContain("- Squat 5x5 102.5 kg — new PR: estimated 1RM 119.6 kg (was 116.7 kg)");
	});

	it("judges a late-logged workout against what came before its day, not against later days", async () => {
		const f = await open();
		await workout(f, squats("2026-10-23", 110));

		const late = await workout(f, squats("2026-10-19", 100));
		const later = await workout(f, squats("2026-10-21", 105));

		expect((late.details as unknown as WorkoutCard).workout.exercises[0]?.pr).toBeUndefined();
		expect((later.details as unknown as WorkoutCard).workout.exercises[0]?.pr).toStrictEqual({ previous: 116.7 });
	});

	it("flags a record for a bodyweight exercise by reps", async () => {
		const f = await open();
		await workout(f, { date: "2026-10-19", exercises: [{ name: "pull-up", sets: [{ reps: 8, count: 3 }] }] });

		const result = await workout(f, {
			date: "2026-10-23",
			exercises: [{ name: "pull-up", sets: [{ reps: 10 }, { reps: 8 }] }],
		});

		expect(textOf(result)).toContain("- Pull-up 1x10, 1x8 — new PR: 10 reps in a set (was 8)");
	});
});

describe("exercise_progress", () => {
	async function seeded(f: Fixture): Promise<void> {
		await workout(f, squats("2026-08-01", 90)); // before the 90-day range
		await workout(f, squats("2026-10-19", 100));
		await workout(f, squats("2026-10-22", 102.5));
		await workout(f, {
			date: "2026-10-25",
			exercises: [
				{
					name: "squat",
					sets: [
						{ reps: 5, weight: 105, count: 2 },
						{ reps: 3, weight: 110 },
					],
				},
				{ name: "bench", sets: [{ reps: 8, weight: 60 }] },
			],
		});
	}

	it("gives the top set, the estimated 1RM and the volume of each day, the records and the change", async () => {
		const f = await open();
		await seeded(f);

		const result = await f.callTool("exercise_progress", { exercise: "squats", range: "14d" }, "p1");

		const card = result.details as unknown as ExerciseChartCard;
		expect(card).toMatchObject({
			type: "exercise_chart",
			exercise: "Squat",
			kind: "weighted",
			metric: "e1rm",
			heading: "Squat, last 14 days",
		});
		// 19 Oct already beats 1 Aug (90 kg), which is before the range: a record is judged against the whole history.
		expect(card.points).toStrictEqual([
			{ date: "2026-10-19", top: { kg: 100, reps: 5 }, e1rm: 116.7, volumeKg: 2500, totalReps: 25, pr: true },
			{ date: "2026-10-22", top: { kg: 102.5, reps: 5 }, e1rm: 119.6, volumeKg: 2562.5, totalReps: 25, pr: true },
			{ date: "2026-10-25", top: { kg: 105, reps: 5 }, e1rm: 122.5, volumeKg: 1380, totalReps: 13, pr: true },
		]);
		expect(card.summary).toMatchObject({
			sessions: 3,
			sets: 13,
			change: 5.8,
			heaviestKg: 110,
			prs: 3,
			best: { top: { kg: 105, reps: 5 }, e1rm: 122.5, day: { date: "2026-10-25" } },
			allTimeBest: { e1rm: 122.5 },
			first: { day: { date: "2026-10-19" } },
			last: { day: { date: "2026-10-25" } },
		});
		const text = textOf(result);
		expect(text).toContain("Squat, last 14 days (Mon 12 Oct 2026 to Sun 25 Oct 2026): 3 days, 13 sets.");
		expect(text).toContain(
			"Best day (highest estimated 1RM, Epley): 105 kg x 5 = est. 1RM 122.5 kg on Sun 25 Oct 2026.",
		);
		expect(text).toContain(
			"Change from the first to the latest day of the range: +5.8 kg (116.7 kg on Mon 19 Oct 2026 to 122.5 kg on Sun 25 Oct 2026).",
		);
		expect(text).toContain("Heaviest weight: 110 kg.");
		expect(text).toContain(
			"Personal records in the range: 3: Mon 19 Oct 2026 116.7 kg (was 105); Thu 22 Oct 2026 119.6 kg (was 116.7); Sun 25 Oct 2026 122.5 kg (was 119.6).",
		);
		expect(text).toContain("- Thu 22 Oct 2026: top 102.5 kg x 5, est. 1RM 119.6 kg, volume 2,563 kg, 5 sets — PR");
	});

	it("counts a record against the whole history, not only the range, and reports the best ever when it is older", async () => {
		const f = await open();
		await workout(f, squats("2026-08-01", 120)); // the best ever, before the range
		await workout(f, squats("2026-10-19", 100));
		await workout(f, squats("2026-10-22", 105)); // a best of the range, not a record

		const result = await f.callTool("exercise_progress", { exercise: "squat", range: "14d" }, "p1");

		const card = result.details as unknown as ExerciseChartCard;
		expect(card.points.map((point) => point.pr)).toStrictEqual([undefined, undefined]);
		expect(card.summary).toMatchObject({ prs: 0, allTimeBest: { day: { date: "2026-08-01" }, e1rm: 140 } });
		expect(textOf(result)).toContain("Best ever: 120 kg x 5 = est. 1RM 140 kg on Sat 1 Aug 2026.");
		expect(textOf(result)).toContain("No new personal record in the range.");
	});

	it("measures a bodyweight exercise in reps and has no estimated 1RM", async () => {
		const f = await open();
		await workout(f, { date: "2026-10-19", exercises: [{ name: "pull-up", sets: [{ reps: 8, count: 3 }] }] });
		await workout(f, { date: "2026-10-25", exercises: [{ name: "pull-up", sets: [{ reps: 10 }, { reps: 9 }] }] });

		const result = await f.callTool("exercise_progress", { exercise: "pull ups" }, "p1");

		const card = result.details as unknown as ExerciseChartCard;
		expect(card).toMatchObject({ kind: "bodyweight", metric: "reps" });
		expect(card.points[1]).toStrictEqual({
			date: "2026-10-25",
			top: { kg: 0, reps: 10 },
			volumeKg: 0,
			totalReps: 19,
			pr: true,
		});
		expect(card.summary.change).toBe(2);
		expect(textOf(result)).toContain("Change from the first to the latest day of the range: +2 reps");
		expect(textOf(result)).toContain("Total reps: 43.");
		expect(textOf(result)).not.toContain("1RM");
	});

	it("merges two workouts of one day into one point", async () => {
		const f = await open();
		await workout(f, squats("2026-10-25", 100, 5, 3));
		await workout(f, squats("2026-10-25", 105, 3, 2));

		const card = (await f.callTool("exercise_progress", { exercise: "squat" }, "p1"))
			.details as unknown as ExerciseChartCard;

		expect(card.points).toHaveLength(1);
		expect(card.points[0]).toMatchObject({ top: { kg: 100, reps: 5 }, totalReps: 21, volumeKg: 1500 + 630 });
	});

	it("names the exercises there are when the name is unknown, and says when nothing is logged in the range", async () => {
		const f = await open();
		await expect(f.callTool("exercise_progress", { exercise: "squat" }, "p0")).rejects.toThrow(
			/No exercise has been logged yet/,
		);
		await seeded(f);

		await expect(f.callTool("exercise_progress", { exercise: "curls" }, "p1")).rejects.toThrow(
			/No exercise called 'curls'. Logged exercises: Bench press, Squat\./,
		);
		const empty = await f.callTool(
			"exercise_progress",
			{ exercise: "bench", from: "2026-10-01", to: "2026-10-20" },
			"p2",
		);
		expect(textOf(empty)).toBe("No sets of Bench press are logged between Thu 1 Oct 2026 and Tue 20 Oct 2026.");
		expect(empty.details).toBeUndefined();
	});
});

describe("list_workouts", () => {
	it("lists the workouts of a range newest first with the ids that delete takes, and says how many there are", async () => {
		const f = await open();
		await workout(f, squats("2026-10-19", 100));
		await workout(f, {
			date: "2026-10-22",
			note: "short",
			exercises: [{ name: "bench", sets: [{ reps: 8, weight: 60, count: 3 }] }],
		});
		await workout(f, squats("2026-10-25", 105));
		await workout(f, squats("2026-08-01", 90));

		const result = await f.callTool("list_workouts", { range: "14d", limit: 2 }, "l1");

		const card = result.details as unknown as WorkoutListCard;
		expect(card).toMatchObject({ type: "workout_list", heading: "Workouts, last 14 days", total: 3 });
		expect(card.workouts.map((entry) => entry.date)).toStrictEqual(["2026-10-25", "2026-10-22"]);
		const [newest, older] = card.workouts;
		expect(textOf(result)).toBe(
			[
				"Workouts, last 14 days: 3 (showing 2 of 3)",
				`Sun 25 Oct 2026 (${newest?.id}): 1 exercise, 5 sets, volume 2,625 kg`,
				"- Squat 5x5 105 kg",
				`Thu 22 Oct 2026 (${older?.id}): 1 exercise, 3 sets, volume 1,440 kg`,
				"- Bench press 3x8 60 kg",
				"  note: short",
			].join("\n"),
		);
		expect(textOf(await f.callTool("list_workouts", { from: "2026-10-23", to: "2026-10-24" }, "l2"))).toBe(
			"No workouts are logged between Fri 23 Oct 2026 and Sat 24 Oct 2026.",
		);
	});
});

describe("deleting needs the owner's approval (rule 3)", () => {
	async function loggedWorkout(f: Fixture): Promise<string> {
		await workout(f, {
			date: "2026-10-22",
			exercises: [{ name: "cable crossover", sets: [{ reps: 12, weight: 15, count: 3 }] }],
		});
		await workout(f, squats("2026-10-23", 100));
		return healthStore.sessionsOn(f.db, "2026-10-22")[0]?.id ?? "";
	}

	it("asks first, deletes only after Approve, and drops an exercise that was left with no set", async () => {
		const f = await open();
		const id = await loggedWorkout(f);
		f.faux.setResponses([toolCall("propose_delete_workout", { session_id: id }, "propose-1"), say("Please approve.")]);
		await f.say("delete that crossover workout");

		const result = await lastResult(f);
		const card = result.details as unknown as ApprovalCard;
		expect(card).toMatchObject({
			type: "approval",
			summary: "Delete the workout of Thu 22 Oct 2026 (1 exercise, 3 sets, volume 540 kg)",
		});
		expect(resultText(result)).toContain("Nothing is deleted yet");
		expect(healthStore.getSession(f.db, id)).toBeDefined();

		await f.deps.approvals.decide(card.actionId, "approve", "button");

		expect(healthStore.getSession(f.db, id)).toBeUndefined();
		expect(sessions(f)).toHaveLength(1);
		expect(healthStore.listExercises(f.db).map((exercise) => exercise.name)).toStrictEqual(["Squat"]);
		expect(setCount(f)).toBe(5);
	});

	it("blocks a direct delete_workout or delete_weight, and one approved for something else", async () => {
		const f = await open();
		const id = await loggedWorkout(f);
		await weigh(f, 72.4);
		const other = healthStore.sessionsOn(f.db, "2026-10-23")[0]?.id ?? "";

		f.faux.setResponses([toolCall("delete_workout", { session_id: id }, "sneaky-1"), say("ok")]);
		await f.say("delete it");
		expect((await lastResult(f)).isError).toBe(true);
		expect(resultText(await lastResult(f))).toMatch(
			/Blocked: delete_workout .* needs the owner's approval.*propose_delete_workout/s,
		);
		f.faux.setResponses([toolCall("delete_weight", { date: TODAY }, "sneaky-2"), say("ok")]);
		await f.say("delete the weight");
		expect(resultText(await lastResult(f))).toMatch(/Blocked: delete_weight .*propose_delete_weight/s);

		f.faux.setResponses([toolCall("propose_delete_workout", { session_id: other }, "propose-2"), say("approve?")]);
		await f.say("delete the squats");
		const card = (await lastResult(f)).details as unknown as ApprovalCard;
		await f.deps.approvals.decide(card.actionId, "approve", "button");
		// The approval was for the squat workout: the crossover workout is still protected.
		f.faux.setResponses([toolCall("delete_workout", { session_id: id }, "sneaky-3"), say("ok")]);
		await f.say("and the other");
		expect(resultText(await lastResult(f))).toMatch(/Blocked/);
		expect(healthStore.getSession(f.db, id)).toBeDefined();
		expect(healthStore.getWeight(f.db, TODAY)).toBeDefined();
	});

	it("deletes the weighing of a day when approved, and not otherwise", async () => {
		const f = await open();
		await weigh(f, 72.4);
		await weigh(f, 72.6, "yesterday");
		f.faux.setResponses([toolCall("propose_delete_weight", { date: "yesterday" }, "propose-w"), say("approve?")]);
		await f.say("delete yesterday's weight");
		const result = await lastResult(f);
		const card = result.details as unknown as ApprovalCard;
		expect(card.summary).toBe("Delete the weight logged for Sat 24 Oct 2026 (72.6 kg)");

		const denied = await f.deps.approvals.decide(card.actionId, "deny", "button");

		expect(denied.status).toBe("denied");
		expect(healthStore.weightsBetween(f.db, undefined, "9999-12-31")).toHaveLength(2);
		f.faux.setResponses([toolCall("propose_delete_weight", { date: "2026-10-24" }, "propose-w2"), say("approve?")]);
		await f.say("really delete it");
		const again = (await lastResult(f)).details as unknown as ApprovalCard;
		await f.deps.approvals.decide(again.actionId, "approve", "button");
		expect(healthStore.weightsBetween(f.db, undefined, "9999-12-31").map((row) => row.date)).toStrictEqual([TODAY]);
	});

	it("refuses to propose deleting what is not there, with where to look", async () => {
		const f = await open();

		await expect(f.callTool("propose_delete_weight", { date: "2026-10-20" }, "d1")).rejects.toThrow(
			/No weight is logged for Tue 20 Oct 2026. weight_trend shows what there is/,
		);
		await expect(f.callTool("propose_delete_workout", { session_id: "w_nope" }, "d2")).rejects.toThrow(
			/No workout 'w_nope'. list_workouts shows the ids that exist/,
		);
	});
});

describe("the health prompt section", () => {
	const render = (f: Fixture, health?: { heightCm?: number }) =>
		renderHealthSection({ db: f.db, timezone: TIMEZONE, ...(health === undefined ? {} : { health }) });

	it("says plainly that nothing is logged yet", async () => {
		const f = await open();

		expect(render(f)).toBe("No weight logged yet.\nNo workouts logged yet.");
	});

	it("gives the latest weight with its average, the last workout, the records of the five exercises trained last, and the names", async () => {
		const f = await open();
		await weigh(f, 72.8, "2026-10-23");
		await weigh(f, 72.4, "2026-10-25");
		for (const [index, name] of ["squat", "bench", "deadlift", "ohp", "barbell row", "curl", "pull-up"].entries()) {
			await workout(f, {
				date: `2026-10-${String(10 + index).padStart(2, "0")}`,
				exercises: [{ name, sets: [{ reps: 5, ...(name === "pull-up" ? {} : { weight: 100 }) }] }],
			});
		}
		await workout(f, { date: "2026-10-12", exercises: [{ name: "squat", sets: [{ reps: 5, weight: 110 }] }] });

		expect(render(f, { heightCm: 176 })).toBe(
			[
				"Latest weight: 72.4 kg on Sun 25 Oct 2026 (7-day average up to that day: 72.6 kg from 2 entries). BMI 23.4 (height 176 cm).",
				"Last workout: Fri 16 Oct 2026.",
				"Current records of the exercises trained most recently (best estimated 1RM; for bodyweight exercises the most reps in a set, or the estimated 1RM of the added weight once a set had any):",
				"- Pull-up: 5 reps (Fri 16 Oct 2026)",
				"- Biceps curl: est. 1RM 116.7 kg (100 kg x 5, Thu 15 Oct 2026)",
				"- Barbell row: est. 1RM 116.7 kg (100 kg x 5, Wed 14 Oct 2026)",
				"- Overhead press: est. 1RM 116.7 kg (100 kg x 5, Tue 13 Oct 2026)",
				"- Deadlift: est. 1RM 116.7 kg (100 kg x 5, Mon 12 Oct 2026)",
				"Exercises logged: Barbell row, Bench press, Biceps curl, Deadlift, Overhead press, Pull-up, Squat.",
			].join("\n"),
		);
	});

	it("renders the same bytes however much time passes, so the provider's prompt cache stays warm", async () => {
		const f = await open();
		await weigh(f, 72.4);
		await workout(f, squats(TODAY, 100));

		const before = render(f);
		f.clock.now += 40 * DAY;

		expect(render(f)).toBe(before);
		expect(before).not.toMatch(/today|now|ago|overdue/i);
	});

	it("is the section the health extension offers, and changes only when something is logged", async () => {
		const f = await open();
		const first = render(f);
		await weigh(f, 72.4);

		expect(render(f)).not.toBe(first);
		expect(render(f)).toContain("Latest weight: 72.4 kg");
	});
});

describe("what the health log says for the daily jobs", () => {
	const facts = (
		f: Fixture,
		job: "briefing" | "wrapup",
		date = TODAY,
		now = at(date, job === "briefing" ? "07:30" : "21:00"),
	) =>
		Object.fromEntries(
			collectFacts(f.deps.facts(), job, dayWindow(date, now, TIMEZONE)).sections.map((section) => [
				section.title,
				section.lines,
			]),
		);

	it("tells the evening what was weighed and trained, and the records the day set", async () => {
		const f = await open();
		await weigh(f, 72.8, "2026-10-23");
		await weigh(f, 72.4);
		await workout(f, squats("2026-10-22", 100));
		await workout(f, {
			date: TODAY,
			exercises: [
				{ name: "squat", sets: [{ reps: 5, weight: 105, count: 5 }] },
				{ name: "pull-up", sets: [{ reps: 8, count: 3 }] },
			],
		});
		await workout(f, { date: "2026-10-24", exercises: [{ name: "pull-up", sets: [{ reps: 6, count: 3 }] }] });

		expect(facts(f, "wrapup")["Health today"]).toStrictEqual([
			"Weighed 72.4 kg (7-day average 72.6 kg)",
			"Trained: Squat 5x5 105 kg; Pull-up 3x8",
			"New personal records: Squat (estimated 1RM 122.5 kg, was 116.7 kg); Pull-up (8 reps in a set, was 6)",
		]);
	});

	it("has nothing to say about a day with nothing logged, and does not nag in the evening about a weight", async () => {
		const f = await open();
		await weigh(f, 72.4, "2026-10-24");

		expect(facts(f, "wrapup")).toStrictEqual({});
		expect(facts(f, "wrapup", "2026-10-24")["Health today"]).toStrictEqual(["Weighed 72.4 kg (7-day average 72.4 kg)"]);
	});

	it("nudges in the morning when yesterday's weight is missing, naming the last one", async () => {
		const f = await open();
		await weigh(f, 72.8, "2026-10-22");
		await weigh(f, 72.6, "2026-10-23");

		expect(facts(f, "briefing").Health).toStrictEqual([
			"No weight was logged yesterday (Sat 24 Oct 2026); the last one was 72.6 kg on Fri 23 Oct 2026. The owner logs it with the Health agent.",
		]);
	});

	it("does not nudge when today's weight is in even though yesterday's is missing, and does when it is not", async () => {
		const f = await open();
		await weigh(f, 72.6, "2026-10-23"); // 24 Oct, yesterday, is missing
		await weigh(f, 72.4, TODAY);
		expect(facts(f, "briefing")).toStrictEqual({});

		const g = await open();
		await weigh(g, 72.6, "2026-10-23");
		expect(facts(g, "briefing").Health).toHaveLength(1);
	});

	it("does not nudge when yesterday or today is logged, for someone who never logged, or for someone who stopped", async () => {
		const f = await open();
		expect(facts(f, "briefing")).toStrictEqual({}); // never logged

		await weigh(f, 72.6, "2026-10-23");
		await weigh(f, 72.4, "2026-10-24");
		expect(facts(f, "briefing")).toStrictEqual({}); // yesterday is there
		await weigh(f, 72.2, TODAY);
		expect(facts(f, "briefing", "2026-10-26")).toStrictEqual({}); // yesterday (the 25th) is there
		expect(facts(f, "briefing", "2026-10-25")).toStrictEqual({}); // today is there already

		// The latest entry is 15 days before yesterday: the owner stopped logging, so there is no line every morning.
		const g = await open();
		await weigh(g, 72.4, "2026-10-09");
		expect(facts(g, "briefing", "2026-10-25")).toStrictEqual({});
		await weigh(g, 72.4, "2026-10-10");
		expect(NUDGE_WINDOW_DAYS).toBe(14);
		expect(facts(g, "briefing", "2026-10-25").Health).toHaveLength(1);
	});
});

describe("an exercise's kind and what its progress is measured in", () => {
	const dips = async (f: Fixture) => {
		await workout(f, { date: "2026-10-19", exercises: [{ name: "dips", sets: [{ reps: 8, count: 3 }] }] });
		await workout(f, { date: "2026-10-22", exercises: [{ name: "dips", sets: [{ reps: 8, weight: 20, count: 3 }] }] });
		return await workout(f, {
			date: "2026-10-25",
			exercises: [{ name: "dips", sets: [{ reps: 5, weight: 30, count: 3 }] }],
		});
	};
	const progress = async (f: Fixture, exercise: string, id = "p-kind") =>
		await f.callTool("exercise_progress", { exercise, range: "14d" }, id);

	it("follows added weight on a bodyweight exercise: loaded dips (8, then 8 with 20 kg, then 5 with 30 kg) are progress", async () => {
		const f = await open();
		await dips(f);

		const result = await progress(f, "dip");

		const card = result.details as unknown as ExerciseChartCard;
		expect(card).toMatchObject({ exercise: "Dip", kind: "bodyweight", metric: "e1rm" });
		expect(card.points.map((point) => [point.date, point.e1rm, point.pr])).toStrictEqual([
			["2026-10-19", 0, undefined],
			["2026-10-22", 25.3, true],
			["2026-10-25", 35, true],
		]);
		expect(card.summary).toMatchObject({ change: 35, prs: 2, heaviestKg: 30, best: { e1rm: 35 } });
		const text = textOf(result);
		expect(text).toContain(
			"Best day (highest estimated 1RM of the added weight, Epley): 5 reps +30 kg = est. 1RM of the added weight 35 kg on Sun 25 Oct 2026.",
		);
		expect(text).toContain(
			"Change from the first to the latest day of the range: +35 kg (0 kg on Mon 19 Oct 2026 to 35 kg on Sun 25 Oct 2026).",
		);
		expect(text).toContain("Heaviest added weight: 30 kg. Total reps: 63.");
		expect(text).toContain(
			"Personal records in the range: 2: Thu 22 Oct 2026 25.3 kg (was 0); Sun 25 Oct 2026 35 kg (was 25.3).",
		);
		expect(text).toContain(
			"- Sun 25 Oct 2026: top 5 reps +30 kg, est. 1RM of the added weight 35 kg, total reps 15, 3 sets — PR",
		);
		expect(text).not.toContain("Total volume");
	});

	it("announces a record for added weight when the workout is logged, and says what the 1RM is of", async () => {
		const f = await open();

		const last = await dips(f);

		const [dip] = (last.details as unknown as WorkoutCard).workout.exercises;
		expect(dip).toMatchObject({
			kind: "bodyweight",
			metric: "e1rm",
			top: { kg: 30, reps: 5, e1rm: 35 },
			pr: { previous: 25.3 },
		});
		expect(textOf(last)).toContain("- Dip 3x5 +30 kg — new PR: estimated 1RM of the added weight 35 kg (was 25.3 kg)");
	});

	it("does not count unloaded reps as a record once the exercise has been loaded, and orders unloaded days by reps", async () => {
		const f = await open();
		await dips(f);

		const more = await workout(f, { date: "2026-10-25", exercises: [{ name: "dip", sets: [{ reps: 20 }] }] });

		expect(textOf(more)).not.toContain("new PR");
		expect(textOf(more)).toContain("- Dip 1x20");
		const card = (await progress(f, "dip", "p-more")).details as unknown as ExerciseChartCard;
		expect(card.points.at(-1)).toMatchObject({ date: "2026-10-25", top: { kg: 30, reps: 5 }, e1rm: 35, totalReps: 35 });
	});

	it("reads an unloaded day of a loaded exercise as 0 kg added in a list of workouts, with the exercise's own metric", async () => {
		const f = await open();
		await dips(f);

		const card = (await f.callTool("list_workouts", { range: "14d" }, "l-dips")).details as unknown as WorkoutListCard;

		const [newest, , oldest] = card.workouts;
		expect(newest?.exercises[0]).toMatchObject({ metric: "e1rm", top: { kg: 30, reps: 5, e1rm: 35 } });
		expect(oldest?.exercises[0]).toMatchObject({ metric: "e1rm", top: { kg: 0, reps: 8, e1rm: 0 } });
	});

	it("keeps a bodyweight exercise that was never loaded measured in reps", async () => {
		const f = await open();
		await workout(f, { date: "2026-10-19", exercises: [{ name: "dip", sets: [{ reps: 8, count: 3 }] }] });
		await workout(f, { date: "2026-10-25", exercises: [{ name: "dip", sets: [{ reps: 10 }] }] });

		const card = (await progress(f, "dip")).details as unknown as ExerciseChartCard;

		expect(card).toMatchObject({ kind: "bodyweight", metric: "reps" });
		expect(card.points.every((point) => point.e1rm === undefined)).toBe(true);
	});

	it("puts the load in the prompt's records and in the evening's facts for a loaded bodyweight exercise", async () => {
		const f = await open();
		await dips(f);

		expect(renderHealthSection({ db: f.db, timezone: TIMEZONE })).toContain(
			"- Dip: est. 1RM of the added weight 35 kg (5 reps +30 kg, Sun 25 Oct 2026)",
		);
		const facts = Object.fromEntries(
			collectFacts(f.deps.facts(), "wrapup", dayWindow(TODAY, at(TODAY, "21:00"), TIMEZONE)).sections.map((section) => [
				section.title,
				section.lines,
			]),
		);
		expect(facts["Health today"]).toContain(
			"New personal records: Dip (estimated 1RM of the added weight 35 kg, was 25.3 kg)",
		);
	});

	it("tracks a new exercise first logged with no weight by its load once a set has one (a weight left out, or '20s' said later)", async () => {
		const f = await open();
		await workout(f, { date: "2026-10-20", exercises: [{ name: "cable crossover", sets: [{ reps: 12, count: 3 }] }] });
		await workout(f, {
			date: "2026-10-23",
			exercises: [{ name: "cable crossover", sets: [{ reps: 12, weight: 15, count: 3 }] }],
		});
		const last = await workout(f, {
			date: "2026-10-25",
			exercises: [{ name: "cable crossover", sets: [{ reps: 12, weight: 20, count: 3 }] }],
		});

		const result = await progress(f, "cable crossover");

		const card = result.details as unknown as ExerciseChartCard;
		expect(card).toMatchObject({ kind: "bodyweight", metric: "e1rm" });
		expect(card.points.map((point) => [point.e1rm, point.pr])).toStrictEqual([
			[0, undefined],
			[21, true],
			[28, true],
		]);
		expect(card.summary).toMatchObject({ change: 28, prs: 2 });
		expect(textOf(last)).toContain(
			"- Cable crossover 3x12 +20 kg — new PR: estimated 1RM of the added weight 28 kg (was 21 kg)",
		);
		// Nothing about it had to be deleted and logged again: one exercise, three workouts.
		expect(healthStore.listExercises(f.db).map((exercise) => exercise.name)).toStrictEqual(["Cable crossover"]);
		expect(sessions(f)).toHaveLength(3);
	});

	it("tells the model which kind a new exercise got, and that giving its weight later changes how it is followed", async () => {
		const f = await open();

		const unloaded = await workout(f, { exercises: [{ name: "ab wheel", sets: [{ reps: 10, count: 3 }] }] });
		const loaded = await workout(f, { exercises: [{ name: "cable crossover", sets: [{ reps: 12, weight: 15 }] }] });

		expect(textOf(unloaded)).toContain(
			"No weight was given, so its progress is repetitions; if it has a load, give the weight when you log it next time and its progress follows the load.",
		);
		expect(textOf(loaded)).toContain("Its sets had weights, so its progress is the estimated 1RM.");
	});
});

describe("a weighted exercise done with no weight (its bodyweight version)", () => {
	it("is refused with the name to use instead, whether the weight is left out or given as 0, and nothing is saved", async () => {
		const f = await open();

		for (const [typed, twin] of [
			["lunges", "Bodyweight lunge"],
			["calf raises", "Bodyweight calf raise"],
			["squats", "Bodyweight squat"],
			["hip thrusts", "Bodyweight hip thrust"],
		] as const) {
			const named = new RegExp(
				`every set needs a weight.*If it really was done with no weight, log it as '${twin}' instead`,
				"s",
			);
			await expect(workout(f, { exercises: [{ name: typed, sets: [{ reps: 12, count: 3 }] }] }), typed).rejects.toThrow(
				named,
			);
			await expect(
				workout(f, { exercises: [{ name: typed, sets: [{ reps: 12, weight: 0, count: 3 }] }] }),
				`${typed} with weight 0`,
			).rejects.toThrow(named);
		}

		expect(sessions(f)).toHaveLength(0);
		expect(healthStore.listExercises(f.db)).toHaveLength(0);
	});

	it("logs under the bodyweight name as its own exercise, with no 'new exercise' note, and leaves the weighted one alone", async () => {
		const f = await open();

		const unloaded = await workout(f, { exercises: [{ name: "bodyweight lunges", sets: [{ reps: 12, count: 3 }] }] });
		const loaded = await workout(f, { exercises: [{ name: "lunge", sets: [{ reps: 8, weight: 40, count: 3 }] }] });

		const [twin] = (unloaded.details as unknown as WorkoutCard).workout.exercises;
		expect(twin).toMatchObject({ name: "Bodyweight lunge", kind: "bodyweight", metric: "reps" });
		expect(textOf(unloaded)).not.toContain("New exercise");
		expect(textOf(loaded)).not.toContain("New exercise");
		expect(healthStore.listExercises(f.db).map((exercise) => [exercise.name, exercise.kind])).toStrictEqual([
			["Bodyweight lunge", "bodyweight"],
			["Lunge", "weighted"],
		]);
	});

	it("names the bodyweight version of an exercise the owner made up, too", async () => {
		const f = await open();
		await workout(f, { exercises: [{ name: "cable crossover", sets: [{ reps: 12, weight: 15 }] }] });

		await expect(workout(f, { exercises: [{ name: "cable crossovers", sets: [{ reps: 12 }] }] })).rejects.toThrow(
			/cable crossovers is a weighted exercise.*'Bodyweight cable crossover' instead/s,
		);
	});
});

describe("log_workout records and replays", () => {
	it("announces a record per session: a second session on a day beats the first, while the day counts one record", async () => {
		const f = await open();
		await workout(f, squats("2026-10-19", 100));

		const morning = await workout(f, squats("2026-10-25", 105));
		const evening = await workout(f, squats("2026-10-25", 110));

		const prOf = (result: { details?: unknown }) => (result.details as unknown as WorkoutCard).workout.exercises[0]?.pr;
		expect(prOf(morning)).toStrictEqual({ previous: 116.7 });
		expect(prOf(evening)).toStrictEqual({ previous: 122.5 });
		const card = (await f.callTool("exercise_progress", { exercise: "squat", range: "14d" }, "p-day"))
			.details as unknown as ExerciseChartCard;
		expect(card.summary.prs).toBe(1);
		expect(card.points.map((point) => point.pr)).toStrictEqual([undefined, true]);
	});

	it("answers a replayed call with the same text and card as the first run: the records and the new exercise included", async () => {
		const f = await open();
		await workout(f, squats("2026-10-19", 100));
		const args = {
			date: "2026-10-25",
			exercises: [
				{ name: "squat", sets: [{ reps: 5, weight: 105, count: 5 }] },
				{ name: "cable crossover", sets: [{ reps: 12, weight: 15, count: 3 }] },
			],
		};
		const first = await workout(f, args, "call-R");
		expect(textOf(first)).toContain("new PR: estimated 1RM 122.5 kg (was 116.7 kg)");
		expect(textOf(first)).toContain('New exercise created: "Cable crossover"');
		// A heavier session dated earlier is logged afterwards (a late entry): it did not exist when the call ran.
		await workout(f, squats("2026-10-22", 108));
		f.clock.now += 3 * DAY;

		const replay = await workout(f, args, "call-R");

		expect(textOf(replay)).toBe(textOf(first));
		expect(replay.details).toStrictEqual(first.details);
	});

	it("answers a replayed call with the pounds note too", async () => {
		const f = await open();
		const args = { unit: "lb", ...squats("2026-10-23", 225, 5, 3) };
		const first = await workout(f, args, "call-LB");

		const replay = await workout(f, args, "call-LB");

		expect(textOf(replay)).toBe(textOf(first));
		expect(textOf(replay)).toContain("Weights were converted from lb to kg.");
	});

	it("finds a plural that ends in -ies, and names with letters of any script", async () => {
		const f = await open();

		await workout(f, { exercises: [{ name: "cable flies", sets: [{ reps: 12, weight: 10, count: 3 }] }] });
		await workout(f, { exercises: [{ name: "Тяга блока", sets: [{ reps: 10, weight: 40, count: 3 }] }] });
		await workout(f, { exercises: [{ name: "тяга  БЛОКА", sets: [{ reps: 10, weight: 42.5 }] }] });

		expect(healthStore.listExercises(f.db).map((exercise) => exercise.name)).toStrictEqual(["Chest fly", "Тяга блока"]);
		expect(setCount(f)).toBe(7);
	});

	it("says 'no letters or digits' only of a name that has none", async () => {
		const f = await open();

		await expect(workout(f, { exercises: [{ name: "?!?", sets: [{ reps: 5, weight: 20 }] }] })).rejects.toThrow(
			/not an exercise name: it has no letters or digits/,
		);
		await workout(f, { exercises: [{ name: "深蹲", sets: [{ reps: 5, weight: 20 }] }] });
		expect(healthStore.listExercises(f.db).map((exercise) => exercise.name)).toStrictEqual(["深蹲"]);
	});

	it("adds the volume of a range from its sets, not from the daily volumes rounded one by one", async () => {
		const f = await open();
		// Each day is 10.05 kg of volume, which shows as 10.1; two days are 20.1 kg, not 20.2.
		await workout(f, { date: "2026-10-20", exercises: [{ name: "curl", sets: [{ reps: 1, weight: 10.05 }] }] });
		await workout(f, { date: "2026-10-21", exercises: [{ name: "curl", sets: [{ reps: 1, weight: 10.05 }] }] });

		const card = (await f.callTool("exercise_progress", { exercise: "curl", range: "14d" }, "p-vol"))
			.details as unknown as ExerciseChartCard;

		expect(card.points.map((point) => point.volumeKg)).toStrictEqual([10.1, 10.1]);
		expect(card.summary.totalVolumeKg).toBe(20.1);
	});
});

describe("exercise_progress of a long history", () => {
	const day = (index: number): string => new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10);

	it("keeps at most 90 points, the latest five days and the newest records, and still counts every day and record", async () => {
		const f = await open();
		for (let index = 0; index < 130; index++) await workout(f, squats(day(index), 100 + index, 5, 1));

		const card = (await f.callTool("exercise_progress", { exercise: "squat", range: "all" }, "p-long"))
			.details as unknown as ExerciseChartCard;

		expect(card.points).toHaveLength(90);
		expect(card.thinned).toBe(true);
		expect(card.summary).toMatchObject({ sessions: 130, sets: 130, prs: 129 });
		// The card is kept in the thread for good and a snapshot carries up to 200 entries: a long history stays small (9.7 KB here).
		expect(JSON.stringify(card).length).toBeLessThan(12_000);
		expect(card.points[0]?.date).toBe(day(0));
		// The card lists the five latest days under the chart: a thinned chart still ends with them.
		expect(card.points.slice(-5).map((point) => point.date)).toStrictEqual([125, 126, 127, 128, 129].map(day));
		// Every day is a record here: the newest 45 before those five are the ringed ones.
		expect(card.points.filter((point) => point.pr === true).length).toBeGreaterThanOrEqual(50);
		expect(card.points.at(-1)).toMatchObject({ date: day(129), pr: true });
		expect(card.points.map((point) => point.date)).toStrictEqual([...card.points.map((point) => point.date)].sort());
	});

	it("keeps every record of a long history when there are few", async () => {
		const f = await open();
		const heavy = new Map([
			[20, 105],
			[60, 110],
			[100, 115],
		]);
		for (let index = 0; index < 130; index++) await workout(f, squats(day(index), heavy.get(index) ?? 100, 5, 1));

		const card = (await f.callTool("exercise_progress", { exercise: "squat", range: "all" }, "p-sparse"))
			.details as unknown as ExerciseChartCard;

		expect(card.points).toHaveLength(90);
		expect(card.points.filter((point) => point.pr === true).map((point) => point.date)).toStrictEqual([
			day(20),
			day(60),
			day(100),
		]);
		expect(card.summary.prs).toBe(3);
	});
});

describe("rename_exercise", () => {
	const rename = (f: Fixture, exercise: string, newName: string, callId = nextCall()) =>
		f.callTool("rename_exercise", { exercise, new_name: newName }, callId);
	const exerciseNames = (f: Fixture) => healthStore.listExercises(f.db).map((exercise) => exercise.name);

	it("gives an exercise another name, keeps every set with it, and the old name and the built-in aliases still find it", async () => {
		const f = await open();
		await workout(f, squats("2026-10-19", 100));

		const result = await rename(f, "squat", "high bar squat (paused)");

		expect(textOf(result)).toBe('Renamed "Squat" to "High bar squat (paused)". "Squat" still finds it.');
		const [renamed] = healthStore.listExercises(f.db);
		expect(renamed).toMatchObject({ name: "High bar squat (paused)", key: "highbarsquatpaused" });
		// Its old name first, then the built-in aliases it had (one of them is a spelling of the new name, and stays).
		expect(renamed?.aliases).toStrictEqual(["Squat", "back squat", "barbell squat", "high bar squat", "low bar squat"]);
		for (const typed of ["squat", "Squats", "back squat", "high bar squat paused"]) {
			await workout(
				f,
				squats("2026-10-22", 102.5, 5, 1).exercises.length === 1
					? { date: "2026-10-22", exercises: [{ name: typed, sets: [{ reps: 5, weight: 102.5 }] }] }
					: {},
				nextCall(),
			);
		}
		expect(exerciseNames(f)).toStrictEqual(["High bar squat (paused)"]);
		expect(setCount(f)).toBe(9);
		const progress = await f.callTool("exercise_progress", { exercise: "squat", range: "14d" }, "p-renamed");
		expect(textOf(progress)).toContain("High bar squat (paused), last 14 days");
	});

	it("lets the owner's own name win over a built-in one: the exercise is not made again from the list", async () => {
		const f = await open();
		await workout(f, { exercises: [{ name: "cable crossover", sets: [{ reps: 12, weight: 15 }] }] });

		await rename(f, "cable crossover", "Chest fly");
		const again = await workout(f, { exercises: [{ name: "pec fly", sets: [{ reps: 12, weight: 17.5 }] }] });

		expect(exerciseNames(f)).toStrictEqual(["Chest fly"]);
		expect(textOf(again)).not.toContain("New exercise");
		expect(setCount(f)).toBe(2);
	});

	it("refuses a name another exercise already answers to, an empty name and an unknown exercise, each saying what to do", async () => {
		const f = await open();
		await workout(f, squats("2026-10-19", 100));
		await workout(f, { exercises: [{ name: "bench", sets: [{ reps: 8, weight: 60 }] }] });

		await expect(rename(f, "bench", "Squat")).rejects.toThrow(
			/'Squat' already means Squat\. If Bench press and Squat are one exercise, merge them with propose_merge_exercises/,
		);
		await expect(rename(f, "bench", "squats")).rejects.toThrow(/already means Squat/);
		await expect(rename(f, "bench", "back squat")).rejects.toThrow(/already means Squat/);
		await expect(rename(f, "bench", "?!")).rejects.toThrow(/not an exercise name: it has no letters or digits/);
		await expect(rename(f, "curls", "Biceps curl")).rejects.toThrow(
			/No exercise called 'curls'\. Logged exercises: Bench press, Squat\./,
		);
		expect(exerciseNames(f)).toStrictEqual(["Bench press", "Squat"]);
	});

	it("says so when the exercise already has the name, and tells an empty log there is nothing to rename", async () => {
		const f = await open();
		await expect(rename(f, "squat", "Squat")).rejects.toThrow(/No exercise has been logged yet/);
		await workout(f, squats("2026-10-19", 100));

		const result = await rename(f, "squat", "squat");

		expect(textOf(result)).toBe('The exercise is already called "Squat". Nothing changed.');
	});

	it("is done once however often the call is replayed, and a replay does not undo a rename made since (rule 8)", async () => {
		const f = await open();
		await workout(f, { exercises: [{ name: "cable crossover", sets: [{ reps: 12, weight: 15 }] }] });

		await rename(f, "cable crossover", "Cable fly", "rename-1");
		await rename(f, "cable fly", "Cable crossover, low", "rename-2");
		const replay = await rename(f, "cable crossover", "Cable fly", "rename-1");

		expect(textOf(replay)).toBe('This exercise is called "Cable crossover, low" (already renamed).');
		expect(exerciseNames(f)).toStrictEqual(["Cable crossover, low"]);
		expect(healthStore.listExercises(f.db)[0]?.aliases).toStrictEqual(["Cable fly", "Cable crossover"]);
	});
});

describe("merging two exercises asks the owner first (rule 3)", () => {
	/** Two exercises that are one: a misspelling became its own exercise. */
	async function typo(f: Fixture): Promise<{ right: healthStore.ExerciseRow; wrong: healthStore.ExerciseRow }> {
		await workout(f, {
			date: "2026-10-20",
			exercises: [{ name: "cable crossover", sets: [{ reps: 12, weight: 15, count: 3 }] }],
		});
		await workout(f, {
			date: "2026-10-22",
			exercises: [{ name: "cable crosover", sets: [{ reps: 10, weight: 17.5, count: 2 }] }],
		});
		const right = healthStore.findExercise(f.db, "cable crossover");
		const wrong = healthStore.findExercise(f.db, "cable crosover");
		if (right === undefined || wrong === undefined || right.id === wrong.id)
			throw new Error("the typo did not make two");
		return { right, wrong };
	}
	const propose = async (f: Fixture, from: string, into: string, callId: string): Promise<ApprovalCard> => {
		f.faux.setResponses([toolCall("propose_merge_exercises", { from, into }, callId), say("Please approve.")]);
		await f.say(`merge ${from} into ${into}`);
		return (await lastResult(f)).details as unknown as ApprovalCard;
	};

	it("asks first, moves every set and keeps the removed name as an alias only after Approve", async () => {
		const f = await open();
		const { right, wrong } = await typo(f);

		const card = await propose(f, "cable crosover", "cable crossover", "merge-1");

		expect(card).toMatchObject({
			type: "approval",
			summary:
				'Merge Cable crosover into Cable crossover (2 sets in 1 workout move; "Cable crosover" stays as another name for it)',
		});
		expect(resultText(await lastResult(f))).toContain(
			"Nothing is merged yet. Tell the owner to tap Approve on the card. Do not say it is merged until they have answered",
		);
		expect(healthStore.listExercises(f.db)).toHaveLength(2); // waiting for the owner

		const state = await f.deps.approvals.decide(card.actionId, "approve", "button");

		expect(state).toMatchObject({
			status: "executed",
			resultText: 'Merged Cable crosover into Cable crossover: 2 sets moved. "Cable crosover" still finds it.',
		});
		const [merged] = healthStore.listExercises(f.db);
		expect(healthStore.listExercises(f.db)).toHaveLength(1);
		expect(merged).toMatchObject({ id: right.id, name: "Cable crossover" });
		expect(merged?.aliases).toContain("Cable crosover");
		expect(healthStore.getExercise(f.db, wrong.id)).toBeUndefined();
		expect(setCount(f)).toBe(5);
		// The old name finds it from now on, and the progress is one line of two days.
		const progress = (await f.callTool("exercise_progress", { exercise: "cable crosover", range: "14d" }, "p-merged"))
			.details as unknown as ExerciseChartCard;
		expect(progress.points.map((point) => point.date)).toStrictEqual(["2026-10-20", "2026-10-22"]);
		await workout(f, { exercises: [{ name: "cable crosover", sets: [{ reps: 10, weight: 20 }] }] });
		expect(healthStore.listExercises(f.db)).toHaveLength(1);
	});

	it("numbers the moved sets after the others in a workout that had both", async () => {
		const f = await open();
		await workout(f, {
			date: "2026-10-22",
			exercises: [
				{ name: "cable crossover", sets: [{ reps: 12, weight: 15, count: 2 }] },
				{ name: "cable crosover", sets: [{ reps: 10, weight: 17.5, count: 3 }] },
			],
		});
		const card = await propose(f, "cable crosover", "cable crossover", "merge-2");

		await f.deps.approvals.decide(card.actionId, "approve", "button");

		const numbers = f.db
			.all<{ set_no: number; reps: number }>("SELECT set_no, reps FROM health_set ORDER BY set_no")
			.map((row) => [row.set_no, row.reps]);
		expect(numbers).toStrictEqual([
			[1, 12],
			[2, 12],
			[3, 10],
			[4, 10],
			[5, 10],
		]);
		const [workoutOnDay] = (
			(await f.callTool("list_workouts", { range: "14d" }, "l-merged")).details as unknown as WorkoutListCard
		).workouts;
		expect(workoutOnDay?.exercises.map((exercise) => [exercise.name, exercise.groups])).toStrictEqual([
			[
				"Cable crossover",
				[
					{ sets: 2, reps: 12, kg: 15 },
					{ sets: 3, reps: 10, kg: 17.5 },
				],
			],
		]);
	});

	it("blocks a direct merge_exercises, and an approval for one pair does not cover another", async () => {
		const f = await open();
		const { right, wrong } = await typo(f);
		await workout(f, { exercises: [{ name: "bench", sets: [{ reps: 8, weight: 60 }] }] });
		const bench = healthStore.findExercise(f.db, "bench");

		f.faux.setResponses([
			toolCall("merge_exercises", { from_id: wrong.id, into_id: right.id }, "sneaky-m1"),
			say("ok"),
		]);
		await f.say("merge them");
		expect((await lastResult(f)).isError).toBe(true);
		expect(resultText(await lastResult(f))).toMatch(
			/Blocked: merge_exercises .* needs the owner's approval.*propose_merge_exercises/s,
		);

		const card = await propose(f, "cable crosover", "cable crossover", "merge-3");
		await f.deps.approvals.decide(card.actionId, "approve", "button");
		f.faux.setResponses([
			toolCall("merge_exercises", { from_id: bench?.id, into_id: right.id }, "sneaky-m2"),
			say("ok"),
		]);
		await f.say("and the bench");
		expect(resultText(await lastResult(f))).toMatch(/Blocked/);
		expect(healthStore.getExercise(f.db, bench?.id ?? -1)).toBeDefined();
	});

	it("refuses to move sets with no weight into a weighted exercise, and an exercise into itself, before the owner is asked", async () => {
		const f = await open();
		await workout(f, { exercises: [{ name: "lunge", sets: [{ reps: 8, weight: 40, count: 3 }] }] });
		await workout(f, { exercises: [{ name: "bodyweight lunge", sets: [{ reps: 12, count: 3 }] }] });

		await expect(
			f.callTool("propose_merge_exercises", { from: "bodyweight lunge", into: "lunge" }, "m-bad1"),
		).rejects.toThrow(
			/Bodyweight lunge has 3 sets with no weight, and Lunge is a weighted exercise.*Merge them the other way round/s,
		);
		await expect(f.callTool("propose_merge_exercises", { from: "lunge", into: "lunges" }, "m-bad2")).rejects.toThrow(
			/'Lunge' and 'Lunge' are the same exercise: there is nothing to merge/,
		);
		await expect(f.callTool("propose_merge_exercises", { from: "curls", into: "lunge" }, "m-bad3")).rejects.toThrow(
			/No exercise called 'curls'. Logged exercises: Bodyweight lunge, Lunge\./,
		);
		// The other way round is fine: a loaded exercise joins a bodyweight one, and the load is then followed.
		const ok = await f.callTool("propose_merge_exercises", { from: "lunge", into: "bodyweight lunge" }, "m-ok");
		expect(textOf(ok)).toContain("Approval requested");
		expect(healthStore.listExercises(f.db)).toHaveLength(2);
	});

	it("is carried out once; run a second time (a crash can do that) the action finds nothing left to do", async () => {
		const f = await open();
		const { right, wrong } = await typo(f);
		const card = await propose(f, "cable crosover", "cable crossover", "merge-4");
		await f.deps.approvals.decide(card.actionId, "approve", "button");

		const again = await f.deps.approvals.decide(card.actionId, "approve", "button");

		expect(again.status).toBe("executed");
		expect(setCount(f)).toBe(5);
		const merge = healthModule.actions?.(f.deps).find((action) => action.tool === "merge_exercises");
		expect(await merge?.run({ from_id: wrong.id, into_id: right.id })).toBe(
			"That merge was already done: the exercise is gone.",
		);
		await expect(Promise.resolve().then(() => merge?.run({ from_id: right.id, into_id: 9999 }))).rejects.toThrow(
			/Cable crossover was to be merged into an exercise that is gone. Nothing was changed/,
		);
		expect(setCount(f)).toBe(5);
		expect(healthStore.getExercise(f.db, right.id)).toBeDefined();
	});
});
