import type { AgentSettings, ModelOption, ThinkingLevel, UpdateAgentSettingsRequest } from "@assistant/shared";
import { isThinkingLevel } from "@assistant/shared";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { AgentDoc, type Harness } from "@earendil-works/pi-durable";
import type { AgentDef } from "./agents.ts";
import { asConversationId } from "./agents.ts";
import { invalidRequest } from "./http/errors.ts";

/**
 * The owner-editable part of an agent: its model and thinking level. They live in Durable's `pi.agent` document of the
 * agent's conversation, never in agent code, and `configure()` changes them from the agent's next request on.
 */

/** Models this server can serve right now: the provider of the configured model mode, nothing else. */
export function listModelOptions(models: Models): ModelOption[] {
	return models
		.getModels()
		.map((model) => ({
			provider: model.provider,
			modelId: model.id,
			name: model.name,
			thinkingLevels: supportedLevels(model),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readAgentSettings(
	harness: Harness,
	conversationId: number,
	def: AgentDef,
	models: Models,
	context: Context,
): Promise<AgentSettings> {
	const stored = await harness.snapshot(AgentDoc, asConversationId(conversationId), context);
	const model = stored?.model;
	const level = stored?.thinkingLevel;
	return {
		id: def.id,
		name: def.name,
		avatar: def.avatar,
		...(model === undefined ? {} : { model: { provider: model.provider, modelId: model.modelId } }),
		...(isThinkingLevel(level) ? { thinkingLevel: level } : {}),
		modelAvailable: model !== undefined && models.getModel(model.provider, model.modelId) !== undefined,
	};
}

/**
 * Validate `request` against the models this server serves and apply it. Throws a 400 that names what is allowed.
 * Choosing a model the current thinking level does not support moves the level to the nearest one the model supports.
 */
export async function updateAgentSettings(
	harness: Harness,
	conversationId: number,
	def: AgentDef,
	request: UpdateAgentSettingsRequest,
	models: Models,
	context: Context,
): Promise<AgentSettings> {
	const id = asConversationId(conversationId);
	const conversation = await harness.conversation(id, context);
	if (conversation === undefined) {
		throw invalidRequest(`Agent '${def.id}' has no conversation in durable.sqlite. The databases may be out of sync.`);
	}
	const stored = await harness.snapshot(AgentDoc, id, context);
	const target = request.model ?? stored?.model;
	const model = target === undefined ? undefined : models.getModel(target.provider, target.modelId);
	if (model === undefined) {
		throw invalidRequest(
			request.model === undefined
				? `'${def.name}' has no model this server can serve, so a thinking level alone cannot be set. Choose a model too. ${availableText(models)}`
				: `Unknown model '${request.model.provider}/${request.model.modelId}'. ${availableText(models)}`,
		);
	}

	const supported = getSupportedThinkingLevels(model);
	const wanted = request.thinkingLevel ?? currentLevel(stored?.thinkingLevel) ?? supported[0];
	if (request.thinkingLevel !== undefined && !supported.includes(request.thinkingLevel)) {
		throw invalidRequest(
			`${model.name} does not support thinking level '${request.thinkingLevel}'. It supports: ${supported.join(", ")}.`,
		);
	}
	const thinkingLevel = wanted === undefined ? undefined : clampThinkingLevel(model, wanted);

	await conversation.configure(
		{
			model: { provider: model.provider, modelId: model.id },
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		},
		context,
	);
	return await readAgentSettings(harness, conversationId, def, models, context);
}

function currentLevel(value: unknown): ThinkingLevel | undefined {
	return isThinkingLevel(value) ? value : undefined;
}

function supportedLevels(model: Parameters<typeof getSupportedThinkingLevels>[0]): ThinkingLevel[] {
	return getSupportedThinkingLevels(model).filter(isThinkingLevel);
}

function availableText(models: Models): string {
	const ids = models.getModels().map((model) => `${model.provider}/${model.id}`);
	const shown = ids.slice(0, 12).join(", ");
	return `Models this server can serve: ${shown}${ids.length > 12 ? `, … (${ids.length} in all; GET /api/settings/agents lists them)` : ""}.`;
}
