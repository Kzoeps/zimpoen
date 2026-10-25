import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { toMinor } from "../money.ts";
import { text } from "../tool-support.ts";
import { createResolvers, defaultCurrencyOf, type LedgerDeps } from "./common.ts";
import { nameKey } from "./keys.ts";
import { kindOf } from "./reports.ts";
import * as store from "./store.ts";

/** The most entries one `ledger_query` call returns. A script pages through more with `offset`. */
export const MAX_QUERY_ROWS = 1000;
const DEFAULT_QUERY_ROWS = 500;

const entrySchema = Type.Object({
	id: Type.String(),
	date: Type.String({ description: "The local day, YYYY-MM-DD." }),
	amount_minor: Type.Integer({
		description: "Signed minor units: money out is negative (cents, chhertum). Divide only to show it.",
	}),
	currency: Type.String(),
	account: Type.String(),
	category: Type.Union([Type.String(), Type.Null()]),
	merchant: Type.String(),
	note: Type.String(),
	kind: Type.Union([Type.Literal("expense"), Type.Literal("income"), Type.Literal("transfer")]),
});

/**
 * The ledger as rows, for code mode scripts. These two tools are `callers: ["tools"]`: the model is never offered them,
 * only the scripts it writes can call them, and the analysis (sums, averages, trends, a month against another) is then
 * done by the script in code, over integers, with only its output coming back to the model (PLAN rule 7).
 */
export function createQueryTools(deps: LedgerDeps): ToolRegistration[] {
	const { db } = deps;
	const { resolveAccount } = createResolvers(deps);
	const defaultCurrency = defaultCurrencyOf(deps);

	const ledgerQuery = defineTool({
		name: "ledger_query",
		description:
			"Entries of the ledger as rows, oldest first (or newest), for analysis in a script. Amounts are integers of minor units: sum those, and divide only to display. " +
			`Returns at most ${MAX_QUERY_ROWS} rows; when next_offset is not null, call again with offset: next_offset.`,
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "First day, YYYY-MM-DD." })),
			to: Type.Optional(Type.String({ description: "Last day, YYYY-MM-DD." })),
			account: Type.Optional(Type.String({ description: "An account, by name." })),
			category: Type.Optional(Type.String({ description: "A category name, or 'uncategorized'." })),
			merchant: Type.Optional(Type.String({ description: "Words of the merchant's name." })),
			text: Type.Optional(Type.String({ description: "Words of the merchant or the note." })),
			kind: Type.Optional(
				Type.Union([Type.Literal("expense"), Type.Literal("income"), Type.Literal("transfer"), Type.Literal("all")], {
					description: "Default all.",
				}),
			),
			currency: Type.Optional(Type.String({ description: "Only this currency, a three-letter code." })),
			min_amount: Type.Optional(
				Type.Number({ minimum: 0, description: "At least this much either way, in major units." }),
			),
			max_amount: Type.Optional(Type.Number({ minimum: 0 })),
			order: Type.Optional(
				Type.Union([Type.Literal("oldest"), Type.Literal("newest")], { description: "Default oldest." }),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_QUERY_ROWS, description: `Default ${DEFAULT_QUERY_ROWS}.` }),
			),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		structuredOutputSchema: Type.Object({
			rows: Type.Array(entrySchema),
			total: Type.Integer({ description: "How many entries match in all." }),
			next_offset: Type.Union([Type.Integer(), Type.Null()], {
				description: "Pass as offset to get the next page; null at the end.",
			}),
		}),
		callers: ["tools"],
		replay: "safe",
		async execute(args) {
			const account = args.account === undefined ? undefined : resolveAccount(args.account);
			const uncategorized = args.category !== undefined && nameKey(args.category) === "uncategorized";
			const category =
				args.category === undefined || uncategorized
					? undefined
					: store.listCategories(db).find((candidate) => candidate.key === nameKey(args.category as string));
			if (args.category !== undefined && !uncategorized && category === undefined) {
				throw new Error(`No category called '${args.category.slice(0, 40)}'. ledger_accounts lists the categories.`);
			}
			const currency = args.currency?.trim().toUpperCase() ?? account?.currency ?? defaultCurrency;
			const filter: store.TxnFilter = {
				...(args.from === undefined ? {} : { from: args.from }),
				...(args.to === undefined ? {} : { to: args.to }),
				...(account === undefined ? {} : { accountId: account.id }),
				...(category === undefined ? {} : { categoryId: category.id }),
				...(uncategorized ? { uncategorized: true } : {}),
				...(args.merchant === undefined ? {} : { merchant: args.merchant }),
				...(args.text === undefined ? {} : { text: args.text }),
				...(args.currency === undefined ? {} : { currency }),
				kind: args.kind ?? "all",
				...(args.min_amount === undefined ? {} : { minMinor: toMinor(args.min_amount, currency, "min_amount") }),
				...(args.max_amount === undefined ? {} : { maxMinor: toMinor(args.max_amount, currency, "max_amount") }),
			};
			const limit = args.limit ?? DEFAULT_QUERY_ROWS;
			const offset = args.offset ?? 0;
			const { rows, total } = store.queryTxns(db, filter, { limit, offset, order: args.order ?? "oldest" });
			const next = offset + rows.length < total ? offset + rows.length : null;
			return {
				output: text(`${rows.length} of ${total} entries.`),
				structuredOutput: {
					rows: rows.map((row) => ({
						id: row.id,
						date: row.date,
						amount_minor: row.amountMinor,
						currency: row.currency,
						account: row.account,
						category: row.category ?? null,
						merchant: row.merchant,
						note: row.note,
						kind: kindOf(row),
					})),
					total,
					next_offset: next,
				},
			};
		},
	});

	const ledgerAccounts = defineTool({
		name: "ledger_accounts",
		description:
			"The accounts with what each holds now (integers of minor units), and the categories, as data for a script. Balances are worked out in code: use these, do not rebuild them from entries.",
		parameters: Type.Object({}),
		structuredOutputSchema: Type.Object({
			accounts: Type.Array(
				Type.Object({
					name: Type.String(),
					kind: Type.String(),
					currency: Type.String(),
					balance_minor: Type.Integer(),
					archived: Type.Boolean(),
				}),
			),
			categories: Type.Array(
				Type.Object({ name: Type.String(), kind: Type.Union([Type.Literal("expense"), Type.Literal("income")]) }),
			),
			default_currency: Type.String(),
		}),
		callers: ["tools"],
		replay: "safe",
		async execute() {
			const accounts = store.listAccounts(db, true).map((account) => ({
				name: account.name,
				kind: account.kind,
				currency: account.currency,
				balance_minor: store.accountBalance(db, account.id).amountMinor,
				archived: account.archived,
			}));
			return {
				output: text(`${accounts.length} accounts.`),
				structuredOutput: {
					accounts,
					categories: store.listCategories(db).map((category) => ({ name: category.name, kind: category.kind })),
					default_currency: defaultCurrency,
				},
			};
		},
	});

	return [ledgerQuery, ledgerAccounts];
}
