"use client";

import { type AgentSummary, withAttachments } from "@assistant/shared";
import {
	type AppendMessage,
	AssistantRuntimeProvider,
	ComposerPrimitive,
	MessageNotSentError,
	MessagePrimitive,
	ThreadPrimitive,
	useAuiState,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useEffect, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "zustand";
import { attached } from "../lib/attachments.ts";
import { convertMessage } from "../lib/convert-message.ts";
import type { Notice } from "../lib/thread-state.ts";
import { threadFor } from "../lib/thread-store.ts";
import { toUiMessages, type UiAttachment, type UiCard, type UiMessage } from "../lib/ui-messages.ts";
import { CardView, FileChip } from "./cards.tsx";
import { useChat } from "./chat-context.tsx";
import { AttachButton, type AttachmentsState, AttachmentTray, useAttachments } from "./composer-attachments.tsx";

export function ThreadView({ agent }: { agent: AgentSummary }) {
	const attachments = useAttachments();
	const { runtime, thread, notice, sendFiles } = useAgentThread(agent, attachments);

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<ThreadPrimitive.Root className="thread">
				<header className="thread__header">
					<span className="thread__avatar" aria-hidden="true">
						{agent.avatar}
					</span>
					<h1 className="thread__title">{agent.name}</h1>
					{thread !== undefined && thread.connection !== "live" ? (
						<span className="thread__connection" role="status">
							{thread.ready ? "Reconnecting…" : "Connecting…"}
						</span>
					) : null}
				</header>

				<ThreadPrimitive.Viewport className="thread__viewport">
					<div className="thread__column">
						<LoadEarlier />
						<ThreadPrimitive.Empty>
							<EmptyThread agent={agent} />
						</ThreadPrimitive.Empty>
						<ThreadPrimitive.Messages>
							{({ message }) =>
								message.role === "user" ? (
									<UserMessage />
								) : message.role === "system" ? (
									<CardMessage />
								) : (
									<AssistantMessage agent={agent} />
								)
							}
						</ThreadPrimitive.Messages>
						<WaitingForAnswer agent={agent} />
					</div>
				</ThreadPrimitive.Viewport>

				{notice !== undefined ? (
					<p className={`notice notice--${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
						{notice.message}
					</p>
				) : null}
				<Composer agent={agent} attachments={attachments} sendFiles={sendFiles} />
			</ThreadPrimitive.Root>
		</AssistantRuntimeProvider>
	);
}

/**
 * Connects the open conversation to assistant-ui: the store's state in, the user's send / stop / load-earlier out.
 * The connection lives exactly as long as the component.
 */
function useAgentThread(agent: AgentSummary, attachments: AttachmentsState) {
	const { store, refresh } = useChat();
	const thread = useStore(store, (state) => threadFor(state, agent.conversationId));
	const sendError = useStore(store, (state) => state.sendError);

	useEffect(() => {
		store.getState().connect(agent.conversationId);
		return () => store.getState().disconnect();
	}, [store, agent.conversationId]);

	// The sidebar's busy dot should follow this thread immediately instead of waiting for the next poll.
	const running = thread?.running;
	useEffect(() => {
		if (running !== undefined) refresh();
	}, [running, refresh]);

	const messages = useMemo(() => (thread === undefined ? [] : toUiMessages(thread)), [thread]);

	const runtime = useExternalStoreRuntime<UiMessage>({
		messages,
		convertMessage,
		isRunning: thread?.running ?? false,
		isLoading: thread === undefined || !thread.ready,
		hasEarlier: thread?.hasEarlier ?? false,
		onLoadEarlier: () => store.getState().loadEarlier(),
		onNew: async (message: AppendMessage) => {
			try {
				// The files are already stored (they upload when picked): the message only names them.
				await store.getState().send(withAttachments(textOf(message), attached(attachments.current())));
			} catch {
				// The send never reached the server: hand the text back to the composer; the reason is shown below it.
				throw new MessageNotSentError("The message was not sent.");
			}
			attachments.clear();
		},
		onCancel: () => store.getState().stop(),
	});

	// A failed send outranks whatever the thread is saying: it is what the user just did.
	const notice: Notice | undefined = sendError === undefined ? thread?.notice : { kind: "error", message: sendError };

	/** Send the attached files alone: assistant-ui's own send button needs words. A failure stays on the composer's notice. */
	const sendFiles = async (): Promise<void> => {
		try {
			await store.getState().send(withAttachments("", attached(attachments.current())));
			attachments.clear();
		} catch {
			// `send` has already put the reason in `sendError`, which the notice shows; the files stay attached.
		}
	};
	return { runtime, thread, notice, sendFiles };
}

function textOf(message: AppendMessage): string {
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function LoadEarlier() {
	const hasEarlier = useAuiState((state) => state.thread.hasEarlier);
	if (!hasEarlier) return null;
	return <ThreadPrimitive.LoadEarlier className="load-earlier">Load earlier messages</ThreadPrimitive.LoadEarlier>;
}

function EmptyThread({ agent }: { agent: AgentSummary }) {
	const loading = useAuiState((state) => state.thread.isLoading);
	if (loading) return <p className="empty">Loading…</p>;
	return (
		<div className="empty">
			<div className="empty__avatar" aria-hidden="true">
				{agent.avatar}
			</div>
			<p>This is the start of your conversation with {agent.name}.</p>
		</div>
	);
}

function UserMessage() {
	const notAnswered = useAuiState((state) => state.message.metadata.custom.notAnswered);
	const files = useAuiState((state) => state.message.metadata.custom.files) as UiAttachment[] | undefined;
	// Files sent on their own have no words: the chips stand alone, without an empty bubble under them.
	const hasText = useAuiState((state) =>
		state.message.parts.some((part) => part.type === "text" && part.text.trim() !== ""),
	);
	return (
		<MessagePrimitive.Root className="msg msg--user">
			{files !== undefined && files.length > 0 ? (
				<div className="msg__files">
					{files.map((file) => (
						<FileChip key={file.id} file={file} />
					))}
				</div>
			) : null}
			{hasText ? (
				<div className="msg__bubble">
					<MessagePrimitive.Parts components={{ Text: PlainText }} />
				</div>
			) : null}
			{typeof notAnswered === "string" ? <p className="status status--error msg__unanswered">{notAnswered}</p> : null}
		</MessagePrimitive.Root>
	);
}

/** A reminder, notice or tool card. It is a message of the thread so that it sits where it happened. */
function CardMessage() {
	const card = useAuiState((state) => state.message.metadata.custom.card) as UiCard | undefined;
	if (card === undefined) return null;
	return (
		<MessagePrimitive.Root className="msg msg--card">
			<CardView card={card} />
		</MessagePrimitive.Root>
	);
}

function AssistantMessage({ agent }: { agent: AgentSummary }) {
	const status = useAuiState((state) => state.message.status);
	const chip = useAuiState((state) => state.message.metadata.custom.chip);
	// A running draft with no words yet (or only thinking) still shows that the agent is working.
	const noTextYet = useAuiState(
		(state) => !state.message.parts.some((part) => part.type === "text" && part.text.trim() !== ""),
	);
	return (
		<MessagePrimitive.Root className="msg msg--assistant">
			<span className="msg__avatar" aria-hidden="true">
				{agent.avatar}
			</span>
			<div className="msg__body">
				{typeof chip === "string" ? <span className="chip">{chip}</span> : null}
				<MessagePrimitive.Parts components={{ Text: MarkdownText, Reasoning }} />
				{status?.type === "running" && noTextYet ? <Dots /> : null}
				<StatusLine status={status} />
			</div>
		</MessagePrimitive.Root>
	);
}

/** Agent answers are Markdown. Raw HTML is not rendered (react-markdown's default), so model output cannot inject markup. */
function MarkdownText({ text }: { text: string }) {
	return (
		<div className="text text--md">
			<Markdown
				remarkPlugins={[remarkGfm]}
				components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
			>
				{text}
			</Markdown>
		</div>
	);
}

// What the owner typed is shown as written, whitespace and all.
function PlainText({ text }: { text: string }) {
	return <p className="text">{text}</p>;
}

function Reasoning({ text, status }: { text: string; status: { type: string } }) {
	return (
		<details className="reasoning" open={status.type === "running"}>
			<summary>Thinking</summary>
			<p>{text}</p>
		</details>
	);
}

type StatusLike = { type: string; reason?: string; error?: unknown };

function StatusLine({ status }: { status: StatusLike | undefined }) {
	const line = status === undefined ? undefined : describeStatus(status);
	return line === undefined ? null : <p className={`status status--${line.kind}`}>{line.text}</p>;
}

function describeStatus(status: StatusLike): { kind: "stopped" | "error"; text: string } | undefined {
	if (status.type !== "incomplete") return undefined;
	if (status.reason === "cancelled") return { kind: "stopped", text: "Stopped" };
	if (status.reason === "other")
		return { kind: "stopped", text: "Interrupted by a restart. The answer below replaces it." };
	if (status.reason === "length") return { kind: "stopped", text: "Cut off: the answer hit the length limit" };
	return { kind: "error", text: typeof status.error === "string" ? status.error : "The model returned an error." };
}

/**
 * Between sending and the first words of the answer, including after a tool card. Once a running assistant draft
 * exists, that message shows its own dots instead.
 */
function WaitingForAnswer({ agent }: { agent: AgentSummary }) {
	const waiting = useAuiState((state) => {
		if (!state.thread.isRunning) return false;
		const last = state.thread.messages.at(-1);
		return last !== undefined && !(last.role === "assistant" && last.status?.type === "running");
	});
	if (!waiting) return null;
	return (
		<div className="msg msg--assistant" role="status" aria-label={`${agent.name} is thinking`}>
			<span className="msg__avatar" aria-hidden="true">
				{agent.avatar}
			</span>
			<div className="msg__body">
				<Dots />
			</div>
		</div>
	);
}

function Dots() {
	return (
		<span className="dots" aria-hidden="true">
			<i />
			<i />
			<i />
		</span>
	);
}

function Composer({
	agent,
	attachments,
	sendFiles,
}: {
	agent: AgentSummary;
	attachments: AttachmentsState;
	sendFiles: () => Promise<void>;
}) {
	const running = useAuiState((state) => state.thread.isRunning);
	const text = useAuiState((state) => state.thread.composer.text);
	// Files with no words: assistant-ui's send button wants text, so this one names the files alone.
	const filesOnly = text.trim() === "" && attachments.ready.length > 0;
	return (
		<ComposerPrimitive.Root className="composer">
			<AttachmentTray attachments={attachments} />
			<div className="composer__row">
				<AttachButton attachments={attachments} />
				<ComposerPrimitive.Input
					className="composer__input"
					placeholder={attachments.list.length > 0 ? "Add a note (optional)" : `Message ${agent.name}`}
					rows={1}
					maxRows={8}
					aria-label={`Message ${agent.name}`}
				/>
				{running ? (
					<ComposerPrimitive.Cancel className="composer__button composer__button--stop" aria-label="Stop answering">
						■
					</ComposerPrimitive.Cancel>
				) : filesOnly ? (
					<button
						type="button"
						className="composer__button"
						aria-label="Send files"
						disabled={attachments.uploading}
						onClick={() => void sendFiles()}
					>
						↑
					</button>
				) : (
					<ComposerPrimitive.Send
						className="composer__button"
						aria-label="Send message"
						disabled={attachments.uploading}
					>
						↑
					</ComposerPrimitive.Send>
				)}
			</div>
		</ComposerPrimitive.Root>
	);
}
