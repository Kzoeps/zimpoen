import type { AgentId } from "./agents.ts";

/**
 * What the agents did (M8): a read-only list worked out from the threads (the tools they called, and what the timers
 * posted for them), newest first. Nothing is written for it.
 */

export type ActivityItem = {
	/** Stable within the thread: `<agent>:<entry>:<n>`. */
	id: string;
	agent: AgentId;
	/** When it happened, epoch ms, and the same moment for people in the owner's zone. */
	at: number;
	atText: string;
	/** `tool`: an agent called a tool. `system`: a timer posted a card for the agent (a reminder, the briefing). */
	source: "tool" | "system";
	/** The tool's name, or what the card is: `reminder`, `briefing`. */
	name: string;
	/** One line of what it did or answered, at most 160 characters. */
	summary: string;
	/** The tool answered with an error. */
	failed?: true;
	/** The thread it is in: `/chat/<agent>`. */
	conversationId: number;
	entryId: number;
};

/** `GET /api/activity`. */
export type ActivityResponse = {
	timezone: string;
	items: ActivityItem[];
	/** Pass back as `cursor` for the next, older page. Absent at the end. */
	next?: string;
	/** The server stopped looking before it reached the start of the range (a very long thread): older items may exist. */
	truncated?: true;
};

export const DEFAULT_ACTIVITY_PAGE = 50;
export const MAX_ACTIVITY_PAGE = 100;

export type ActivityAgentFilter = AgentId | "all";
