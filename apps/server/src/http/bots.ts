import {
	BOT_PRESETS,
	BotConflict,
	BotNotFound,
	BotSpecError,
	MAX_BOT_NAME_CHARS,
	MAX_BOTS,
	MAX_SOUL_CHARS,
	type OwnerBots,
} from "@assistant/extensions";
import { type BotsResponse, type BotView, botIdOf, type TrustSettingView } from "@assistant/shared";
import { Hono } from "hono";
import { type TrustSettings, UnknownTrustProject } from "../trust-settings.ts";
import { ApiError, invalidRequest, notFound } from "./errors.ts";
import { parseCreateBot, parseUpdateTrust, readJsonObject } from "./validation.ts";

export type BotsAppDeps = {
	bots: OwnerBots;
	trust: TrustSettings;
	/**
	 * Says something in the PA's thread, display-only (no model tokens). Used for a trust level change, so the thread shows
	 * what the owner changed. Absent in tests of other routes.
	 */
	note?: (text: string) => Promise<void>;
	logger?: Partial<Pick<Console, "info" | "warn">>;
};

/**
 * The owner's Bots page and trust levels (PLAN upgrade §3, §4). Mounted under `/api` behind the same guards as every
 * route. Creating or deleting a bot here is the owner acting directly, so no approval is asked, but the caps and checks
 * are the PA's own (the same functions run). Trust levels are written only here: no tool reaches them.
 */
export function createBotsApp(deps: BotsAppDeps): Hono {
	const app = new Hono();

	const list = (): BotsResponse => ({
		bots: deps.bots.list().map(
			(bot): BotView => ({
				id: botIdOf(bot.slug),
				slug: bot.slug,
				name: bot.name,
				avatar: bot.avatar,
				soul: bot.soul,
				tools: bot.tools,
				approvedVia: bot.approvedVia,
				createdAt: bot.createdAt,
			}),
		),
		max: MAX_BOTS,
		presets: [...BOT_PRESETS],
		maxSoulChars: MAX_SOUL_CHARS,
		maxNameChars: MAX_BOT_NAME_CHARS,
	});

	app.get("/bots", (c) => c.json(list()));

	app.post("/bots", async (c) => {
		const request = parseCreateBot(await readJsonObject(c));
		try {
			const bot = await deps.bots.create(request);
			deps.logger?.info?.(`[bots] ${botIdOf(bot.slug)} was created from the Bots page.`);
		} catch (error) {
			if (error instanceof BotSpecError) throw invalidRequest(error.message);
			if (error instanceof BotConflict) throw new ApiError(409, "conflict", error.message);
			throw error;
		}
		return c.json(list(), 201);
	});

	app.delete("/bots/:slug", async (c) => {
		const slug = c.req.param("slug").replace(/^bot:/, "");
		try {
			await deps.bots.delete(slug);
		} catch (error) {
			if (error instanceof BotNotFound) throw notFound(`${error.message} GET /api/bots lists them.`);
			throw error;
		}
		deps.logger?.info?.(`[bots] ${botIdOf(slug)} was deleted from the Bots page.`);
		return c.json(list());
	});

	app.get("/settings/trust", (c) => c.json(deps.trust.view()));

	/** The change is saved before this runs: a thread that cannot take the note must not undo it, so a failure is logged. */
	async function announce(subject: string, before: TrustSettingView, after: TrustSettingView): Promise<void> {
		if (before.level === after.level) return;
		const how = after.overridden ? "set in Settings" : `back to its default, set in Settings`;
		try {
			await deps.note?.(`Trust level of ${subject} changed from ${before.level} to ${after.level} (${how}).`);
		} catch (error) {
			deps.logger?.warn?.(
				`[trust] the trust level of ${subject} changed, but the note in the PA's thread could not be posted: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	app.put("/settings/trust/pa", async (c) => {
		const { level } = parseUpdateTrust(await readJsonObject(c));
		const before = deps.trust.view().pa;
		const view = deps.trust.setPa(level);
		await announce("the PA", before, view.pa);
		deps.logger?.info?.(`[trust] the PA's trust level is now ${view.pa.level} (set in Settings).`);
		return c.json(view);
	});

	app.put("/settings/trust/projects/:id", async (c) => {
		const { level } = parseUpdateTrust(await readJsonObject(c));
		const id = c.req.param("id");
		try {
			const before = deps.trust.view().projects.find((known) => known.id === id);
			const view = deps.trust.setProject(id, level);
			const project = view.projects.find((known) => known.id === id);
			if (before !== undefined && project !== undefined) await announce(`project ${id}`, before, project);
			deps.logger?.info?.(`[trust] project ${id} is now ${project?.level} (set in Settings).`);
			return c.json(view);
		} catch (error) {
			if (error instanceof UnknownTrustProject) throw notFound(error.message);
			throw error;
		}
	});

	return app;
}
