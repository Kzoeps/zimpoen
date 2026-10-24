"use client";

import { isAgentId } from "@assistant/shared";
import Link from "next/link";
import { useChat } from "./chat-context.tsx";
import { ThreadView } from "./thread-view.tsx";

/** The thread of one agent, once the agent list says which conversation that is. */
export function AgentThread({ agentId }: { agentId: string }) {
	const { agents, error } = useChat();

	if (agents === undefined) {
		return <p className="placeholder">{error ?? "Loading…"}</p>;
	}
	const agent = isAgentId(agentId) ? agents.find((candidate) => candidate.id === agentId) : undefined;
	if (agent === undefined) {
		return (
			<p className="placeholder">
				There is no agent called “{agentId}”. <Link href="/chat/pa">Go to the assistant</Link>.
			</p>
		);
	}
	// Keyed by conversation: switching agents builds a fresh runtime and connection instead of mutating the old ones.
	return <ThreadView key={agent.conversationId} agent={agent} />;
}
