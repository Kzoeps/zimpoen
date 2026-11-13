import { botIdOf } from "@assistant/shared";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ActionArgs, ApprovalAction } from "../approvals/service.ts";
import * as memoryStore from "../memory/store.ts";
import type { DomainDeps } from "../module.ts";
import { isScheduledRun, SCHEDULED_RUN_REFUSAL } from "../scheduled-run.ts";
import { asDetails, text } from "../tool-support.ts";
import { decide, type TrustLevel } from "../trust.ts";
import * as usageStore from "../usage/store.ts";
import { BOT_PRESETS, type BotSpec, BotSpecError, cleanSpec, MAX_BOTS, MAX_SOUL_CHARS } from "./presets.ts";
import * as store from "./store.ts";

/** What the server gives the bots module: how a bot's conversation is made and archived, and the PA's trust level. */
export type BotsDeps = {
	/** Who decides bot creation and deletion (PLAN upgrade §3). Only the owner sets it. */
	trustLevel: TrustLevel;
	/** Make sure the bot has its conversation and an `agents` row `bot:<slug>`. Idempotent: called again after a crash. */
	spawn(bot: BotSpec): Promise<void>;
	/** Archive the bot's conversation (kept in durable.sqlite) and remove its `agents` row. Idempotent. */
	retire(slug: string): Promise<void>;
	/** Rule 13 check, replaceable in tests. Default: {@link isScheduledRun} over the Harness. */
	isScheduledRun?: (conversationId: number) => Promise<boolean>;
};

type Deps = Pick<DomainDeps, "db" | "now" | "harness" | "approvals" | "bots" | "warn">;

/** Approval action names: not tools the model can call. The server runs them when the owner approves. */
export const CREATE_BOT_ACTION = "spawn_bot";
export const DELETE_BOT_ACTION = "retire_bot";

function requireBots(deps: Deps): BotsDeps {
	if (deps.bots === undefined) throw new Error("Bots are not set up on this server.");
	return deps.bots;
}

function specFromArgs(args: ActionArgs): { spec: BotSpec; callId: string } {
	const { slug, name, avatar, soul, tools, callId } = args;
	if (
		typeof callId !== "string" ||
		callId === "" ||
		typeof slug !== "string" ||
		typeof name !== "string" ||
		typeof avatar !== "string" ||
		typeof soul !== "string" ||
		!Array.isArray(tools) ||
		!tools.every((tool) => typeof tool === "string")
	) {
		throw new Error("This request is damaged: it does not say which bot to create. Ask the assistant to ask again.");
	}
	return { spec: cleanSpec({ slug, name, avatar, soul, tools }), callId };
}

/** Create the bot: the row first (authoritative), then its conversation. Safe to run twice. */
async function createBot(deps: Deps, spec: BotSpec, via: "owner" | "open", callId: string): Promise<string> {
	const bots = requireBots(deps);
	const existing = store.getBot(deps.db, spec.slug);
	if (existing !== undefined && existing.callId !== callId) {
		throw new Error(`There is already a bot ${botIdOf(spec.slug)}, made by another request. Nothing was changed.`);
	}
	if (existing === undefined) {
		if (store.countBots(deps.db) >= MAX_BOTS) {
			throw new Error(`There are already ${MAX_BOTS} bots, the most there can be. Delete one first.`);
		}
		store.insertBot(deps.db, { ...spec, approvedVia: via, callId, now: deps.now() });
	}
	await bots.spawn(spec);
	return `Created the bot ${spec.name} (${botIdOf(spec.slug)}) with ${spec.tools.length === 0 ? "no tools" : spec.tools.join(", ")}. It is in the sidebar, and ask_agent can reach it.`;
}

/** Delete the bot: the row first, then archive its conversation. Safe to run twice. */
async function deleteBot(deps: Deps, slug: string): Promise<string> {
	const bots = requireBots(deps);
	const known = store.getBot(deps.db, slug);
	store.deleteBot(deps.db, slug);
	await bots.retire(slug);
	// A later bot with the same slug starts clean: nothing the old one kept, and no weekly limit set for it.
	memoryStore.deleteScope(deps.db, botIdOf(slug));
	usageStore.setLimit(deps.db, botIdOf(slug), null, deps.now());
	return known === undefined
		? `There is no bot ${botIdOf(slug)} any more.`
		: `Deleted the bot ${known.name} (${botIdOf(slug)}). Its conversation is archived, not erased.`;
}

/** Bot creation and deletion as approval actions: the server carries them out when the owner approves. */
export function createBotActions(deps: Deps): ApprovalAction[] {
	return [
		{
			tool: CREATE_BOT_ACTION,
			proposeTool: "create_bot",
			target: (args) => `bot:${String(args.slug)}`,
			run: (args) => {
				const { spec, callId } = specFromArgs(args);
				return createBot(deps, spec, "owner", callId);
			},
		},
		{
			tool: DELETE_BOT_ACTION,
			proposeTool: "delete_bot",
			target: (args) => `bot:${String(args.slug)}`,
			run: (args) => deleteBot(deps, String(args.slug)),
		},
	];
}

/** `create_bot`, `delete_bot` and `list_bots`: the PA's alone (PLAN upgrade §4). */
export function createBotTools(deps: Deps) {
	const { db } = deps;

	/** Rule 8 and rule 13 for both lifecycle tools; `act` runs at most once per call id. */
	async function lifecycle(
		tool: string,
		api: ToolExecutionApi,
		act: (resumed: boolean) => Promise<{ output: string; details?: ReturnType<typeof asDetails> }>,
	) {
		const earlier = store.findCall(db, api.callId);
		if (earlier !== undefined && earlier !== "") return { output: text(earlier) };
		// `""`: this call began an open-mode change and the process stopped before it answered. Rule 13 passed then.
		const resumed = earlier === "";
		const bots = requireBots(deps);
		if (!resumed) {
			const conversationId = Number(api.conversationId);
			const scheduled = await (bots.isScheduledRun ?? ((id) => isScheduledRun(deps.harness(), id)))(conversationId);
			if (scheduled) throw new Error(SCHEDULED_RUN_REFUSAL);
		}
		const result = await act(resumed);
		store.recordCall(db, api.callId, tool, result.output, api.now());
		return { output: text(result.output), ...(result.details === undefined ? {} : { details: result.details }) };
	}

	function askOwner(api: ToolExecutionApi, action: string, args: ActionArgs, summary: string) {
		const state = deps.approvals.propose({
			conversationId: Number(api.conversationId),
			tool: action,
			args,
			summary,
			callId: api.callId,
		});
		return {
			output:
				state.status === "pending"
					? `Asked the owner to approve (${state.id}): ${summary}. Nothing is done yet: tell them to tap Approve or reply YES, and do not say it is done until they have.`
					: `That request is already ${state.status}.`,
			details: asDetails({ type: "approval", actionId: state.id, summary, expiresAt: state.expiresAt }),
		};
	}

	const createBotTool = defineTool({
		name: "create_bot",
		description:
			"Create a specialist bot: its own chat in the sidebar with its own instructions (soul) and a few tool presets. " +
			`At most ${MAX_BOTS} bots. Depending on the owner's trust setting it asks them to approve first. ` +
			"Bots cannot ask other agents; you reach a bot with ask_agent and its id bot:<slug>.",
		parameters: Type.Object({
			slug: Type.String({ minLength: 2, maxLength: 32, description: "Short id: lowercase letters, digits, dashes." }),
			name: Type.String({ minLength: 1, maxLength: 40, description: "What the sidebar calls it." }),
			avatar: Type.Optional(Type.String({ maxLength: 16, description: "One emoji." })),
			soul: Type.String({
				minLength: 1,
				maxLength: MAX_SOUL_CHARS,
				description: "Who the bot is and how it works, written to the bot.",
			}),
			tools: Type.Array(Type.Union(BOT_PRESETS.map((preset) => Type.Literal(preset))), {
				maxItems: BOT_PRESETS.length,
				description: `Tool presets: ${BOT_PRESETS.join(", ")}.`,
			}),
		}),
		replay: "safe",
		deferred: true,
		execute: (args, api) =>
			lifecycle("create_bot", api, async () => {
				let spec: BotSpec;
				try {
					spec = cleanSpec(args);
				} catch (error) {
					if (error instanceof BotSpecError) throw new Error(error.message);
					throw error;
				}
				const existing = store.getBot(db, spec.slug);
				if (existing !== undefined && existing.callId !== api.callId) {
					throw new Error(
						`There is already a bot ${botIdOf(spec.slug)}. Choose another slug, or delete that one first.`,
					);
				}
				if (existing === undefined && store.countBots(db) >= MAX_BOTS) {
					throw new Error(`There are already ${MAX_BOTS} bots, the most there can be. Delete one first.`);
				}
				const verdict = decide(requireBots(deps).trustLevel, "bot_lifecycle");
				if (verdict === "deny") throw new Error("The owner's trust setting does not allow creating bots.");
				if (verdict === "allow") {
					deps.warn?.(`[bots] creating ${botIdOf(spec.slug)} without asking: the PA's trust level is open.`);
					store.beginCall(db, api.callId, "create_bot", api.now());
					return { output: await createBot(deps, spec, "open", api.callId) };
				}
				return askOwner(
					api,
					CREATE_BOT_ACTION,
					{ ...spec, callId: api.callId },
					`Create the bot ${spec.avatar} ${spec.name} (${botIdOf(spec.slug)}) with ${spec.tools.length === 0 ? "no tools" : spec.tools.join(", ")}`,
				);
			}),
	});

	const deleteBotTool = defineTool({
		name: "delete_bot",
		description:
			"Delete a bot you created. Its chat is archived, not erased. Depending on the owner's trust setting it asks them to approve first.",
		parameters: Type.Object({ slug: Type.String({ minLength: 1, maxLength: 40, description: "The bot's slug." }) }),
		replay: "safe",
		deferred: true,
		execute: (args, api) =>
			lifecycle("delete_bot", api, async (resumed) => {
				const slug = args.slug.trim().toLowerCase().replace(/^bot:/, "");
				const bot = store.getBot(db, slug);
				// A replay of a delete this call already began: finish it (every step is idempotent).
				if (bot === undefined && resumed) return { output: await deleteBot(deps, slug) };
				if (bot === undefined) throw new Error(`There is no bot '${slug.slice(0, 40)}'. list_bots shows them.`);
				const verdict = decide(requireBots(deps).trustLevel, "bot_lifecycle");
				if (verdict === "deny") throw new Error("The owner's trust setting does not allow deleting bots.");
				if (verdict === "allow") {
					deps.warn?.(`[bots] deleting ${botIdOf(slug)} without asking: the PA's trust level is open.`);
					store.beginCall(db, api.callId, "delete_bot", api.now());
					return { output: await deleteBot(deps, slug) };
				}
				return askOwner(
					api,
					DELETE_BOT_ACTION,
					{ slug },
					`Delete the bot ${bot.avatar} ${bot.name} (${botIdOf(slug)})`,
				);
			}),
	});

	const listBotsTool = defineTool({
		name: "list_bots",
		description: "The bots you created: their ids, names and tool presets.",
		parameters: Type.Object({}),
		replay: "safe",
		deferred: true,
		async execute() {
			const bots = store.listBots(db);
			const body =
				bots.length === 0
					? `There are no bots. You can create up to ${MAX_BOTS}.`
					: `${bots.length} of at most ${MAX_BOTS} bots:\n${bots
							.map(
								(bot) =>
									`${botIdOf(bot.slug)} ${bot.avatar} ${bot.name}: ${bot.tools.length === 0 ? "no tools" : bot.tools.join(", ")}`,
							)
							.join("\n")}`;
			return { output: text(body) };
		},
	});

	return [createBotTool, deleteBotTool, listBotsTool];
}
