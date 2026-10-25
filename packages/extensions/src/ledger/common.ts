import { formatMoney } from "@assistant/shared";
import * as files from "../files/store.ts";
import type { DomainDeps } from "../module.ts";
import { toMinor } from "../money.ts";
import { addDays, parseWhen } from "../time.ts";
import { nameKey } from "./keys.ts";
import * as store from "./store.ts";

export type LedgerDeps = Pick<DomainDeps, "db" | "timezone" | "approvals" | "accountant">;

/** What an amount is in when nobody says: the owner's currency (`ASSISTANT_CURRENCY`), the Ngultrum by default. */
export const defaultCurrencyOf = (deps: Pick<DomainDeps, "accountant">): string => deps.accountant?.currency ?? "BTN";

export const DAY_HELP = "The local day, YYYY-MM-DD, or today / yesterday. Never in the future. Default today.";

/** A currency as the model may write it ("usd") to the ISO code the ledger stores. */
export function currencyCode(value: string, name = "currency"): string {
	const code = value.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(code))
		throw new Error(`${name} must be a three-letter code such as BTN, USD or INR; got '${value.slice(0, 20)}'.`);
	return code;
}

/** The pieces of resolving what a tool call names (a day, an account, a category) against the ledger, with errors that say what to send instead. */
export function createResolvers(deps: LedgerDeps) {
	const { db, timezone } = deps;

	/** The local day a call is about. Words and dates are accepted; a day that has not happened yet is not. */
	function resolveDay(value: string | undefined, today: string, name = "date"): string {
		if (value === undefined) return today;
		const word = value.trim().toLowerCase();
		if (word === "today") return today;
		if (word === "yesterday") return addDays(today, -1);
		const parsed = parseWhen(value, timezone);
		if (!parsed.ok || !parsed.dateOnly || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
			throw new Error(
				`${name} must be a day written YYYY-MM-DD, or today or yesterday; got '${value.slice(0, 40)}'. Call current_time if you need today's date.`,
			);
		}
		const day = value.trim();
		if (day > today) throw new Error(`${name} ${day} is in the future; today is ${today}.`);
		if (day < "2000-01-01") throw new Error(`${name} ${day} is too long ago to be right. Check the year.`);
		return day;
	}

	const accountList = (accounts: readonly store.AccountRow[]): string =>
		accounts.map((account) => `${account.name} (${account.kind}, ${account.currency})`).join("; ");

	/**
	 * The account a call names: its name or part of it ("bob" for "BoB savings"). Without a name, the one account the owner has,
	 * or the one in the currency asked for, or the only one in the owner's currency; anything else is a question for the owner.
	 */
	function resolveAccount(typed: string | undefined, currency?: string): store.AccountRow {
		const accounts = store.listAccounts(db);
		if (accounts.length === 0) {
			throw new Error(
				"There are no accounts yet. Ask the owner where the money is (cash, a bank account, a wallet, a card), then create it with add_account, for example name 'Cash' kind cash.",
			);
		}
		if (typed !== undefined && typed.trim() !== "") {
			const key = nameKey(typed);
			const exact = accounts.find((account) => account.key === key);
			if (exact !== undefined) return exact;
			const partial = accounts.filter(
				(account) => key !== "" && (account.key.includes(key) || key.includes(account.key)),
			);
			if (partial.length === 1) return partial[0] as store.AccountRow;
			if (partial.length > 1) {
				throw new Error(
					`'${typed.slice(0, 40)}' could mean several accounts: ${accountList(partial)}. Use the full name.`,
				);
			}
			const archived = store.listAccounts(db, true).find((account) => account.archived && account.key === key);
			throw new Error(
				archived === undefined
					? `No account called '${typed.slice(0, 40)}'. Accounts: ${accountList(accounts)}. Create a new one with add_account.`
					: `The account '${archived.name}' is archived. Restore it with archive_account (restore: true) first.`,
			);
		}
		if (currency !== undefined) {
			const matching = accounts.filter((account) => account.currency === currency);
			if (matching.length === 1) return matching[0] as store.AccountRow;
			if (matching.length === 0) {
				throw new Error(
					`There is no ${currency} account. Accounts: ${accountList(accounts)}. If the owner holds ${currency} somewhere, create that account with add_account; if the amount was charged to an account in another currency, give the amount in that currency.`,
				);
			}
			throw new Error(`Which ${currency} account? ${accountList(matching)}. Pass account.`);
		}
		if (accounts.length === 1) return accounts[0] as store.AccountRow;
		const usual = accounts.filter((account) => account.currency === defaultCurrencyOf(deps));
		if (usual.length === 1) return usual[0] as store.AccountRow;
		throw new Error(`Which account? ${accountList(accounts)}. Ask the owner if they did not say, then pass account.`);
	}

	/** The category a call names, of the kind it needs. */
	function resolveCategory(typed: string, kind: "expense" | "income"): store.CategoryRow {
		const categories = store.listCategories(db);
		const key = nameKey(typed);
		const same = categories.filter((category) => category.kind === kind);
		const found =
			same.find((category) => category.key === key) ??
			(() => {
				const partial = same.filter(
					(category) => key !== "" && (category.key.includes(key) || key.includes(category.key)),
				);
				return partial.length === 1 ? partial[0] : undefined;
			})();
		if (found !== undefined) return found;
		const other = categories.find((category) => category.kind !== kind && category.key === key);
		throw new Error(
			other === undefined
				? `No ${kind} category called '${typed.slice(0, 40)}'. The ${kind} categories are: ${same.map((category) => category.name).join(", ")}. Pick one of them, or create a new one with add_category.`
				: `'${other.name}' is an ${other.kind} category, and this is ${kind === "expense" ? "an expense" : "income"}. The ${kind} categories are: ${same.map((category) => category.name).join(", ")}.`,
		);
	}

	/** An amount to minor units in the currency of `currency`; it must be above zero (the tool knows which way the money went). */
	function amountOf(value: number, currency: string, name = "amount"): number {
		const minor = toMinor(value, currency, name);
		if (minor <= 0) {
			throw new Error(
				`${name} must be above zero. Give the amount as a positive number: add_expense and add_income know which way the money went.`,
			);
		}
		return minor;
	}

	/** A receipt or bill the call points at: the file must be one the assistant knows. Returns its id. */
	function receiptId(value: string | undefined): string | undefined {
		if (value === undefined) return undefined;
		const id = value.trim();
		if (files.getFile(db, id) === undefined) {
			throw new Error(
				`No file '${id.slice(0, 30)}'. The file id (fi_...) is in the message that carried the photo; search_files finds others.`,
			);
		}
		return id;
	}

	/** "BoB savings now holds Nu. 11,550.00", the account after a change: how a balance moves is part of the answer. */
	function balanceLine(account: store.AccountRow): string {
		const balance = store.accountBalance(db, account.id);
		return `${account.name} now holds ${formatMoney(balance.amountMinor, account.currency)}${balance.snapshot === undefined ? " by the entries alone (no balance was ever stated)" : ""}.`;
	}

	return { resolveDay, resolveAccount, resolveCategory, amountOf, receiptId, balanceLine, accountList };
}
