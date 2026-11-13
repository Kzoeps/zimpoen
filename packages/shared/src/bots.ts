import type { BotId } from "./agents.ts";

/**
 * The owner's bots and trust pages (PLAN upgrade §4, §3). Creating or deleting a bot here is the owner acting directly:
 * no approval is asked. The caps and checks are the same ones the PA's tools obey (the server runs the same code).
 */

/** Trust levels, as the API carries them. The server's `decide()` gives them meaning (docs/plans/upgrade.md §3). */
export const TRUST_LEVEL_NAMES = ["open", "normal", "strict"] as const;

export type TrustLevelName = (typeof TRUST_LEVEL_NAMES)[number];

export function isTrustLevelName(value: unknown): value is TrustLevelName {
	return (TRUST_LEVEL_NAMES as readonly unknown[]).includes(value);
}

export type BotView = {
	id: BotId;
	slug: string;
	name: string;
	/** An emoji. */
	avatar: string;
	/** The bot's instructions. */
	soul: string;
	tools: string[];
	/** Who allowed its creation: the owner (an approval or this page), or the PA at trust level open. */
	approvedVia: "owner" | "open";
	createdAt: number;
};

/** `GET /api/bots`, and the answer to a create or delete: the bots as they are now and what a new one may have. */
export type BotsResponse = {
	bots: BotView[];
	/** The most bots there can be. */
	max: number;
	/** The tool presets a bot may be given. */
	presets: string[];
	maxSoulChars: number;
	maxNameChars: number;
};

/** `POST /api/bots`. */
export type CreateBotRequest = {
	slug: string;
	name: string;
	/** One emoji. Omitted: 🤖. */
	avatar?: string;
	soul: string;
	tools: string[];
};

/**
 * One trust setting. `level` is what applies now: the owner's stored choice when there is one (`overridden`), else
 * `defaultLevel` (for the PA: `ZIMPOEN_PA_TRUST` or normal; for a project: its level in the broker policy).
 */
export type TrustSettingView = { level: TrustLevelName; defaultLevel: TrustLevelName; overridden: boolean };

export type ProjectTrustView = TrustSettingView & { id: string };

/** `GET /api/settings/trust`. */
export type TrustSettingsResponse = {
	/** Whether the PA asks before creating or deleting a bot. */
	pa: TrustSettingView;
	/** Whether the credential broker is on (`ZIMPOEN_CRED_BROKER=inprocess`). Off: no projects. */
	broker: "on" | "off";
	/** The broker policy's projects. */
	projects: ProjectTrustView[];
};

/** `PUT /api/settings/trust/pa` and `PUT /api/settings/trust/projects/:id`. `null` goes back to the default. */
export type UpdateTrustRequest = { level: TrustLevelName | null };
