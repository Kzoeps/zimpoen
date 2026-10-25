"use client";

import {
	canPin,
	MAX_MEMORY_LIST,
	type MemoryFactView,
	type MemoryResponse,
	PROFILE_SLOT_LABEL,
	PROFILE_SLOTS,
	type ProfileResponse,
	type ProfileSlot,
} from "@assistant/shared";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	ApiRequestError,
	deleteMemory,
	fetchMemory,
	fetchProfile,
	updateMemory,
	updatePreferences,
} from "../lib/api.ts";
import { MEMORY_TABS, moveTargets, originLabel } from "../lib/owner-pages.ts";
import { scopeLabel } from "./memory-cards.tsx";

const messageOf = (error: unknown, fallback: string): string =>
	error instanceof ApiRequestError ? error.message : fallback;

const SLOT_HINT: Record<ProfileSlot, string> = {
	tone: "How you want the assistant to sound: for example “direct and brief, no filler”.",
	explanations: "How you like things explained: for example “step by step, with an example”.",
};

/** What the agents are told about the owner, what they were asked to remember, and the people the assistant keeps. */
export function ProfileView() {
	const [profile, setProfile] = useState<ProfileResponse>();
	const [error, setError] = useState<string>();

	useEffect(() => {
		fetchProfile().then(setProfile, (failure: unknown) => setError(messageOf(failure, "Could not load the profile.")));
	}, []);

	// A line edited or deleted in the list may be the tone or explanations line: read the fields again.
	const refreshProfile = useCallback((): void => {
		fetchProfile().then(setProfile, () => undefined);
	}, []);

	return (
		<div className="settings">
			<div className="settings__column">
				<Link href="/chat/pa" className="settings__back">
					← Back to chat
				</Link>
				<h1 className="settings__title">Profile</h1>
				<p className="settings__intro">What the agents know about you, and what they were asked to remember.</p>
				{error !== undefined ? (
					<p className="notice notice--error" role="alert">
						{error}
					</p>
				) : null}
				{profile === undefined && error === undefined ? <p className="placeholder">Loading…</p> : null}
				{profile !== undefined ? <OwnerCard profile={profile} /> : null}
				{profile !== undefined ? <PreferencesCard profile={profile} onSaved={setProfile} /> : null}
				<MemoryEditor onChanged={refreshProfile} />
				{profile !== undefined ? <PeopleCard profile={profile} /> : null}
			</div>
		</div>
	);
}

function OwnerCard({ profile }: { profile: ProfileResponse }) {
	const { owner } = profile;
	return (
		<section className="settings-card" aria-label="About you">
			<h2 className="settings-card__title">
				<span aria-hidden="true">👤</span> About you
			</h2>
			<ul className="facts">
				<li>Name: {owner.name ?? "not set"}</li>
				<li>Time zone: {owner.timezone}</li>
				<li>Currency: {owner.currency}</li>
				<li>
					Height:{" "}
					{owner.heightCm === undefined
						? "not set (only the Health agent uses it, for the BMI)"
						: `${owner.heightCm} cm`}
				</li>
			</ul>
			<p className="settings-card__hint">
				These come from the server's settings (<code>ASSISTANT_OWNER_NAME</code>, <code>ASSISTANT_TIMEZONE</code>,{" "}
				<code>ASSISTANT_CURRENCY</code>, <code>ASSISTANT_OWNER_HEIGHT_CM</code>): change them in the environment file
				and restart the server.
			</p>
		</section>
	);
}

function PreferencesCard({
	profile,
	onSaved,
}: {
	profile: ProfileResponse;
	onSaved: (profile: ProfileResponse) => void;
}) {
	const stored = { tone: profile.preferences.tone ?? "", explanations: profile.preferences.explanations ?? "" };
	const [draft, setDraft] = useState<Record<ProfileSlot, string>>(stored);
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState<{ kind: "saved" | "error"; text: string }>();
	const ids = { tone: useId(), explanations: useId() };
	const changed = PROFILE_SLOTS.some((slot) => draft[slot].trim() !== stored[slot]);

	// What is stored changed (a line edited or deleted in the list below): the fields show it, not what was typed before.
	useEffect(() => {
		setDraft({ tone: stored.tone, explanations: stored.explanations });
	}, [stored.tone, stored.explanations]);

	const save = async (): Promise<void> => {
		setSaving(true);
		setResult(undefined);
		try {
			const saved = await updatePreferences({
				tone: draft.tone.trim() === "" ? null : draft.tone.trim(),
				explanations: draft.explanations.trim() === "" ? null : draft.explanations.trim(),
			});
			onSaved(saved);
			setResult({ kind: "saved", text: "Saved. Every agent is told from its next message." });
		} catch (failure) {
			setResult({ kind: "error", text: messageOf(failure, "Could not save.") });
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			className="settings-card"
			aria-label="Preferences"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<h2 className="settings-card__title">
				<span aria-hidden="true">🎛️</span> How you like it
			</h2>
			{PROFILE_SLOTS.map((slot) => (
				<label key={slot} className="settings-card__field" htmlFor={ids[slot]}>
					{PROFILE_SLOT_LABEL[slot]}
					<input
						id={ids[slot]}
						className="owner-input"
						maxLength={400}
						value={draft[slot]}
						placeholder={SLOT_HINT[slot]}
						onChange={(event) => setDraft({ ...draft, [slot]: event.target.value })}
					/>
				</label>
			))}
			<div className="settings-card__actions">
				<button type="submit" className="settings-card__save" disabled={!changed || saving}>
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

function MemoryEditor({ onChanged }: { onChanged: () => void }) {
	const [scope, setScope] = useState<MemoryFactView["scope"]>("shared");
	const [query, setQuery] = useState("");
	const [searched, setSearched] = useState("");
	const [data, setData] = useState<MemoryResponse>();
	const [error, setError] = useState<string>();
	const searchId = useId();
	// Only the newest request may fill the list: a slow answer for the tab or search left behind must not replace it.
	const newest = useRef(0);

	const load = useCallback(async (): Promise<void> => {
		const ticket = ++newest.current;
		try {
			const loaded = await fetchMemory({ scope, q: searched, limit: MAX_MEMORY_LIST });
			if (ticket !== newest.current) return;
			setData(loaded);
			setError(undefined);
		} catch (failure) {
			if (ticket === newest.current) setError(messageOf(failure, "Could not load what is remembered."));
		}
	}, [scope, searched]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<section className="settings-card" aria-label="Memory">
			<h2 className="settings-card__title">
				<span aria-hidden="true">🧠</span> What is remembered
			</h2>
			<p className="settings-card__hint">
				Preferences are what you asked the assistant to remember; facts are details an agent noted, and each agent keeps
				its own. An agent can only ask you to add a preference, in its chat, and it is here once you approve. You can
				change, move (to every agent, or to one) or delete any line: the agents are told the change from their next
				message, and nothing asks for approval here.
			</p>
			<div className="owner-tabs">
				{MEMORY_TABS.map((tab) => (
					<button
						key={tab.scope}
						type="button"
						className="owner-tab"
						aria-pressed={scope === tab.scope}
						onClick={() => setScope(tab.scope)}
					>
						{tab.label} ({data?.counts[tab.scope] ?? "…"})
					</button>
				))}
			</div>
			<form
				className="owner-limit"
				onSubmit={(event) => {
					event.preventDefault();
					setSearched(query);
				}}
			>
				<label htmlFor={searchId}>Search</label>
				<input id={searchId} className="owner-input" value={query} onChange={(event) => setQuery(event.target.value)} />
				<button type="submit" className="owner-button">
					Search
				</button>
			</form>
			{error !== undefined ? (
				<p className="notice notice--error" role="alert">
					{error}
				</p>
			) : null}
			{data?.facts.length === 0 ? (
				<p className="settings-card__hint">
					{searched === "" ? `Nothing is remembered for ${scopeLabel(scope)}.` : "Nothing matches that search."}
				</p>
			) : null}
			{data !== undefined && data.total > data.facts.length ? (
				<p className="settings-card__hint">
					Showing {data.facts.length} of {data.total}: search to narrow them down.
				</p>
			) : null}
			<ul className="owner-list" aria-label="Remembered lines">
				{data?.facts.map((fact) => (
					<FactRow
						key={fact.id}
						fact={fact}
						onChanged={() => {
							void load();
							onChanged();
						}}
					/>
				))}
			</ul>
		</section>
	);
}

function FactRow({ fact, onChanged }: { fact: MemoryFactView; onChanged: () => void }) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(fact.text);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	const act = async (work: () => Promise<unknown>): Promise<void> => {
		setBusy(true);
		setError(undefined);
		try {
			await work();
			setEditing(false);
			setConfirming(false);
			onChanged();
		} catch (failure) {
			setError(messageOf(failure, "That did not work."));
		} finally {
			setBusy(false);
		}
	};

	return (
		<li className="owner-row">
			{editing ? (
				<textarea
					className="owner-textarea"
					aria-label="Text of the line"
					rows={3}
					maxLength={2000}
					value={text}
					onChange={(event) => setText(event.target.value)}
				/>
			) : (
				<p className="owner-row__text">
					{fact.slot === undefined ? "" : `${PROFILE_SLOT_LABEL[fact.slot]}: `}
					{fact.text}
				</p>
			)}
			<p className="owner-row__meta">
				<span className="chip">{fact.kind}</span>
				{fact.pinned ? <span className="chip">pinned</span> : null}
				<span>{originLabel(fact)}</span>
			</p>
			{error !== undefined ? (
				<p className="settings-card__result settings-card__result--error" role="alert">
					{error}
				</p>
			) : null}
			<div className="owner-row__actions">
				{editing ? (
					<>
						<button
							type="button"
							className="owner-button"
							disabled={busy || text.trim() === ""}
							onClick={() => void act(() => updateMemory(fact.id, { text }))}
						>
							Save
						</button>
						<button
							type="button"
							className="owner-button"
							disabled={busy}
							onClick={() => {
								setEditing(false);
								setText(fact.text);
							}}
						>
							Cancel
						</button>
					</>
				) : confirming ? (
					<>
						<span>Delete this line for good?</span>
						<button
							type="button"
							className="owner-button owner-button--danger"
							disabled={busy}
							onClick={() => void act(() => deleteMemory(fact.id))}
						>
							Delete
						</button>
						<button type="button" className="owner-button" disabled={busy} onClick={() => setConfirming(false)}>
							Keep it
						</button>
					</>
				) : (
					<>
						<button type="button" className="owner-button" disabled={busy} onClick={() => setEditing(true)}>
							Edit
						</button>
						{canPin(fact) ? (
							<button
								type="button"
								className="owner-button"
								disabled={busy}
								onClick={() => void act(() => updateMemory(fact.id, { pinned: !fact.pinned }))}
							>
								{fact.pinned ? "Unpin" : "Pin"}
							</button>
						) : null}
						<MoveSelect fact={fact} busy={busy} onMove={(scope) => void act(() => updateMemory(fact.id, { scope }))} />
						<button
							type="button"
							className="owner-button owner-button--danger"
							disabled={busy}
							onClick={() => setConfirming(true)}
						>
							Delete
						</button>
					</>
				)}
			</div>
		</li>
	);
}

/** Move a line to every agent's memory, or to one agent's: the owner's way of sharing a fact. */
function MoveSelect({
	fact,
	busy,
	onMove,
}: {
	fact: MemoryFactView;
	busy: boolean;
	onMove: (scope: MemoryFactView["scope"]) => void;
}) {
	const targets = moveTargets(fact);
	if (targets.length === 0) return null;
	return (
		<select
			className="owner-select"
			aria-label="Move this line to"
			disabled={busy}
			value=""
			onChange={(event) => {
				const target = targets.find((candidate) => candidate.scope === event.target.value);
				if (target !== undefined) onMove(target.scope);
			}}
		>
			<option value="">Move to…</option>
			{targets.map((target) => (
				<option key={target.scope} value={target.scope}>
					{target.label}
				</option>
			))}
		</select>
	);
}

function PeopleCard({ profile }: { profile: ProfileResponse }) {
	return (
		<section className="settings-card" aria-label="People">
			<h2 className="settings-card__title">
				<span aria-hidden="true">🎂</span> People the assistant keeps
			</h2>
			{profile.people.length === 0 ? (
				<p className="settings-card__hint">No one yet. Tell the assistant a birthday and it keeps it.</p>
			) : null}
			<ul className="facts">
				{profile.people.map((person) => (
					<li key={person.id}>
						{person.name}
						{person.relation === undefined ? "" : ` (${person.relation})`} · {person.birthdayText}
					</li>
				))}
			</ul>
			<p className="settings-card__hint">
				Ask the assistant in <Link href="/chat/pa">its chat</Link> to add, change or remove someone.
			</p>
		</section>
	);
}
