"use client";

import type { AgentSummary, ServerHealth } from "@assistant/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, fetchAgents } from "./api.ts";

const POLL_MS = 4000;

export type AgentsState = {
	/** Undefined until the first answer arrives. Kept (stale) while the server is unreachable. */
	agents: AgentSummary[] | undefined;
	/** What the server says about itself; undefined until the first answer. */
	health: ServerHealth | undefined;
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
	const [error, setError] = useState<string>();

	const refresh = useCallback(() => {
		fetchAgents().then(
			(next) => {
				setAgents(next.agents);
				setHealth(next.health);
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

	return { agents, health, error, refresh };
}
