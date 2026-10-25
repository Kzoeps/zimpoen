"use client";

import type { ScheduleJobSettings, ScheduleSettingsResponse } from "@assistant/shared";
import { useEffect, useId, useState } from "react";
import { ApiRequestError, fetchSchedule, updateSchedule } from "../lib/api.ts";
import { scheduleChange } from "../lib/schedule-form.ts";

const messageOf = (error: unknown, fallback: string): string =>
	error instanceof ApiRequestError ? error.message : fallback;

/** When the morning briefing and the evening wrap-up happen, and whether they happen at all. */
export function ScheduleCard() {
	const [data, setData] = useState<ScheduleSettingsResponse>();
	const [error, setError] = useState<string>();

	useEffect(() => {
		fetchSchedule().then(setData, (failure: unknown) =>
			setError(messageOf(failure, "Could not load the daily schedule.")),
		);
	}, []);

	return (
		<section className="settings-card" aria-label="Daily schedule">
			<h2 className="settings-card__title">
				<span aria-hidden="true">🗓️</span> Daily schedule
			</h2>
			<p className="settings-card__hint">
				The assistant writes you a briefing in the morning and asks what you got done in the evening
				{data === undefined ? "" : `. Times are in ${data.timezone}`}. If the server was off at the time, a briefing
				still comes when it starts up again before 11:00, and a wrap-up before midnight; later than that the day is
				skipped.
			</p>
			{error !== undefined ? (
				<p className="notice notice--error" role="alert">
					{error}
				</p>
			) : null}
			{data === undefined && error === undefined ? <p className="placeholder">Loading…</p> : null}
			{data?.jobs.map((job) => (
				<JobRow key={job.job} initial={job} onSaved={setData} />
			))}
		</section>
	);
}

function JobRow({
	initial,
	onSaved,
}: {
	initial: ScheduleJobSettings;
	onSaved: (data: ScheduleSettingsResponse) => void;
}) {
	const [job, setJob] = useState(initial);
	const [time, setTime] = useState(initial.localTime);
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState<{ kind: "saved" | "error"; text: string }>();
	const timeId = useId();

	const change = scheduleChange(job, { localTime: time });

	const save = async (body: { localTime?: string; enabled?: boolean }): Promise<void> => {
		setSaving(true);
		setResult(undefined);
		try {
			const saved = await updateSchedule(job.job, body);
			const fresh = saved.jobs.find((candidate) => candidate.job === job.job);
			if (fresh !== undefined) {
				setJob(fresh);
				setTime(fresh.localTime);
			}
			onSaved(saved);
			setResult({ kind: "saved", text: "Saved." });
		} catch (failure) {
			setResult({ kind: "error", text: messageOf(failure, "Could not save.") });
			setTime(job.localTime);
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			className="schedule-job"
			onSubmit={(event) => {
				event.preventDefault();
				if (change !== undefined) void save(change);
			}}
		>
			<div className="schedule-job__head">
				<span className="schedule-job__label">{job.label}</span>
				<label className="schedule-job__switch">
					<input
						type="checkbox"
						checked={job.enabled}
						disabled={saving}
						onChange={(event) => void save({ enabled: event.target.checked })}
					/>{" "}
					On
				</label>
			</div>
			<div className="schedule-job__row">
				<label htmlFor={timeId}>At</label>
				<input
					id={timeId}
					type="time"
					required
					value={time}
					disabled={saving || !job.enabled}
					onChange={(event) => setTime(event.target.value)}
				/>
				<button type="submit" className="settings-card__save" disabled={change === undefined || saving}>
					{saving ? "Saving…" : "Save"}
				</button>
			</div>
			<p className="settings-card__hint">
				{job.enabled ? `Next: ${job.nextRunText ?? "soon"}` : "Off: nothing is sent."}
				{job.localTime !== job.defaultTime ? ` · usual time ${job.defaultTime}` : ""}
			</p>
			<span
				className={`settings-card__result${result?.kind === "error" ? " settings-card__result--error" : ""}`}
				role="status"
			>
				{result?.text}
			</span>
		</form>
	);
}
