import type {
	ActivityAgentFilter,
	AgentId,
	MemoryFactView,
	MemoryKind,
	MemoryScope,
	UsageFigures,
} from "@assistant/shared";

/** The pure parts of the owner's pages (profile, activity, usage): what they ask the server, and how numbers read. */

export type ActivityQuery = {
	agent?: ActivityAgentFilter;
	from?: string;
	to?: string;
	cursor?: string;
};

/** `?agent=…&from=…`: only what is set. "all" and an empty day are not sent. */
export function activityQueryString(query: ActivityQuery): string {
	const params = new URLSearchParams();
	if (query.agent !== undefined && query.agent !== "all") params.set("agent", query.agent);
	if (query.from !== undefined && query.from !== "") params.set("from", query.from);
	if (query.to !== undefined && query.to !== "") params.set("to", query.to);
	if (query.cursor !== undefined) params.set("cursor", query.cursor);
	const text = params.toString();
	return text === "" ? "" : `?${text}`;
}

export type MemoryQuery = { scope?: MemoryScope | "all"; kind?: MemoryKind | "all"; q?: string; limit?: number };

export function memoryQueryString(query: MemoryQuery): string {
	const params = new URLSearchParams();
	if (query.scope !== undefined && query.scope !== "all") params.set("scope", query.scope);
	if (query.kind !== undefined && query.kind !== "all") params.set("kind", query.kind);
	const q = query.q?.trim();
	if (q !== undefined && q !== "") params.set("q", q);
	if (query.limit !== undefined) params.set("limit", String(query.limit));
	const text = params.toString();
	return text === "" ? "" : `?${text}`;
}

/** Tabs of the memory editor, in the order shown. */
export const MEMORY_TABS: ReadonlyArray<{ scope: MemoryScope; label: string }> = [
	{ scope: "shared", label: "Shared" },
	{ scope: "pa", label: "Assistant" },
	{ scope: "inbox", label: "Inbox" },
	{ scope: "health", label: "Health" },
	{ scope: "accountant", label: "Accountant" },
];

/** Where a remembered line can be moved to, and what to call it: every agent's memory, or one agent's. */
export const scopeName = (scope: MemoryScope): string => MEMORY_TABS.find((tab) => tab.scope === scope)?.label ?? scope;

/** The places a line can move to: every scope but the one it is in (the page owns the two profile lines: they cannot move). */
export function moveTargets(
	fact: Pick<MemoryFactView, "scope" | "slot">,
): Array<{ scope: MemoryScope; label: string }> {
	if (fact.slot !== undefined) return [];
	return MEMORY_TABS.filter((tab) => tab.scope !== fact.scope).map((tab) => ({
		scope: tab.scope,
		label: tab.scope === "shared" ? "Every agent" : tab.label,
	}));
}

/**
 * Who a line came from, in a few words: the owner's own, a preference an agent asked for (the owner said yes, or it would not
 * be here), or a fact an agent noted. A line from before origins were recorded says only that an agent kept it.
 */
export function originLabel(fact: Pick<MemoryFactView, "source" | "kind" | "origin">): string {
	if (fact.source === "owner") return "written by you";
	if (fact.origin === undefined) return "kept by an agent";
	const who = `the ${scopeName(fact.origin.agent)} agent`;
	return fact.kind === "preference" ? `asked for by ${who}, and you approved it` : `noted by ${who}`;
}

/** `12,345`, or `1.2M` from a million: the dashboard's tokens. */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
	return Math.round(tokens).toLocaleString("en-US");
}

/** Dollars at API prices: `$0.0123`, and `$0` for nothing. */
export function formatCost(dollars: number): string {
	if (dollars === 0) return "$0";
	return dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

/**
 * What the owner typed as a weekly limit: a whole number of tokens (spaces, commas and `k`/`m` suffixes allowed: `500k`,
 * `1.5m`), `null` for an empty box (no limit), `undefined` for something that is not a number of tokens.
 */
export function parseTokenLimit(text: string): number | null | undefined {
	const cleaned = text.trim().toLowerCase().replaceAll(",", "").replaceAll(" ", "");
	if (cleaned === "") return null;
	const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(cleaned);
	if (match === null) return undefined;
	const value = Math.round(Number(match[1]) * (match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1));
	return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/** How much of the limit is used, 0 to 100 for the bar (a bar past full stays full; the text says the real number). */
export const percentOf = (used: number, limit: number | undefined): number =>
	limit === undefined || limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));

/** The cache's share of what was read in, for the line under a card: cache reads are most of every request after the first. */
export const cacheShare = (figures: UsageFigures): number =>
	figures.tokens === 0 ? 0 : Math.round(((figures.cacheRead + figures.cacheWrite) / figures.tokens) * 100);

/** `Assistant` for `pa`, from the list the server gave. */
export const agentName = (agents: ReadonlyArray<{ id: AgentId; name: string }>, id: AgentId): string =>
	agents.find((agent) => agent.id === id)?.name ?? id;
