import { formatMoney } from "@assistant/shared";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { localDate } from "../time.ts";
import { createLedgerFacts } from "./facts.ts";
import { createImportApprovalActions, createImportTools } from "./import-tools.ts";
import { ledgerMigrations } from "./migrations.ts";
import { createQueryTools } from "./query.ts";
import { monthName } from "./range.ts";
import { topCategories } from "./reports.ts";
import * as store from "./store.ts";
import { createLedgerApprovalActions, createLedgerTools } from "./tools.ts";

export const LEDGER_EXTENSION_NAME = "ledger";

/** How many accounts the prompt section lists; a ledger with more is a business, and the rest is one line. */
const ACCOUNTS_LISTED = 8;
const TOP_CATEGORIES = 3;

/**
 * The prompt section: what each account holds, the categories there are, and this month's spending with its three biggest
 * categories. It has no clock in the sense of a time that moves: the month is read from the Harness clock and written as
 * its name, so it renders the same bytes all month until an entry or an account changes (as the `people` section does for
 * the day), and a changed section costs one system-prompt entry, not a cache miss on every request.
 */
export function renderLedgerSection(deps: Pick<DomainDeps, "db" | "now" | "timezone" | "accountant">): string {
	const { db } = deps;
	const currency = deps.accountant?.currency ?? "BTN";
	const lines: string[] = [];

	const accounts = store.listAccounts(db);
	if (accounts.length === 0) lines.push("No accounts yet: ask the owner where their money is, then add_account.");
	else {
		const shown = accounts
			.slice(0, ACCOUNTS_LISTED)
			.map(
				(account) =>
					`${account.name} (${account.kind}) ${formatMoney(store.accountBalance(db, account.id).amountMinor, account.currency)}`,
			);
		lines.push(
			`Accounts: ${shown.join("; ")}${accounts.length > ACCOUNTS_LISTED ? `; and ${accounts.length - ACCOUNTS_LISTED} more` : ""}.`,
		);
	}

	const categories = store.listCategories(db);
	for (const kind of ["expense", "income"] as const) {
		lines.push(
			`Categories of ${kind}: ${categories
				.filter((category) => category.kind === kind)
				.map((category) => category.name)
				.join(", ")}.`,
		);
	}

	const today = localDate(deps.now(), deps.timezone);
	const month = topCategories(db, { from: `${today.slice(0, 7)}-01`, to: today }, currency, TOP_CATEGORIES);
	lines.push(
		month.count === 0
			? `Nothing spent in ${monthName(today)} yet.`
			: `Spending in ${monthName(today)} so far: ${formatMoney(month.totalMinor, currency)} in ${month.count} ${month.count === 1 ? "entry" : "entries"}; the biggest: ${month.top.map((entry) => `${entry.label} ${formatMoney(entry.amountMinor, currency)}`).join(", ")}.`,
	);
	return lines.join("\n");
}

export const ledgerModule: DomainModule = {
	name: "ledger",
	migrations: ledgerMigrations,
	extension: (deps) =>
		defineExtension({
			name: LEDGER_EXTENSION_NAME,
			tools: [...createLedgerTools(deps), ...createImportTools(deps), ...createQueryTools(deps)],
			sections: [section("ledger", () => renderLedgerSection(deps))],
		}),
	actions: (deps) => [...createLedgerApprovalActions(deps), ...createImportApprovalActions(deps)],
	facts: (deps) => [createLedgerFacts(deps)],
};

export { decodeCsv, detectDelimiter, parseCsv, parseDateCell } from "./csv.ts";
export { merchantKey, nameKey } from "./keys.ts";
export { SEED_EXPENSE_CATEGORIES, SEED_INCOME_CATEGORIES } from "./migrations.ts";
export { monthName, resolveSpendRange } from "./range.ts";
export { fingerprints, normalizeRows, proposeMapping, resolveMapping } from "./statement.ts";
export * as ledgerStore from "./store.ts";
