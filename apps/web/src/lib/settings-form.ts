import {
	type AgentSettings,
	type ModelOption,
	type ModelSelection,
	THINKING_LEVELS,
	type ThinkingLevel,
	type UpdateAgentSettingsRequest,
} from "@assistant/shared";

/** The settings form of one agent, as the select boxes hold it. */
export type SettingsDraft = {
	/** `provider/modelId` of the chosen model, or "" while the agent's own model cannot be served and none is chosen yet. */
	model: string;
	thinkingLevel: ThinkingLevel | undefined;
};

export const modelKey = (model: ModelSelection): string => `${model.provider}/${model.modelId}`;

export const findModel = (models: readonly ModelOption[], key: string): ModelOption | undefined =>
	models.find((model) => modelKey(model) === key);

/**
 * The level to hold after the model changed: the current one when the new model supports it, otherwise the nearest
 * supported one (the lower on a tie), so switching models never leaves a level the server would refuse.
 */
export function chooseThinkingLevel(
	current: ThinkingLevel | undefined,
	supported: readonly ThinkingLevel[],
): ThinkingLevel | undefined {
	const wanted = current ?? "medium";
	if (supported.length === 0 || supported.includes(wanted)) return supported.length === 0 ? undefined : wanted;
	const rank = (level: ThinkingLevel): number => THINKING_LEVELS.indexOf(level);
	const distance = (level: ThinkingLevel): number => Math.abs(rank(level) - rank(wanted));
	return [...supported].sort((a, b) => distance(a) - distance(b) || rank(a) - rank(b))[0];
}

/** What the form starts with: the agent's own settings, or an empty model choice when the server cannot serve its model. */
export function draftOf(settings: AgentSettings): SettingsDraft {
	return {
		model: settings.model !== undefined && settings.modelAvailable ? modelKey(settings.model) : "",
		thinkingLevel: settings.thinkingLevel,
	};
}

/** Pick another model, keeping the thinking level if that model supports it. */
export function withModel(draft: SettingsDraft, models: readonly ModelOption[], key: string): SettingsDraft {
	const option = findModel(models, key);
	return { model: key, thinkingLevel: chooseThinkingLevel(draft.thinkingLevel, option?.thinkingLevels ?? []) };
}

/** The request that turns `settings` into `draft`, or undefined when there is nothing to save. */
export function changeOf(
	settings: AgentSettings,
	draft: SettingsDraft,
	models: readonly ModelOption[],
): UpdateAgentSettingsRequest | undefined {
	const option = findModel(models, draft.model);
	if (option === undefined) return undefined;
	const modelChanged =
		!settings.modelAvailable || settings.model === undefined || modelKey(settings.model) !== draft.model;
	const levelChanged = draft.thinkingLevel !== undefined && draft.thinkingLevel !== settings.thinkingLevel;
	if (!modelChanged && !levelChanged) return undefined;
	return {
		...(modelChanged ? { model: { provider: option.provider, modelId: option.modelId } } : {}),
		...(draft.thinkingLevel === undefined ? {} : { thinkingLevel: draft.thinkingLevel }),
	};
}
