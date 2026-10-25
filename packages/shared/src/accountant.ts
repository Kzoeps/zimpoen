/**
 * The Accountant agent's cards: what its tool results carry in `details` so the thread can draw them. Plain JSON of
 * integers (minor units), dates and text; the web app formats amounts with `formatMoney`, the same way the tools' text does.
 */

export type AccountKind = "cash" | "bank" | "wallet" | "card";

export const ACCOUNT_KINDS: readonly AccountKind[] = ["cash", "bank", "wallet", "card"];

/** One entry of the ledger as a card shows it. `amountMinor` is signed: money out is negative. */
export type TxnItem = {
	id: string;
	/** The local day, `2026-10-25`, and the same day for people: `Sun 25 Oct 2026`. */
	date: string;
	dateText: string;
	amountMinor: number;
	currency: string;
	account: string;
	kind: "expense" | "income" | "transfer";
	category?: string;
	merchant?: string;
	note?: string;
	/** The photo or file the entry was read from: the card shows it as a chip that opens it. */
	receipt?: { id: string; name: string; mime: string };
};

/** One entry after `add_expense` or `add_income`, or the two legs of `add_transfer`. */
export type TxnCard = {
	type: "txn";
	txns: TxnItem[];
	/** An entry like this one (same day, amount, account and merchant) was already there: its id. */
	similarTo?: string;
};

/** The answer to `list_txns`. `total` counts every match; `sums` add up every match, not only the ones shown. */
export type TxnListCard = {
	type: "txn_list";
	heading: string;
	txns: TxnItem[];
	total: number;
	sums: Array<{ currency: string; outMinor: number; inMinor: number }>;
};

export type BalanceItem = {
	account: string;
	kind: AccountKind;
	currency: string;
	amountMinor: number;
	/** `snapshot`: the last balance the owner stated plus what was recorded since; `entries`: no balance stated, only entries. */
	basis: "snapshot" | "entries";
	asOfText?: string;
	entriesSince: number;
};

/** The answer to `balances`. */
export type BalancesCard = {
	type: "balances";
	accounts: BalanceItem[];
	totals: Array<{ currency: string; amountMinor: number }>;
	/** Everything in one currency, from the rates the owner gave. `missing` lists currencies that had none and are left out. */
	converted?: { currency: string; amountMinor: number; missing: string[] };
};

export type SpendingGroup = {
	label: string;
	amountMinor: number;
	count: number;
	/** The group's share of the total, in tenths of a percent (whole numbers: computed in code, never by the model). */
	tenths: number;
};

export type SpendingGroupBy = "category" | "merchant" | "account" | "week" | "month";

/** The answer to `spending_summary`: where the money went in a range, as bars. */
export type SpendingCard = {
	type: "spending";
	heading: string;
	rangeText: string;
	groupBy: SpendingGroupBy;
	currency: string;
	totalMinor: number;
	count: number;
	/** What came in over the same days (not transfers), same currency. */
	incomeMinor: number;
	/** Largest first. A long tail is one group called "Other". `week` and `month` are in date order instead. */
	groups: SpendingGroup[];
	/** Spending in other currencies that was not converted. */
	others: Array<{ currency: string; totalMinor: number; count: number }>;
};

export type ImportColumnRole =
	| "date"
	| "description"
	| "amount"
	| "debit"
	| "credit"
	| "direction"
	| "balance"
	| "category"
	| "currency"
	| "ignored";

/** A statement row that probably repeats an entry the owner typed in chat or read from a receipt. */
export type ImportMatch = {
	/** The file's line, as `confirm_import`'s `include_lines` takes it. */
	line: number;
	dateText: string;
	amountMinor: number;
	description: string;
	/** The entry it probably repeats. */
	entry: { id: string; dateText: string; merchant: string; source: "chat" | "receipt" };
};

/** What `import_csv` found in a file and would import: nothing is written until `confirm_import`. */
export type ImportPreviewCard = {
	type: "import_preview";
	importId: string;
	fileName: string;
	account: string;
	currency: string;
	encoding: string;
	delimiter: string;
	dateOrder: "DMY" | "MDY" | "YMD";
	columns: Array<{ header: string; role: ImportColumnRole }>;
	/** Rows that would be added. */
	rows: number;
	/** Rows of the file that could not be read (no date, no amount, a day that has not come). */
	skipped: number;
	/** Rows already in the ledger from an earlier import: they are not added again. */
	duplicates: number;
	outMinor: number;
	outCount: number;
	inMinor: number;
	inCount: number;
	uncategorized: number;
	firstDate?: string;
	lastDate?: string;
	sample: Array<{
		dateText: string;
		amountMinor: number;
		description: string;
		category?: string;
		duplicate: boolean;
		/** Probably an entry the owner already has: left out unless `confirm_import` is told to include it. */
		match?: boolean;
	}>;
	problems: string[];
	/** How many rows probably repeat an entry already in the ledger, and (the first ones) which. They are not in `rows`. */
	matchCount?: number;
	matches?: ImportMatch[];
	/** Things that look wrong with the file as read, which the owner should hear before agreeing. */
	warnings?: string[];
};

/** What `confirm_import` did. Importing the same file twice adds nothing the second time. */
export type ImportResultCard = {
	type: "import_result";
	importId: string;
	account: string;
	currency: string;
	inserted: number;
	duplicates: number;
	/** Rows left out because they probably repeat an entry the owner already has. */
	skippedMatches?: number;
	/** What the entries this import wrote add up to. */
	outMinor: number;
	inMinor: number;
	/** The import had been confirmed before: nothing changed. */
	already: boolean;
};

export type SplitShare = {
	person: string;
	itemsMinor: number;
	extrasMinor: number;
	owedMinor: number;
	/** This person paid the bill: what they "owe" is their own share and is not a debt. */
	paid: boolean;
};

/** A bill after `split_bill`: what each person owes, to the minor unit, adding up to the total exactly. */
export type SplitCard = {
	type: "split";
	billId: string;
	title: string;
	dateText: string;
	payer: string;
	currency: string;
	totalMinor: number;
	items: Array<{ description: string; amountMinor: number; sharedBy: string[] }>;
	extras: Array<{ label: string; amountMinor: number }>;
	shares: SplitShare[];
	/** Split equally, with no items. */
	equal: boolean;
};

export type DebtItem = { debtor: string; creditor: string; amountMinor: number; currency: string };

/** The answer to `who_owes`: every open balance, who owes whom. */
export type WhoOwesCard = {
	type: "who_owes";
	heading: string;
	debts: DebtItem[];
};

export type InvoiceItem = {
	number: string;
	periodText: string;
	issueText: string;
	dueText: string;
	clientName: string;
	amountMinor: number;
	currency: string;
	/** The PDF, as the files API serves it (`GET /api/files/:id`). */
	file?: { id: string; name: string; mime: string; size: number };
};

/** An invoice just made (or, when this call had already made it, found again). The PDF is a download in the card. */
export type InvoiceCard = {
	type: "invoice";
	/** `preview`: a PDF marked PREVIEW that took no number and is not an invoice. */
	event: "created" | "existing" | "preview";
	invoice: InvoiceItem;
};

export type InvoiceListCard = {
	type: "invoice_list";
	heading: string;
	invoices: InvoiceItem[];
	total: number;
};

/** A few plain lines: an account made, a balance stated, a rate saved, a settlement recorded, a profile saved. */
export type AccountantNoteCard = {
	type: "accountant_note";
	heading: string;
	lines: string[];
};

export type AccountantCard =
	| TxnCard
	| TxnListCard
	| BalancesCard
	| SpendingCard
	| ImportPreviewCard
	| ImportResultCard
	| SplitCard
	| WhoOwesCard
	| InvoiceCard
	| InvoiceListCard
	| AccountantNoteCard;
