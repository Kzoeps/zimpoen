import { ACCOUNT_KINDS, type AccountantNoteCard, formatMoney, type TxnCard } from "@assistant/shared";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ApprovalAction } from "../approvals/service.ts";
import { toMinor, toRateMicro } from "../money.ts";
import { localDate } from "../time.ts";
import { asDetails, currentTimeTool, dayText, oneLine, text } from "../tool-support.ts";
import { createResolvers, currencyCode, DAY_HELP, defaultCurrencyOf, type LedgerDeps } from "./common.ts";
import { merchantKey, nameKey } from "./keys.ts";
import { resolveSpendRange, SPEND_RANGE_HELP } from "./range.ts";
import { balancesReport, describeTxn, listReport, spendingReport, txnItem } from "./reports.ts";
import * as store from "./store.ts";

const MAX_LISTED = 50;
const DEFAULT_LISTED = 20;
const MAX_RECATEGORIZED = 500;
const MAX_GROUPS = 25;

const accountKind = Type.Union(
	ACCOUNT_KINDS.map((kind) => Type.Literal(kind)),
	{
		description:
			"cash (notes and coins), bank, wallet (mBoB, a mobile wallet) or card (a credit card: it holds a negative balance when it owes).",
	},
);

const noteCard = (heading: string, lines: string[]): AccountantNoteCard => ({
	type: "accountant_note",
	heading,
	lines,
});

const CATEGORY_HELP =
	"A category name: food, groceries, transport, rent, utilities, phone/internet, health, shopping, entertainment, travel, gifts, fees, other " +
	"(the prompt lists the owner's own). Leave it out when it is not clear; the merchant's usual category is used when there is one.";

/**
 * The tools of the ledger. Every tool that writes is replay-safe because it is idempotent by its call id (rule 8): the
 * entry tools through `source_call_id UNIQUE`, the tools that change a row that exists through the call ledger, and each looks
 * for its own earlier result before it reads the clock. Amounts come in as plain numbers of major units (`1234.5`) and are
 * stored as integers of minor units; every total, balance and share is worked out here, never by the model.
 */
export function createLedgerTools(deps: LedgerDeps): ToolRegistration[] {
	const { db, timezone, approvals } = deps;
	const defaultCurrency = defaultCurrencyOf(deps);
	const { resolveDay, resolveAccount, resolveCategory, amountOf, receiptId, balanceLine, accountList } =
		createResolvers(deps);
	const conversationOf = (api: ToolExecutionApi): number => Number(api.conversationId);

	// ----- recording ----------------------------------------------------------------------------------------------------

	const recorded = (row: store.TxnView, extra: { similarTo?: string; usual?: boolean } = {}) => {
		const account = store.getAccount(db, row.accountId) as store.AccountRow;
		const lines = [`Recorded ${describeTxn(row)}.`, balanceLine(account)];
		if (extra.usual === true)
			lines.push(`The category is the one the owner usually gives ${row.merchant}; recategorize changes it.`);
		if (extra.similarTo !== undefined) {
			lines.push(
				row.source === "receipt" &&
					row.sourceRef !== undefined &&
					store.txnByReceipt(db, row.sourceRef)?.id === extra.similarTo
					? `This receipt (${row.sourceRef}) already has an entry: ${extra.similarTo}. If it is the same purchase entered twice, offer to delete one with propose_delete_txn.`
					: `An entry like this one (same day, amount, account and merchant) already exists: ${extra.similarTo}. If the owner entered it twice, offer to delete one with propose_delete_txn.`,
			);
		}
		const card: TxnCard = {
			type: "txn",
			txns: [txnItem(db, row, timezone)],
			...(extra.similarTo === undefined ? {} : { similarTo: extra.similarTo }),
		};
		return { output: text(lines.join("\n")), details: asDetails(card) };
	};

	/** What `add_expense` and `add_income` share: only the sign, the kind of category and the words differ. */
	function recordEntry(args: EntryArgs, api: ToolExecutionApi, direction: "out" | "in") {
		// Rule 8: a replay finds what its first run wrote before it checks anything; the checks read the clock ("today").
		const earlier = store.txnByCallId(db, api.callId);
		if (earlier !== undefined) return recorded(earlier);

		const today = localDate(api.now(), timezone);
		const date = resolveDay(args.date, today);
		const currency = args.currency === undefined ? undefined : currencyCode(args.currency);
		const account = resolveAccount(args.account, currency);
		if (currency !== undefined && currency !== account.currency) {
			throw new Error(
				`${account.name} holds ${account.currency}, not ${currency}. Give the amount in ${account.currency} (what the account was actually charged), or use an account in ${currency}.`,
			);
		}
		const minor = amountOf(args.amount, account.currency);
		const merchant = oneLine(args.merchant ?? "").slice(0, 120);
		const note = oneLine(args.note ?? "").slice(0, 300);
		const kind = direction === "out" ? "expense" : "income";
		let category = args.category === undefined ? undefined : resolveCategory(args.category, kind);
		let usual = false;
		if (category === undefined && merchant !== "") {
			const remembered = store.categoryForMerchant(db, merchantKey(merchant));
			const found =
				remembered === undefined ? undefined : store.listCategories(db).find((entry) => entry.id === remembered);
			if (found !== undefined && found.kind === kind) {
				category = found;
				usual = true;
			}
		}
		const receipt = receiptId(args.receipt_file_id);
		const signed = direction === "out" ? -minor : minor;
		// The same photo recorded twice (the merchant spelt another way would slip past the check on the entry itself).
		const sameReceipt = receipt === undefined ? undefined : store.txnByReceipt(db, receipt)?.id;
		const similarTo =
			store.similarTxn(db, { accountId: account.id, date, amountMinor: signed, merchant }) ?? sameReceipt;
		const outcome = store.insertTxn(db, {
			accountId: account.id,
			date,
			amountMinor: signed,
			currency: account.currency,
			...(category === undefined ? {} : { categoryId: category.id }),
			merchant,
			note,
			source: receipt === undefined ? "chat" : "receipt",
			...(receipt === undefined ? {} : { sourceRef: receipt }),
			sourceCallId: api.callId,
			now: api.now(),
		});
		if (outcome.status === "duplicate")
			throw new Error("The entry was not written. This should be impossible; check ledger_txn.");
		const row = store.getTxn(db, outcome.id) as store.TxnView;
		return recorded(row, { ...(similarTo === undefined ? {} : { similarTo }), usual });
	}

	type EntryArgs = {
		amount: number;
		account?: string | undefined;
		currency?: string | undefined;
		category?: string | undefined;
		merchant?: string | undefined;
		note?: string | undefined;
		date?: string | undefined;
		receipt_file_id?: string | undefined;
	};

	const entryParameters = {
		amount: Type.Number({
			exclusiveMinimum: 0,
			description: "A positive amount in major units, as stated: 1234.5 for Nu. 1,234.50.",
		}),
		account: Type.Optional(
			Type.String({
				description:
					"The account it came out of or went into, by name. Optional when it is clear (one account, or one in the currency).",
			}),
		),
		currency: Type.Optional(
			Type.String({
				description:
					"A three-letter code, only when the owner named one (USD, INR). It must be the account's currency.",
			}),
		),
		category: Type.Optional(Type.String({ description: CATEGORY_HELP })),
		merchant: Type.Optional(
			Type.String({ maxLength: 120, description: "Who was paid or who paid: 'Druk Mart', 'Pema'." }),
		),
		note: Type.Optional(Type.String({ maxLength: 300, description: "Anything worth keeping with it." })),
		date: Type.Optional(Type.String({ description: DAY_HELP })),
		receipt_file_id: Type.Optional(
			Type.String({
				description: "The file id (fi_...) of the receipt photo or bill this was read from: it is linked to the entry.",
			}),
		),
	};

	const addExpense = defineTool({
		name: "add_expense",
		description:
			"Record money the owner spent (or lost): an amount, and where it came from. The account's balance is worked out by the tool. " +
			"For a receipt photo, read it first with read_file, then record the total here with receipt_file_id. Never add up several amounts yourself: record each, or ask.",
		parameters: Type.Object(entryParameters),
		replay: "safe",
		async execute(args, api) {
			return recordEntry(args, api, "out");
		},
	});

	const addIncome = defineTool({
		name: "add_income",
		description:
			"Record money the owner received: a salary, a payment, a refund. Not for moving money between the owner's own accounts (add_transfer), and not for a friend paying back a split (record_settlement).",
		parameters: Type.Object(entryParameters),
		replay: "safe",
		async execute(args, api) {
			return recordEntry(args, api, "in");
		},
	});

	const transferResult = (legs: store.TxnView[]) => {
		const [out, into] = legs;
		if (out === undefined || into === undefined) throw new Error("A transfer has disappeared; check ledger_txn.");
		const outAccount = store.getAccount(db, out.accountId) as store.AccountRow;
		const inAccount = store.getAccount(db, into.accountId) as store.AccountRow;
		const card: TxnCard = { type: "txn", txns: legs.map((leg) => txnItem(db, leg, timezone)) };
		return {
			output: text(
				[
					`Transferred ${formatMoney(-out.amountMinor, out.currency)} from ${out.account} to ${into.account} on ${out.date}` +
						(out.currency === into.currency ? "." : ` (${formatMoney(into.amountMinor, into.currency)} arrived).`),
					`Entries ${out.id} and ${into.id}. A transfer is not spending and not income.`,
					balanceLine(outAccount),
					balanceLine(inAccount),
				].join("\n"),
			),
			details: asDetails(card),
		};
	};

	const addTransfer = defineTool({
		name: "add_transfer",
		description:
			"Move money between two of the owner's accounts: a cash withdrawal, paying a card, topping up a wallet. It is neither spending nor income. " +
			"When the accounts are in different currencies, give to_amount: what arrived, as the owner states it.",
		parameters: Type.Object({
			from_account: Type.String({ description: "The account the money left." }),
			to_account: Type.String({ description: "The account it went into." }),
			amount: Type.Number({ exclusiveMinimum: 0, description: "What left the first account, in its currency." }),
			to_amount: Type.Optional(
				Type.Number({
					exclusiveMinimum: 0,
					description: "What arrived, in the second account's currency. Needed when the currencies differ.",
				}),
			),
			date: Type.Optional(Type.String({ description: DAY_HELP })),
			note: Type.Optional(Type.String({ maxLength: 300 })),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.txnByCallId(db, api.callId);
			if (earlier?.transferId !== undefined) return transferResult(store.transferLegs(db, earlier.transferId));

			const date = resolveDay(args.date, localDate(api.now(), timezone));
			const from = resolveAccount(args.from_account);
			const to = resolveAccount(args.to_account);
			if (from.id === to.id)
				throw new Error(`Both accounts are ${from.name}. A transfer needs two different accounts.`);
			const outMinor = amountOf(args.amount, from.currency);
			if (from.currency !== to.currency && args.to_amount === undefined) {
				throw new Error(
					`${from.name} holds ${from.currency} and ${to.name} holds ${to.currency}: give to_amount, what arrived in ${to.currency}, as the owner states it. Never convert it yourself.`,
				);
			}
			const inMinor = args.to_amount === undefined ? outMinor : amountOf(args.to_amount, to.currency, "to_amount");
			if (from.currency === to.currency && inMinor !== outMinor) {
				throw new Error("Both accounts hold the same currency, so the same amount arrives. Leave to_amount out.");
			}
			const note = oneLine(args.note ?? "").slice(0, 300);
			const now = api.now();
			const transferId = store.newTransferId();
			db.transaction(() => {
				const shared = { date, merchant: "", note, source: "chat" as const, transferId, now };
				store.insertTxn(db, {
					...shared,
					accountId: from.id,
					amountMinor: -outMinor,
					currency: from.currency,
					sourceCallId: api.callId,
				});
				store.insertTxn(db, {
					...shared,
					accountId: to.id,
					amountMinor: inMinor,
					currency: to.currency,
					sourceCallId: `${api.callId}:in`,
				});
			});
			const out = store.txnByCallId(db, api.callId) as store.TxnView;
			return transferResult(store.transferLegs(db, out.transferId as string));
		},
	});

	// ----- accounts and balances -----------------------------------------------------------------------------------------

	const accountNote = (account: store.AccountRow, extra: string[]) => {
		const card = noteCard(`Account ${account.name}`, [`${account.kind}, ${account.currency}`, ...extra]);
		return asDetails(card);
	};

	const addAccount = defineTool({
		name: "add_account",
		description:
			"Create an account the owner keeps money in: cash, a bank account, a wallet or a card, in one currency. Give balance when the owner says what it holds now.",
		parameters: Type.Object({
			name: Type.String({
				minLength: 1,
				maxLength: 60,
				description: "As the owner calls it: 'Cash', 'BoB savings', 'mBoB'.",
			}),
			kind: accountKind,
			currency: Type.Optional(Type.String({ description: `A three-letter code. Default ${defaultCurrency}.` })),
			balance: Type.Optional(
				Type.Number({ description: "What it holds now, in major units. Negative for a card that owes money." }),
			),
			date: Type.Optional(Type.String({ description: `The day that balance is of. ${DAY_HELP}` })),
		}),
		replay: "safe",
		async execute(args, api) {
			const now = api.now();
			let account = store.accountByCallId(db, api.callId);
			if (account === undefined) {
				const name = oneLine(args.name).slice(0, 60);
				if (nameKey(name) === "") throw new Error("An account needs a name with letters or digits in it.");
				const existing = store.accountByKey(db, nameKey(name));
				if (existing !== undefined) {
					throw new Error(
						`An account called '${existing.name}' already exists (${existing.kind}, ${existing.currency}${existing.archived ? ", archived: restore it with archive_account" : ""}). Use it, or pick another name.`,
					);
				}
				const currency = args.currency === undefined ? defaultCurrency : currencyCode(args.currency);
				account = store.insertAccount(db, { name, kind: args.kind, currency, now }, api.callId).row;
			}
			const lines: string[] = [];
			if (args.balance !== undefined) {
				// Also on a replay: a crash may have come between the account and its first balance. Both are idempotent.
				const asOf = resolveDay(args.date, localDate(now, timezone));
				const { row } = store.insertSnapshot(
					db,
					{
						accountId: account.id,
						asOf,
						amountMinor: toMinor(args.balance, account.currency, "balance"),
						note: "opening balance",
						now,
					},
					`${api.callId}:balance`,
				);
				lines.push(`Balance ${formatMoney(row.amountMinor, account.currency)} as of ${dayText(row.asOf, timezone)}`);
			}
			return {
				output: text(
					`Account ${account.name} (${account.kind}, ${account.currency}) is ready.${lines.length === 0 ? " No balance is stated yet: use set_balance when the owner says what it holds." : ` ${lines.join(". ")}.`}`,
				),
				details: accountNote(account, lines),
			};
		},
	});

	const setBalance = defineTool({
		name: "set_balance",
		description:
			"Record what an account holds, as the owner states it (a bank app's balance, the cash in the wallet). The tool compares it with what the entries explain and reports the difference. " +
			"From then on the balance is this figure plus the entries since.",
		parameters: Type.Object({
			account: Type.String({ description: "The account, by name." }),
			balance: Type.Number({ description: "What it holds, in major units. Negative for a card that owes money." }),
			date: Type.Optional(Type.String({ description: `The day it is of. ${DAY_HELP}` })),
			note: Type.Optional(Type.String({ maxLength: 200 })),
		}),
		replay: "safe",
		async execute(args, api) {
			const done = store.snapshotByCallId(db, api.callId);
			if (done !== undefined) {
				const account = store.getAccount(db, done.accountId) as store.AccountRow;
				return {
					output: text(
						`The balance of ${account.name} was already recorded: ${formatMoney(done.amountMinor, account.currency)} as of ${dayText(done.asOf, timezone)}.\n${balanceLine(account)}`,
					),
					details: accountNote(account, [
						`Balance ${formatMoney(done.amountMinor, account.currency)} as of ${dayText(done.asOf, timezone)}`,
					]),
				};
			}
			const now = api.now();
			const account = resolveAccount(args.account);
			const asOf = resolveDay(args.date, localDate(now, timezone));
			const stated = toMinor(args.balance, account.currency, "balance");
			const before = store.accountBalance(db, account.id, asOf);
			const known = before.snapshot !== undefined || before.entriesSince > 0;
			const { row: snapshot } = store.insertSnapshot(
				db,
				{ accountId: account.id, asOf, amountMinor: stated, note: oneLine(args.note ?? "").slice(0, 200), now },
				api.callId,
			);
			const lines = [
				`${account.name} holds ${formatMoney(stated, account.currency)} as of ${dayText(asOf, timezone)}.`,
			];
			const card = [`Balance ${formatMoney(stated, account.currency)}`, `As of ${dayText(asOf, timezone)}`];
			const newest = store.latestSnapshot(db, account.id);
			if (newest !== undefined && newest.id !== snapshot.id) {
				// A figure for an earlier day than the one the balance counts from: kept as a record, and it moves nothing.
				lines.push(
					`This changes nothing: the owner stated ${formatMoney(newest.amountMinor, account.currency)} as of ${dayText(newest.asOf, timezone)}, a later day, and the balance counts from that one.`,
				);
				card.push("Changes nothing: a later balance was stated");
			} else if (!known) lines.push("This is the opening balance: there was nothing to compare it with.");
			else {
				const difference = stated - before.amountMinor;
				const compared = `The entries explained ${formatMoney(before.amountMinor, account.currency)}`;
				if (difference === 0) {
					lines.push(`${compared}: it matches exactly.`);
					card.push("Matches the entries exactly");
				} else {
					const word =
						difference < 0
							? `${formatMoney(-difference, account.currency)} less: some spending or a fee may not be recorded`
							: `${formatMoney(difference, account.currency)} more: some money that came in may not be recorded`;
					lines.push(`${compared}, so the owner has ${word}. Ask what it was; do not invent entries.`);
					card.push(`${formatMoney(difference, account.currency, { sign: "always" })} against the entries`);
				}
			}
			return { output: text(lines.join("\n")), details: asDetails(noteCard(`Balance of ${account.name}`, card)) };
		},
	});

	const balances = defineTool({
		name: "balances",
		description:
			"What the owner's accounts hold now, with a total per currency: each account's last stated balance plus the entries since, all worked out by the tool. " +
			"convert_to also gives one total in that currency, from the rates the owner gave.",
		parameters: Type.Object({
			convert_to: Type.Optional(
				Type.String({ description: "A three-letter code: add everything up in this currency." }),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const today = localDate(api.now(), timezone);
			const report = balancesReport(
				db,
				timezone,
				today,
				args.convert_to === undefined ? undefined : currencyCode(args.convert_to, "convert_to"),
			);
			return { output: text(report.text), details: asDetails(report.card) };
		},
	});

	// ----- looking -------------------------------------------------------------------------------------------------------

	const spendingSummary = defineTool({
		name: "spending_summary",
		description:
			"Where the money went over a range of days, as a ranked list with shares and a bar chart: by category (default), merchant, account, week or month. " +
			"Only spending counts (money out, not transfers). Every figure is computed in code: quote them, never add anything up yourself. " +
			"Spending in other currencies is listed apart, or converted with convert_to when the owner gave a rate.",
		parameters: Type.Object({
			range: Type.Optional(Type.String({ description: `${SPEND_RANGE_HELP} Default this_month.` })),
			from: Type.Optional(Type.String({ description: "First day, YYYY-MM-DD. Use instead of range." })),
			to: Type.Optional(Type.String({ description: "Last day, YYYY-MM-DD. Default today." })),
			group_by: Type.Optional(
				Type.Union(
					[
						Type.Literal("category"),
						Type.Literal("merchant"),
						Type.Literal("account"),
						Type.Literal("week"),
						Type.Literal("month"),
					],
					{
						description: "What to rank by. Default category.",
					},
				),
			),
			account: Type.Optional(Type.String({ description: "Only this account." })),
			category: Type.Optional(Type.String({ description: "Only this category." })),
			convert_to: Type.Optional(
				Type.String({ description: "A three-letter code: convert other currencies into it, with the owner's rates." }),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_GROUPS,
					description: "Most groups shown, the rest as 'Other'. Default 8.",
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const range = resolveSpendRange(args, localDate(api.now(), timezone), "this_month");
			const account = args.account === undefined ? undefined : resolveAccount(args.account);
			const category = args.category === undefined ? undefined : findAnyCategory(args.category);
			const convertTo = args.convert_to === undefined ? undefined : currencyCode(args.convert_to, "convert_to");
			const report = spendingReport(db, timezone, {
				range,
				groupBy: args.group_by ?? "category",
				currency: convertTo ?? defaultCurrency,
				convert: convertTo !== undefined,
				...(account === undefined ? {} : { accountId: account.id }),
				...(category === undefined ? {} : { categoryId: category.id }),
				limit: args.limit ?? 8,
			});
			return { output: text(report.text), details: asDetails(report.card) };
		},
	});

	/** A category of either kind, for a filter. */
	function findAnyCategory(typed: string): store.CategoryRow {
		const key = nameKey(typed);
		const all = store.listCategories(db);
		const found =
			all.find((category) => category.key === key) ??
			(() => {
				const partial = all.filter((category) => key !== "" && category.key.includes(key));
				return partial.length === 1 ? partial[0] : undefined;
			})();
		if (found === undefined)
			throw new Error(
				`No category called '${typed.slice(0, 40)}'. Categories: ${all.map((category) => category.name).join(", ")}.`,
			);
		return found;
	}

	const listTxns = defineTool({
		name: "list_txns",
		description:
			"List entries of the ledger, newest first, with the ids that recategorize and propose_delete_txn take. Filter by days, account, category, merchant, words, kind or size. " +
			"The totals over all matches are worked out in code.",
		parameters: Type.Object({
			range: Type.Optional(Type.String({ description: `${SPEND_RANGE_HELP} Default 30d.` })),
			from: Type.Optional(Type.String({ description: "First day, YYYY-MM-DD. Use instead of range." })),
			to: Type.Optional(Type.String({ description: "Last day, YYYY-MM-DD. Default today." })),
			account: Type.Optional(Type.String()),
			category: Type.Optional(Type.String({ description: "A category name, or 'uncategorized'." })),
			merchant: Type.Optional(Type.String({ description: "Words of the merchant's name." })),
			text: Type.Optional(Type.String({ description: "Words of the merchant or the note." })),
			kind: Type.Optional(
				Type.Union([Type.Literal("expense"), Type.Literal("income"), Type.Literal("transfer"), Type.Literal("all")], {
					description: "Default all.",
				}),
			),
			min_amount: Type.Optional(
				Type.Number({
					minimum: 0,
					description: "At least this much (either way), in major units of the account's currency.",
				}),
			),
			max_amount: Type.Optional(Type.Number({ minimum: 0, description: "At most this much, in major units." })),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_LISTED, description: `At most this many. Default ${DEFAULT_LISTED}.` }),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const range = resolveSpendRange(args, localDate(api.now(), timezone), "30d");
			const account = args.account === undefined ? undefined : resolveAccount(args.account);
			const uncategorized = args.category !== undefined && nameKey(args.category) === "uncategorized";
			const category = args.category === undefined || uncategorized ? undefined : findAnyCategory(args.category);
			const currency = account?.currency ?? defaultCurrency;
			const filter: store.TxnFilter = {
				...(range.from === undefined ? {} : { from: range.from }),
				to: range.to,
				...(account === undefined ? {} : { accountId: account.id }),
				...(category === undefined ? {} : { categoryId: category.id }),
				...(uncategorized ? { uncategorized: true } : {}),
				...(args.merchant === undefined ? {} : { merchant: args.merchant }),
				...(args.text === undefined ? {} : { text: args.text }),
				kind: args.kind ?? "all",
				...(args.min_amount === undefined ? {} : { minMinor: toMinor(args.min_amount, currency, "min_amount") }),
				...(args.max_amount === undefined ? {} : { maxMinor: toMinor(args.max_amount, currency, "max_amount") }),
			};
			const report = listReport(db, timezone, filter, `Entries ${range.label}`, args.limit ?? DEFAULT_LISTED);
			return { output: text(report.text), details: asDetails(report.card) };
		},
	});

	// ----- changing what is there ------------------------------------------------------------------------------------------

	/** More entries than this change only after the owner has seen them: the tool shows what would change, then waits for `confirm`. */
	const CONFIRM_ABOVE = 20;
	const SHOWN_GROUPS = 6;
	const SAMPLE = 5;

	const recategorize = defineTool({
		name: "recategorize",
		deferred: true,
		description:
			"Give entries another category: the ones whose ids you pass, or every entry of one merchant (optionally only the uncategorized ones, or a range of days). " +
			"A merchant matches by its whole name (case and punctuation aside); match 'words' also takes names that contain the words as whole words. " +
			`More than ${CONFIRM_ABOVE} entries are changed only after the owner has seen what would change and agreed: the first call shows it, then call again with confirm true. ` +
			"Every change can be taken back with undo_recategorize. The ledger remembers a merchant's category for new entries and imports. Transfers have no category.",
		parameters: Type.Object({
			category: Type.String({ description: CATEGORY_HELP.replace(/ Leave it out.*$/, "") }),
			txn_ids: Type.Optional(
				Type.Array(Type.String(), {
					minItems: 1,
					maxItems: MAX_RECATEGORIZED,
					description: "Entry ids, as list_txns shows them (x_...).",
				}),
			),
			merchant: Type.Optional(
				Type.String({ description: "The merchant's name: every entry of that merchant (the whole name) changes." }),
			),
			match: Type.Optional(
				Type.Union([Type.Literal("exact"), Type.Literal("words")], {
					description:
						"With merchant. exact (default): the same merchant. words: any merchant whose name contains these words as whole words ('tea' finds 'Tea stall' but not 'Steak House').",
				}),
			),
			only_uncategorized: Type.Optional(
				Type.Boolean({ description: "With merchant: leave entries that already have a category alone." }),
			),
			range: Type.Optional(Type.String({ description: `With merchant: only these days. ${SPEND_RANGE_HELP}` })),
			from: Type.Optional(Type.String()),
			to: Type.Optional(Type.String()),
			confirm: Type.Optional(
				Type.Boolean({
					description: `Required to change more than ${CONFIRM_ABOVE} entries: true only after the owner has seen the preview and agreed.`,
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findCall(db, api.callId);
			if (earlier?.tool === "recategorize") return recategorized(earlier.subject);
			if (args.txn_ids === undefined && args.merchant === undefined) {
				throw new Error("Say which entries: txn_ids (from list_txns), or merchant for every entry of one.");
			}
			const category = findAnyCategory(args.category);
			let found: store.TxnView[];
			let what: string;
			if (args.txn_ids !== undefined) {
				found = store.queryTxns(db, { ids: args.txn_ids }, { limit: MAX_RECATEGORIZED }).rows;
				const missing = args.txn_ids.filter((id) => !found.some((row) => row.id === id));
				if (missing.length > 0)
					throw new Error(`No entry has the id ${missing.slice(0, 5).join(", ")}. list_txns shows the ids.`);
				what = "entries by id";
			} else {
				const merchant = args.merchant as string;
				if (merchantKey(merchant) === "")
					throw new Error("A merchant needs a name with letters or digits in it. For entries by id, pass txn_ids.");
				const words = args.match === "words";
				const range =
					args.range === undefined && args.from === undefined && args.to === undefined
						? undefined
						: resolveSpendRange(args, localDate(api.now(), timezone), "all");
				const page = store.queryTxns(
					db,
					{
						...(words ? { merchantWords: merchant } : { merchantExact: merchant }),
						kind: category.kind === "income" ? "income" : "expense",
						...(args.only_uncategorized === true ? { uncategorized: true } : {}),
						...(range?.from === undefined ? {} : { from: range.from }),
						...(range === undefined ? {} : { to: range.to }),
					},
					{ limit: MAX_RECATEGORIZED + 1 },
				);
				if (page.total > MAX_RECATEGORIZED)
					throw new Error(
						`That merchant has ${page.total} entries, more than ${MAX_RECATEGORIZED} at once. Narrow it with range or only_uncategorized.`,
					);
				found = page.rows;
				what = `${words ? "every entry whose merchant has the words" : "every entry of the merchant"} '${oneLine(merchant).slice(0, 60)}'`;
			}
			if (found.length === 0) throw new Error("No entry matches. list_txns shows what is there.");
			const moving = found.filter((row) => row.transferId === undefined && row.categoryId !== category.id);
			if (moving.length > CONFIRM_ABOVE && args.confirm !== true) return recategorizePreview(moving, category, what);
			const { batch } = store.recategorize(db, {
				ids: moving.map((row) => row.id),
				category,
				what,
				callId: api.callId,
				now: api.now(),
			});
			return recategorized(batch === undefined ? `none:${category.name}` : `batch:${batch.id}`);
		},
	});

	/** "Tea stall ×3 (from food)": what moves, by merchant and by the category it comes from. */
	function groupedMoves(groups: ReadonlyArray<{ merchant: string; from: string | undefined; count: number }>): string {
		const shown = groups
			.slice(0, SHOWN_GROUPS)
			.map(
				(group) =>
					`${group.merchant === "" ? "(no merchant)" : group.merchant} ×${group.count} (from ${group.from ?? "uncategorized"})`,
			);
		const more = groups.length - SHOWN_GROUPS;
		return `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
	}

	/** What a change over the limit would do, with nothing changed: the owner reads this before the model repeats the call with `confirm`. */
	function recategorizePreview(moving: readonly store.TxnView[], category: store.CategoryRow, what: string) {
		const groups = new Map<string, { merchant: string; from: string | undefined; count: number }>();
		for (const row of moving) {
			const key = `${row.merchantKey}|${row.categoryId ?? ""}`;
			const group = groups.get(key);
			if (group === undefined) groups.set(key, { merchant: row.merchant, from: row.category, count: 1 });
			else group.count++;
		}
		const ordered = [...groups.values()].sort((a, b) => b.count - a.count || a.merchant.localeCompare(b.merchant));
		const sample = moving.slice(0, SAMPLE).map((row) => `- ${describeTxn(row)}`);
		const lines = [
			`Nothing has changed yet. ${moving.length} entries would move to ${category.name} (${what}), more than ${CONFIRM_ABOVE} at once: ${groupedMoves(ordered)}.`,
			"Some of them:",
			...sample,
			`Show the owner this. If they agree, call recategorize again with the same arguments and confirm true; a change can be taken back with undo_recategorize.`,
		];
		return {
			output: text(lines.join("\n")),
			details: asDetails(
				noteCard("Recategorize: waiting for the owner", [
					`${moving.length} entries → ${category.name}`,
					groupedMoves(ordered),
					"Nothing has changed yet",
				]),
			),
		};
	}

	/** The answer, from what the ledger recorded (`batch:<id>`, or `none:<category>`): the same words for the first run and a replay. */
	function recategorized(subject: string) {
		if (subject.startsWith("none:")) {
			const label = subject.slice(5);
			return {
				output: text(`Nothing changed: every matching entry already has the category ${label}.`),
				details: asDetails(noteCard("Category changed", [`0 entries → ${label}`])),
			};
		}
		const batch = store.getBatch(db, subject.slice(6)) as store.RecategorizeBatch;
		const moves = groupedMoves(store.batchMoves(db, batch.id));
		const n = batch.changed;
		const line = `${n} ${n === 1 ? "entry" : "entries"} → ${batch.categoryName}`;
		return {
			output: text(
				`${n} ${n === 1 ? "entry is" : "entries are"} now in ${batch.categoryName}: ${moves}. ` +
					`To take it back: undo_recategorize ${batch.id}.`,
			),
			details: asDetails(noteCard("Category changed", [line, moves, `Undo: ${batch.id}`])),
		};
	}

	const undoRecategorize = defineTool({
		name: "undo_recategorize",
		deferred: true,
		description:
			"Take back one recategorize: each entry it moved goes back to the category it had (an entry changed again since, or deleted, is left alone). Pass the batch id the recategorize answer gave (rc_...).",
		parameters: Type.Object({
			batch_id: Type.String({ minLength: 1, description: "The id recategorize gave (rc_...)." }),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findCall(db, api.callId);
			if (earlier?.tool === "undo_recategorize") {
				return {
					output: text(earlier.subject),
					details: asDetails(noteCard("Category change undone", [earlier.subject])),
				};
			}
			const id = args.batch_id.trim();
			const batch = store.getBatch(db, id);
			if (batch === undefined)
				throw new Error(
					`No category change called '${oneLine(id).slice(0, 30)}'. The answer of recategorize names it (rc_...).`,
				);
			if (batch.undoneAt !== undefined) {
				return {
					output: text(`The change ${id} was already undone. Nothing changed.`),
					details: asDetails(noteCard("Category change undone", [`${id} was undone before`])),
				};
			}
			const now = api.now();
			const subject = db.transaction(() => {
				const result = store.undoRecategorization(db, id, now);
				const parts = [
					`Put ${result.restored} ${result.restored === 1 ? "entry" : "entries"} back to the category ${result.restored === 1 ? "it" : "they"} had before ${id}`,
				];
				if (result.changedSince > 0)
					parts.push(
						`${result.changedSince} changed again since and ${result.changedSince === 1 ? "was" : "were"} left alone`,
					);
				if (result.gone > 0) parts.push(`${result.gone} no longer exist`);
				const answer = `${parts.join("; ")}.`;
				store.recordCall(db, api.callId, "undo_recategorize", answer, now);
				return answer;
			});
			return { output: text(subject), details: asDetails(noteCard("Category change undone", [subject])) };
		},
	});

	// ----- deleting (rule 3: only with the owner's approval) --------------------------------------------------------------------

	const proposeDelete = defineTool({
		name: "propose_delete_txn",
		deferred: true,
		description:
			"Ask the owner to approve deleting one entry for good (a duplicate, a mistake). For a transfer, both legs go. Nothing is deleted until they tap Approve or reply YES; never say it is deleted before they have. To fix a category use recategorize.",
		parameters: Type.Object({
			txn_id: Type.String({ minLength: 1, description: "The entry's id, as list_txns shows it (x_...)." }),
		}),
		replay: "safe",
		async execute(args, api) {
			const row = store.getTxn(db, args.txn_id.trim());
			if (row === undefined)
				throw new Error(`No entry has the id '${oneLine(args.txn_id).slice(0, 30)}'. list_txns shows the ids.`);
			const legs = row.transferId === undefined ? [row] : store.transferLegs(db, row.transferId);
			const summary =
				legs.length === 1
					? `Delete the entry ${describeTxn(row)}`
					: `Delete the transfer of ${formatMoney(-(legs[0]?.amountMinor ?? 0), legs[0]?.currency ?? "")} on ${row.date}, both entries (${legs.map((leg) => leg.id).join(", ")})`;
			const state = approvals.propose({
				conversationId: conversationOf(api),
				tool: "delete_txn",
				args: { txn_id: row.id },
				summary,
				callId: api.callId,
			});
			return {
				output: text(
					`Approval requested (${state.id}): ${state.summary}. ` +
						(state.status === "pending"
							? "Nothing is deleted yet. Tell the owner to tap Approve on the card. Do not say it is deleted until they have answered; list_txns shows whether it went through."
							: `That request is already ${state.status}.`),
				),
				details: asDetails({
					type: "approval",
					actionId: state.id,
					summary: state.summary,
					expiresAt: state.expiresAt,
				}),
			};
		},
	});

	const deleteTxn = defineTool({
		name: "delete_txn",
		deferred: true,
		description:
			"Permanently delete an entry. Blocked unless the owner has approved exactly this deletion: do not call it yourself, use propose_delete_txn and wait for their answer. (The assistant normally carries out an approved deletion by itself.)",
		parameters: Type.Object({ txn_id: Type.String({ minLength: 1 }) }),
		replay: "safe",
		async execute(args, api) {
			return { output: text(await approvals.runApproved(conversationOf(api), "delete_txn", { txn_id: args.txn_id })) };
		},
	});

	// ----- setting up ------------------------------------------------------------------------------------------------------

	const archiveAccount = defineTool({
		name: "archive_account",
		deferred: true,
		description:
			"Hide an account the owner no longer uses (it keeps its entries, drops out of balances and of the choices tools offer), or bring it back with restore: true. Nothing is deleted.",
		parameters: Type.Object({ account: Type.String(), restore: Type.Optional(Type.Boolean()) }),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.findCall(db, api.callId);
			if (earlier?.tool === "archive_account") return { output: text(earlier.subject) };
			const key = nameKey(args.account);
			const all = store.listAccounts(db, true);
			// The whole name first ("savings" is the account called Savings, not "BoB savings"), then a part that only one account has.
			const partial = all.filter((candidate) => key !== "" && candidate.key.includes(key));
			const account = all.find((candidate) => candidate.key === key) ?? (partial.length === 1 ? partial[0] : undefined);
			if (account === undefined) {
				throw new Error(
					partial.length > 1
						? `'${args.account.slice(0, 40)}' could mean several accounts: ${accountList(partial)}. Use the full name.`
						: `No account called '${args.account.slice(0, 40)}'. Accounts: ${accountList(all)}.`,
				);
			}
			const restore = args.restore === true;
			const balance = store.accountBalance(db, account.id).amountMinor;
			const subject =
				account.archived === !restore
					? `${account.name} is already ${restore ? "active" : "archived"}.`
					: restore
						? `${account.name} is back in use.`
						: `${account.name} is archived (it held ${formatMoney(balance, account.currency)}). Its entries are kept; restore: true brings it back.`;
			db.transaction(() => {
				store.setArchived(db, account.id, !restore);
				store.recordCall(db, api.callId, "archive_account", subject, api.now());
			});
			return {
				output: text(subject),
				details: asDetails(noteCard(restore ? "Account restored" : "Account archived", [subject])),
			};
		},
	});

	const addCategory = defineTool({
		name: "add_category",
		deferred: true,
		description:
			"Add a category the owner wants for their entries, when none of the existing ones fits. Names are matched loosely ('Eating out' and 'eating-out' are one).",
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: 40 }),
			kind: Type.Optional(
				Type.Union([Type.Literal("expense"), Type.Literal("income")], { description: "Default expense." }),
			),
			parent: Type.Optional(Type.String({ description: "An existing category it belongs under." })),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.categoryByCallId(db, api.callId);
			if (earlier !== undefined) return categoryAdded(earlier);
			const name = oneLine(args.name).slice(0, 40);
			if (nameKey(name) === "") throw new Error("A category needs a name with letters or digits in it.");
			const existing = store.listCategories(db).find((category) => category.key === nameKey(name));
			if (existing !== undefined)
				throw new Error(`The category '${existing.name}' already exists (${existing.kind}). Use it.`);
			const parent = args.parent === undefined ? undefined : findAnyCategory(args.parent);
			const kind = args.kind ?? parent?.kind ?? "expense";
			return categoryAdded(
				store.insertCategory(db, { name, kind, ...(parent === undefined ? {} : { parentId: parent.id }) }, api.callId)
					.row,
			);
		},
	});

	const categoryAdded = (category: store.CategoryRow) => ({
		output: text(`Category '${category.name}' (${category.kind}) is ready to use.`),
		details: asDetails(noteCard("Category added", [`${category.name} (${category.kind})`])),
	});

	const setFxRate = defineTool({
		name: "set_fx_rate",
		deferred: true,
		description:
			"Save an exchange rate the owner gives: 1 `from` is `rate` `to`. Rates are never fetched from anywhere; without one, other currencies are not converted. A later rate for the same pair replaces an earlier one from its day on.",
		parameters: Type.Object({
			from: Type.String({ description: "The currency being converted: USD." }),
			to: Type.String({ description: "The currency it is converted to: BTN." }),
			rate: Type.Number({
				exclusiveMinimum: 0,
				description: "How many `to` one `from` is: 83.5 when 1 USD is Nu. 83.50. At most six decimals.",
			}),
			date: Type.Optional(Type.String({ description: `The day it applies from. ${DAY_HELP}` })),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.fxByCallId(db, api.callId);
			if (earlier !== undefined) return rateSaved(earlier);
			const from = currencyCode(args.from, "from");
			const to = currencyCode(args.to, "to");
			if (from === to) throw new Error("Both currencies are the same: there is nothing to convert.");
			const date = resolveDay(args.date, localDate(api.now(), timezone));
			return rateSaved(
				store.insertFx(db, { date, from, to, rateMicro: toRateMicro(args.rate), now: api.now() }, api.callId).row,
			);
		},
	});

	const rateSaved = (rate: store.FxRate) => {
		const line = `1 ${rate.from} = ${rate.rateMicro / 1_000_000} ${rate.to}, from ${rate.date}`;
		return { output: text(`Saved the rate: ${line}.`), details: asDetails(noteCard("Exchange rate saved", [line])) };
	};

	return [
		currentTimeTool(timezone),
		addExpense,
		addIncome,
		addTransfer,
		setBalance,
		balances,
		spendingSummary,
		listTxns,
		addAccount,
		recategorize,
		undoRecategorize,
		proposeDelete,
		deleteTxn,
		archiveAccount,
		addCategory,
		setFxRate,
	];
}

/** Deleting an entry is what the Accountant can do to its ledger that cannot be undone (rule 3). */
export function createLedgerApprovalActions(deps: Pick<LedgerDeps, "db">): ApprovalAction[] {
	const { db } = deps;
	return [
		{
			tool: "delete_txn",
			proposeTool: "propose_delete_txn",
			target: (args) => `txn:${String(args.txn_id)}`,
			run: (args) => {
				const id = String(args.txn_id);
				const deleted = store.deleteTxn(db, id);
				if (deleted.length === 0) return `Entry ${id} was already gone.`;
				return deleted.length === 1
					? `Deleted the entry ${describeTxn(deleted[0] as store.TxnView)}.`
					: `Deleted the transfer: ${deleted.map((leg) => leg.id).join(" and ")}.`;
			},
		},
	];
}
