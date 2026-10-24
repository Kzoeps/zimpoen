import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

export const PROFILE_EXTENSION_NAME = "profile";

/** Stable facts about the owner that every agent is told. */
export type ProfileFacts = {
	ownerName: string;
	/** IANA time zone, for example `Asia/Thimphu`. */
	timezone: string;
	/** ISO 4217 code, for example `BTN`. */
	currency: string;
};

/**
 * The text of the `profile` prompt section.
 *
 * Deterministic on purpose: Durable appends a system-prompt delta (and misses the provider's prompt cache) whenever a
 * section's rendered text changes, so nothing time-dependent, such as today's date, may go in here.
 */
export function renderProfile(facts: ProfileFacts): string {
	return [
		`Owner: ${facts.ownerName}`,
		`Time zone: ${facts.timezone}. Read and write every date and time in this zone unless told otherwise.`,
		`Currency: ${facts.currency}. Assume amounts are in this currency unless told otherwise.`,
	].join("\n");
}

/** Every agent installs this: the owner's name, time zone and currency as one prompt section. No tools. */
export function createProfileExtension(facts: ProfileFacts): Extension {
	const text = renderProfile(facts);
	return defineExtension({
		name: PROFILE_EXTENSION_NAME,
		sections: [section("profile", () => text)],
	});
}
