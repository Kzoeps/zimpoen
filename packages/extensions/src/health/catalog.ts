import type { ExerciseKind } from "@assistant/shared";

/**
 * Exercise names. The owner says "bench", "ohp" or "pull ups"; the log keeps one canonical name per exercise, so that
 * progress is one line and not five. Matching ignores case, spaces, punctuation and accents, and a trailing plural.
 *
 * The built-in list only seeds an exercise the first time it is logged. After that the exercise (its name, its aliases
 * and its kind) lives in `health_exercise`, and a name that is in neither place creates a new exercise.
 */
export type CatalogEntry = {
	name: string;
	/** Other names for it. Plurals and spacing variants need no entry: `exerciseKey` already treats them as the same. */
	aliases: readonly string[];
	kind: ExerciseKind;
};

const weighted = (name: string, ...aliases: string[]): CatalogEntry => ({ name, aliases, kind: "weighted" });
const bodyweight = (name: string, ...aliases: string[]): CatalogEntry => ({ name, aliases, kind: "bodyweight" });

export const CATALOG: readonly CatalogEntry[] = [
	weighted("Squat", "back squat", "barbell squat", "high bar squat", "low bar squat"),
	weighted("Front squat"),
	weighted("Bench press", "bench", "flat bench", "barbell bench", "barbell bench press", "bb bench", "bp"),
	weighted("Incline bench press", "incline bench", "incline press", "incline barbell bench"),
	weighted("Dumbbell bench press", "db bench", "db bench press", "dumbbell bench", "dumbbell press"),
	weighted("Overhead press", "ohp", "shoulder press", "military press", "standing press", "strict press"),
	weighted("Dumbbell shoulder press", "db shoulder press", "seated dumbbell press", "dumbbell overhead press"),
	weighted("Deadlift", "dl", "conventional deadlift", "barbell deadlift"),
	weighted("Sumo deadlift", "sumo"),
	weighted("Trap bar deadlift", "hex bar deadlift", "trapbar deadlift"),
	weighted("Romanian deadlift", "rdl", "romanian dl", "stiff leg deadlift"),
	weighted("Barbell row", "bent over row", "barbell bent over row", "bb row", "pendlay row"),
	weighted("Seated cable row", "cable row", "seated row"),
	weighted("Lat pulldown", "pulldown", "lat pull down", "wide grip pulldown"),
	weighted("Hip thrust", "barbell hip thrust"),
	weighted("Leg press", "sled press"),
	weighted("Lunge", "walking lunge", "dumbbell lunge"),
	weighted("Leg extension", "quad extension"),
	weighted("Leg curl", "hamstring curl", "lying leg curl", "seated leg curl"),
	weighted("Calf raise", "standing calf raise", "seated calf raise"),
	weighted("Lateral raise", "side raise", "side lateral raise", "dumbbell lateral raise"),
	weighted("Face pull"),
	weighted("Chest fly", "fly", "pec fly", "pec deck", "cable fly", "dumbbell fly"),
	weighted("Biceps curl", "bicep curl", "dumbbell curl", "db curl", "barbell curl", "ez bar curl", "curl"),
	weighted("Triceps pushdown", "tricep pushdown", "cable pushdown", "rope pushdown"),
	weighted("Triceps extension", "tricep extension", "skull crusher", "overhead triceps extension"),
	weighted("Shrug", "barbell shrug", "dumbbell shrug"),
	bodyweight("Pull-up"),
	bodyweight("Chin-up", "underhand pull up"),
	bodyweight("Push-up", "press up"),
	bodyweight("Dip", "chest dip", "parallel bar dip", "bar dip"),
	bodyweight("Sit-up"),
	bodyweight("Hanging leg raise", "leg raise", "hanging knee raise"),
	bodyweight("Inverted row", "bodyweight row", "australian pull up"),
	// The weighted exercises above refuse a set with no weight (a forgotten weight is the likelier mistake). These are the
	// way to log the same movement done with the body weight only, and the refusal names them.
	bodyweight("Bodyweight squat", "air squat", "bw squat"),
	bodyweight("Bodyweight lunge", "bw lunge"),
	bodyweight("Bodyweight calf raise", "bw calf raise"),
	bodyweight("Bodyweight hip thrust", "bw hip thrust"),
];

/** The name to log a weighted exercise under when it was done with no weight at all: `Lunge` becomes `Bodyweight lunge`. */
export const bodyweightNameOf = (name: string): string =>
	`Bodyweight ${/^[A-Z][a-z]/.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name}`;

/**
 * What two spellings of one exercise have in common: lower case, letters and digits only, in any script, accents
 * dropped. `Bench-Press`, `bench press` and `benchpress` are one key. The empty string means the name had no letters or
 * digits at all.
 */
export function exerciseKey(name: string): string {
	return name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * A key and the keys it becomes without a plural ending (`squats`, `lunges`, `presses`, `flies`). A key of three letters
 * or fewer is never shortened, so `abs` stays `abs`.
 */
function variantsOfKey(key: string): string[] {
	const variants = [key];
	if (key.length > 3 && key.endsWith("es")) variants.push(key.slice(0, -2));
	if (key.length > 3 && key.endsWith("s")) variants.push(key.slice(0, -1));
	if (key.length > 4 && key.endsWith("ies")) variants.push(`${key.slice(0, -3)}y`);
	return variants;
}

/**
 * Of `items`, the one whose names a typed name stands for. A name that is the same after `exerciseKey` wins over one
 * that is the same only once a plural ending is dropped on either side (`squats` is `Squat`, and `plank` is `Planks`).
 */
export function bestMatch<T>(
	typed: string,
	items: readonly T[],
	namesOf: (item: T) => readonly string[],
): T | undefined {
	const wanted = exerciseKey(typed);
	if (wanted === "") return undefined;
	const keysOf = (item: T): string[] =>
		namesOf(item)
			.map(exerciseKey)
			.filter((key) => key !== "");
	const exact = items.find((item) => keysOf(item).includes(wanted));
	if (exact !== undefined) return exact;
	const wantedVariants = variantsOfKey(wanted);
	return items.find((item) =>
		keysOf(item).some((key) => variantsOfKey(key).some((variant) => wantedVariants.includes(variant))),
	);
}

/** The built-in exercise a typed name stands for, or undefined. */
export function findInCatalog(typed: string): CatalogEntry | undefined {
	return bestMatch(typed, CATALOG, (entry) => [entry.name, ...entry.aliases]);
}

/**
 * A new exercise's name from what the owner typed: spaces tidied, the first letter capital, and a name typed in capitals
 * (`CABLE FLY`) written in sentence case. Letters in the middle stay as typed (`T-bar row`, `Smith machine RDL`).
 */
export function tidyExerciseName(typed: string): string {
	const spaced = typed.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
	const calm = spaced.length > 3 && spaced === spaced.toUpperCase() ? spaced.toLowerCase() : spaced;
	return calm.charAt(0).toUpperCase() + calm.slice(1);
}
