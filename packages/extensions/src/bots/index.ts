import { defineExtension } from "@earendil-works/pi-durable";
import type { DomainModule } from "../module.ts";
import { botsMigrations } from "./migrations.ts";
import { createBotActions, createBotTools } from "./tools.ts";

export const BOTS_EXTENSION_NAME = "bots";

/** The PA's specialist bots (PLAN upgrade §4). Only the PA selects this extension. */
export const botsModule: DomainModule = {
	name: "bots",
	migrations: botsMigrations,
	extension: (deps) => defineExtension({ name: BOTS_EXTENSION_NAME, tools: createBotTools(deps) }),
	actions: createBotActions,
};

export {
	BOT_PRESETS,
	type BotPreset,
	type BotSpec,
	BotSpecError,
	cleanSpec as cleanBotSpec,
	isBotPreset,
	MAX_BOT_NAME_CHARS,
	MAX_BOTS,
	MAX_SOUL_CHARS,
} from "./presets.ts";
export * as botsStore from "./store.ts";
export {
	BotConflict,
	BotNotFound,
	type BotsDeps,
	CREATE_BOT_ACTION,
	createOwnerBots,
	DELETE_BOT_ACTION,
	type OwnerBots,
} from "./tools.ts";
