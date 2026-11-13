"use client";

import {
	TRUST_LEVEL_NAMES,
	type TrustLevelName,
	type TrustSettingsResponse,
	type TrustSettingView,
} from "@assistant/shared";
import { useEffect, useId, useState } from "react";
import { ApiRequestError, fetchTrust, updatePaTrust, updateProjectTrust } from "../lib/api.ts";
import { TRUST_TEXT, trustSourceText } from "../lib/bots-form.ts";

const messageOf = (error: unknown, fallback: string): string =>
	error instanceof ApiRequestError ? error.message : fallback;

/** A change the owner picked: a level, or back to the default. */
export type TrustChoice = TrustLevelName | "default";

/**
 * Settings → Trust levels: whether the assistant asks before creating or deleting bots, and how each project of the
 * credential broker is guarded. Only the owner changes them, here; no tool can.
 */
export function TrustCard() {
	const [data, setData] = useState<TrustSettingsResponse>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		fetchTrust().then(setData, (failure: unknown) => setError(messageOf(failure, "Could not load the trust levels.")));
	}, []);

	const change = async (subject: { kind: "pa" } | { kind: "project"; id: string }, choice: TrustChoice) => {
		const level = choice === "default" ? null : choice;
		setBusy(true);
		try {
			setData(subject.kind === "pa" ? await updatePaTrust(level) : await updateProjectTrust(subject.id, level));
			setError(undefined);
		} catch (failure) {
			setError(messageOf(failure, "Could not save the trust level."));
		} finally {
			setBusy(false);
		}
	};

	return (
		<TrustSettingsView
			data={data}
			error={error}
			busy={busy}
			onChange={(subject, choice) => void change(subject, choice)}
		/>
	);
}

/** The trust levels, as a plain function of what `GET /api/settings/trust` answered. */
export function TrustSettingsView({
	data,
	error,
	busy,
	onChange,
}: {
	data: TrustSettingsResponse | undefined;
	error: string | undefined;
	busy: boolean;
	onChange: (subject: { kind: "pa" } | { kind: "project"; id: string }, choice: TrustChoice) => void;
}) {
	return (
		<section className="settings-card" aria-labelledby="trust-title">
			<h2 className="settings-card__title" id="trust-title">
				<span aria-hidden="true">🛡️</span> Trust levels
			</h2>
			<p className="settings-card__hint">
				How much the assistant may do without asking you. Only you change these; the assistant cannot.
			</p>
			{error === undefined ? null : (
				<p className="notice notice--error" role="alert">
					{error}
				</p>
			)}
			{data === undefined && error === undefined ? <p className="placeholder">Loading…</p> : null}
			{data === undefined ? null : (
				<>
					<TrustSelect
						label="Assistant: creating and deleting bots"
						setting={data.pa}
						defaultName="ZIMPOEN_PA_TRUST"
						busy={busy}
						onChange={(choice) => onChange({ kind: "pa" }, choice)}
					/>
					{data.broker === "off" ? (
						<p className="settings-card__hint">
							The credential broker is off (<code>ZIMPOEN_CRED_BROKER</code>), so there are no projects to set.
						</p>
					) : data.projects.length === 0 ? (
						<p className="settings-card__hint">The broker policy names no projects.</p>
					) : (
						data.projects.map((project) => (
							<TrustSelect
								key={project.id}
								label={`Project ${project.id}`}
								setting={project}
								defaultName="the broker policy"
								busy={busy}
								onChange={(choice) => onChange({ kind: "project", id: project.id }, choice)}
							/>
						))
					)}
				</>
			)}
		</section>
	);
}

function TrustSelect({
	label,
	setting,
	defaultName,
	busy,
	onChange,
}: {
	label: string;
	setting: TrustSettingView;
	defaultName: string;
	busy: boolean;
	onChange: (choice: TrustChoice) => void;
}) {
	const id = useId();
	return (
		<div className="settings-card__field">
			<label htmlFor={id}>{label}</label>
			<select
				id={id}
				value={setting.overridden ? setting.level : "default"}
				disabled={busy}
				onChange={(event) => onChange(event.target.value as TrustChoice)}
			>
				<option value="default">Default ({setting.defaultLevel})</option>
				{TRUST_LEVEL_NAMES.map((level) => (
					<option key={level} value={level}>
						{level}
					</option>
				))}
			</select>
			<span className="settings-card__hint">
				{TRUST_TEXT[setting.level]} {trustSourceText(setting, defaultName)}
			</span>
		</div>
	);
}
