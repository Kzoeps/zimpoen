"use client";

import type { AgentSummary, BudgetHealth, ServerHealth } from "@assistant/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, fetchAgents } from "./api.ts";

const POLL_MS = 4000;

export type AgentsState = {
	/** Undefined until the first answer arrives. Kept (stale) while the server is unreachable. */
	agents: AgentSummary[] | undefined;
	/** What the server says about itself; undefined until the first answer. */
	health: ServerHealth | undefined;
	/** The agents that reached their weekly token limit; undefined until the first answer. */
	budget: BudgetHealth | undefined;
	error: string | undefined;
	refresh: () => void;
};

/**
 * The sidebar's agents with their busy flags. Polled rather than streamed: four small rows, and the open thread
 * already has its own live stream. Pauses while the tab is hidden.
 */
export function useAgents(): AgentsState {
	const [agents, setAgents] = useState<AgentSummary[]>();
	const [health, setHealth] = useState<ServerHealth>();
	const [budget, setBudget] = useState<BudgetHealth>();
	const [error, setError] = useState<string>();

	const refresh = useCallback(() => {
		fetchAgents().then(
			(next) => {
				setAgents(next.agents);
				setHealth(next.health);
				setBudget(next.budget);
				setError(undefined);
			},
			(failure: unknown) =>
				setError(failure instanceof ApiRequestError ? failure.message : "Could not load the agents."),
		);
	}, []);

	useEffect(() => {
		refresh();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") refresh();
		}, POLL_MS);
		const onVisible = () => document.visibilityState === "visible" && refresh();
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [refresh]);

	return { agents, health, budget, error, refresh };
}
