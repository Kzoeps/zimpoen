"use client";

import { MAX_MESSAGE_CHARS, withAttachments } from "@assistant/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, useRef, useState } from "react";
import { ApiRequestError, newRequestId, sendMessage } from "../lib/api.ts";
import { readCapture, type SharedItem, shareText } from "../lib/share.ts";
import { FileChip } from "./cards.tsx";
import { useChat } from "./chat-context.tsx";

/** What was shared to the assistant, and who it should go to. The files are already stored; sending only names them. */
export function CaptureView() {
	const params = useSearchParams();
	const query = params.toString();
	const shared = useMemo(() => readCapture(new URLSearchParams(query)), [query]);
	// Another share while this page is open is a new form, not an edit of the old one.
	return <Capture key={query} shared={shared} />;
}

function Capture({ shared }: { shared: SharedItem }) {
	const { agents, error } = useChat();
	const router = useRouter();
	const [text, setText] = useState(() => shareText(shared));
	const [agentId, setAgentId] = useState("pa");
	const [sending, setSending] = useState(false);
	const [failure, setFailure] = useState<string>();
	// The same message sent again after a failure is the same message: it keeps its id, so the server posts it once.
	const unsent = useRef<{ key: string; requestId: string }>(undefined);
	const agentFieldId = useId();
	const textFieldId = useId();

	if (agents === undefined) return <p className="placeholder">{error ?? "Loading…"}</p>;
	const agent = agents.find((candidate) => candidate.id === agentId) ?? agents[0];
	if (agent === undefined) return <p className="placeholder">The assistant has no agents to send this to.</p>;

	const nothingShared = shared.title === "" && shared.text === "" && shared.url === "" && shared.files.length === 0;
	const canSend = !sending && (text.trim() !== "" || shared.files.length > 0);

	const send = async (): Promise<void> => {
		const content = withAttachments(text, shared.files);
		const key = `${agent.conversationId}\n${content}`;
		const requestId = unsent.current?.key === key ? unsent.current.requestId : newRequestId();
		unsent.current = { key, requestId };
		setSending(true);
		setFailure(undefined);
		try {
			await sendMessage(agent.conversationId, { content, requestId });
			router.push(`/chat/${agent.id}`);
		} catch (problem) {
			setFailure(problem instanceof ApiRequestError ? problem.message : "The message could not be sent.");
			setSending(false);
		}
	};

	return (
		<div className="capture">
			<form
				className="capture__column"
				onSubmit={(event) => {
					event.preventDefault();
					if (canSend) void send();
				}}
			>
				<h1 className="capture__title">Send to the assistant</h1>
				<p className="capture__intro">
					{nothingShared
						? "Nothing was shared with the assistant. Type a note to send it one, or go back to the chat."
						: "Add a note if you like, choose who gets it, and send."}
				</p>

				{shared.problems.map((problem) => (
					<p key={problem} className="notice notice--error" role="alert">
						{problem}
					</p>
				))}

				{shared.files.length > 0 ? (
					<ul className="capture__files" aria-label="Shared files">
						{shared.files.map((file) => (
							<li key={file.id}>
								<FileChip file={file} />
							</li>
						))}
					</ul>
				) : null}

				<label className="capture__field" htmlFor={textFieldId}>
					Message
					<textarea
						id={textFieldId}
						className="capture__text"
						value={text}
						rows={5}
						maxLength={MAX_MESSAGE_CHARS}
						placeholder="Add a note (optional when files are attached)"
						onChange={(event) => setText(event.target.value)}
					/>
				</label>

				<label className="capture__field" htmlFor={agentFieldId}>
					Send to
					<select id={agentFieldId} value={agent.id} onChange={(event) => setAgentId(event.target.value)}>
						{agents.map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.avatar} {candidate.name}
							</option>
						))}
					</select>
				</label>

				{failure !== undefined ? (
					<p className="notice notice--error" role="alert">
						{failure}
					</p>
				) : null}

				<div className="capture__actions">
					<button type="submit" className="settings-card__save" disabled={!canSend}>
						{sending ? "Sending…" : `Send to ${agent.name}`}
					</button>
					<Link href="/chat/pa">Cancel</Link>
				</div>
			</form>
		</div>
	);
}
