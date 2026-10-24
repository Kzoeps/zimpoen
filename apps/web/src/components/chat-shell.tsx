"use client";

import type { ServerHealth } from "@assistant/shared";
import { type ReactNode, useMemo, useState } from "react";
import { ApiRequestError, retryTask } from "../lib/api.ts";
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
					{health !== undefined && health.parkedTasks > 0 ? <ParkedBanner health={health} refresh={refresh} /> : null}
					{children}
				</main>
			</div>
		</ChatContext.Provider>
	);
}

/**
 * Durable parks a task that crashes the process again and again, and the agent whose run it was goes silent. Nothing
 * retries it by itself, because the usual cause keeps killing the server; this button is the person deciding to try.
 */
function ParkedBanner({ health, refresh }: { health: ServerHealth; refresh: () => void }) {
	const [retrying, setRetrying] = useState(false);
	const [error, setError] = useState<string>();
	const many = health.parkedTasks !== 1;

	const retry = async (): Promise<void> => {
		setRetrying(true);
		setError(undefined);
		// One task that cannot be retried (another tab already did it: 404) must not keep the others from being tried.
		const failures: string[] = [];
		for (const task of health.parked) {
			try {
				await retryTask(task.id);
			} catch (failure) {
				failures.push(failure instanceof ApiRequestError ? failure.message : "Could not retry.");
			}
		}
		if (failures[0] !== undefined) {
			setError(failures.length > 1 ? `${failures[0]} (${failures.length - 1} more failed)` : failures[0]);
		}
		setRetrying(false);
		refresh();
	};

	return (
		<p className="banner banner--error" role="alert">
			{many ? `${health.parkedTasks} tasks have` : "1 task has"} stopped after the assistant crashed repeatedly. Chats
			that depend on {many ? "them" : "it"} stay silent until {many ? "they are" : "it is"} retried. If retrying does
			not help, see the server log.
			<button type="button" className="banner__retry" onClick={() => void retry()} disabled={retrying}>
				{retrying ? "Retrying…" : "Retry"}
			</button>
			{error !== undefined ? ` ${error}` : null}
		</p>
	);
}
