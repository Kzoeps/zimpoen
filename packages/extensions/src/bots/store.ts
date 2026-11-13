import type { AppDb } from "@assistant/db";
import { BOT_PRESETS, type BotPreset, type BotSpec } from "./presets.ts";

export type BotRow = BotSpec & { approvedVia: "owner" | "open"; callId: string; createdAt: number };

type DbRow = {
	slug: string;
	name: string;
	avatar: string;
	soul: string;
	tools: string;
	approved_via: "owner" | "open";
	source_call_id: string;
	created_at: number;
};

const COLUMNS = "slug, name, avatar, soul, tools, approved_via, source_call_id, created_at";

function presetsFrom(raw: string): BotPreset[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		// A preset dropped from the allowlist since is dropped from the bot too: the allowlist is the boundary, not the row.
		return Array.isArray(parsed)
			? parsed.filter((name): name is BotPreset => (BOT_PRESETS as readonly unknown[]).includes(name))
			: [];
	} catch {
		return [];
	}
}

const botFrom = (row: DbRow): BotRow => ({
	slug: row.slug,
	name: row.name,
	avatar: row.avatar,
	soul: row.soul,
	tools: presetsFrom(row.tools),
	approvedVia: row.approved_via,
	callId: row.source_call_id,
	createdAt: row.created_at,
});

export function getBot(db: AppDb, slug: string): BotRow | undefined {
	const row = db.get<DbRow>(`SELECT ${COLUMNS} FROM bots_bot WHERE slug = ?`, slug);
	return row === undefined ? undefined : botFrom(row);
}

export function listBots(db: AppDb): BotRow[] {
	return db.all<DbRow>(`SELECT ${COLUMNS} FROM bots_bot ORDER BY created_at, slug`).map(botFrom);
}

export function countBots(db: AppDb): number {
	return db.get<{ n: number }>("SELECT count(*) AS n FROM bots_bot")?.n ?? 0;
}

/** Insert the bot; a row with the same slug already there is kept as it is. Returns whether this call made it. */
export function insertBot(
	db: AppDb,
	bot: BotSpec & { approvedVia: "owner" | "open"; callId: string; now: number },
): boolean {
	const result = db.run(
		`INSERT INTO bots_bot (slug, name, avatar, soul, tools, approved_via, source_call_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (slug) DO NOTHING`,
		bot.slug,
		bot.name,
		bot.avatar,
		bot.soul,
		JSON.stringify(bot.tools),
		bot.approvedVia,
		bot.callId,
		bot.now,
	);
	return result.changes > 0;
}

export function deleteBot(db: AppDb, slug: string): boolean {
	return db.run("DELETE FROM bots_bot WHERE slug = ?", slug).changes > 0;
}

export function findCall(db: AppDb, callId: string): string | undefined {
	return db.get<{ output: string }>("SELECT output FROM bots_call WHERE call_id = ?", callId)?.output;
}

export function recordCall(db: AppDb, callId: string, tool: string, output: string, now: number): void {
	db.run(
		"INSERT INTO bots_call (call_id, tool, output, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (call_id) DO NOTHING",
		callId,
		tool,
		output,
		now,
	);
}
