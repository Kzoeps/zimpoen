import { type DebtItem, formatMoney, type SplitCard, type WhoOwesCard } from "@assistant/shared";
import { dayText } from "../tool-support.ts";
import { type BillView, type Debt, OWNER_KEY, type SettlementRow } from "./store.ts";

/** "Pema owes you Nu. 500.00", "You owe Pema Nu. 500.00", "Pema owes Tashi Nu. 500.00": the owner is spoken to, not about. */
export function oweText(
	debtor: { key: string; name: string },
	creditor: { key: string; name: string },
	amountMinor: number,
	currency: string,
): string {
	const amount = formatMoney(amountMinor, currency);
	if (debtor.key === OWNER_KEY) return `You owe ${creditor.name} ${amount}`;
	if (creditor.key === OWNER_KEY) return `${debtor.name} owes you ${amount}`;
	return `${debtor.name} owes ${creditor.name} ${amount}`;
}

export const debtText = (debt: Debt): string =>
	oweText(
		{ key: debt.debtorKey, name: debt.debtorName },
		{ key: debt.creditorKey, name: debt.creditorName },
		debt.amountMinor,
		debt.currency,
	);

export function whoOwesCard(heading: string, debts: readonly Debt[]): WhoOwesCard {
	return {
		type: "who_owes",
		heading,
		debts: debts.map(
			(debt): DebtItem => ({
				debtor: debt.debtorName,
				creditor: debt.creditorName,
				amountMinor: debt.amountMinor,
				currency: debt.currency,
			}),
		),
	};
}

export function billCard(bill: BillView, timezone: string): SplitCard {
	return {
		type: "split",
		billId: bill.id,
		title: bill.title,
		dateText: dayText(bill.date, timezone),
		payer: bill.payerName,
		currency: bill.currency,
		totalMinor: bill.totalMinor,
		items: bill.items.map((item) => ({
			description: item.description,
			amountMinor: item.amountMinor,
			sharedBy: item.sharedBy,
		})),
		extras: bill.extras,
		shares: bill.shares.map((share) => ({
			person: share.personName,
			itemsMinor: share.itemsMinor,
			extrasMinor: share.extrasMinor,
			owedMinor: share.owedMinor,
			paid: share.personKey === bill.payerKey,
		})),
		equal: bill.equal,
	};
}

/**
 * What the model reads after a bill was split: every share (so it can say them back), who owes the payer what, and what
 * the owner's own share is. The bill is read back from storage, so a replayed call says the same words as the first one.
 */
export function billText(bill: BillView, timezone: string, notes: readonly string[]): string {
	const money = (minor: number): string => formatMoney(minor, bill.currency);
	const payer = { key: bill.payerKey, name: bill.payerName };
	const lines = [
		`${bill.title} (${bill.id}), ${dayText(bill.date, timezone)}: total ${money(bill.totalMinor)}, paid by ${bill.payerName}${bill.equal ? ", shared equally" : ""}.`,
	];
	if (bill.items.length > 0) {
		lines.push(
			`Items ${money(bill.items.reduce((sum, item) => sum + item.amountMinor, 0))}${bill.extras.map((extra) => `; ${extra.label} ${money(extra.amountMinor)}`).join("")}.`,
		);
	}
	lines.push(
		`Shares: ${bill.shares
			.map(
				(share) =>
					`${share.personName} ${money(share.owedMinor)}${bill.extras.length > 0 ? ` (items ${money(share.itemsMinor)} + extras ${money(share.extrasMinor)})` : ""}`,
			)
			.join("; ")}. They add up to ${money(bill.shares.reduce((sum, share) => sum + share.owedMinor, 0))}.`,
	);
	const owing = bill.shares.filter((share) => share.personKey !== bill.payerKey && share.owedMinor > 0);
	if (owing.length > 0) {
		lines.push(
			`${owing
				.map((share) =>
					oweText({ key: share.personKey, name: share.personName }, payer, share.owedMinor, bill.currency),
				)
				.join("; ")}.`,
		);
	}
	const paidOwn = bill.shares.find((share) => share.personKey === bill.payerKey);
	if (paidOwn !== undefined) {
		const whose = bill.payerKey === OWNER_KEY ? "Your" : `${bill.payerName}'s`;
		lines.push(`${whose} own share, ${money(paidOwn.owedMinor)}, is not a debt.`);
	} else {
		lines.push(
			`${bill.payerName} paid but is not among the people who shared it, so has no share. If they had a share too, delete this bill (propose_delete_split) and enter it again with them in people.`,
		);
	}
	const mine = bill.shares.find((share) => share.personKey === OWNER_KEY);
	if (mine !== undefined) {
		lines.push(
			`Your share: ${money(mine.owedMinor)}. It is not added to your expenses: use add_expense if the owner wants it recorded there.`,
		);
	}
	lines.push(...notes);
	return lines.join("\n");
}

export function settlementLine(row: SettlementRow): string {
	return `${row.fromName === "You" ? "You paid" : `${row.fromName} paid`} ${row.toKey === OWNER_KEY ? "you" : row.toName} ${formatMoney(row.amountMinor, row.currency)}`;
}
