import type { AgentId } from "./agents.ts";

/**
 * What the agents spent (M8), as Durable counts it (`pi.usage`), sampled into per-day totals so that a day and a week can
 * be told apart, and the weekly token limit that makes the daily jobs stop asking the model.
 */

/** Tokens as the provider reports them, and the cost its price list gives them (US dollars; what a subscription costs is another matter). */
export type UsageFigures = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** The provider's own total: what the weekly limit counts. */
	tokens: number;
	/** US dollars at API prices. A ChatGPT subscription does not bill by it. */
	cost: number;
};

/** One model (`openai/gpt-6.1-sol`) or one tool that spent on its own (`tool:name`). */
export type UsageModelRow = UsageFigures & { model: string };

export type AgentUsage = {
	id: AgentId;
	name: string;
	avatar: string;
	/** This week so far (Monday to today, in the owner's zone). */
	week: UsageFigures;
	/** Since the conversation began, from Durable's own ledger. */
	allTime: UsageFigures;
	/** Per model, since the conversation began. */
	models: UsageModelRow[];
	/** The weekly token limit; absent when the owner set none. */
	limit?: number;
	/** The week's tokens have reached the limit. */
	over: boolean;
};

export type UsageDay = {
	/** `2026-10-26`, a local day. */
	date: string;
	/** `Mon 26 Oct`. */
	label: string;
	tokens: number;
	cost: number;
	byAgent: Partial<Record<AgentId, number>>;
};

export type UsageWeek = {
	/** The Monday, `2026-10-26`. */
	start: string;
	/** `Week of 26 Oct`. */
	label: string;
	tokens: number;
	cost: number;
	byAgent: Partial<Record<AgentId, number>>;
};

/** `GET /api/usage`. */
export type UsageResponse = {
	timezone: string;
	/** The Monday of the current week, and today. */
	weekStart: string;
	today: string;
	agents: AgentUsage[];
	/** The last 14 local days, oldest first; a day with nothing is listed with zeros. */
	days: UsageDay[];
	/** The last 8 weeks, oldest first. */
	weeks: UsageWeek[];
	/** When the numbers were last read from Durable, epoch ms. Spend before the first reading has no day. */
	sampledAt: number;
};

/** An agent that has reached its weekly limit: what the banner says. */
export type BudgetAlert = {
	agent: AgentId;
	name: string;
	used: number;
	limit: number;
};

/** What `GET /api/agents` says about the budget: empty when every agent is within its limit (or has none). */
export type BudgetHealth = { over: BudgetAlert[] };

/** `PUT /api/settings/budget/:agent`. `null` removes the limit. */
export type UpdateBudgetRequest = { weeklyTokens: number | null };

/** The largest weekly limit accepted: far above any plan, and small enough for exact arithmetic. */
export const MAX_WEEKLY_TOKENS = 1_000_000_000_000;
