"use client";

import type { AgentSettings, AllAgentSettingsResponse, ModelOption } from "@assistant/shared";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { ApiRequestError, fetchAgentSettings, updateAgentSettings } from "../lib/api.ts";
import {
	changeOf,
	draftOf,
	findModel,
	modelKey,
	offeredModels,
	type SettingsDraft,
	withModel,
} from "../lib/settings-form.ts";
import { GoogleCard } from "./google-card.tsx";
import { NotificationsCard } from "./notifications-card.tsx";
import { ScheduleCard } from "./schedule-card.tsx";

const messageOf = (error: unknown, fallback: string): string =>
	error instanceof ApiRequestError ? error.message : fallback;

/** Model and thinking level of every agent: the settings that change at runtime, never in code. */
export function SettingsView() {
	const [data, setData] = useState<AllAgentSettingsResponse>();
	const [error, setError] = useState<string>();
	const [showAll, setShowAll] = useState(false);

	useEffect(() => {
		fetchAgentSettings().then(setData, (failure: unknown) =>
			setError(messageOf(failure, "Could not load the settings.")),
		);
	}, []);

	return (
		<div className="settings">
			<div className="settings__column">
				<Link href="/chat/pa" className="settings__back">
					← Back to chat
				</Link>
				<h1 className="settings__title">Agent settings</h1>
				<p className="settings__intro">
					The model and thinking level of each agent. A change applies from the agent's next message.
				</p>
				{error !== undefined ? (
					<p className="notice notice--error" role="alert">
						{error}
					</p>
				) : null}
				<NotificationsCard />
				<ScheduleCard />
				<GoogleCard />
				{data === undefined && error === undefined ? <p className="placeholder">Loading…</p> : null}
				{data !== undefined && offeredModels(data.models, "", false).length < data.models.length ? (
					<label className="settings-card__check">
						<input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> Show all
						models ({data.models.length})
					</label>
				) : null}
				{data?.agents.map((agent) => (
					<AgentSettingsCard key={agent.id} initial={agent} models={data.models} showAll={showAll} />
				))}
			</div>
		</div>
	);
}

function AgentSettingsCard({
	initial,
	models,
	showAll,
}: {
	initial: AgentSettings;
	models: ModelOption[];
	showAll: boolean;
}) {
	const [settings, setSettings] = useState(initial);
	const [draft, setDraft] = useState<SettingsDraft>(() => draftOf(initial));
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState<{ kind: "saved" | "error"; text: string }>();
	const modelId = useId();
	const levelId = useId();

	const option = findModel(models, draft.model);
	const change = changeOf(settings, draft, models);

	const save = async (): Promise<void> => {
		if (change === undefined) return;
		setSaving(true);
		setResult(undefined);
		try {
			const saved = await updateAgentSettings(settings.id, change);
			setSettings(saved.agent);
			setDraft(draftOf(saved.agent));
			setResult({ kind: "saved", text: "Saved. It applies from the next message." });
		} catch (failure) {
			setResult({ kind: "error", text: messageOf(failure, "Could not save the settings.") });
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			className="settings-card"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<h2 className="settings-card__title">
				<span aria-hidden="true">{settings.avatar}</span> {settings.name}
			</h2>
			{!settings.modelAvailable ? (
				<p className="notice notice--error" role="alert">
					{settings.model === undefined
						? "This agent has no model yet."
						: `This agent is set to ${modelKey(settings.model)}, which this server cannot serve, so its messages fail.`}{" "}
					Choose a model below and save.
				</p>
			) : null}
			<label className="settings-card__field" htmlFor={modelId}>
				Model
				<select
					id={modelId}
					value={draft.model}
					onChange={(event) => setDraft(withModel(draft, models, event.target.value))}
				>
					{draft.model === "" ? (
						<option value="" disabled>
							Choose a model…
						</option>
					) : null}
					{offeredModels(models, draft.model, showAll).map((model) => (
						<option key={modelKey(model)} value={modelKey(model)}>
							{model.name}
						</option>
					))}
				</select>
			</label>
			<label className="settings-card__field" htmlFor={levelId}>
				Thinking level
				<select
					id={levelId}
					value={draft.thinkingLevel ?? ""}
					disabled={option === undefined}
					onChange={(event) =>
						setDraft({ ...draft, thinkingLevel: event.target.value as SettingsDraft["thinkingLevel"] })
					}
				>
					{option?.thinkingLevels.map((level) => (
						<option key={level} value={level}>
							{level}
						</option>
					))}
				</select>
			</label>
			<div className="settings-card__actions">
				<button type="submit" className="settings-card__save" disabled={change === undefined || saving}>
					{saving ? "Saving…" : "Save"}
				</button>
				<span
					className={`settings-card__result${result?.kind === "error" ? " settings-card__result--error" : ""}`}
					role="status"
				>
					{result?.text}
				</span>
			</div>
		</form>
	);
}
