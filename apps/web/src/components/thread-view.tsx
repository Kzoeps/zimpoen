"use client";

import type { AgentSummary } from "@assistant/shared";
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
import { useStore } from "zustand";
import { convertMessage } from "../lib/convert-message.ts";
import type { Notice } from "../lib/thread-state.ts";
import { threadFor } from "../lib/thread-store.ts";
import { toUiMessages, type UiMessage } from "../lib/ui-messages.ts";
import { useChat } from "./chat-context.tsx";

export function ThreadView({ agent }: { agent: AgentSummary }) {
	const { runtime, thread, notice } = useAgentThread(agent);

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
							{({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage agent={agent} />)}
						</ThreadPrimitive.Messages>
						<WaitingForAnswer agent={agent} />
					</div>
				</ThreadPrimitive.Viewport>

				{notice !== undefined ? (
					<p className={`notice notice--${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
						{notice.message}
					</p>
				) : null}
				<Composer agent={agent} />
			</ThreadPrimitive.Root>
		</AssistantRuntimeProvider>
	);
}

/**
 * Connects the open conversation to assistant-ui: the store's state in, the user's send / stop / load-earlier out.
 * The connection lives exactly as long as the component.
 */
function useAgentThread(agent: AgentSummary) {
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
				await store.getState().send(textOf(message));
			} catch {
				// The send never reached the server: hand the text back to the composer; the reason is shown below it.
				throw new MessageNotSentError("The message was not sent.");
			}
		},
		onCancel: () => store.getState().stop(),
	});

	// A failed send outranks whatever the thread is saying: it is what the user just did.
	const notice: Notice | undefined = sendError === undefined ? thread?.notice : { kind: "error", message: sendError };
	return { runtime, thread, notice };
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
	return (
		<MessagePrimitive.Root className="msg msg--user">
			<div className="msg__bubble">
				<MessagePrimitive.Parts components={{ Text: PlainText }} />
			</div>
			{typeof notAnswered === "string" ? <p className="status status--error msg__unanswered">{notAnswered}</p> : null}
		</MessagePrimitive.Root>
	);
}

function AssistantMessage({ agent }: { agent: AgentSummary }) {
	const status = useAuiState((state) => state.message.status);
	return (
		<MessagePrimitive.Root className="msg msg--assistant">
			<span className="msg__avatar" aria-hidden="true">
				{agent.avatar}
			</span>
			<div className="msg__body">
				<MessagePrimitive.Parts components={{ Text: PlainText, Reasoning }} />
				<StatusLine status={status} />
			</div>
		</MessagePrimitive.Root>
	);
}

// Text is shown as written, whitespace and all. Markdown rendering is a later milestone.
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

/** Between sending and the first words of the answer. */
function WaitingForAnswer({ agent }: { agent: AgentSummary }) {
	const waiting = useAuiState((state) => state.thread.isRunning && state.thread.messages.at(-1)?.role === "user");
	if (!waiting) return null;
	return (
		<div className="msg msg--assistant" role="status" aria-label={`${agent.name} is thinking`}>
			<span className="msg__avatar" aria-hidden="true">
				{agent.avatar}
			</span>
			<div className="msg__body">
				<span className="dots" aria-hidden="true">
					<i />
					<i />
					<i />
				</span>
			</div>
		</div>
	);
}

function Composer({ agent }: { agent: AgentSummary }) {
	const running = useAuiState((state) => state.thread.isRunning);
	return (
		<ComposerPrimitive.Root className="composer">
			<ComposerPrimitive.Input
				className="composer__input"
				placeholder={`Message ${agent.name}`}
				rows={1}
				maxRows={8}
				aria-label={`Message ${agent.name}`}
			/>
			{running ? (
				<ComposerPrimitive.Cancel className="composer__button composer__button--stop" aria-label="Stop answering">
					■
				</ComposerPrimitive.Cancel>
			) : (
				<ComposerPrimitive.Send className="composer__button" aria-label="Send message">
					↑
				</ComposerPrimitive.Send>
			)}
		</ComposerPrimitive.Root>
	);
}
