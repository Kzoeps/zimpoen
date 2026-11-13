/** Built-in agents. `cto` exists only with `ZIMPOEN_CTO=on` (PLAN upgrade §7). */
export const AGENT_IDS = ["pa", "inbox", "health", "accountant", "cto"] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentId(value: string): value is AgentId {
	return (AGENT_IDS as readonly string[]).includes(value);
}

/**
 * A specialist bot the PA created (PLAN upgrade §4): `bot:<slug>`. Built-in agents keep {@link AgentId}; code that must
 * accept either (memory scopes, ask_agent, the sidebar) uses {@link AnyAgentId}.
 */
export type BotId = `bot:${string}`;

/** A bot's slug: lowercase letters, digits and dashes, starting with a letter, 2 to 32 characters. */
export const BOT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export type AnyAgentId = AgentId | BotId;

export function isBotId(value: string): value is BotId {
	return value.startsWith("bot:") && BOT_SLUG_PATTERN.test(value.slice(4));
}

export function isAnyAgentId(value: string): value is AnyAgentId {
	return isAgentId(value) || isBotId(value);
}

export const botIdOf = (slug: string): BotId => `bot:${slug}`;

/** One row of the sidebar: who the agent is and whether it is working right now. */
export type AgentSummary = {
	id: AnyAgentId;
	name: string;
	/** An emoji. */
	avatar: string;
	/** Durable conversation that holds this agent's one endless thread. */
	conversationId: number;
	/** A run is in progress: the model is answering or a tool is running. */
	busy: boolean;
};
