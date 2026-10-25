"use client";

import type { AgentUsage, UsageResponse } from "@assistant/shared";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { ApiRequestError, fetchUsage, updateBudget } from "../lib/api.ts";
import { cacheShare, formatCost, formatTokens, parseTokenLimit, percentOf } from "../lib/owner-pages.ts";

const messageOf = (error: unknown, fallback: string): string =>
	error instanceof ApiRequestError ? error.message : fallback;

/** What each agent spent this week and since the beginning, the weekly limit the owner sets, and the days and weeks before. */
export function UsageView() {
	const [data, setData] = useState<UsageResponse>();
	const [error, setError] = useState<string>();
	const [view, setView] = useState<"days" | "weeks">("days");

	useEffect(() => {
		fetchUsage().then(setData, (failure: unknown) => setError(messageOf(failure, "Could not load the usage.")));
	}, []);

	return (
		<div className="settings">
			<div className="settings__column">
				<Link href="/chat/pa" className="settings__back">
					← Back to chat
				</Link>
				<h1 className="settings__title">Usage</h1>
				<p className="settings__intro">
					What the agents spent, as the model provider counts it. The weekly limit is a soft one: when an agent reaches
					it, its briefing, wrap-up and digests become plain cards that cost no tokens, until the week turns on Monday (
					{data === undefined ? "owner's time zone" : data.timezone}). What you type is never held back.
				</p>
				{error !== undefined ? (
					<p className="notice notice--error" role="alert">
						{error}
					</p>
				) : null}
				{data === undefined && error === undefined ? <p className="placeholder">Loading…</p> : null}
				{data?.agents.map((agent) => (
					<AgentCard key={agent.id} agent={agent} onChange={setData} />
				))}
				{data !== undefined ? <History data={data} view={view} onView={setView} /> : null}
				{data !== undefined ? <Models data={data} /> : null}
			</div>
		</div>
	);
}

function AgentCard({ agent, onChange }: { agent: AgentUsage; onChange: (data: UsageResponse) => void }) {
	const [text, setText] = useState(agent.limit === undefined ? "" : String(agent.limit));
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState<{ kind: "saved" | "error"; text: string }>();
	const inputId = useId();
	const parsed = parseTokenLimit(text);
	const unchanged = parsed === (agent.limit ?? null);

	const save = async (): Promise<void> => {
		if (parsed === undefined) return;
		setSaving(true);
		setResult(undefined);
		try {
			const saved = await updateBudget(agent.id, parsed);
			onChange(saved);
			setText(parsed === null ? "" : String(parsed));
			setResult({ kind: "saved", text: parsed === null ? "No limit." : "Saved." });
		} catch (failure) {
			setResult({ kind: "error", text: messageOf(failure, "Could not save the limit.") });
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className="settings-card" aria-label={`${agent.name} usage`}>
			<h2 className="settings-card__title">
				<span aria-hidden="true">{agent.avatar}</span> {agent.name}
			</h2>
			<p className="usage-figure" data-testid={`week-${agent.id}`}>
				<strong>{formatTokens(agent.week.tokens)}</strong> tokens this week
				{agent.limit === undefined ? "" : ` of ${formatTokens(agent.limit)}`}{" "}
				<span className="card__muted">· {formatCost(agent.week.cost)} at API prices</span>
			</p>
			{agent.limit !== undefined ? (
				<div
					className="usage-bar"
					role="img"
					aria-label={`${percentOf(agent.week.tokens, agent.limit)}% of the weekly limit`}
				>
					<div
						className={`usage-bar__fill${agent.over ? " usage-bar__fill--over" : ""}`}
						style={{ width: `${percentOf(agent.week.tokens, agent.limit)}%` }}
					/>
				</div>
			) : null}
			{agent.over ? (
				<p className="notice notice--error" role="alert">
					Limit reached: this agent's briefing, wrap-up and digests are plain cards until Monday.
				</p>
			) : null}
			<p className="settings-card__hint">
				This week: {formatTokens(agent.week.input)} in, {formatTokens(agent.week.output)} out,{" "}
				{formatTokens(agent.week.cacheRead + agent.week.cacheWrite)} cached ({cacheShare(agent.week)}% of the total).
				Since the beginning: {formatTokens(agent.allTime.tokens)} tokens, {formatCost(agent.allTime.cost)}.
			</p>
			<form
				className="owner-limit"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<label htmlFor={inputId}>Weekly limit (tokens)</label>
				<input
					id={inputId}
					className="owner-input"
					inputMode="numeric"
					placeholder="no limit (e.g. 500k)"
					value={text}
					disabled={saving}
					onChange={(event) => setText(event.target.value)}
				/>
				<button type="submit" className="settings-card__save" disabled={parsed === undefined || unchanged || saving}>
					{saving ? "Saving…" : "Save"}
				</button>
			</form>
			{parsed === undefined ? (
				<p className="settings-card__result settings-card__result--error" role="status">
					Use a whole number of tokens, such as 500000, 500k or 2m; leave it empty for no limit.
				</p>
			) : (
				<span
					className={`settings-card__result${result?.kind === "error" ? " settings-card__result--error" : ""}`}
					role="status"
				>
					{result?.text}
				</span>
			)}
		</section>
	);
}

function History({
	data,
	view,
	onView,
}: {
	data: UsageResponse;
	view: "days" | "weeks";
	onView: (view: "days" | "weeks") => void;
}) {
	const rows =
		view === "days"
			? data.days.map((day) => ({ key: day.date, label: day.label, tokens: day.tokens, cost: day.cost }))
			: data.weeks.map((week) => ({ key: week.start, label: week.label, tokens: week.tokens, cost: week.cost }));
	const peak = Math.max(1, ...rows.map((row) => row.tokens));
	return (
		<section className="settings-card" aria-label="History">
			<h2 className="settings-card__title">
				<span aria-hidden="true">📈</span> {view === "days" ? "The last 14 days" : "The last 8 weeks"}
			</h2>
			<div className="owner-tabs">
				{(["days", "weeks"] as const).map((choice) => (
					<button
						key={choice}
						type="button"
						className="owner-tab"
						aria-pressed={view === choice}
						onClick={() => onView(choice)}
					>
						{choice === "days" ? "Days" : "Weeks"}
					</button>
				))}
			</div>
			<div className="usage-history">
				{rows.map((row) => (
					<div key={row.key} className="usage-history__row">
						<span>{row.label}</span>
						<div className="usage-bar">
							<div className="usage-bar__fill" style={{ width: `${Math.round((row.tokens / peak) * 100)}%` }} />
						</div>
						<span className="card__muted">
							{formatTokens(row.tokens)} · {formatCost(row.cost)}
						</span>
					</div>
				))}
			</div>
			<p className="settings-card__hint">
				Spend is dated to the day it was first seen (the server reads Durable's totals every ten minutes), and spend
				from before this page existed has no day.
			</p>
		</section>
	);
}

function Models({ data }: { data: UsageResponse }) {
	const rows = data.agents.flatMap((agent) => agent.models.map((model) => ({ agent, model })));
	if (rows.length === 0) return null;
	return (
		<section className="settings-card" aria-label="By model">
			<h2 className="settings-card__title">
				<span aria-hidden="true">🧮</span> By model, since the beginning
			</h2>
			<ul className="facts">
				{rows.map(({ agent, model }) => (
					<li key={`${agent.id}:${model.model}`}>
						{agent.name} · <code>{model.model}</code>: {formatTokens(model.tokens)} tokens ({formatTokens(model.input)}{" "}
						in, {formatTokens(model.output)} out), {formatCost(model.cost)}
					</li>
				))}
			</ul>
		</section>
	);
}
