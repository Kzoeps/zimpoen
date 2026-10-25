import { defineExtension, section } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { splitsMigrations } from "./migrations.ts";
import { debtText } from "./reports.ts";
import * as store from "./store.ts";
import { createSplitApprovalActions, createSplitTools } from "./tools.ts";

export const SPLITS_EXTENSION_NAME = "splits";

/** How many open balances the prompt section names; the rest is a count. */
const BALANCES_LISTED = 5;

/**
 * The prompt section: how many balances between people are open (netted per pair, so bills are not settled one by one)
 * and the first few, with the owner's first. It has no clock, so it renders the same bytes until a bill or a payment is
 * written. It names no totals: the model reads sums from `who_owes`, never adds them.
 */
export function renderSplitsSection(deps: Pick<DomainDeps, "db">): string {
	const debts = store.openBalances(deps.db);
	if (debts.length === 0) {
		return store.knownPeople(deps.db).size === 0
			? "No bill has been split yet."
			: "No open balances: every bill is settled.";
	}
	const lines = [`Open balances between people: ${debts.length}.`];
	for (const debt of debts.slice(0, BALANCES_LISTED)) lines.push(`- ${debtText(debt)}`);
	if (debts.length > BALANCES_LISTED) lines.push(`- and ${debts.length - BALANCES_LISTED} more (who_owes lists them)`);
	return lines.join("\n");
}

export const splitsModule: DomainModule = {
	name: "splits",
	migrations: splitsMigrations,
	extension: (deps) =>
		defineExtension({
			name: SPLITS_EXTENSION_NAME,
			tools: createSplitTools(deps),
			sections: [section("splits", () => renderSplitsSection(deps))],
		}),
	actions: (deps) => createSplitApprovalActions(deps),
};

export { type BillExtra, type BillItem, netEntries, type SplitResult, splitEqually, splitItems } from "./compute.ts";
export * as splitsStore from "./store.ts";
