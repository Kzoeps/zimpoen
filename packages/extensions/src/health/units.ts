/**
 * Units and the small arithmetic the Health tools share. The database holds kilograms only; pounds are converted once,
 * where they come in, and never again (PLAN rule 7: arithmetic is code, never the model).
 */

import { round } from "@assistant/shared";

export type WeightUnit = "kg" | "lb";

/** The international pound, exactly. */
export const KG_PER_LB = 0.45359237;

// Shared with the web app, which draws the same numbers: they are written in one place so both say them the same way.
export { formatKg, formatVolume, round, signed } from "@assistant/shared";

export const round1 = (value: number): number => round(value, 1);
export const round2 = (value: number): number => round(value, 2);

/** A weight in the unit the owner used, as kilograms rounded to 10 g: the precision of a scale, and of a plate. */
export function toKg(value: number, unit: WeightUnit): number {
	return round2(unit === "lb" ? value * KG_PER_LB : value);
}

/** Weights are kept to 10 g (see {@link toKg}), so they are whole numbers of hundredths of a kilogram. */
export const hundredths = (kg: number): number => Math.round(kg * 100);

/**
 * `a - b` to one decimal, for two weights kept to 10 g. The difference is taken in whole hundredths: 72.57 - 72.42 is
 * exactly 0.15 and rounds to 0.2, where the floating point difference, 0.1499999999999915, would round to 0.1.
 */
export function diffKg(a: number, b: number): number {
	return round((hundredths(a) - hundredths(b)) / 100, 1);
}

/**
 * Estimated one-rep max by the Epley formula: `kg x (1 + reps / 30)`. One rep is the weight itself. It is an estimate
 * that drifts above about ten reps, which is why the tools say "estimated" wherever they show it.
 */
export function epley(kg: number, reps: number): number {
	return reps <= 1 ? kg : kg * (1 + reps / 30);
}

/** Body mass index from kilograms and a height in centimetres, one decimal. */
export function bmi(kg: number, heightCm: number): number {
	const metres = heightCm / 100;
	return round1(kg / (metres * metres));
}
