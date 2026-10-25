import { allocate, percentOf } from "../money.ts";

/**
 * How a bill is shared (PLAN rule 7: arithmetic is code). Everything here is integer minor units and BigInt; the
 * shares of a bill always add up to its total exactly, however the rounding falls.
 */

export type BillItem = {
	description: string;
	/** Above zero. A discount is an extra with a negative amount. */
	amountMinor: number;
	/** Person keys. Each of them has an equal part of the item. */
	sharedBy: readonly string[];
};

/** A charge or a discount on top of the items: tax, service, a tip. Exactly one of the two is set. */
export type BillExtra = {
	label: string;
	/** As printed on the bill, signed. */
	amountMinor?: number;
	/** Of the items' total, in basis points, signed (a discount is negative). Not compounded with the other extras. */
	basisPoints?: number;
};

export type Share = { key: string; itemsMinor: number; extrasMinor: number; owedMinor: number };

export type SplitResult = {
	itemsMinor: number;
	/** Each extra with its amount in minor units (a percentage turned into an amount). */
	extras: Array<{ label: string; amountMinor: number }>;
	extrasMinor: number;
	totalMinor: number;
	/** In the order of the people that were given. */
	shares: Share[];
};

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const lcm = (a: bigint, b: bigint): bigint => (a / gcd(a, b)) * b;

/**
 * Share a bill that has items. Each item is shared equally by those who had it; a person's claim on the items is the sum of
 * their parts as an exact fraction, and rounding happens once per person (largest remainder), not once per item, so three
 * items of 1.00 shared by three people give each exactly 1.00 and a single 1.00 shared by three gives 0.34, 0.33, 0.33.
 * The extras are then shared in proportion to what each person's items came to, again by largest remainder.
 * Ties go to the earlier person in `keys`.
 */
export function splitItems(
	keys: readonly string[],
	items: readonly BillItem[],
	extras: readonly BillExtra[],
): SplitResult {
	if (keys.length === 0) throw new Error("A bill needs at least one person to share it.");
	if (items.length === 0) throw new Error("splitItems needs items; use splitEqually for a bill without them.");
	const index = new Map(keys.map((key, position) => [key, position]));
	const itemsMinor = items.reduce((sum, item) => sum + item.amountMinor, 0);

	const common = items.reduce((value, item) => lcm(value, BigInt(Math.max(1, item.sharedBy.length))), 1n);
	const claims: bigint[] = keys.map(() => 0n);
	for (const item of items) {
		if (item.sharedBy.length === 0) throw new Error(`Nobody shares '${item.description}'.`);
		const part = BigInt(item.amountMinor) * (common / BigInt(item.sharedBy.length));
		for (const key of item.sharedBy) {
			const position = index.get(key);
			if (position === undefined)
				throw new Error(`'${key}' shares '${item.description}' but is not one of the people.`);
			claims[position] = (claims[position] ?? 0n) + part;
		}
	}
	const itemShares = allocate(itemsMinor, claims);

	const resolved = extras.map((extra) => ({
		label: extra.label,
		amountMinor: extra.amountMinor ?? percentOf(itemsMinor, extra.basisPoints ?? 0),
	}));
	const extrasMinor = resolved.reduce((sum, extra) => sum + extra.amountMinor, 0);
	const totalMinor = itemsMinor + extrasMinor;
	if (totalMinor <= 0) {
		throw new Error(
			`The items come to ${itemsMinor} and the extras to ${extrasMinor}: the bill would not be above zero.`,
		);
	}
	const extraShares = extrasMinor === 0 ? keys.map(() => 0) : allocate(extrasMinor, itemShares);
	return {
		itemsMinor,
		extras: resolved,
		extrasMinor,
		totalMinor,
		shares: keys.map((key, position) => {
			const own = itemShares[position] ?? 0;
			const extra = extraShares[position] ?? 0;
			return { key, itemsMinor: own, extrasMinor: extra, owedMinor: own + extra };
		}),
	};
}

/** Share a total equally. The units that do not divide go one each to the first people. */
export function splitEqually(keys: readonly string[], totalMinor: number): SplitResult {
	if (keys.length === 0) throw new Error("A bill needs at least one person to share it.");
	if (totalMinor <= 0) throw new Error("The total must be above zero.");
	const parts = allocate(
		totalMinor,
		keys.map(() => 1),
	);
	return {
		itemsMinor: totalMinor,
		extras: [],
		extrasMinor: 0,
		totalMinor,
		shares: keys.map((key, position) => ({
			key,
			itemsMinor: parts[position] ?? 0,
			extrasMinor: 0,
			owedMinor: parts[position] ?? 0,
		})),
	};
}

/** One open balance between two people in one currency: `debtor` owes `creditor`. */
export type Entry = { from: string; to: string; amountMinor: number; currency: string };

/**
 * Net what people owe each other, per pair of people and currency (nothing is converted between currencies). Each entry is
 * "`from` owes `to` this much"; a settlement is an entry with a negative amount (`from` paid `to`, so owes less). Opposite
 * debts cancel: "A owes B 300" and "B owes A 100" is "A owes B 200". Pairs that cancel exactly are left out.
 */
export function netEntries(
	entries: readonly Entry[],
): Array<{ debtor: string; creditor: string; amountMinor: number; currency: string }> {
	const nets = new Map<string, { a: string; b: string; currency: string; net: number }>();
	for (const entry of entries) {
		if (entry.from === entry.to || entry.amountMinor === 0) continue;
		const [a, b] = entry.from < entry.to ? [entry.from, entry.to] : [entry.to, entry.from];
		const slot = `${entry.currency}\u0000${a}\u0000${b}`;
		const found = nets.get(slot) ?? { a, b, currency: entry.currency, net: 0 };
		// Positive: a owes b.
		found.net += entry.from === a ? entry.amountMinor : -entry.amountMinor;
		nets.set(slot, found);
	}
	return [...nets.values()]
		.filter((pair) => pair.net !== 0)
		.map((pair) =>
			pair.net > 0
				? { debtor: pair.a, creditor: pair.b, amountMinor: pair.net, currency: pair.currency }
				: { debtor: pair.b, creditor: pair.a, amountMinor: -pair.net, currency: pair.currency },
		);
}
