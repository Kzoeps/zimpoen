import type { AgentSettings, ModelOption } from "@assistant/shared";
import { describe, expect, it } from "vitest";
import {
	changeOf,
	chooseThinkingLevel,
	draftOf,
	isCurated,
	modelKey,
	offeredModels,
	withModel,
} from "../src/lib/settings-form.ts";

const faux: ModelOption = {
	provider: "faux",
	modelId: "faux-1",
	name: "Faux model (dev)",
	thinkingLevels: ["off", "minimal", "low", "medium", "high"],
};
const sol: ModelOption = {
	provider: "openai",
	modelId: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
};
const models = [faux, sol];

const agent = (extra: Partial<AgentSettings> = {}): AgentSettings => ({
	id: "pa",
	name: "Assistant",
	avatar: "🧭",
	model: { provider: "faux", modelId: "faux-1" },
	thinkingLevel: "medium",
	modelAvailable: true,
	...extra,
});

describe("chooseThinkingLevel", () => {
	it("keeps the level when the model supports it", () => {
		expect(chooseThinkingLevel("high", sol.thinkingLevels)).toBe("high");
	});

	it("moves to the nearest supported level, the lower one on a tie", () => {
		expect(chooseThinkingLevel("off", sol.thinkingLevels)).toBe("low");
		expect(chooseThinkingLevel("minimal", sol.thinkingLevels)).toBe("low");
		expect(chooseThinkingLevel("max", faux.thinkingLevels)).toBe("high");
		expect(chooseThinkingLevel("medium", ["high", "low"])).toBe("low");
	});

	it("falls back to medium when nothing was chosen, and to nothing when no level exists", () => {
		expect(chooseThinkingLevel(undefined, faux.thinkingLevels)).toBe("medium");
		expect(chooseThinkingLevel("low", [])).toBeUndefined();
	});
});

describe("the settings form", () => {
	it("starts from the agent's own model and level", () => {
		expect(draftOf(agent())).toStrictEqual({ model: "faux/faux-1", thinkingLevel: "medium" });
	});

	it("starts without a model when the server cannot serve the agent's, so the owner has to choose one", () => {
		const broken = agent({
			model: { provider: "faux", modelId: "faux-1" },
			modelAvailable: false,
			thinkingLevel: "xhigh",
		});

		expect(draftOf(broken)).toStrictEqual({ model: "", thinkingLevel: "xhigh" });
		expect(changeOf(broken, draftOf(broken), models)).toBeUndefined();
	});

	it("offers nothing to save until something differs", () => {
		const settings = agent();

		expect(changeOf(settings, draftOf(settings), models)).toBeUndefined();
		expect(changeOf(settings, { ...draftOf(settings), thinkingLevel: "high" }, models)).toStrictEqual({
			thinkingLevel: "high",
		});
	});

	it("sends the model and a level the new model supports when the model changes", () => {
		const settings = agent({ thinkingLevel: "minimal" });
		const draft = withModel(draftOf(settings), models, modelKey(sol));

		expect(draft).toStrictEqual({ model: "openai/gpt-6.1-sol", thinkingLevel: "low" });
		expect(changeOf(settings, draft, models)).toStrictEqual({
			model: { provider: "openai", modelId: "gpt-6.1-sol" },
			thinkingLevel: "low",
		});
	});

	it("repairs an agent whose model is unavailable by saving the model, even when it is the one named before", () => {
		const broken = agent({ modelAvailable: false, thinkingLevel: "medium" });
		const draft = withModel(draftOf(broken), models, "faux/faux-1");

		expect(changeOf(broken, draft, models)).toStrictEqual({
			model: { provider: "faux", modelId: "faux-1" },
			thinkingLevel: "medium",
		});
	});
});

describe("offeredModels", () => {
	const mini: ModelOption = { provider: "openai", modelId: "gpt-5-mini", name: "GPT-5 mini", thinkingLevels: ["low"] };
	const terra: ModelOption = {
		provider: "openai",
		modelId: "gpt-6-terra",
		name: "GPT-6 Terra",
		thinkingLevels: ["low"],
	};
	const claude: ModelOption = { provider: "anthropic", modelId: "claude-x", name: "Claude X", thinkingLevels: ["low"] };
	const catalog = [mini, sol, terra, claude];

	it("offers only the gpt-6 models by default, and everything on request", () => {
		expect(catalog.filter(isCurated)).toStrictEqual([sol, terra]);
		expect(offeredModels(catalog, modelKey(sol), false)).toStrictEqual([sol, terra]);
		expect(offeredModels(catalog, modelKey(sol), true)).toStrictEqual(catalog);
	});

	it("keeps the agent's current model in the list even when it is not curated, so the select never lies", () => {
		expect(offeredModels(catalog, modelKey(mini), false)).toStrictEqual([mini, sol, terra]);
	});

	it("offers everything when no model is curated (the scripted dev model), because an empty list is useless", () => {
		expect(offeredModels([faux], modelKey(faux), false)).toStrictEqual([faux]);
		expect(offeredModels([mini, claude], "", false)).toStrictEqual([mini, claude]);
	});
});
