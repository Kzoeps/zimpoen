import type { ThreadMessageLike } from "@assistant-ui/react";
import type { UiAssistantStatus, UiMessage } from "./ui-messages.ts";

/** `convertMessage` of assistant-ui's external store runtime: our message to its shape. */
export function convertMessage(message: UiMessage): ThreadMessageLike {
	if (message.role === "user") {
		return {
			role: "user",
			id: message.id,
			createdAt: new Date(message.createdAt),
			content: [{ type: "text", text: message.text }],
			...(message.notAnswered === undefined ? {} : { metadata: { custom: { notAnswered: message.notAnswered } } }),
		};
	}
	return {
		role: "assistant",
		id: message.id,
		createdAt: new Date(message.createdAt),
		content: message.parts.map((part) => ({ type: part.type, text: part.text })),
		status: statusOf(message.status),
	};
}

function statusOf(status: UiAssistantStatus): NonNullable<ThreadMessageLike["status"]> {
	switch (status.type) {
		case "running":
			return { type: "running" };
		case "complete":
			return { type: "complete", reason: "stop" };
		case "stopped":
			return { type: "incomplete", reason: "cancelled" };
		case "interrupted":
			return { type: "incomplete", reason: "other" };
		case "cut-off":
			return { type: "incomplete", reason: "length" };
		case "error":
			return { type: "incomplete", reason: "error", error: status.message };
	}
}
