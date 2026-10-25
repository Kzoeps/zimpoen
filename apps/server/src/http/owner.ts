import type { AppDb } from "@assistant/db";
import { birthdays, MemoryError, memoryStore, peopleStore, type UsageService } from "@assistant/extensions";
import {
	type ActivityResponse,
	AGENT_IDS,
	isAgentId,
	type MemoryFactResponse,
	type MemoryResponse,
	type MemoryScope,
	PROFILE_SLOTS,
	type ProfileResponse,
	type UsageResponse,
} from "@assistant/shared";
import { Hono } from "hono";
import type { ActivityReader } from "../activity.ts";
import { invalidRequest, notFound } from "./errors.ts";
import {
	parseActivityQuery,
	parseMemoryQuery,
	parseUpdateBudget,
	parseUpdateMemory,
	parseUpdatePreferences,
	readJsonObject,
} from "./validation.ts";

/** What the owner's own pages need to know about the deployment, as the server's configuration states it. */
export type OwnerProfile = { ownerName?: string; timezone: string; currency: string; heightCm?: number };

export type OwnerDeps = {
	db: AppDb;
	/** Who the agents are, for the pages that name them. */
	agents: readonly { id: (typeof AGENT_IDS)[number]; name: string; avatar: string }[];
	profile: OwnerProfile;
	usage: UsageService;
	activity: ActivityReader;
	now?: () => number;
};

const ALL_SCOPES: readonly MemoryScope[] = ["shared", ...AGENT_IDS];

/**
 * The owner's pages (M8): the profile and the memory editor, the activity log, the usage dashboard and the weekly limits.
 * Mounted under `/api` behind the same guards as every route. What the owner changes here needs no approval: rule 3 is about
 * what the assistant deletes, and these are the owner's own hands.
 */
export function createOwnerApp(deps: OwnerDeps): Hono {
	const { db } = deps;
	const now = deps.now ?? Date.now;
	const app = new Hono();

	function profile(): ProfileResponse {
		const preferences = memoryStore.slotTexts(db);
		return {
			owner: {
				...(deps.profile.ownerName === undefined ? {} : { name: deps.profile.ownerName }),
				timezone: deps.profile.timezone,
				currency: deps.profile.currency,
				...(deps.profile.heightCm === undefined ? {} : { heightCm: deps.profile.heightCm }),
			},
			preferences,
			people: peopleStore.listPeople(db).map((person) => ({
				id: person.id,
				name: person.name,
				...(person.relation === "" ? {} : { relation: person.relation }),
				birthdayText: birthdays.birthdayLabel(person.birthdayMd, person.birthdayYear),
			})),
		};
	}

	app.get("/profile", (c) => c.json(profile()));

	app.put("/profile/preferences", async (c) => {
		const change = parseUpdatePreferences(await readJsonObject(c));
		try {
			// All or nothing: a line that is refused must not leave the other one changed.
			db.transaction(() => {
				for (const slot of PROFILE_SLOTS) {
					const value = change[slot];
					if (value !== undefined) memoryStore.setSlot(db, slot, value, now());
				}
			});
		} catch (error) {
			if (error instanceof MemoryError) throw invalidRequest(error.message);
			throw error;
		}
		return c.json(profile());
	});

	app.get("/memory", (c) => {
		const query = parseMemoryQuery(c);
		const match = query.q === undefined ? undefined : memoryStore.ftsQuery(query.q);
		const empty = query.q !== undefined && match === undefined;
		const { rows, total } = empty
			? { rows: [], total: 0 }
			: memoryStore.listFacts(db, {
					limit: query.limit,
					...(query.scope === undefined ? {} : { scopes: [query.scope] }),
					...(query.kind === undefined ? {} : { kind: query.kind }),
					...(match === undefined ? {} : { match }),
				});
		const body: MemoryResponse = {
			facts: rows.map(memoryStore.toView),
			total,
			counts: memoryStore.countsByScope(db, ALL_SCOPES),
		};
		return c.json(body);
	});

	app.patch("/memory/:id", async (c) => {
		const change = parseUpdateMemory(await readJsonObject(c));
		try {
			const row = memoryStore.updateFact(db, c.req.param("id"), change, now());
			if (row === undefined)
				throw notFound(`There is no remembered line '${c.req.param("id").slice(0, 20)}'. GET /api/memory lists them.`);
			const body: MemoryFactResponse = { fact: memoryStore.toView(row) };
			return c.json(body);
		} catch (error) {
			if (error instanceof MemoryError) throw invalidRequest(error.message);
			throw error;
		}
	});

	app.delete("/memory/:id", (c) => {
		if (!memoryStore.deleteFact(db, c.req.param("id"))) {
			throw notFound(`There is no remembered line '${c.req.param("id").slice(0, 20)}'. GET /api/memory lists them.`);
		}
		return c.json({ removed: true });
	});

	app.get("/activity", async (c) => {
		const query = parseActivityQuery(c);
		const body: ActivityResponse = await deps.activity.read({
			limit: query.limit,
			...(query.agent === undefined || !isAgentId(query.agent) ? {} : { agent: query.agent }),
			...(query.from === undefined ? {} : { from: query.from }),
			...(query.to === undefined ? {} : { to: query.to }),
			...(query.cursor === undefined ? {} : { cursor: query.cursor }),
		});
		return c.json(body);
	});

	app.get("/usage", async (c) => {
		const body: UsageResponse = await deps.usage.report(deps.agents);
		return c.json(body);
	});

	app.put("/settings/budget/:agent", async (c) => {
		const agent = c.req.param("agent");
		if (!isAgentId(agent)) throw notFound(`There is no agent '${agent.slice(0, 20)}'. GET /api/agents lists them.`);
		const { weeklyTokens } = parseUpdateBudget(await readJsonObject(c));
		deps.usage.setLimit(agent, weeklyTokens);
		const body: UsageResponse = await deps.usage.report(deps.agents);
		return c.json(body);
	});

	return app;
}
