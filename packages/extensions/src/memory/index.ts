import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { memoryMigrations } from "./migrations.ts";
import { memoryText } from "./section.ts";
import {
	agentOfConversation,
	createForgetAction,
	createMemoryTools,
	createPreferenceAction,
	createRecallTool,
} from "./tools.ts";

/** An agent that may remember, recall and (with approval) forget. */
export const MEMORY_EXTENSION_NAME = "memory";

/** An agent that only reads: its prompt lists what is remembered and it has `recall`, and it can change nothing. */
export const MEMORY_READ_EXTENSION_NAME = "memory-read";

export type MemoryModule = DomainModule & {
	/**
	 * What the Inbox agent gets instead of the full extension. It reads untrusted email text, and a line it remembered
	 * would be in a prompt for good, so it can read memory and never write it (PLAN rule 6).
	 */
	readOnlyExtension: (deps: DomainDeps) => Extension;
};

/** The section reads the agent of the conversation it is built for: each agent is told the shared preferences and its own lines. */
function memorySection(deps: Pick<DomainDeps, "db">) {
	return section("memory", (input) => {
		const agent = agentOfConversation(deps.db, Number(input.conversationId));
		return agent === undefined ? undefined : memoryText(deps.db, agent);
	});
}

export const memoryModule: MemoryModule = {
	name: "memory",
	migrations: memoryMigrations,
	actions: (deps) => [createForgetAction(deps), createPreferenceAction(deps)],
	extension: (deps) =>
		defineExtension({ name: MEMORY_EXTENSION_NAME, tools: createMemoryTools(deps), sections: [memorySection(deps)] }),
	readOnlyExtension: (deps) =>
		defineExtension({
			name: MEMORY_READ_EXTENSION_NAME,
			tools: [createRecallTool(deps)],
			sections: [memorySection(deps)],
		}),
};

export { MEMORY_LINE_CHARS, MEMORY_SECTION_CHARS, renderMemory } from "./section.ts";
export * as memoryStore from "./store.ts";
export { MAX_FACTS_PER_SCOPE, MemoryError } from "./store.ts";
export { agentOfConversation, PREFERENCE_ACTION } from "./tools.ts";
