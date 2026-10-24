"use client";

import { type ReactNode, useMemo, useState } from "react";
import { createThreadStore } from "../lib/thread-store.ts";
import { useAgents } from "../lib/use-agents.ts";
import { AgentSidebar } from "./agent-sidebar.tsx";
import { ChatContext } from "./chat-context.tsx";

/** Sidebar plus the open thread. Lives in the layout, so switching agents keeps the sidebar and its polling. */
export function ChatShell({ children }: { children: ReactNode }) {
	const { agents, health, error, refresh } = useAgents();
	const [store] = useState(createThreadStore);
	const value = useMemo(() => ({ agents, health, error, refresh, store }), [agents, health, error, refresh, store]);

	return (
		<ChatContext.Provider value={value}>
			<div className="shell">
				<AgentSidebar />
				<main className="main">
					{health !== undefined && health.parkedTasks > 0 ? (
						<p className="banner banner--error" role="alert">
							{health.parkedTasks === 1 ? "1 task has" : `${health.parkedTasks} tasks have`} stopped after the assistant
							crashed repeatedly. Chats that depend on {health.parkedTasks === 1 ? "it" : "them"} stay silent until it
							is retried. See the server log.
						</p>
					) : null}
					{children}
				</main>
			</div>
		</ChatContext.Provider>
	);
}
