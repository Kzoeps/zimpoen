import type { BotsResponse, CreateBotRequest, TrustLevelName, TrustSettingView } from "@assistant/shared";

/** What the owner is typing into the new-bot form. */
export type BotDraft = { name: string; slug: string; avatar: string; soul: string; tools: string[] };

export const EMPTY_DRAFT: BotDraft = { name: "", slug: "", avatar: "", soul: "", tools: [] };

/** A slug suggested from the name: lowercase, dashes, starting with a letter, at most 32 characters. */
export function slugFromName(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^[^a-z]+/, "")
		.slice(0, 32)
		.replace(/-+$/, "");
}

/**
 * Why the form cannot be sent yet, or undefined. Only what the owner can see at a glance: the server checks everything
 * again with the PA's own rules and says what is wrong.
 */
export function draftProblem(draft: BotDraft, data: BotsResponse): string | undefined {
	if (data.bots.length >= data.max)
		return `There are already ${data.max} bots, the most there can be. Delete one first.`;
	if (draft.name.trim() === "") return "Give the bot a name.";
	if (draft.name.trim().length > data.maxNameChars) return `A name is at most ${data.maxNameChars} characters.`;
	if (!/^[a-z][a-z0-9-]{1,31}$/.test(draft.slug.trim()))
		return "The id is 2 to 32 lowercase letters, digits and dashes, starting with a letter.";
	if (draft.soul.trim() === "") return "Say who the bot is and what it does.";
	if (draft.soul.length > data.maxSoulChars) return `The instructions are at most ${data.maxSoulChars} characters.`;
	return undefined;
}

export function requestOf(draft: BotDraft): CreateBotRequest {
	const avatar = draft.avatar.trim();
	return {
		name: draft.name.trim(),
		slug: draft.slug.trim(),
		soul: draft.soul.trim(),
		tools: draft.tools,
		...(avatar === "" ? {} : { avatar }),
	};
}

export const toggleTool = (tools: readonly string[], tool: string, on: boolean): string[] =>
	on ? [...new Set([...tools, tool])] : tools.filter((known) => known !== tool);

/** What each tool preset lets a bot do, in a few words. Unknown presets show their name only. */
export const PRESET_TEXT: Record<string, string> = {
	"tasks-read": "read your tasks and the time",
	documents: "make PDFs and document numbers",
	web: "search and read the web",
	memory: "remember things in its own memory",
	codemode: "run small scripts over its own tools",
};

export const TRUST_TEXT: Record<TrustLevelName, string> = {
	open: "Open: never asks. Everything it does is logged.",
	normal: "Normal: asks before anything sensitive.",
	strict: "Strict: asks before anything sensitive, and refuses what the policy marks as never under strict.",
};

/** Where a level comes from, for the line under its select. */
export function trustSourceText(setting: TrustSettingView, defaultName: string): string {
	return setting.overridden
		? `Set here; ${defaultName} says ${setting.defaultLevel}.`
		: `From ${defaultName} (${setting.defaultLevel}).`;
}
