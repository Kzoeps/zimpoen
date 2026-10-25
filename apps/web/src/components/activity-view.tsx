"use client";

import type { ActivityItem, ActivityResponse, AgentId } from "@assistant/shared";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiRequestError, fetchActivity } from "../lib/api.ts";
import type { ActivityQuery } from "../lib/owner-pages.ts";
import { useChat } from "./chat-context.tsx";

const messageOf = (error: unknown, fallback: string): string =>
	error instanceof ApiRequestError ? error.message : fallback;

/** What the agents did, newest first: the tools they called and what the timers posted for them. Read-only. */
export function ActivityView() {
	const { agents } = useChat();
	const [filters, setFilters] = useState<ActivityQuery>({ agent: "all", from: "", to: "" });
	const [items, setItems] = useState<ActivityItem[]>();
	const [next, setNext] = useState<string>();
	const [truncated, setTruncated] = useState(false);
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const agentId = useId();
	const fromId = useId();
	const toId = useId();
	// Only the newest request may fill the list: a slow answer for filters since changed must not replace what is shown.
	const newest = useRef(0);

	const load = useCallback(async (query: ActivityQuery, append: boolean): Promise<void> => {
		const ticket = ++newest.current;
		setLoading(true);
		setError(undefined);
		try {
			const page: ActivityResponse = await fetchActivity(query);
			if (ticket !== newest.current) return;
			setItems((current) => (append ? [...(current ?? []), ...page.items] : page.items));
			setNext(page.next);
			setTruncated(page.truncated === true);
		} catch (failure) {
			if (ticket === newest.current) setError(messageOf(failure, "Could not load the activity."));
		} finally {
			if (ticket === newest.current) setLoading(false);
		}
	}, []);

	// The list follows the filters: changing one starts again from the newest.
	useEffect(() => {
		void load(filters, false);
	}, [filters, load]);

	const named = (id: AgentId) => agents?.find((agent) => agent.id === id);

	return (
		<div className="settings">
			<div className="settings__column">
				<Link href="/chat/pa" className="settings__back">
					← Back to chat
				</Link>
				<h1 className="settings__title">Activity</h1>
				<p className="settings__intro">
					What the agents did: the tools they called, and the reminders, briefings and questions the assistant posted
					for them. It is worked out from the conversations, so it always agrees with them.
				</p>
				<form className="settings-card owner-filters" onSubmit={(event) => event.preventDefault()}>
					<label htmlFor={agentId}>Agent</label>
					<select
						id={agentId}
						className="owner-input"
						value={filters.agent ?? "all"}
						onChange={(event) => setFilters({ ...filters, agent: event.target.value as ActivityQuery["agent"] })}
					>
						<option value="all">Every agent</option>
						{agents?.map((agent) => (
							<option key={agent.id} value={agent.id}>
								{agent.name}
							</option>
						))}
					</select>
					<label htmlFor={fromId}>From</label>
					<input
						id={fromId}
						className="owner-input"
						type="date"
						value={filters.from ?? ""}
						onChange={(event) => setFilters({ ...filters, from: event.target.value })}
					/>
					<label htmlFor={toId}>To</label>
					<input
						id={toId}
						className="owner-input"
						type="date"
						value={filters.to ?? ""}
						onChange={(event) => setFilters({ ...filters, to: event.target.value })}
					/>
				</form>
				{error !== undefined ? (
					<p className="notice notice--error" role="alert">
						{error}
					</p>
				) : null}
				{items === undefined && error === undefined ? <p className="placeholder">Loading…</p> : null}
				{items?.length === 0 ? <p className="placeholder">Nothing in this range.</p> : null}
				<ul className="owner-list" aria-label="Activity">
					{items?.map((item) => (
						<li key={item.id} className={`owner-row${item.failed === true ? " owner-row--failed" : ""}`}>
							<p className="owner-row__text">{item.summary}</p>
							<p className="owner-row__meta">
								<span>{item.atText}</span>
								<span>
									{named(item.agent)?.avatar} {named(item.agent)?.name ?? item.agent}
								</span>
								<span className="chip">{item.name}</span>
								{item.failed === true ? <span className="chip chip--late">failed</span> : null}
								<Link href={`/chat/${item.agent}`}>Open the conversation</Link>
							</p>
						</li>
					))}
				</ul>
				{truncated ? (
					<p className="settings-card__hint">
						A conversation here is very long: only its newest entries were searched, so older items are not listed.
					</p>
				) : null}
				{next !== undefined ? (
					<button
						type="button"
						className="owner-button"
						disabled={loading}
						onClick={() => void load({ ...filters, cursor: next }, true)}
					>
						{loading ? "Loading…" : "Load more"}
					</button>
				) : null}
			</div>
		</div>
	);
}
