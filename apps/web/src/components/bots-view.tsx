"use client";

import type { BotsResponse, BotView } from "@assistant/shared";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { ApiRequestError, createBot, deleteBot, fetchBots } from "../lib/api.ts";
import {
	type BotDraft,
	draftProblem,
	EMPTY_DRAFT,
	PRESET_TEXT,
	requestOf,
	slugFromName,
	toggleTool,
} from "../lib/bots-form.ts";
import { useChat } from "./chat-context.tsx";

const messageOf = (error: unknown, fallback: string): string =>
	error instanceof ApiRequestError ? error.message : fallback;

/**
 * The owner's Bots page: the specialist bots, a form to make one and a way to delete one. What the owner does here needs
 * no approval (they are the one deciding); the server applies the same caps and checks as the PA's `create_bot`.
 */
export function BotsView() {
	const [data, setData] = useState<BotsResponse>();
	const [error, setError] = useState<string>();
	const { refresh } = useChat();

	const load = useCallback(async (): Promise<void> => {
		try {
			setData(await fetchBots());
			setError(undefined);
		} catch (failure) {
			setError(messageOf(failure, "Could not load the bots."));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const changed = (next: BotsResponse): void => {
		setData(next);
		setError(undefined);
		// The sidebar lists bots as agents: show the change now rather than at its next poll.
		refresh();
	};

	return (
		<div className="settings">
			<div className="settings__column">
				<Link href="/chat/pa" className="settings__back">
					← Back to chat
				</Link>
				<h1 className="settings__title">Bots</h1>
				<p className="settings__intro">
					Specialist bots with their own chat and a few tools. The assistant can make them too, asking you first unless
					its trust level in Settings is open. Here you make and delete them yourself.
				</p>
				<BotListView
					data={data}
					error={error}
					remove={(bot) => (
						<DeleteBotButton key={bot.slug} bot={bot} onDelete={async () => changed(await deleteBot(bot.slug))} />
					)}
				/>
				{data === undefined ? null : <CreateBotForm data={data} onCreated={changed} />}
			</div>
		</div>
	);
}

/** The bots, as a plain function of what `GET /api/bots` answered. `remove` renders a bot's delete control. */
export function BotListView({
	data,
	error,
	remove,
}: {
	data: BotsResponse | undefined;
	error: string | undefined;
	remove: (bot: BotView) => ReactNode;
}) {
	if (error !== undefined) {
		return (
			<p className="notice notice--error" role="alert">
				{error}
			</p>
		);
	}
	if (data === undefined) return <p className="placeholder">Loading…</p>;
	return (
		<section className="settings-card" aria-labelledby="bots-title">
			<h2 className="settings-card__title" id="bots-title">
				<span aria-hidden="true">🤖</span> {data.bots.length} of {data.max} bots
			</h2>
			{data.bots.length === 0 ? <p className="settings-card__hint">There are no bots yet.</p> : null}
			{data.bots.map((bot) => (
				<article key={bot.slug} className="bot-row">
					<h3 className="bot-row__name">
						<span aria-hidden="true">{bot.avatar}</span> <Link href={`/chat/${bot.id}`}>{bot.name}</Link>{" "}
						<code>{bot.id}</code>
					</h3>
					<p className="settings-card__hint">
						{bot.tools.length === 0 ? "No tools." : `Tools: ${bot.tools.join(", ")}.`}{" "}
						{bot.approvedVia === "open" ? "Made by the assistant without asking (trust level open)." : null}
					</p>
					<details>
						<summary>Instructions</summary>
						<p className="bot-row__soul">{bot.soul}</p>
					</details>
					{remove(bot)}
				</article>
			))}
		</section>
	);
}

/** Delete asks once more in the page: the bot's memory and weekly limit go with it. Its chat is archived, not erased. */
function DeleteBotButton({ bot, onDelete }: { bot: BotView; onDelete: () => Promise<void> }) {
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	const confirm = async (): Promise<void> => {
		setBusy(true);
		setError(undefined);
		try {
			await onDelete();
		} catch (failure) {
			setError(messageOf(failure, "Could not delete the bot."));
			setBusy(false);
		}
	};

	if (!asking) {
		return (
			<div className="settings-card__actions">
				<button type="button" className="card__button" onClick={() => setAsking(true)}>
					Delete
				</button>
			</div>
		);
	}
	return (
		<fieldset className="google-account__confirm">
			<legend className="visually-hidden">Delete {bot.name}</legend>
			<p className="settings-card__hint">
				Delete {bot.name}? Its chat is archived (kept, but no longer in the sidebar), and what it remembered and its
				weekly limit are removed.
			</p>
			<div className="settings-card__actions">
				<button
					type="button"
					className="card__button card__button--danger"
					disabled={busy}
					onClick={() => void confirm()}
				>
					{busy ? "Deleting…" : "Delete"}
				</button>
				<button type="button" className="card__button" disabled={busy} onClick={() => setAsking(false)}>
					Cancel
				</button>
			</div>
			{error === undefined ? null : (
				<p className="card__error" role="alert">
					{error}
				</p>
			)}
		</fieldset>
	);
}

function CreateBotForm({ data, onCreated }: { data: BotsResponse; onCreated: (next: BotsResponse) => void }) {
	const [draft, setDraft] = useState<BotDraft>(EMPTY_DRAFT);
	// The id follows the name until the owner types one of their own.
	const [slugEdited, setSlugEdited] = useState(false);
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState<{ kind: "saved" | "error"; text: string }>();
	const nameId = useId();
	const slugId = useId();
	const avatarId = useId();
	const soulId = useId();
	const problem = draftProblem(draft, data);

	const save = async (): Promise<void> => {
		if (problem !== undefined) return;
		setSaving(true);
		setResult(undefined);
		try {
			onCreated(await createBot(requestOf(draft)));
			setDraft(EMPTY_DRAFT);
			setSlugEdited(false);
			setResult({ kind: "saved", text: "Created. It is in the sidebar." });
		} catch (failure) {
			setResult({ kind: "error", text: messageOf(failure, "Could not create the bot.") });
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			className="settings-card"
			aria-labelledby="new-bot-title"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<h2 className="settings-card__title" id="new-bot-title">
				New bot
			</h2>
			<label className="settings-card__field" htmlFor={nameId}>
				Name
				<input
					id={nameId}
					className="owner-input"
					value={draft.name}
					maxLength={data.maxNameChars}
					onChange={(event) =>
						setDraft({
							...draft,
							name: event.target.value,
							...(slugEdited ? {} : { slug: slugFromName(event.target.value) }),
						})
					}
				/>
			</label>
			<label className="settings-card__field" htmlFor={slugId}>
				Id (bot:…)
				<input
					id={slugId}
					className="owner-input"
					value={draft.slug}
					maxLength={32}
					onChange={(event) => {
						setSlugEdited(true);
						setDraft({ ...draft, slug: event.target.value.toLowerCase() });
					}}
				/>
			</label>
			<label className="settings-card__field" htmlFor={avatarId}>
				Avatar (one emoji, optional)
				<input
					id={avatarId}
					className="owner-input"
					value={draft.avatar}
					maxLength={16}
					onChange={(event) => setDraft({ ...draft, avatar: event.target.value })}
				/>
			</label>
			<label className="settings-card__field" htmlFor={soulId}>
				Instructions ({draft.soul.length} / {data.maxSoulChars})
				<textarea
					id={soulId}
					className="owner-textarea"
					rows={6}
					value={draft.soul}
					maxLength={data.maxSoulChars}
					onChange={(event) => setDraft({ ...draft, soul: event.target.value })}
				/>
			</label>
			<fieldset className="bot-tools">
				<legend className="settings-card__field">Tools</legend>
				{data.presets.map((preset) => (
					<label key={preset} className="settings-card__check">
						<input
							type="checkbox"
							checked={draft.tools.includes(preset)}
							onChange={(event) => setDraft({ ...draft, tools: toggleTool(draft.tools, preset, event.target.checked) })}
						/>{" "}
						{preset}
						{PRESET_TEXT[preset] === undefined ? null : `: ${PRESET_TEXT[preset]}`}
					</label>
				))}
			</fieldset>
			<div className="settings-card__actions">
				<button type="submit" className="settings-card__save" disabled={problem !== undefined || saving}>
					{saving ? "Creating…" : "Create"}
				</button>
				<span
					className={`settings-card__result${result?.kind === "error" ? " settings-card__result--error" : ""}`}
					role="status"
				>
					{result?.text ?? (draft === EMPTY_DRAFT ? undefined : problem)}
				</span>
			</div>
		</form>
	);
}
