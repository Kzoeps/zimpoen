import { createHash } from "node:crypto";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
	type FauxProviderHandle,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

export const FAUX_PROVIDER_ID = "faux";
export const FAUX_MODEL_ID = "faux-1";

/** Longest echo of the user's message; keeps the scripted reply streaming for seconds, not minutes. */
const MAX_ECHO_CHARS = 280;

const STREAMING_NOTE =
	"Streaming check: this paragraph arrives a few characters at a time, the way a real model's answer would, " +
	"so you can watch the text grow while the reply is still being written.";

export type ScriptedReplyInput = {
	/** Text of the user's newest message. */
	userText: string;
	/** How many user messages the model can see in this conversation, including this one. */
	userTurns: number;
};

/** What the dev model says. Pure, so tests and the stream fixtures do not depend on pacing. */
export function scriptedReply({ userText, userTurns }: ScriptedReplyInput): string {
	const echoed = userText.length > MAX_ECHO_CHARS ? `${userText.slice(0, MAX_ECHO_CHARS)}…` : userText;
	return [
		"Faux model (dev mode): this reply is scripted, nothing here comes from a real model.",
		`You said: “${echoed}”`,
		`That is message ${userTurns} of this conversation as the model sees it.`,
		STREAMING_NOTE,
	].join("\n\n");
}

/** A message of the form `/tool <name> {json}`: what the dev model turns into a tool call instead of an echo. */
export type ToolCommand = { name: string; args: Record<string, unknown> } | { problem: string };

const TOOL_COMMAND = /^\/tool\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/;

/**
 * Parse `/tool add_task {"title":"Pay rent","remind_in_minutes":1}`. Undefined when the message is not a command.
 *
 * This is how a developer (or a browser test) makes the scripted model use a tool without a real model: the dev model
 * has no judgement of its own, so the command says exactly which tool to call and with what.
 */
export function parseToolCommand(text: string): ToolCommand | undefined {
	const match = TOOL_COMMAND.exec(text.trim());
	if (match === null) return undefined;
	const [, name = "", rawArgs = ""] = match;
	if (rawArgs.trim() === "") return { name, args: {} };
	try {
		const parsed: unknown = JSON.parse(rawArgs);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
		return { name, args: parsed as Record<string, unknown> };
	} catch {
		return {
			problem: `Dev model: the arguments of /tool ${name} must be a JSON object, for example /tool ${name} {"title":"x"}.`,
		};
	}
}

/** What the dev model says once a tool it called has returned. Pure, like {@link scriptedReply}. */
export function scriptedToolReply(toolName: string, resultText: string, isError: boolean): string {
	const shown = resultText.length > 400 ? `${resultText.slice(0, 400)}…` : resultText;
	return `Faux model (dev mode): ${isError ? "the tool " : ""}${toolName} ${isError ? "failed" : "returned"}:\n\n${shown}`;
}

export type DevProviderOptions = {
	/** Streaming speed. The default (about 200 characters a second) makes the 100 ms partial commits visible. */
	tokensPerSecond?: number;
};

/**
 * A pi-ai faux provider that answers every request with {@link scriptedReply}, forever.
 *
 * The faux provider consumes one scripted response per request, so the echo puts itself back on the queue each time it
 * runs, and the queue starts with a few spare copies in case several conversations ask at once.
 */
export function createDevProvider(options: DevProviderOptions = {}): FauxProviderHandle {
	const faux = fauxProvider({
		provider: FAUX_PROVIDER_ID,
		tokensPerSecond: options.tokensPerSecond ?? 50,
		tokenSize: { min: 1, max: 2 },
		models: [{ id: FAUX_MODEL_ID, name: "Faux model (dev)", reasoning: true }],
	});

	const echo: FauxResponseFactory = (context, streamOptions) => {
		faux.appendResponses([echo]);
		// A tool that changes a prompt section makes Durable put a system message after its result, so look past those.
		const last = context.messages.filter((message) => message.role !== "system").at(-1);
		if (last?.role === "toolResult") {
			const result = last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			return fauxAssistantMessage([fauxText(scriptedToolReply(last.toolName, result, last.isError))]);
		}
		const command = parseToolCommand(lastUserText(context));
		if (command !== undefined) {
			if ("problem" in command) return fauxAssistantMessage([fauxText(command.problem)]);
			// The id comes from what was asked and where in the conversation, so a regenerated answer after a crash makes
			// the same call id, which the tools' idempotency (rule 8) treats as the same call.
			const id = `dev-${createHash("sha1")
				.update(`${lastUserText(context)}#${userMessages(context).length}`)
				.digest("hex")
				.slice(0, 12)}`;
			return fauxAssistantMessage([fauxToolCall(command.name, command.args as never, { id })], {
				stopReason: "toolUse",
			});
		}
		const text = scriptedReply({ userText: lastUserText(context), userTurns: countUserTurns(context) });
		// Durable passes the agent's thinking level as `reasoning`; show a thinking block when it is on.
		const thinking =
			streamOptions?.reasoning === undefined ? [] : [fauxThinking("Reading your message and writing an echo.")];
		return fauxAssistantMessage([...thinking, fauxText(text)]);
	};
	faux.setResponses(Array.from({ length: 8 }, () => echo));
	return faux;
}

function userMessages(context: TranscriptContext) {
	return context.messages.filter((message) => message.role === "user");
}

function countUserTurns(context: TranscriptContext): number {
	return userMessages(context).length;
}

function lastUserText(context: TranscriptContext): string {
	const last = userMessages(context).at(-1);
	if (last === undefined) return "";
	if (typeof last.content === "string") return last.content;
	return last.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
}
