import { BOT_SLUG_PATTERN } from "@assistant/shared";

/**
 * What a bot may be given (PLAN upgrade §4): names of existing extensions, nothing else. Never `inbox` (untrusted mail,
 * rule 6), `files`, `delegate` (rule 12: bots talk to nobody), `bots`, `daily`, `routines` or the approvals admin. Every
 * bot also gets the approval hook and `tool_search`, so a preset's guarded deletes stay guarded. No preset writes the
 * owner's domain data (tasks are read-only; health, ledger and splits are not offered), which is what makes a bot with `web`
 * acceptable: what a page talks it into can reach only its own memory scope and the PDFs and numbers `documents` makes.
 */
export const BOT_PRESETS = ["tasks-read", "documents", "web", "memory", "codemode"] as const;

export type BotPreset = (typeof BOT_PRESETS)[number];

export const isBotPreset = (value: string): value is BotPreset => (BOT_PRESETS as readonly string[]).includes(value);

export const MAX_BOTS = 8;
export const MAX_SOUL_CHARS = 6000;
export const MAX_BOT_NAME_CHARS = 40;

/** What the PA writes for a bot, and what the server builds its agent from. */
export type BotSpec = {
	slug: string;
	name: string;
	/** An emoji. */
	avatar: string;
	/** The bot's own instructions, written by the PA. */
	soul: string;
	tools: BotPreset[];
};

/** Built-in agent ids a slug must not shadow in sentences ("the pa bot") or in memory scopes. */
const RESERVED_SLUGS = new Set(["pa", "inbox", "health", "accountant", "shared", "all"]);

export class BotSpecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BotSpecError";
	}
}

/** Check and normalise what the PA asked for. Throws {@link BotSpecError} saying what to change. */
export function cleanSpec(raw: {
	slug: string;
	name: string;
	avatar?: string;
	soul: string;
	tools: readonly string[];
}): BotSpec {
	const slug = raw.slug.trim().toLowerCase();
	if (!BOT_SLUG_PATTERN.test(slug) || RESERVED_SLUGS.has(slug)) {
		throw new BotSpecError(
			`'${raw.slug.slice(0, 40)}' cannot be a bot's slug. Use 2 to 32 lowercase letters, digits and dashes, starting with a letter, and not pa, inbox, health, accountant, shared or all.`,
		);
	}
	const name = raw.name.replace(/\s+/g, " ").trim();
	if (name === "" || name.length > MAX_BOT_NAME_CHARS) {
		throw new BotSpecError(`A bot's name is 1 to ${MAX_BOT_NAME_CHARS} characters.`);
	}
	const avatar = (raw.avatar ?? "").trim() || "🤖";
	if ([...avatar].length > 4) throw new BotSpecError("avatar is one emoji.");
	const soul = raw.soul.trim();
	if (soul === "") throw new BotSpecError("soul must say who the bot is and what it does.");
	if (soul.length > MAX_SOUL_CHARS) {
		throw new BotSpecError(`soul is ${soul.length} characters; at most ${MAX_SOUL_CHARS}. Shorten it.`);
	}
	const unknown = raw.tools.filter((tool) => !isBotPreset(tool));
	if (unknown.length > 0) {
		throw new BotSpecError(
			`A bot cannot have ${unknown.map((tool) => `'${tool.slice(0, 30)}'`).join(", ")}. Choose from: ${BOT_PRESETS.join(", ")}.`,
		);
	}
	const tools = BOT_PRESETS.filter((preset) => raw.tools.includes(preset));
	return { slug, name, avatar, soul, tools };
}
