import { formatMoney } from "@assistant/shared";
import { type DailyFactsProvider, sectionOf } from "../daily/facts.ts";
import type { DomainDeps } from "../module.ts";
import * as store from "./store.ts";

type Deps = Pick<DomainDeps, "db" | "accountant">;

const plural = (count: number): string => `${count} ${count === 1 ? "entry" : "entries"}`;

/** Totals of expenses by currency, in code, as `[currency, minor, count]`, the owner's currency first. */
function totalsByCurrency(
	rows: readonly store.TxnView[],
	first: string,
): Array<{ currency: string; minor: number; count: number }> {
	const totals = new Map<string, { minor: number; count: number }>();
	for (const row of rows) {
		const total = totals.get(row.currency) ?? { minor: 0, count: 0 };
		total.minor -= row.amountMinor;
		total.count += 1;
		totals.set(row.currency, total);
	}
	return [...totals.entries()]
		.map(([currency, total]) => ({ currency, ...total }))
		.sort((a, b) => (a.currency === first ? -1 : b.currency === first ? 1 : a.currency < b.currency ? -1 : 1));
}

/**
 * What the ledger can say for the evening wrap-up: what was spent on the day, by category, and what came in; and what was
 * added today for other days (a forgotten lunch of yesterday). Entries a CSV import added are not "added today": a month of
 * statement rows would drown the day. The briefing gets nothing from the ledger.
 */
export function createLedgerFacts(deps: Deps): DailyFactsProvider {
	const { db } = deps;
	const currency = deps.accountant?.currency ?? "BTN";
	return {
		id: "ledger",
		wrapup: (day) => {
			const lines: string[] = [];
			const spentToday = store.allTxns(db, { from: day.date, to: day.date, kind: "expense" });
			for (const total of totalsByCurrency(spentToday, currency)) {
				const byCategory = new Map<string, number>();
				for (const row of spentToday.filter((entry) => entry.currency === total.currency)) {
					const label = row.category ?? "uncategorized";
					byCategory.set(label, (byCategory.get(label) ?? 0) - row.amountMinor);
				}
				const top = [...byCategory.entries()]
					.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
					.slice(0, 3)
					.map(([label, minor]) => `${label} ${formatMoney(minor, total.currency)}`);
				lines.push(
					`Spent today: ${formatMoney(total.minor, total.currency)} in ${plural(total.count)} (${top.join(", ")})`,
				);
			}
			for (const sum of store.sumsOf(db, { from: day.date, to: day.date, kind: "income" })) {
				lines.push(`Received today: ${formatMoney(sum.inMinor, sum.currency)}`);
			}
			const elsewhere = store
				.allTxns(db, { createdFrom: day.startMs, createdTo: day.endMs, kind: "expense" })
				.filter((row) => row.date !== day.date && row.source !== "csv");
			for (const total of totalsByCurrency(elsewhere, currency)) {
				lines.push(
					`Also added today for other days: ${formatMoney(total.minor, total.currency)} in ${plural(total.count)}`,
				);
			}
			return sectionOf("Spending today", lines);
		},
	};
}
