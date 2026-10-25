import type { AppDb } from "@assistant/db";
import {
	type BalanceItem,
	type BalancesCard,
	formatMoney,
	formatTenths,
	type SpendingCard,
	type SpendingGroup,
	type SpendingGroupBy,
	type TxnItem,
	type TxnListCard,
} from "@assistant/shared";
import * as files from "../files/store.ts";
import type { DayRange } from "../health/range.ts";
import { allocate, convertMinor } from "../money.ts";
import { dayText } from "../tool-support.ts";
import { monthName, weekStart } from "./range.ts";
import * as store from "./store.ts";

/**
 * What the ledger's tools say: a text for the model and a typed card for the thread, built from the same numbers in one
 * place so the two never disagree. Everything here reads the database and computes in integers; nothing writes.
 */

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

export const kindOf = (row: Pick<store.TxnView, "transferId" | "amountMinor">): TxnItem["kind"] =>
	row.transferId !== undefined ? "transfer" : row.amountMinor < 0 ? "expense" : "income";

/** The photo or file an entry was read from, when the index knows it: what a card shows as a chip. */
export function receiptOf(db: AppDb, row: Pick<store.TxnView, "sourceRef">): TxnItem["receipt"] | undefined {
	if (row.sourceRef === undefined || !row.sourceRef.startsWith("fi_")) return undefined;
	const file = files.getFile(db, row.sourceRef);
	return file === undefined ? undefined : { id: file.id, name: file.name, mime: file.mime };
}

export function txnItem(db: AppDb, row: store.TxnView, timezone: string): TxnItem {
	const receipt = receiptOf(db, row);
	return {
		id: row.id,
		date: row.date,
		dateText: dayText(row.date, timezone),
		amountMinor: row.amountMinor,
		currency: row.currency,
		account: row.account,
		kind: kindOf(row),
		...(row.category === undefined ? {} : { category: row.category }),
		...(row.merchant === "" ? {} : { merchant: row.merchant }),
		...(row.note === "" ? {} : { note: row.note }),
		...(receipt === undefined ? {} : { receipt }),
	};
}

/** One entry as the model reads it: the id it can pass back, the day in ISO form, the signed amount, what and where. */
export function describeTxn(row: store.TxnView): string {
	const what = row.transferId !== undefined ? "transfer" : (row.category ?? "uncategorized");
	return [
		row.id,
		row.date,
		formatMoney(row.amountMinor, row.currency),
		what,
		...(row.merchant === "" ? [] : [row.merchant]),
		row.account,
		...(row.note === "" ? [] : [`“${row.note}”`]),
	].join(" · ");
}

// ----- entry lists ---------------------------------------------------------------------------------------------------

function sumsText(sums: ReturnType<typeof store.sumsOf>): string {
	return sums
		.map((sum) => {
			const parts = [
				...(sum.outMinor > 0 ? [`out ${formatMoney(sum.outMinor, sum.currency)}`] : []),
				...(sum.inMinor > 0 ? [`in ${formatMoney(sum.inMinor, sum.currency)}`] : []),
			];
			return `${sum.currency}: ${parts.join(", ")}`;
		})
		.join("; ");
}

export function listReport(
	db: AppDb,
	timezone: string,
	filter: store.TxnFilter,
	heading: string,
	limit: number,
): { text: string; card: TxnListCard } {
	const { rows, total } = store.queryTxns(db, filter, { limit });
	const sums = store.sumsOf(db, filter);
	const moved = store.movedOf(db, filter);
	const card: TxnListCard = {
		type: "txn_list",
		heading,
		txns: rows.map((row) => txnItem(db, row, timezone)),
		total,
		sums,
	};
	if (rows.length === 0) return { text: `${heading}: no matching entries.`, card };
	const shown = rows.length < total ? ` (showing the newest ${rows.length} of ${total})` : "";
	const lines = [
		`${heading}: ${plural(total, "entry", "entries")}${shown}`,
		...rows.map((row) => `- ${describeTxn(row)}`),
	];
	if (sums.length > 0) lines.push(`Over all ${total}: ${sumsText(sums)}.`);
	if (moved.length > 0) {
		lines.push(
			`Moved between the owner's accounts, and not counted as spending or income: ${moved.map((entry) => formatMoney(entry.movedMinor, entry.currency)).join(", ")}.`,
		);
	}
	return { text: lines.join("\n"), card };
}

// ----- balances ------------------------------------------------------------------------------------------------------

export function balancesReport(
	db: AppDb,
	timezone: string,
	today: string,
	convertTo?: string,
): { text: string; card: BalancesCard } {
	const accounts = store.listAccounts(db);
	const items: BalanceItem[] = accounts.map((account) => {
		const balance = store.accountBalance(db, account.id);
		return {
			account: account.name,
			kind: account.kind,
			currency: account.currency,
			amountMinor: balance.amountMinor,
			basis: balance.snapshot === undefined ? "entries" : "snapshot",
			...(balance.snapshot === undefined ? {} : { asOfText: dayText(balance.snapshot.asOf, timezone) }),
			entriesSince: balance.entriesSince,
		};
	});
	const totals = [...new Set(items.map((item) => item.currency))].sort().map((currency) => ({
		currency,
		amountMinor: items.filter((item) => item.currency === currency).reduce((sum, item) => sum + item.amountMinor, 0),
	}));
	let converted: BalancesCard["converted"];
	if (convertTo !== undefined && totals.length > 0) {
		let amountMinor = 0;
		const missing: string[] = [];
		for (const total of totals) {
			if (total.currency === convertTo) {
				amountMinor += total.amountMinor;
				continue;
			}
			const rate = store.findRate(db, total.currency, convertTo, today);
			if (rate === undefined) missing.push(total.currency);
			else amountMinor += convertMinor(total.amountMinor, total.currency, convertTo, rate.rateMicro, rate.inverse);
		}
		converted = { currency: convertTo, amountMinor, missing };
	}
	const card: BalancesCard = {
		type: "balances",
		accounts: items,
		totals,
		...(converted === undefined ? {} : { converted }),
	};
	if (items.length === 0) {
		return {
			text: "No accounts yet. Create one with add_account (a name, its kind and, if the owner knows it, what it holds).",
			card,
		};
	}
	const lines = [`Balances (${plural(items.length, "account")}):`];
	for (const item of items) {
		const basis =
			item.basis === "snapshot"
				? `from the balance the owner stated on ${item.asOfText}${item.entriesSince === 0 ? "" : `, plus ${plural(item.entriesSince, "entry", "entries")} since`}`
				: `from entries only (${plural(item.entriesSince, "entry", "entries")}; no balance has been stated, so use set_balance when the owner tells you what it holds)`;
		lines.push(`- ${item.account} (${item.kind}): ${formatMoney(item.amountMinor, item.currency)} — ${basis}`);
	}
	for (const total of totals) lines.push(`Total ${total.currency}: ${formatMoney(total.amountMinor, total.currency)}`);
	if (converted !== undefined) {
		lines.push(
			`All in ${converted.currency}: ${formatMoney(converted.amountMinor, converted.currency)}` +
				(converted.missing.length === 0
					? " (at the rates the owner gave)."
					: `; not included: ${converted.missing.join(", ")} (no rate given: set_fx_rate).`),
		);
	}
	return { text: lines.join("\n"), card };
}

// ----- spending ------------------------------------------------------------------------------------------------------

export type SpendingOptions = {
	range: DayRange;
	groupBy: SpendingGroupBy;
	/** The currency of the groups. Entries in others are listed apart, or converted when `convert` is set. */
	currency: string;
	convert: boolean;
	accountId?: number;
	categoryId?: number;
	/** The most groups of a chart that is ordered by size; the rest is one group, "Other". */
	limit: number;
};

const MAX_CHRONOLOGICAL_GROUPS = 60;

type Group = { key: string; label: string; amountMinor: number; count: number; labels: Map<string, number> };

function groupKey(row: store.TxnView, groupBy: SpendingGroupBy): { key: string; label: string } {
	switch (groupBy) {
		case "category": {
			const label = row.category ?? "uncategorized";
			return { key: label, label };
		}
		case "merchant":
			return {
				key: row.merchantKey === "" ? "(no merchant)" : row.merchantKey,
				label: row.merchant === "" ? "(no merchant)" : row.merchant,
			};
		case "account":
			return { key: row.account, label: row.account };
		case "week": {
			const start = weekStart(row.date);
			return { key: start, label: `Week of ${start}` };
		}
		case "month":
			return { key: row.date.slice(0, 7), label: monthName(row.date) };
	}
}

/** Where the money went: expenses (out, not transfers) over a range, grouped, in integers, with shares that add up to 100.0 %. */
export function spendingReport(
	db: AppDb,
	timezone: string,
	options: SpendingOptions,
): { text: string; card: SpendingCard } {
	const { range, groupBy, currency } = options;
	const filter: store.TxnFilter = {
		...(range.from === undefined ? {} : { from: range.from }),
		to: range.to,
		kind: "expense",
		...(options.accountId === undefined ? {} : { accountId: options.accountId }),
		...(options.categoryId === undefined ? {} : { categoryId: options.categoryId }),
	};
	const groups = new Map<string, Group>();
	const others = new Map<string, { totalMinor: number; count: number }>();
	let totalMinor = 0;
	let count = 0;
	for (const row of store.allTxns(db, filter)) {
		let spent = -row.amountMinor;
		if (row.currency !== currency) {
			const rate = options.convert ? store.findRate(db, row.currency, currency, row.date) : undefined;
			if (rate === undefined) {
				const other = others.get(row.currency) ?? { totalMinor: 0, count: 0 };
				other.totalMinor += spent;
				other.count += 1;
				others.set(row.currency, other);
				continue;
			}
			spent = convertMinor(spent, row.currency, currency, rate.rateMicro, rate.inverse);
		}
		const { key, label } = groupKey(row, groupBy);
		const group = groups.get(key) ?? { key, label, amountMinor: 0, count: 0, labels: new Map() };
		group.amountMinor += spent;
		group.count += 1;
		group.labels.set(label, (group.labels.get(label) ?? 0) + 1);
		groups.set(key, group);
		totalMinor += spent;
		count += 1;
	}

	const chronological = groupBy === "week" || groupBy === "month";
	let ordered = [...groups.values()].map((group) => ({
		...group,
		// The most used spelling of a merchant stands for the group.
		label: [...group.labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? group.label,
	}));
	if (chronological) {
		ordered.sort((a, b) => (a.key < b.key ? -1 : 1));
		if (ordered.length > MAX_CHRONOLOGICAL_GROUPS) {
			throw new Error(`${ordered.length} ${groupBy}s are too many to show. Use group_by month, or a shorter range.`);
		}
	} else {
		ordered.sort((a, b) => b.amountMinor - a.amountMinor || (a.label < b.label ? -1 : 1));
		if (ordered.length > options.limit) {
			const rest = ordered.slice(options.limit);
			ordered = [
				...ordered.slice(0, options.limit),
				{
					key: "(other)",
					label: `Other (${rest.length})`,
					amountMinor: rest.reduce((sum, group) => sum + group.amountMinor, 0),
					count: rest.reduce((sum, group) => sum + group.count, 0),
					labels: new Map(),
				},
			];
		}
	}
	const tenths =
		ordered.length > 0 && totalMinor > 0
			? allocate(
					1000,
					ordered.map((group) => group.amountMinor),
				)
			: [];
	const spendingGroups: SpendingGroup[] = ordered.map((group, index) => ({
		label:
			chronological && groupBy === "week"
				? `Week of ${dayText(group.key, timezone).replace(/^\w+ /, "")}`
				: group.label,
		amountMinor: group.amountMinor,
		count: group.count,
		tenths: tenths[index] ?? 0,
	}));
	const income = store.sumsOf(db, { ...filter, kind: "income" }).find((sum) => sum.currency === currency)?.inMinor ?? 0;
	const otherSpending = [...others.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([other, sum]) => ({ currency: other, totalMinor: sum.totalMinor, count: sum.count }));
	const heading = `Spending by ${groupBy}`;
	const card: SpendingCard = {
		type: "spending",
		heading,
		rangeText: range.label,
		groupBy,
		currency,
		totalMinor,
		count,
		incomeMinor: income,
		groups: spendingGroups,
		others: otherSpending,
	};

	if (count === 0 && otherSpending.length === 0) {
		return { text: `No spending in ${currency} ${range.label}.`, card };
	}
	const lines = [
		`Spending ${range.label}, by ${groupBy}: ${formatMoney(totalMinor, currency)} in ${plural(count, "entry", "entries")}.`,
		...spendingGroups.map(
			(group) =>
				`- ${group.label}: ${formatMoney(group.amountMinor, currency)} (${formatTenths(group.tenths)}, ${plural(group.count, "entry", "entries")})`,
		),
	];
	for (const other of otherSpending) {
		lines.push(
			`Also spent in ${other.currency}: ${formatMoney(other.totalMinor, other.currency)} in ${plural(other.count, "entry", "entries")}, not included above` +
				(options.convert
					? " (no rate between the two: set_fx_rate)."
					: " (pass convert_to to include it, once there is a rate)."),
		);
	}
	if (income > 0) lines.push(`Received over the same days (not counting transfers): ${formatMoney(income, currency)}.`);
	return { text: lines.join("\n"), card };
}

/** The biggest categories of a month in one currency, for the prompt section and the daily facts: `[label, minor, count]`. */
export function topCategories(
	db: AppDb,
	range: { from: string; to: string },
	currency: string,
	limit: number,
): { totalMinor: number; count: number; top: Array<{ label: string; amountMinor: number }> } {
	const byCategory = new Map<string, number>();
	let totalMinor = 0;
	let count = 0;
	for (const row of store.allTxns(db, { from: range.from, to: range.to, kind: "expense", currency })) {
		const label = row.category ?? "uncategorized";
		byCategory.set(label, (byCategory.get(label) ?? 0) - row.amountMinor);
		totalMinor -= row.amountMinor;
		count += 1;
	}
	const top = [...byCategory.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.slice(0, limit)
		.map(([label, amountMinor]) => ({ label, amountMinor }));
	return { totalMinor, count, top };
}
