import { listAgentRows } from "@assistant/db";
import type {
	AgentId,
	AgentUsage,
	BudgetAlert,
	UsageDay,
	UsageFigures,
	UsageModelRow,
	UsageResponse,
	UsageWeek,
} from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import type { BudgetCheck, BudgetGate, DomainDeps } from "../module.ts";
import { addDays, atLocalTime, formatLocalDate, localDate } from "../time.ts";
import * as store from "./store.ts";

type Deps = Pick<DomainDeps, "db" | "now" | "timezone" | "harness"> & Partial<Pick<DomainDeps, "warn">>;

/** Who an agent is, for the pages that name it. The module does not know the agents; the server does. */
export type AgentIdentity = { id: AgentId; name: string; avatar: string };

/** How old a sample may be for the banner, which every open tab asks for every few seconds. */
export const ALERT_SAMPLE_MAX_AGE_MS = 30_000;

const DAYS_SHOWN = 14;
const WEEKS_SHOWN = 8;

export type UsageService = BudgetGate & {
	/**
	 * Read Durable's usage ledgers and add what is new to the days. One reading at a time; a reading younger than
	 * `maxAgeMs` is not repeated. A conversation Durable cannot answer for is skipped (the others are still read).
	 */
	sample(maxAgeMs?: number): Promise<void>;
	/** The agents that have used their weekly limit. The banner's question: it reuses a recent sample. */
	alerts(agents: readonly AgentIdentity[]): Promise<BudgetAlert[]>;
	/** The dashboard: a fresh reading, then the numbers. */
	report(agents: readonly AgentIdentity[]): Promise<UsageResponse>;
	/** The weekly token limit of an agent, or none (`null`). */
	setLimit(agentId: string, weeklyTokens: number | null): void;
};

/** The Monday of the week a local day is in. */
export function weekStartOf(date: string): string {
	const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
	const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
	return addDays(date, -((weekday + 6) % 7));
}

/** Counters are whole numbers (the ledger's columns are integers): a provider that reports a fraction is counted to the nearest token, not skipped. */
const finite = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;

const finiteDollars = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Durable's ledger as counters: tokens as the provider reported them, money in whole micro-dollars. */
export function entriesOf(state: UsageState | undefined): store.Entry[] {
	const entries: store.Entry[] = [];
	for (const [bucket, group] of [
		["model", state?.models],
		["tool", state?.tools],
	] as const) {
		for (const [key, usage] of Object.entries(group ?? {})) {
			const u = usage as unknown as Record<string, unknown> & { cost?: { total?: unknown } };
			entries.push({
				bucket,
				key,
				counters: {
					input: finite(u.input),
					output: finite(u.output),
					cacheRead: finite(u.cacheRead),
					cacheWrite: finite(u.cacheWrite),
					tokens: finite(u.totalTokens),
					costMicro: Math.round(finiteDollars(u.cost?.total) * 1_000_000),
				},
			});
		}
	}
	return entries;
}

const growth = (now: number, before: number): number => Math.max(0, now - before);

/** What `now` holds beyond `before`, counter by counter; a counter that went down (a restored database) grew by nothing. */
export const deltaOf = (now: store.Counters, before: store.Counters): store.Counters => ({
	input: growth(now.input, before.input),
	output: growth(now.output, before.output),
	cacheRead: growth(now.cacheRead, before.cacheRead),
	cacheWrite: growth(now.cacheWrite, before.cacheWrite),
	tokens: growth(now.tokens, before.tokens),
	costMicro: growth(now.costMicro, before.costMicro),
});

const same = (a: store.Counters, b: store.Counters): boolean =>
	a.input === b.input &&
	a.output === b.output &&
	a.cacheRead === b.cacheRead &&
	a.cacheWrite === b.cacheWrite &&
	a.tokens === b.tokens &&
	a.costMicro === b.costMicro;

const figures = (counters: store.Counters): UsageFigures => ({
	input: counters.input,
	output: counters.output,
	cacheRead: counters.cacheRead,
	cacheWrite: counters.cacheWrite,
	tokens: counters.tokens,
	cost: counters.costMicro / 1_000_000,
});

function sum(entries: readonly store.Entry[]): store.Counters {
	const total = { ...store.ZERO };
	for (const { counters } of entries) {
		total.input += counters.input;
		total.output += counters.output;
		total.cacheRead += counters.cacheRead;
		total.cacheWrite += counters.cacheWrite;
		total.tokens += counters.tokens;
		total.costMicro += counters.costMicro;
	}
	return total;
}

export function createUsageService(deps: Deps): UsageService {
	const { db } = deps;
	let reading: Promise<void> = Promise.resolve();
	let sampledAt = 0;
	/** What has been said already (an agent and its error): the sampler runs every ten minutes, so a lasting failure is one log line, not hundreds. */
	const told = new Set<string>();

	function tell(agentId: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const key = `${agentId}:${message}`;
		if (told.has(key)) return;
		if (told.size >= 50) told.clear();
		told.add(key);
		deps.warn?.(
			`[usage] Could not count what the ${agentId} agent spent (${message}); the weekly limit does not see it until this works.`,
		);
	}

	/** One agent: what its ledger holds now against what the last reading saw, dated to today. */
	function apply(agentId: string, day: string, entries: readonly store.Entry[], now: number): void {
		db.transaction(() => {
			// The first reading of an agent only copies the totals: what was spent before anyone looked has no day.
			const seeded = store.isSeeded(db, agentId);
			const before = store.baselines(db, agentId);
			for (const entry of entries) {
				const known = before.get(`${entry.bucket}:${entry.key}`) ?? store.ZERO;
				if (seeded) {
					const delta = deltaOf(entry.counters, known);
					if (delta.tokens > 0 || delta.costMicro > 0 || delta.input > 0 || delta.output > 0) {
						store.addToDay(db, agentId, day, { ...entry, counters: delta });
					}
				}
				// The baseline follows the ledger down as well as up, so that growth after a restore is counted from there.
				if (!same(known, entry.counters)) store.setBaseline(db, agentId, entry);
			}
			if (!seeded) store.markSeeded(db, agentId, now);
		});
	}

	async function readOnce(): Promise<void> {
		const now = deps.now();
		const day = localDate(now, deps.timezone);
		for (const agent of listAgentRows(db)) {
			try {
				const state = await deps
					.harness()
					.snapshot(UsageDoc, agent.conversationId as ConversationId, BACKGROUND_CONTEXT);
				apply(agent.id, day, entriesOf(state), now);
			} catch (error) {
				// A conversation Durable cannot answer for (lost in a power cut: the server says so at start) must not stop the others.
				tell(agent.id, error);
			}
		}
		sampledAt = now;
	}

	function sample(maxAgeMs = 0): Promise<void> {
		// Readings run one after the other: two at once could apply an older ledger over a newer baseline and count growth twice.
		reading = reading
			.catch(() => {})
			.then(async () => {
				if (maxAgeMs > 0 && sampledAt !== 0 && deps.now() - sampledAt < maxAgeMs) return;
				await readOnce();
			});
		return reading;
	}

	const weekOf = (): { today: string; weekStart: string } => {
		const today = localDate(deps.now(), deps.timezone);
		return { today, weekStart: weekStartOf(today) };
	};

	function standing(agentId: string): BudgetCheck | undefined {
		const limit = store.getLimit(db, agentId);
		if (limit === undefined) return undefined;
		const { today, weekStart } = weekOf();
		const used = store.rangeCounters(db, agentId, weekStart, today).tokens;
		return { agent: agentId, used, limit, over: used >= limit, weekStart };
	}

	const shortDay = (date: string): string =>
		formatLocalDate(atLocalTime(date, "12:00", deps.timezone), deps.timezone).replace(/ \d{4}$/, "");

	return {
		sample,

		async check(agentId) {
			await sample();
			return standing(agentId);
		},

		async alerts(agents) {
			await sample(ALERT_SAMPLE_MAX_AGE_MS);
			return agents.flatMap((agent) => {
				const status = standing(agent.id);
				return status?.over === true
					? [{ agent: agent.id, name: agent.name, used: status.used, limit: status.limit }]
					: [];
			});
		},

		setLimit(agentId, weeklyTokens) {
			store.setLimit(db, agentId, weeklyTokens, deps.now());
		},

		async report(agents) {
			await sample();
			const { today, weekStart } = weekOf();
			const firstWeek = addDays(weekStart, -7 * (WEEKS_SHOWN - 1));
			const totals = store.dayTotals(db, firstWeek, today);

			const days: UsageDay[] = [];
			for (let offset = DAYS_SHOWN - 1; offset >= 0; offset--) {
				const date = addDays(today, -offset);
				const rows = totals.filter((row) => row.day === date);
				days.push({
					date,
					label: shortDay(date),
					tokens: rows.reduce((total, row) => total + row.tokens, 0),
					cost: rows.reduce((total, row) => total + row.costMicro, 0) / 1_000_000,
					byAgent: Object.fromEntries(rows.map((row) => [row.agentId, row.tokens])) as UsageDay["byAgent"],
				});
			}

			const weeks: UsageWeek[] = [];
			for (let index = 0; index < WEEKS_SHOWN; index++) {
				const start = addDays(firstWeek, 7 * index);
				const end = addDays(start, 6);
				const rows = totals.filter((row) => row.day >= start && row.day <= end);
				const byAgent: Record<string, number> = {};
				for (const row of rows) byAgent[row.agentId] = (byAgent[row.agentId] ?? 0) + row.tokens;
				weeks.push({
					start,
					label: `Week of ${shortDay(start).split(" ").slice(1).join(" ")}`,
					tokens: rows.reduce((total, row) => total + row.tokens, 0),
					cost: rows.reduce((total, row) => total + row.costMicro, 0) / 1_000_000,
					byAgent: byAgent as UsageWeek["byAgent"],
				});
			}

			const perAgent: AgentUsage[] = agents.map((agent) => {
				const lifetime = store.lifetime(db, agent.id);
				const limit = store.getLimit(db, agent.id);
				const week = store.rangeCounters(db, agent.id, weekStart, today);
				const models: UsageModelRow[] = lifetime
					.map((entry) => ({
						model: entry.bucket === "tool" ? `tool:${entry.key}` : entry.key,
						...figures(entry.counters),
					}))
					.filter((row) => row.tokens > 0 || row.cost > 0);
				return {
					id: agent.id,
					name: agent.name,
					avatar: agent.avatar,
					week: figures(week),
					allTime: figures(sum(lifetime)),
					models,
					...(limit === undefined ? {} : { limit }),
					// The one rule of "has used its limit" is standing()'s: the page, the banner and the daily jobs agree on it.
					over: standing(agent.id)?.over === true,
				};
			});
			return { timezone: deps.timezone, weekStart, today, agents: perAgent, days, weeks, sampledAt };
		},
	};
}
