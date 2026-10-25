import type { Migration } from "@assistant/db";

/**
 * Tables of the usage module (PLAN §7, M8). Never edit one that has shipped: add `usage/00N_...` after it.
 *
 * Durable keeps one running total per conversation (`pi.usage`), which cannot say what was spent on a given day. So the
 * totals are sampled: `usage_baseline` is what the last sample saw, `usage_day` accumulates what each sample found new on
 * top of it, under the owner's local day of the sample. Money is micro-dollars (integers: sums stay exact).
 */
export const usageMigrations: readonly Migration[] = [
	{
		id: "usage/001_ledger",
		up: (db) => {
			db.exec(`
				CREATE TABLE usage_baseline (
					agent_id TEXT NOT NULL,
					-- 'model': a provider/model that answered; 'tool': a tool whose result reported its own spend.
					bucket TEXT NOT NULL CHECK (bucket IN ('model', 'tool')),
					key TEXT NOT NULL,
					input INTEGER NOT NULL,
					output INTEGER NOT NULL,
					cache_read INTEGER NOT NULL,
					cache_write INTEGER NOT NULL,
					tokens INTEGER NOT NULL,
					cost_micro INTEGER NOT NULL,
					PRIMARY KEY (agent_id, bucket, key)
				) STRICT;

				CREATE TABLE usage_day (
					agent_id TEXT NOT NULL,
					-- The owner's local day the sample fell on, 2026-10-26.
					day TEXT NOT NULL,
					bucket TEXT NOT NULL CHECK (bucket IN ('model', 'tool')),
					key TEXT NOT NULL,
					input INTEGER NOT NULL,
					output INTEGER NOT NULL,
					cache_read INTEGER NOT NULL,
					cache_write INTEGER NOT NULL,
					tokens INTEGER NOT NULL,
					cost_micro INTEGER NOT NULL,
					PRIMARY KEY (agent_id, day, bucket, key)
				) STRICT;
				CREATE INDEX usage_day_day ON usage_day (day);

				-- An agent is in this table once its first sample has copied Durable's totals into the baseline without dating them:
				-- what was spent before anyone looked has no day, and must not land on today's.
				CREATE TABLE usage_seed (
					agent_id TEXT PRIMARY KEY,
					seeded_at INTEGER NOT NULL
				) STRICT;

				-- The owner's weekly soft limit, in tokens, per agent. No row: no limit.
				CREATE TABLE usage_budget (
					agent_id TEXT PRIMARY KEY,
					weekly_tokens INTEGER NOT NULL CHECK (weekly_tokens > 0),
					updated_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
];
