import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
	type FauxProviderHandle,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
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
