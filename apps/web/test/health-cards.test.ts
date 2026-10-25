import type {
	ExerciseChartCard,
	WeightCard,
	WeightChartCard,
	WorkoutCard,
	WorkoutListCard,
	WorkoutSummary,
} from "@assistant/shared";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	ExerciseChartView,
	WeightChartView,
	WeightLoggedView,
	WorkoutListView,
	WorkoutLoggedView,
} from "../src/components/health-charts.tsx";
import { cardSummary } from "../src/lib/card-text.ts";
import { toUiMessages, type UiCard, type UiMessage } from "../src/lib/ui-messages.ts";

const day = (date: string, dateText: string) => ({ date, dateText });

const weightChart: WeightChartCard = {
	type: "weight_chart",
	heading: "Weight, last 14 days",
	rangeText: "Mon 12 Oct 2026 to Sun 25 Oct 2026",
	points: [
		{ date: "2026-10-12", kg: 74, avg7: 74 },
		{ date: "2026-10-16", kg: 73.4, avg7: 73.7 },
		{ date: "2026-10-20", kg: 72.8, avg7: 73.4 },
		{ date: "2026-10-25", kg: 72.4, avg7: 72.5 },
	],
	summary: {
		entries: 4,
		first: { ...day("2026-10-12", "Mon 12 Oct 2026"), kg: 74 },
		latest: { ...day("2026-10-25", "Sun 25 Oct 2026"), kg: 72.4 },
		changeKg: -1.6,
		min: { ...day("2026-10-25", "Sun 25 Oct 2026"), kg: 72.4 },
		max: { ...day("2026-10-12", "Mon 12 Oct 2026"), kg: 74 },
		averageKg: 73.2,
		avg7Kg: 72.5,
		avg7Entries: 3,
		trendChangeKg: -1.5,
		perWeekKg: -0.8,
		bmi: 23.4,
	},
};

const squat: ExerciseChartCard = {
	type: "exercise_chart",
	exercise: "Squat",
	kind: "weighted",
	metric: "e1rm",
	heading: "Squat, last 90 days",
	rangeText: "Sun 26 Jul 2026 to Sun 25 Oct 2026",
	points: [
		{ date: "2026-10-19", top: { kg: 100, reps: 5 }, e1rm: 116.7, volumeKg: 2500, totalReps: 25 },
		{ date: "2026-10-22", top: { kg: 102.5, reps: 5 }, e1rm: 119.6, volumeKg: 2562.5, totalReps: 25, pr: true },
		{ date: "2026-10-25", top: { kg: 105, reps: 5 }, e1rm: 122.5, volumeKg: 1380, totalReps: 13, pr: true },
	],
	summary: {
		sessions: 3,
		sets: 13,
		best: { day: day("2026-10-25", "Sun 25 Oct 2026"), top: { kg: 105, reps: 5 }, e1rm: 122.5 },
		allTimeBest: { day: day("2026-10-25", "Sun 25 Oct 2026"), top: { kg: 105, reps: 5 }, e1rm: 122.5 },
		first: { day: day("2026-10-19", "Mon 19 Oct 2026"), top: { kg: 100, reps: 5 }, e1rm: 116.7 },
		last: { day: day("2026-10-25", "Sun 25 Oct 2026"), top: { kg: 105, reps: 5 }, e1rm: 122.5 },
		change: 5.8,
		heaviestKg: 110,
		totalVolumeKg: 6442.5,
		prs: 2,
	},
};

const pullUps: ExerciseChartCard = {
	type: "exercise_chart",
	exercise: "Pull-up",
	kind: "bodyweight",
	metric: "reps",
	heading: "Pull-up, last 90 days",
	rangeText: "Sun 26 Jul 2026 to Sun 25 Oct 2026",
	points: [
		{ date: "2026-10-19", top: { kg: 0, reps: 8 }, volumeKg: 0, totalReps: 24 },
		{ date: "2026-10-25", top: { kg: 0, reps: 10 }, volumeKg: 0, totalReps: 19, pr: true },
	],
	summary: {
		sessions: 2,
		sets: 5,
		best: { day: day("2026-10-25", "Sun 25 Oct 2026"), top: { kg: 0, reps: 10 } },
		allTimeBest: { day: day("2026-10-25", "Sun 25 Oct 2026"), top: { kg: 0, reps: 10 } },
		first: { day: day("2026-10-19", "Mon 19 Oct 2026"), top: { kg: 0, reps: 8 } },
		last: { day: day("2026-10-25", "Sun 25 Oct 2026"), top: { kg: 0, reps: 10 } },
		change: 2,
		heaviestKg: 0,
		totalVolumeKg: 0,
		prs: 1,
	},
};

const workout: WorkoutSummary = {
	...day("2026-10-23", "Fri 23 Oct 2026"),
	id: "w_ab12cd34",
	note: "felt strong",
	exercises: [
		{
			name: "Squat",
			kind: "weighted",
			metric: "e1rm",
			groups: [{ sets: 5, reps: 5, kg: 100 }],
			volumeKg: 2500,
			totalReps: 25,
			top: { kg: 100, reps: 5, e1rm: 116.7 },
			pr: { previous: 113.3 },
		},
		{
			name: "Bench press",
			kind: "weighted",
			metric: "e1rm",
			groups: [
				{ sets: 2, reps: 8, kg: 60 },
				{ sets: 1, reps: 6, kg: 65 },
			],
			volumeKg: 1350,
			totalReps: 22,
			top: { kg: 60, reps: 8, e1rm: 76 },
		},
		{
			name: "Pull-up",
			kind: "bodyweight",
			metric: "reps",
			groups: [{ sets: 3, reps: 8, kg: 0 }],
			volumeKg: 0,
			totalReps: 24,
			top: { kg: 0, reps: 8 },
		},
		{
			name: "Cable crossover",
			kind: "weighted",
			metric: "e1rm",
			groups: [{ sets: 3, reps: 12, kg: 15 }],
			volumeKg: 540,
			totalReps: 36,
			top: { kg: 15, reps: 12, e1rm: 21 },
			created: true,
		},
	],
	totalSets: 14,
	volumeKg: 4390,
};

function render<Card>(component: (props: { card: Card }) => ReactElement, card: Card): string {
	return renderToStaticMarkup(createElement(component, { card }));
}

const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

describe("the weight chart card", () => {
	const markup = render(WeightChartView, weightChart);

	it("draws every weighing as a dot and the 7-day average as one line, in an svg that scales to the card", () => {
		expect(markup).toContain('<svg class="chart" viewBox="0 0 360 176" role="img"');
		expect(markup).toContain(
			'aria-label="Weight in kilograms, Mon 12 Oct 2026 to Sun 25 Oct 2026: 4 entries, from 74 to 72.4"',
		);
		expect(count(markup, "<circle")).toBe(4);
		expect(count(markup, "<path")).toBe(1);
		expect(markup).toMatch(/<path d="M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+"/);
		expect(markup).not.toMatch(/NaN|Infinity|undefined/);
	});

	it("labels the axes with the days and the kilograms, and says what the two marks are", () => {
		expect(markup).toContain(">12 Oct<");
		expect(markup).toContain(">25 Oct<");
		expect(markup).toMatch(/<text[^>]*>73<\/text>/);
		expect(markup).toContain("weighings");
		expect(markup).toContain("7-day average");
	});

	it("shows the numbers the server computed, not ones of its own", () => {
		for (const text of ["Latest", "72.4 kg", "-1.6 kg", "-1.5 kg", "-0.8 a week", "74 kg", "23.4"]) {
			expect(markup, text).toContain(text);
		}
		expect(markup).not.toContain("selection of the weighings");
	});

	it("says when the chart shows a selection, and draws one lonely entry without a line to speak of", () => {
		expect(render(WeightChartView, { ...weightChart, thinned: true })).toContain(
			"The chart shows a selection of the weighings.",
		);
		const single = render(WeightChartView, {
			...weightChart,
			points: [{ date: "2026-10-25", kg: 72.4, avg7: 72.4 }],
			summary: { ...weightChart.summary, entries: 1 },
		});
		expect(count(single, "<circle")).toBe(1);
		expect(single).not.toMatch(/NaN|Infinity|undefined/);
		expect(single).not.toContain("Lowest");
		expect(single).toContain("1 entry");
	});
});

describe("the exercise progress card", () => {
	it("draws the estimated 1RM per day as a line with a dot for each, and rings the records", () => {
		const markup = render(ExerciseChartView, squat);

		expect(count(markup, "<path")).toBe(1);
		expect(count(markup, "chart__dot--pr")).toBe(2);
		expect(count(markup, "<circle")).toBe(3);
		expect(markup).toContain("Estimated one-rep max (Epley) of the best set of each day, in kg");
		for (const text of ["122.5 kg", "105 kg × 5", "+5.8 kg", "Records", "6,443 kg"])
			expect(markup, text).toContain(text);
		expect(markup).not.toContain("Best ever");
		expect(markup).not.toMatch(/NaN|Infinity|undefined/);
	});

	it("lists the latest days with their top set, newest first, and a PR badge", () => {
		const markup = render(ExerciseChartView, squat);

		expect(markup.indexOf("25 Oct")).toBeLessThan(markup.indexOf("19 Oct"));
		expect(markup).toContain("102.5 kg × 5");
		expect(markup).toContain("est. 119.6 kg");
		expect(count(markup, 'badge badge--pr">PR')).toBe(2);
	});

	it("says where the best ever was when it is older than the range", () => {
		const older = {
			...squat,
			summary: {
				...squat.summary,
				allTimeBest: { ...squat.summary.allTimeBest, day: day("2026-08-01", "Sat 1 Aug 2026"), e1rm: 140 },
			},
		};

		expect(render(ExerciseChartView, older)).toContain("Best ever: 140 kg on 1 Aug");
	});

	it("measures a bodyweight exercise in reps, with no kilograms", () => {
		const markup = render(ExerciseChartView, pullUps);

		expect(markup).toContain("Repetitions in the best set of each day");
		expect(markup).toContain("10 reps");
		expect(markup).toContain("+2 reps");
		expect(markup).not.toMatch(/est\.|kg|Volume/);
		// The best set is the number above it, so the note under it is only the day.
		expect(markup).toContain('<span class="stat__note">25 Oct</span>');
	});
});

describe("the exercise progress card of a bodyweight exercise with added weight", () => {
	const dips: ExerciseChartCard = {
		type: "exercise_chart",
		exercise: "Dip",
		kind: "bodyweight",
		metric: "e1rm",
		heading: "Dip, last 14 days",
		rangeText: "Mon 12 Oct 2026 to Sun 25 Oct 2026",
		points: [
			{ date: "2026-10-19", top: { kg: 0, reps: 8 }, e1rm: 0, volumeKg: 0, totalReps: 24 },
			{ date: "2026-10-22", top: { kg: 20, reps: 8 }, e1rm: 25.3, volumeKg: 480, totalReps: 24, pr: true },
			{ date: "2026-10-25", top: { kg: 30, reps: 5 }, e1rm: 35, volumeKg: 450, totalReps: 15, pr: true },
		],
		summary: {
			sessions: 3,
			sets: 9,
			best: { day: day("2026-10-25", "Sun 25 Oct 2026"), top: { kg: 30, reps: 5 }, e1rm: 35 },
			allTimeBest: { day: day("2026-10-25", "Sun 25 Oct 2026"), top: { kg: 30, reps: 5 }, e1rm: 35 },
			first: { day: day("2026-10-19", "Mon 19 Oct 2026"), top: { kg: 0, reps: 8 }, e1rm: 0 },
			last: { day: day("2026-10-25", "Sun 25 Oct 2026"), top: { kg: 30, reps: 5 }, e1rm: 35 },
			change: 35,
			heaviestKg: 30,
			totalVolumeKg: 930,
			prs: 2,
		},
	};

	it("draws the estimated 1RM of the added weight, and writes each set as reps with the added weight", () => {
		const markup = render(ExerciseChartView, dips);

		expect(markup).toContain("Estimated one-rep max (Epley) of the added weight in the best set of each day, in kg");
		expect(markup).toContain("estimated one-rep max of the added weight in kilograms");
		for (const text of ["+35 kg", "5 reps +30 kg · 25 Oct", "8 reps +20 kg", "est. +25.3 kg", "+35 kg<"]) {
			expect(markup, text).toContain(text);
		}
		// The unloaded day is a set of 8 reps, and 0 kg added on the line.
		expect(markup).toContain("8 reps</span>");
		expect(markup).toContain("no added weight");
		expect(markup).not.toContain("+0 kg");
		expect(count(markup, "chart__dot--pr")).toBe(2);
		expect(markup).not.toContain("Volume");
		expect(markup).not.toMatch(/NaN|Infinity|undefined/);
	});

	it("says where the best added weight ever was, with the plus", () => {
		const older = {
			...dips,
			summary: {
				...dips.summary,
				allTimeBest: { ...dips.summary.allTimeBest, day: day("2026-08-01", "Sat 1 Aug 2026"), e1rm: 40 },
			},
		};

		expect(render(ExerciseChartView, older)).toContain("Best ever: +40 kg on 1 Aug");
	});

	it("flags a record of added weight on the workout card with the plus: PR +35 kg est. 1RM", () => {
		const card: WorkoutCard = {
			type: "workout",
			event: "logged",
			workout: {
				...day("2026-10-25", "Sun 25 Oct 2026"),
				id: "w_dips0001",
				exercises: [
					{
						name: "Dip",
						kind: "bodyweight",
						metric: "e1rm",
						groups: [{ sets: 3, reps: 5, kg: 30 }],
						volumeKg: 450,
						totalReps: 15,
						top: { kg: 30, reps: 5, e1rm: 35 },
						pr: { previous: 25.3 },
					},
				],
				totalSets: 3,
				volumeKg: 450,
			},
		};

		const markup = render(WorkoutLoggedView, card);

		expect(markup).toContain("3×5 +30 kg");
		expect(markup).toContain("PR +35 kg est. 1RM");
	});
});

describe("a thinned exercise card", () => {
	it("lists the five latest days, which a thinned chart keeps, and says it shows a selection", () => {
		const dates = [
			"2026-10-01",
			"2026-10-05",
			"2026-10-11",
			"2026-10-17",
			"2026-10-20",
			"2026-10-21",
			"2026-10-23",
			"2026-10-25",
		];
		const thinned: ExerciseChartCard = {
			...squat,
			thinned: true,
			points: dates.map((date, index) => ({
				date,
				top: { kg: 100 + index, reps: 5 },
				e1rm: 116.7 + index,
				volumeKg: 2500,
				totalReps: 25,
			})),
		};

		const markup = render(ExerciseChartView, thinned);

		expect(markup).toContain("The chart shows a selection of the days.");
		const listed = [...markup.matchAll(/<span class="days__date">([^<]+)<\/span>/g)].map((match) => match[1]);
		expect(listed).toStrictEqual(["25 Oct", "23 Oct", "21 Oct", "20 Oct", "17 Oct"]);
	});
});

describe("the weight and workout cards", () => {
	it("says what was logged, how it moved and the 7-day average", () => {
		const card: WeightCard = {
			type: "weight",
			event: "logged",
			day: day("2026-10-25", "Sun 25 Oct 2026"),
			kg: 72.57,
			fromLb: 160,
			previous: { ...day("2026-10-24", "Sat 24 Oct 2026"), kg: 72.6, deltaKg: 0 },
			avg7Kg: 72.5,
			avg7Entries: 2,
			bmi: 23.4,
			note: "after breakfast",
		};

		const markup = render(WeightLoggedView, card);

		expect(markup).toContain("Weight logged");
		expect(markup).toContain("72.57 kg");
		expect(markup).toContain("160 lb");
		expect(markup).toContain("0 kg since 24 Oct");
		expect(markup).toContain("7-day average 72.5 kg");
		expect(markup).toContain("BMI 23.4");
		expect(markup).toContain("after breakfast");
		expect(render(WeightLoggedView, { ...card, event: "updated", previous: undefined, fromLb: undefined })).toContain(
			"first entry",
		);
	});

	it("lists each exercise with its sets as people write them, flags a record and a new exercise, and totals the session", () => {
		const card: WorkoutCard = { type: "workout", event: "logged", workout };

		const markup = render(WorkoutLoggedView, card);

		for (const text of [
			"Fri 23 Oct 2026",
			"Squat",
			"5×5 100 kg",
			"2×8 60 kg, 1×6 65 kg",
			"3×8<",
			"PR 116.7 kg est. 1RM",
			"new exercise",
			"14 sets · volume 4,390 kg",
			"felt strong",
		]) {
			expect(markup, text).toContain(text);
		}
		expect(count(markup, "badge--pr")).toBe(1);
	});

	it("lists several workouts with their ids, and says how many more there are", () => {
		const card: WorkoutListCard = {
			type: "workout_list",
			heading: "Workouts, last 30 days",
			workouts: [workout, { ...workout, id: "w_ee00ff11", note: undefined }],
			total: 5,
		};

		const markup = render(WorkoutListView, card);

		expect(markup).toContain("Workouts, last 30 days");
		expect(markup).toContain("w_ab12cd34");
		expect(markup).toContain("w_ee00ff11");
		expect(markup).toContain("…and 3 more");
	});
});

describe("health cards in the thread", () => {
	const toolResult = (id: number, details: unknown) => ({
		id,
		conversationId: 3,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: `c${id}`,
				toolName: "t",
				content: [],
				details,
				isError: false,
				timestamp: id * 1000,
			},
		],
	});
	const messages: UiMessage[] = toUiMessages({
		entries: [
			toolResult(1, { type: "weight", event: "logged", day: day("2026-10-25", "Sun 25 Oct 2026"), kg: 72.4 }),
			toolResult(2, weightChart),
			toolResult(3, squat),
			toolResult(4, { type: "workout", event: "logged", workout }),
			toolResult(5, { type: "workout_list", heading: "Workouts, last 30 days", workouts: [workout], total: 1 }),
		] as never,
		draft: undefined,
		unanswered: [],
	});
	const cards = messages.flatMap((message) => (message.role === "system" ? [message.card] : []));

	it("turns the typed results of the health tools into cards, in the order they came", () => {
		expect(cards.map((card) => card.type)).toStrictEqual([
			"weight",
			"weight_chart",
			"exercise_chart",
			"workout",
			"workout_list",
		]);
	});

	it("says in one line what each is, where the card itself cannot be shown", () => {
		expect(cards.map((card: UiCard) => cardSummary(card))).toStrictEqual([
			"Weight logged: 72.4 kg, Sun 25 Oct 2026",
			"Weight, last 14 days: 4 entries, latest 72.4 kg",
			"Squat, last 90 days: 3 days",
			"Workout logged: Fri 23 Oct 2026, Squat, Bench press, Pull-up, Cable crossover",
			"Workouts, last 30 days: 1",
		]);
	});
});
