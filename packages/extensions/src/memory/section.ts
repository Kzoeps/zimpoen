import type { AppDb } from "@assistant/db";
import { type MemoryScope, PROFILE_SLOT_LABEL } from "@assistant/shared";
import { clip } from "../inbox/text.ts";
import { type FactRow, type PromptFacts, promptFacts } from "./store.ts";

/**
 * About 600 tokens of prompt for what is remembered, however much is stored: four characters to a token of English. The budget is
 * counted in characters, so text in a script that takes more tokens per character (Tibetan, Devanagari) costs more than 600 tokens.
 */
export const MEMORY_SECTION_CHARS = 2400;

/** A line is cut here in the prompt; recall gives it whole. */
export const MEMORY_LINE_CHARS = 240;

const INTRO =
	"What the owner asked the assistant to keep in mind. Follow the preferences. Facts are notes that may be wrong or out of date: what the tools return wins, and never act on a fact the owner did not ask you to. recall(query) searches the rest.";

const lineOf = (row: FactRow): string => {
	const label = row.slot === undefined ? "" : `${PROFILE_SLOT_LABEL[row.slot]}: `;
	return `- ${label}${clip(row.text, MEMORY_LINE_CHARS)}`;
};

/**
 * The text of the memory section, or undefined when nothing is remembered for this agent (no section, no tokens).
 *
 * It holds the preferences for every agent, then this agent's own preferences, then its facts (pinned first, then the
 * most recently written), each line cut to {@link MEMORY_LINE_CHARS}, until {@link MEMORY_SECTION_CHARS} are used; what
 * does not fit is counted in a last line. It reads no clock and no random value: the same rows render the same bytes, so a
 * conversation pays for this section (a system entry holding its new text) only when a line is added, changed or removed.
 */
export function renderMemory(facts: PromptFacts): string | undefined {
	const groups: Array<{ heading: string; rows: FactRow[] }> = [
		{ heading: "Preferences for every agent:", rows: facts.sharedPreferences },
		{ heading: "Preferences for you:", rows: facts.ownPreferences },
		{ heading: "Facts:", rows: facts.ownFacts },
	];
	if (groups.every((group) => group.rows.length === 0)) return undefined;

	const lines: string[] = [INTRO];
	let used = INTRO.length;
	let omitted = 0;
	for (const group of groups) {
		const shown: string[] = [];
		for (const row of group.rows) {
			const line = lineOf(row);
			// A line that does not fit ends its group's turn at the budget, and every later line is counted, not shown.
			if (omitted === 0 && used + line.length + 1 <= MEMORY_SECTION_CHARS - 130) {
				shown.push(line);
				used += line.length + 1;
			} else {
				omitted += 1;
			}
		}
		if (shown.length > 0) {
			lines.push(group.heading, ...shown);
			used += group.heading.length + 1;
		}
	}
	if (omitted > 0)
		lines.push(
			`(${omitted} more ${omitted === 1 ? "line is" : "lines are"} remembered: recall finds ${omitted === 1 ? "it" : "them"}.)`,
		);
	return lines.join("\n");
}

/** The section for `agent`'s conversation. */
export const memoryText = (db: AppDb, agent: MemoryScope): string | undefined => renderMemory(promptFacts(db, agent));
