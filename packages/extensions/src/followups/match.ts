/**
 * Which meeting does "the Dabtonog house one" mean? Matching is by words, not by guessing: every word of what the owner
 * said (minus filler such as "meeting" and "with") has to appear in the meeting, so a name that matches two meetings
 * returns both and the caller asks, and a name that matches none returns none instead of the nearest one.
 */

const FILLER = new Set([
	"a",
	"an",
	"the",
	"my",
	"our",
	"your",
	"with",
	"about",
	"for",
	"of",
	"to",
	"on",
	"at",
	"in",
	"and",
	"meeting",
	"meet",
	"call",
	"chat",
	"talk",
	"next",
	"upcoming",
	"agenda",
	"one",
]);

/** The words that carry meaning in `text`: lower case, letters and digits only, no filler, no single characters. */
export function significantWords(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 1 && !FILLER.has(word));
}

/** Words match when equal, or when one starts with the other and the shorter has at least three letters ("house" ~ "houses"). */
function sameWord(wanted: string, have: string): boolean {
	if (wanted === have) return true;
	const [short, long] = wanted.length <= have.length ? [wanted, have] : [have, wanted];
	return short.length >= 3 && long.startsWith(short);
}

type Searchable = { title: string; counterpart: string; context: string };

function containsAll(wanted: readonly string[], text: string): boolean {
	const words = significantWords(text);
	return wanted.every((word) => words.some((have) => sameWord(word, have)));
}

/**
 * The candidates `query` names. A query that is only filler ("the meeting") names no one in particular and matches all
 * of them. The title and counterpart are searched first; only when they match nothing is the background context
 * searched too, because the owner may name a meeting by what it is about.
 */
export function matchMeetings<T extends Searchable>(query: string, candidates: readonly T[]): T[] {
	const wanted = significantWords(query);
	if (wanted.length === 0) return [...candidates];
	const byName = candidates.filter((candidate) => containsAll(wanted, `${candidate.title} ${candidate.counterpart}`));
	if (byName.length > 0) return byName;
	return candidates.filter((candidate) =>
		containsAll(wanted, `${candidate.title} ${candidate.counterpart} ${candidate.context}`),
	);
}
