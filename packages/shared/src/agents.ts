export const AGENT_IDS = ["pa", "inbox", "health", "accountant"] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentId(value: string): value is AgentId {
	return (AGENT_IDS as readonly string[]).includes(value);
}

/** One row of the sidebar: who the agent is and whether it is working right now. */
export type AgentSummary = {
	id: AgentId;
	name: string;
	/** An emoji. */
	avatar: string;
	/** Durable conversation that holds this agent's one endless thread. */
	conversationId: number;
	/** A run is in progress: the model is answering or a tool is running. */
	busy: boolean;
};
