import { type AppDb, listAgentRows } from "@assistant/db";
import { type BotSpec, botsStore } from "@assistant/extensions";
import { isBotId } from "@assistant/shared";
import type { Harness } from "@earendil-works/pi-durable";
import { type AgentDef, archiveAgent, botAgentDef, type EnsureAgentsOptions, ensureAgents } from "./agents.ts";
import type { Domain } from "./domain.ts";

/**
 * The server's half of the PA's bots (PLAN upgrade §4): `bots_bot` rows are authoritative, and this keeps the conversations
 * and the live agent list in step with them. `agents` is the very array the HTTP API reads, so the sidebar shows a bot as
 * soon as it exists.
 */
export type BotRuntime = {
	spawn(spec: BotSpec): Promise<void>;
	retire(slug: string): Promise<void>;
	/** At start: a conversation for every bot row, and the conversation of every bot whose row is gone archived. */
	start(): Promise<{ ensured: string[]; archived: string[] }>;
};

export function createBotRuntime(options: {
	harness: Harness;
	db: AppDb;
	domain: Pick<Domain, "botExtensions">;
	/** The live list of agents. Mutated in place. */
	agents: AgentDef[];
	ensure: Omit<EnsureAgentsOptions, "agents">;
	now: () => number;
}): BotRuntime {
	const { harness, db, agents } = options;

	const defOf = (spec: BotSpec): AgentDef => botAgentDef(spec, options.domain.botExtensions(spec.tools));

	function remember(def: AgentDef): void {
		const index = agents.findIndex((known) => known.id === def.id);
		if (index === -1) agents.push(def);
		else agents[index] = def;
	}

	function forget(id: string): void {
		const index = agents.findIndex((known) => known.id === id);
		if (index !== -1) agents.splice(index, 1);
	}

	async function spawn(spec: BotSpec): Promise<void> {
		const def = defOf(spec);
		await ensureAgents(harness, db, { ...options.ensure, agents: [def] });
		remember(def);
	}

	async function retire(slug: string): Promise<void> {
		const id = `bot:${slug}`;
		forget(id);
		await archiveAgent(harness, db, id, options.now);
	}

	return {
		spawn,
		retire,
		start: async () => {
			const ensured: string[] = [];
			for (const bot of botsStore.listBots(db)) {
				await spawn(bot);
				ensured.push(bot.slug);
			}
			const archived: string[] = [];
			for (const row of listAgentRows(db)) {
				if (isBotId(row.id) && botsStore.getBot(db, row.id.slice(4)) === undefined) {
					await retire(row.id.slice(4));
					archived.push(row.id);
				}
			}
			return { ensured, archived };
		},
	};
}
