import type { AppDb } from "@assistant/db";
import { nameKey } from "../ledger/keys.ts";
import type { DomainDeps } from "../module.ts";
import { oneLine } from "../tool-support.ts";
import { knownPeople, OWNER_KEY, OWNER_NAME } from "./store.ts";

/** A person as bills store them: the key two spellings of the name share, and the name to show. */
export type PersonRef = {
	key: string;
	name: string;
	/** The person of the same name in the birthdays list, when exactly one has it. */
	personId?: string;
};

/** Words that mean the owner. The configured name (`ASSISTANT_OWNER_NAME`) does too, when there is one. */
const OWNER_WORDS: ReadonlySet<string> = new Set(["me", "i", "myself", "owner", "the owner", "you", "yourself"]);

const MAX_NAME = 60;

/** Resolving what a tool call calls people to the people the splits mean, with errors that say what to send instead. */
export function createPersonResolver(deps: Pick<DomainDeps, "db" | "accountant">) {
	const { db } = deps;
	const ownerKeys = new Set(OWNER_WORDS);
	const configured = deps.accountant?.ownerName;
	if (configured !== undefined && nameKey(configured) !== "") ownerKeys.add(nameKey(configured));

	/** `field` names the parameter, so the message names what the model sent. */
	function resolve(typed: string, field: string): PersonRef {
		const name = oneLine(typed).slice(0, MAX_NAME);
		const key = nameKey(name);
		if (key === "") {
			throw new Error(
				`${field}: a person needs a name with letters or digits in it; got '${typed.slice(0, 20)}'. Use 'me' for the owner.`,
			);
		}
		if (ownerKeys.has(key)) return { key: OWNER_KEY, name: OWNER_NAME };
		const matches = db.all<{ id: string }>("SELECT id FROM people_person WHERE lower(name) = lower(?)", name);
		const personId = matches.length === 1 ? matches[0]?.id : undefined;
		return { key, name, ...(personId === undefined ? {} : { personId }) };
	}

	return { resolve };
}

/** The words of a name key. */
const wordsOf = (key: string): string[] => key.split(" ").filter((word) => word !== "");

/**
 * The people the bills already know whose name only partly matches `person`: every word of one name is a word of the
 * other ("Pema" and "Pema Dorji", "Dorji" and "Pema Dorji"). Empty when the name is the owner, a whole-name match or
 * unrelated to every known name. People are matched by their whole name, so these are the cases where the model may have
 * meant someone who is already there, or may be about to make a second person.
 */
export function partialMatches(db: AppDb, person: PersonRef): Array<{ key: string; name: string }> {
	if (person.key === OWNER_KEY) return [];
	const known = knownPeople(db);
	if (known.has(person.key)) return [];
	const words = new Set(wordsOf(person.key));
	return [...known.entries()]
		.filter(([key]) => {
			if (key === OWNER_KEY) return false;
			const other = new Set(wordsOf(key));
			return [...words].every((word) => other.has(word)) || [...other].every((word) => words.has(word));
		})
		.map(([key, name]) => ({ key, name }));
}

/**
 * Names that are new to the bills but look like one that is not: "Pema" when "Pema Dorji" has shared bills before. A new bill
 * only gets this warning, because a bill that names someone new is how a friend joins; a payment may not (see
 * {@link ambiguousPayer}).
 */
export function lookalikes(db: AppDb, people: readonly PersonRef[]): string[] {
	const notes: string[] = [];
	for (const person of people) {
		const similar = partialMatches(db, person);
		if (similar.length > 0) {
			notes.push(
				`'${person.name}' is new here, and ${similar.map(({ name }) => `'${name}'`).join(" and ")} appear${similar.length === 1 ? "s" : ""} in earlier bills. People are matched by their whole name: if they are the same person, use the same name from now on (propose_delete_split removes a bill that was entered under the wrong one).`,
			);
		}
	}
	return notes;
}

/**
 * What to tell the model when a payment names someone by part of a known person's name. A payment from "Pema" when "Pema
 * Dorji" owes the owner would otherwise start a second person, reverse the debt and leave the real one open; so nothing is
 * recorded until it is clear who paid. Undefined when no name is in doubt.
 */
export function ambiguousPayer(
	db: AppDb,
	people: ReadonlyArray<{ role: string; person: PersonRef }>,
): string | undefined {
	const doubts = people.flatMap(({ role, person }) => {
		const similar = partialMatches(db, person);
		return similar.length === 0 ? [] : [{ role, person, similar }];
	});
	if (doubts.length === 0) return undefined;
	const parts = doubts.map(
		({ role, person, similar }) =>
			`'${person.name}' (${role}) could be ${similar.map(({ name }) => `'${name}'`).join(" or ")}, who ${similar.length === 1 ? "is" : "are"} already in the bills`,
	);
	const example = doubts[0]?.similar[0]?.name ?? "";
	return (
		`Nothing was recorded: ${parts.join("; ")}. Ask the owner which person they mean, then call record_settlement again with the full name ('${example}'). ` +
		"If it really is somebody else, call it again with new_person true."
	);
}
