import type { AgentId } from "./agents.ts";

/**
 * What the assistant remembers (M8): short lines the owner asked it to keep (`preference`) or that it learned and the
 * domain tools have no table for (`fact`), kept per agent (`scope` is the agent's id) or for every agent (`shared`).
 */

export type MemoryScope = "shared" | AgentId;

export type MemoryKind = "preference" | "fact";

export const MEMORY_KINDS: readonly MemoryKind[] = ["preference", "fact"];

/** The longest a remembered line is: a sentence, not a document. */
export const MAX_MEMORY_CHARS = 400;

/**
 * The most lines one `GET /api/memory` lists. A scope holds at most 400 lines (and the two profile lines), so one request
 * lists a whole scope and the profile page needs no paging.
 */
export const MAX_MEMORY_LIST = 500;

/**
 * The preferences the profile page owns, one row each: they carry a `slot`, so the page can change them in place. Their
 * text is what the owner wrote, and the prompt shows it under the slot's label.
 */
export const PROFILE_SLOTS = ["tone", "explanations"] as const;

export type ProfileSlot = (typeof PROFILE_SLOTS)[number];

export const PROFILE_SLOT_LABEL: Record<ProfileSlot, string> = {
	tone: "Preferred tone",
	explanations: "Preferred explanations",
};

export function isMemoryScope(value: unknown): value is MemoryScope {
	return value === "shared" || value === "pa" || value === "inbox" || value === "health" || value === "accountant";
}

export function isMemoryKind(value: unknown): value is MemoryKind {
	return value === "preference" || value === "fact";
}

/**
 * Where an agent-written line came from: the agent, its conversation and the moment it wrote or proposed the line. A
 * preference an agent proposed was approved by the owner later (`createdAt` is that moment); `at` is when it was asked.
 */
export type MemoryOrigin = { agent: AgentId; conversationId: number; at: number };

export type MemoryFactView = {
	id: string;
	scope: MemoryScope;
	kind: MemoryKind;
	text: string;
	/** A pinned fact is always in its agent's prompt, before the recent ones. Only a fact in an agent's own scope can be pinned. */
	pinned: boolean;
	/** Present for the preferences the profile page owns. */
	slot?: ProfileSlot;
	/**
	 * Who wrote it: an agent, or the owner on the profile page. A preference with source `agent` is one the owner approved
	 * when the agent proposed it (an agent cannot write a preference itself), and `origin` says who asked.
	 */
	source: "agent" | "owner";
	/** Present for what an agent wrote or proposed. */
	origin?: MemoryOrigin;
	createdAt: number;
	updatedAt: number;
};

/** The card of `remember`: what was kept (or was already kept). */
export type MemoryCard = {
	type: "memory";
	event: "saved" | "existing";
	fact: MemoryFactView;
};

/** The card of `recall`: what matched, best first. */
export type MemoryListCard = {
	type: "memory_list";
	heading: string;
	facts: MemoryFactView[];
	total: number;
};

/** `GET /api/memory`: the facts that match the filters, and how many each scope holds. */
export type MemoryResponse = {
	facts: MemoryFactView[];
	/** How many matched (the list holds at most `limit`). */
	total: number;
	counts: Record<MemoryScope, number>;
};

/** `PATCH /api/memory/:id` answers with the line as it is now. */
export type MemoryFactResponse = { fact: MemoryFactView };

/**
 * `PATCH /api/memory/:id`. At least one field. `scope` moves the line to another agent's memory or to every agent's (the
 * only way a fact becomes shared: an agent keeps its facts for itself).
 */
export type UpdateMemoryRequest = { text?: string; pinned?: boolean; scope?: MemoryScope };

/** A fact can be pinned only where the prompt lists it: a fact kept for one agent. Preferences are always in the prompt, shared facts are in none. */
export const canPin = (fact: Pick<MemoryFactView, "kind" | "scope">): boolean =>
	fact.kind === "fact" && fact.scope !== "shared";

export type ProfilePerson = {
	id: string;
	name: string;
	relation?: string;
	/** "5 Mar", or "5 Mar 1990" when the birth year is known. */
	birthdayText: string;
};

/**
 * `GET /api/profile`: who the agents are told the owner is (`name` is absent when none was configured), the two preferences
 * the page edits, and the people the PA keeps.
 */
export type ProfileResponse = {
	/** From the server's configuration (`ASSISTANT_*`): changed in the environment file, not here. */
	owner: { name?: string; timezone: string; currency: string; heightCm?: number };
	preferences: Partial<Record<ProfileSlot, string>>;
	people: ProfilePerson[];
};

/** `PUT /api/profile/preferences`. A string sets the preference, `null` clears it; a field left out is not touched. */
export type UpdatePreferencesRequest = Partial<Record<ProfileSlot, string | null>>;
