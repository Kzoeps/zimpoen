import type { AppDb } from "@assistant/db";

export type Bucket = "model" | "tool";

/** Every counter of one `Usage`, money in micro-dollars. */
export type Counters = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tokens: number;
	costMicro: number;
};

export const ZERO: Counters = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, costMicro: 0 };

export type Entry = { bucket: Bucket; key: string; counters: Counters };

type BaselineRow = {
	bucket: Bucket;
	key: string;
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	tokens: number;
	cost_micro: number;
};

const countersOf = (row: BaselineRow): Counters => ({
	input: row.input,
	output: row.output,
	cacheRead: row.cache_read,
	cacheWrite: row.cache_write,
	tokens: row.tokens,
	costMicro: row.cost_micro,
});

export const isSeeded = (db: AppDb, agentId: string): boolean =>
	db.get("SELECT 1 AS one FROM usage_seed WHERE agent_id = ?", agentId) !== undefined;

export function markSeeded(db: AppDb, agentId: string, now: number): void {
	db.run("INSERT OR IGNORE INTO usage_seed (agent_id, seeded_at) VALUES (?, ?)", agentId, now);
}

export function baselines(db: AppDb, agentId: string): Map<string, Counters> {
	const map = new Map<string, Counters>();
	for (const row of db.all<BaselineRow>(
		"SELECT bucket, key, input, output, cache_read, cache_write, tokens, cost_micro FROM usage_baseline WHERE agent_id = ?",
		agentId,
	)) {
		map.set(`${row.bucket}:${row.key}`, countersOf(row));
	}
	return map;
}

export function setBaseline(db: AppDb, agentId: string, entry: Entry): void {
	const c = entry.counters;
	db.run(
		`INSERT INTO usage_baseline (agent_id, bucket, key, input, output, cache_read, cache_write, tokens, cost_micro)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (agent_id, bucket, key) DO UPDATE SET input = excluded.input, output = excluded.output,
		   cache_read = excluded.cache_read, cache_write = excluded.cache_write, tokens = excluded.tokens, cost_micro = excluded.cost_micro`,
		agentId,
		entry.bucket,
		entry.key,
		c.input,
		c.output,
		c.cacheRead,
		c.cacheWrite,
		c.tokens,
		c.costMicro,
	);
}

/** Add `delta` to what the day already holds for this model or tool. */
export function addToDay(db: AppDb, agentId: string, day: string, entry: Entry): void {
	const c = entry.counters;
	db.run(
		`INSERT INTO usage_day (agent_id, day, bucket, key, input, output, cache_read, cache_write, tokens, cost_micro)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (agent_id, day, bucket, key) DO UPDATE SET input = input + excluded.input, output = output + excluded.output,
		   cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
		   tokens = tokens + excluded.tokens, cost_micro = cost_micro + excluded.cost_micro`,
		agentId,
		day,
		entry.bucket,
		entry.key,
		c.input,
		c.output,
		c.cacheRead,
		c.cacheWrite,
		c.tokens,
		c.costMicro,
	);
}

export type DayTotal = { agentId: string; day: string; tokens: number; costMicro: number };

/** Tokens and money per agent and local day, for the days from `from` to `to` inclusive. */
export function dayTotals(db: AppDb, from: string, to: string): DayTotal[] {
	return db
		.all<{ agent_id: string; day: string; tokens: number; cost_micro: number }>(
			`SELECT agent_id, day, SUM(tokens) AS tokens, SUM(cost_micro) AS cost_micro FROM usage_day
			 WHERE day >= ? AND day <= ? GROUP BY agent_id, day ORDER BY day`,
			from,
			to,
		)
		.map((row) => ({ agentId: row.agent_id, day: row.day, tokens: row.tokens, costMicro: row.cost_micro }));
}

/** What an agent has used from `from` to `to` inclusive. */
export function rangeCounters(db: AppDb, agentId: string, from: string, to: string): Counters {
	const row = db.get<{
		input: number | null;
		output: number | null;
		cache_read: number | null;
		cache_write: number | null;
		tokens: number | null;
		cost_micro: number | null;
	}>(
		`SELECT SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
		        SUM(tokens) AS tokens, SUM(cost_micro) AS cost_micro
		 FROM usage_day WHERE agent_id = ? AND day >= ? AND day <= ?`,
		agentId,
		from,
		to,
	);
	return {
		input: row?.input ?? 0,
		output: row?.output ?? 0,
		cacheRead: row?.cache_read ?? 0,
		cacheWrite: row?.cache_write ?? 0,
		tokens: row?.tokens ?? 0,
		costMicro: row?.cost_micro ?? 0,
	};
}

/** The last sampled lifetime totals of an agent, one entry per model or tool. */
export function lifetime(db: AppDb, agentId: string): Entry[] {
	return db
		.all<BaselineRow>(
			"SELECT bucket, key, input, output, cache_read, cache_write, tokens, cost_micro FROM usage_baseline WHERE agent_id = ? ORDER BY tokens DESC, key",
			agentId,
		)
		.map((row) => ({ bucket: row.bucket, key: row.key, counters: countersOf(row) }));
}

export function getLimit(db: AppDb, agentId: string): number | undefined {
	return db.get<{ weekly_tokens: number }>("SELECT weekly_tokens FROM usage_budget WHERE agent_id = ?", agentId)
		?.weekly_tokens;
}

export function setLimit(db: AppDb, agentId: string, weeklyTokens: number | null, now: number): void {
	if (weeklyTokens === null) {
		db.run("DELETE FROM usage_budget WHERE agent_id = ?", agentId);
		return;
	}
	db.run(
		`INSERT INTO usage_budget (agent_id, weekly_tokens, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (agent_id) DO UPDATE SET weekly_tokens = excluded.weekly_tokens, updated_at = excluded.updated_at`,
		agentId,
		weeklyTokens,
		now,
	);
}
