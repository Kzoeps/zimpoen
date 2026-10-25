import { type AccountantNoteCard, formatMoney } from "@assistant/shared";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ApprovalAction } from "../approvals/service.ts";
import { createResolvers, currencyCode, DAY_HELP, defaultCurrencyOf, type LedgerDeps } from "../ledger/common.ts";
import { toBasisPoints, toMinor } from "../money.ts";
import { localDate } from "../time.ts";
import { asDetails, dayText, oneLine, text } from "../tool-support.ts";
import { type BillExtra, type BillItem, type SplitResult, splitEqually, splitItems } from "./compute.ts";
import { ambiguousPayer, createPersonResolver, lookalikes, type PersonRef } from "./people.ts";
import { billCard, billText, debtText, oweText, settlementLine, whoOwesCard } from "./reports.ts";
import * as store from "./store.ts";

const MAX_PEOPLE = 30;
const MAX_ITEMS = 100;
const MAX_LISTED = 30;
const DEFAULT_LISTED = 12;

type SplitArgs = {
	title: string;
	payer: string;
	people: string[];
	items?: Array<{ description: string; amount: number; shared_by?: string[] | undefined }> | undefined;
	extras?: Array<{ label: string; amount?: number | undefined; percent?: number | undefined }> | undefined;
	total?: number | undefined;
	date?: string | undefined;
	currency?: string | undefined;
	receipt_file_id?: string | undefined;
	note?: string | undefined;
};

const noteCard = (heading: string, lines: string[]): AccountantNoteCard => ({
	type: "accountant_note",
	heading,
	lines,
});

const nameList = (people: readonly PersonRef[]): string => people.map((person) => person.name).join(", ");

/**
 * The tools of the splits: who had what on a bill, what each person owes the one who paid, and what is still owed after
 * payments back. Every share is worked out in `compute.ts` and adds up to the bill exactly; the model reads the bill and
 * says who had what, it never adds or divides. Each tool is replay-safe through `source_call_id UNIQUE` (rule 8) and
 * looks for its earlier result before it reads the clock.
 */
export function createSplitTools(deps: LedgerDeps): ToolRegistration[] {
	const { db, timezone, approvals } = deps;
	const defaultCurrency = defaultCurrencyOf(deps);
	const { resolveDay, receiptId } = createResolvers(deps);
	const { resolve } = createPersonResolver(deps);
	const conversationOf = (api: ToolExecutionApi): number => Number(api.conversationId);

	// ----- splitting a bill ----------------------------------------------------------------------------------------------

	/** The people a call names, each once (the same person under two words is one), in the order given. */
	function resolvePeople(names: readonly string[], field: string): PersonRef[] {
		const seen = new Map<string, PersonRef>();
		for (const typed of names) {
			const person = resolve(typed, field);
			if (!seen.has(person.key)) seen.set(person.key, person);
		}
		return [...seen.values()];
	}

	/** Items with their sharers, in minor units; everything the model typed is checked against `people`. */
	function readItems(args: SplitArgs, people: readonly PersonRef[], currency: string): BillItem[] {
		const byKey = new Map(people.map((person) => [person.key, person]));
		return (args.items ?? []).map((item, index) => {
			const where = `items[${index}]`;
			const description = oneLine(item.description).slice(0, 120);
			if (description === "") throw new Error(`${where}.description is empty.`);
			const amountMinor = toMinor(item.amount, currency, `${where}.amount`);
			if (amountMinor <= 0) {
				throw new Error(
					`${where}.amount must be above zero ('${description}'). A discount or a service charge is not an item: put it in extras, with a negative amount for a discount.`,
				);
			}
			const sharers = item.shared_by === undefined ? [...people] : resolvePeople(item.shared_by, `${where}.shared_by`);
			if (sharers.length === 0)
				throw new Error(`${where}.shared_by is empty: who had '${description}'? Leave it out for everyone.`);
			for (const sharer of sharers) {
				if (!byKey.has(sharer.key)) {
					throw new Error(
						`${where}.shared_by names ${sharer.name}, who is not in people (${nameList(people)}). Add them to people, or fix the name.`,
					);
				}
			}
			return { description, amountMinor, sharedBy: sharers.map((sharer) => sharer.key) };
		});
	}

	/** Tax, service and tip as the bill prints them (an amount) or as a percentage of the items. */
	function readExtras(args: SplitArgs, currency: string): BillExtra[] {
		return (args.extras ?? []).map((extra, index) => {
			const where = `extras[${index}]`;
			const label = oneLine(extra.label).slice(0, 60);
			if (label === "")
				throw new Error(`${where}.label is empty: say what it is (Service charge, GST, tip, discount).`);
			if ((extra.amount === undefined) === (extra.percent === undefined)) {
				throw new Error(
					`${where} ('${label}') needs exactly one of amount (as printed on the bill) or percent (of the items).`,
				);
			}
			if (extra.amount !== undefined) {
				const amountMinor = toMinor(extra.amount, currency, `${where}.amount`);
				if (amountMinor === 0) throw new Error(`${where}.amount of '${label}' is zero: leave it out.`);
				return { label, amountMinor };
			}
			const percent = extra.percent as number;
			const points = toBasisPoints(Math.abs(percent), `${where}.percent`);
			if (points === 0) throw new Error(`${where}.percent of '${label}' is zero: leave it out.`);
			return { label, basisPoints: percent < 0 ? -points : points };
		});
	}

	/** Share the bill, and check it against the total the model read from it. `items` is empty for an equal split. */
	function shareBill(
		args: SplitArgs,
		people: readonly PersonRef[],
		currency: string,
	): { result: SplitResult; items: BillItem[] } {
		const keys = people.map((person) => person.key);
		if (args.items === undefined || args.items.length === 0) {
			if (args.extras !== undefined && args.extras.length > 0) {
				throw new Error(
					"extras need items to be shared by. Without items give total, the amount printed on the bill, and it is shared equally.",
				);
			}
			if (args.total === undefined) {
				throw new Error("Give either items (what each person had) or total (the bill's amount, to be shared equally).");
			}
			return { result: splitEqually(keys, toMinor(args.total, currency, "total")), items: [] };
		}
		const items = readItems(args, people, currency);
		const result = splitItems(keys, items, readExtras(args, currency));
		if (args.total !== undefined) {
			const stated = toMinor(args.total, currency, "total");
			if (stated !== result.totalMinor) {
				const money = (minor: number): string => formatMoney(minor, currency);
				throw new Error(
					`The bill does not add up: the items come to ${money(result.itemsMinor)} and the extras to ${money(result.extrasMinor)}, ${money(result.totalMinor)} together, but total says ${money(stated)} (${money(Math.abs(stated - result.totalMinor))} ${stated > result.totalMinor ? "more" : "less"}). Check the bill for an item or a charge that is missing or was read wrongly, then call again.`,
				);
			}
		}
		return { result, items };
	}

	const billResult = (bill: store.BillView, notes: readonly string[] = []) => ({
		output: text(billText(bill, timezone, notes)),
		details: asDetails(billCard(bill, timezone)),
	});

	const splitBill = defineTool({
		name: "split_bill",
		description:
			"Split a bill that one person paid among the people who shared it, and remember who owes whom. Read the bill (a photo with read_file, or what the owner typed) and pass what each person had; " +
			"the tool does all the arithmetic, shares tax, service and tip in proportion, and the shares add up to the total exactly. Pass the amounts exactly as printed; never add, divide or round anything yourself. " +
			"Without items, pass total and it is shared equally. It does not change the owner's accounts.",
		parameters: Type.Object({
			title: Type.String({
				minLength: 1,
				maxLength: 120,
				description: "What the bill was: 'Dinner at Folk Heritage'.",
			}),
			payer: Type.String({ description: "Who paid the whole bill: 'me' for the owner, or a friend's name." }),
			people: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), {
				minItems: 1,
				maxItems: MAX_PEOPLE,
				description:
					"Everyone who shared the bill, the payer included when they had a share too ('me' for the owner). Use the same spelling of a friend's name every time: people are matched by their whole name.",
			}),
			items: Type.Optional(
				Type.Array(
					Type.Object({
						description: Type.String({ minLength: 1, maxLength: 120 }),
						amount: Type.Number({
							exclusiveMinimum: 0,
							description: "The line's amount as printed, in major units.",
						}),
						shared_by: Type.Optional(
							Type.Array(Type.String(), {
								description: "Who had it, shared equally. Leave it out for everyone in people.",
							}),
						),
					}),
					{ maxItems: MAX_ITEMS, description: "The lines of the bill and who had each." },
				),
			),
			extras: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ minLength: 1, maxLength: 60, description: "Service charge, GST, tip, discount." }),
						amount: Type.Optional(Type.Number({ description: "As printed on the bill. Negative for a discount." })),
						percent: Type.Optional(
							Type.Number({
								description:
									"Instead of an amount: a percentage of the items (10 for 10 %). Each is of the items alone, not of the others.",
							}),
						),
					}),
					{ maxItems: 10, description: "Tax, service charge, tip or a discount, shared in proportion to the items." },
				),
			),
			total: Type.Optional(
				Type.Number({
					exclusiveMinimum: 0,
					description:
						"The total printed on the bill. With items it is a check: the call fails when it differs from what the items and extras add up to. Without items it is the amount to share equally.",
				}),
			),
			date: Type.Optional(Type.String({ description: DAY_HELP })),
			currency: Type.Optional(
				Type.String({ description: `A three-letter code, only when the bill is not in ${defaultCurrency}.` }),
			),
			receipt_file_id: Type.Optional(
				Type.String({ description: "The file id (fi_...) of the photo of the bill: it is linked to the split." }),
			),
			note: Type.Optional(Type.String({ maxLength: 300 })),
		}),
		replay: "safe",
		async execute(args, api) {
			// Rule 8: a replay finds what its first run wrote before it checks anything (the checks read the clock).
			const earlier = store.billByCallId(db, api.callId);
			if (earlier !== undefined) return billResult(earlier);

			const title = oneLine(args.title).slice(0, 120);
			if (title === "") throw new Error("A bill needs a title: what was it?");
			const date = resolveDay(args.date, localDate(api.now(), timezone));
			const currency = args.currency === undefined ? defaultCurrency : currencyCode(args.currency);
			const payer = resolve(args.payer, "payer");
			const people = resolvePeople(args.people, "people");
			if (people.every((person) => person.key === payer.key)) {
				throw new Error(
					`Only ${payer.name} shares this bill, so there is nothing to split. Put everyone who shared it in people (the payer too, if they had a share).`,
				);
			}
			const { result, items } = shareBill(args, people, currency);
			const receipt = receiptId(args.receipt_file_id);
			// Before the bill is written: afterwards every name in it is a known one.
			const notes = lookalikes(db, [payer, ...people]);
			const peopleByKey = new Map(people.map((person) => [person.key, person]));
			const { bill } = store.insertBill(
				db,
				{
					title,
					date,
					payerKey: payer.key,
					payerName: payer.name,
					totalMinor: result.totalMinor,
					currency,
					equal: items.length === 0,
					extras: result.extras,
					...(receipt === undefined ? {} : { sourceRef: receipt }),
					note: oneLine(args.note ?? "").slice(0, 300),
					items: items.map((item) => ({
						description: item.description,
						amountMinor: item.amountMinor,
						sharedBy: item.sharedBy.map((key) => peopleByKey.get(key)?.name ?? key),
					})),
					shares: result.shares.map((share) => {
						const person = peopleByKey.get(share.key) as PersonRef;
						return {
							personKey: person.key,
							personName: person.name,
							...(person.personId === undefined ? {} : { personId: person.personId }),
							itemsMinor: share.itemsMinor,
							extrasMinor: share.extrasMinor,
							owedMinor: share.owedMinor,
						};
					}),
					now: api.now(),
				},
				api.callId,
			);
			return billResult(bill, notes);
		},
	});

	// ----- who owes whom --------------------------------------------------------------------------------------------------

	/** The person a call names among those the bills know: a whole name, or a part that only one person has. */
	function findKnown(typed: string): PersonRef {
		const person = resolve(typed, "person");
		const known = store.knownPeople(db);
		if (known.has(person.key)) return { key: person.key, name: known.get(person.key) as string };
		const partial = [...known.entries()].filter(([key]) => key.includes(person.key));
		if (partial.length === 1)
			return { key: (partial[0] as [string, string])[0], name: (partial[0] as [string, string])[1] };
		const names = [...known.values()].filter((name) => name !== "You");
		throw new Error(
			partial.length > 1
				? `'${person.name}' could mean ${partial.map(([, name]) => name).join(" or ")}. Use the full name.`
				: `No bill or payment mentions '${person.name}'.${names.length === 0 ? " No bill has been split yet." : ` People so far: ${names.join(", ")}.`}`,
		);
	}

	const whoOwes = defineTool({
		name: "who_owes",
		description:
			"Who owes whom after every bill and payment back, netted per pair of people. Pass person for one person's balances. Amounts are never converted between currencies.",
		parameters: Type.Object({
			person: Type.Optional(Type.String({ description: "Only the balances of this person ('me' for the owner)." })),
		}),
		replay: "safe",
		async execute(args) {
			const all = store.openBalances(db);
			const who = args.person === undefined ? undefined : findKnown(args.person);
			const debts =
				who === undefined ? all : all.filter((debt) => debt.debtorKey === who.key || debt.creditorKey === who.key);
			const heading = who === undefined ? "Who owes whom" : `Balances of ${who.name}`;
			const output =
				debts.length === 0
					? who === undefined
						? store.knownPeople(db).size === 0
							? "Nothing is owed: no bill has been split yet."
							: "Nothing is owed: every bill is settled."
						: `${who.name} ${who.key === store.OWNER_KEY ? "have" : "has"} nothing open: every bill with ${who.key === store.OWNER_KEY ? "you" : "them"} is settled.`
					: `${debts.map(debtText).join("\n")}\n(Netted per pair of people; bills in different currencies are listed apart.)`;
			return { output: text(output), details: asDetails(whoOwesCard(heading, debts)) };
		},
	});

	// ----- paying back ------------------------------------------------------------------------------------------------------

	const settlementResult = (row: store.SettlementRow) => {
		const from = { key: row.fromKey, name: row.fromName };
		const to = { key: row.toKey, name: row.toName };
		const lines = [`Recorded: ${settlementLine(row)} on ${dayText(row.date, timezone)} (${row.id}).`];
		const between = store.balanceBetween(db, row.fromKey, row.toKey, row.currency);
		if (between === 0)
			lines.push(
				`${from.key === store.OWNER_KEY ? "You" : from.name} and ${to.key === store.OWNER_KEY ? "you" : to.name} are settled up.`,
			);
		else if (between > 0) lines.push(`${oweText(from, to, between, row.currency)} still.`);
		else
			lines.push(
				`That is more than was owed. Now ${oweText(to, from, -between, row.currency).replace(/^You owe/, "you owe")}.`,
			);
		lines.push(
			"This is only the record between people: it does not change the owner's accounts. If the money arrived in one, the balance there is corrected when the owner next states it (set_balance).",
		);
		return {
			output: text(lines.join("\n")),
			details: asDetails(noteCard("Payment recorded", lines.slice(0, 2))),
		};
	};

	const recordSettlement = defineTool({
		name: "record_settlement",
		description:
			"Record that someone paid money back toward a split bill: 'Pema paid me 500' is from Pema to me. 'I paid Pema 300' is from me to Pema. Says what is still owed between the two afterwards. " +
			"Use the name as the bills have it. A name that is only part of someone the bills know ('Pema' for 'Pema Dorji') is not guessed: the tool records nothing and says whom to ask about. " +
			"Use it for payments between people only; it does not add income to an account.",
		parameters: Type.Object({
			from: Type.String({ description: "Who paid ('me' for the owner)." }),
			to: Type.String({ description: "Who received it ('me' for the owner)." }),
			amount: Type.Number({ exclusiveMinimum: 0, description: "In major units, as stated." }),
			currency: Type.Optional(Type.String({ description: `A three-letter code. Default ${defaultCurrency}.` })),
			date: Type.Optional(Type.String({ description: DAY_HELP })),
			note: Type.Optional(Type.String({ maxLength: 300 })),
			new_person: Type.Optional(
				Type.Boolean({
					description:
						"Only after the tool asked which person you meant: true when the name really is somebody other than the people it listed.",
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.settlementByCallId(db, api.callId);
			if (earlier !== undefined) return settlementResult(earlier);

			const from = resolve(args.from, "from");
			const to = resolve(args.to, "to");
			if (from.key === to.key) throw new Error(`Both are ${from.name}: a payment needs two different people.`);
			if (args.new_person !== true) {
				// A payment from "Pema" while "Pema Dorji" owes the owner would reverse the debt and leave the real one open.
				const doubt = ambiguousPayer(db, [
					{ role: "from", person: from },
					{ role: "to", person: to },
				]);
				if (doubt !== undefined) throw new Error(doubt);
			}
			const currency = args.currency === undefined ? defaultCurrency : currencyCode(args.currency);
			const amountMinor = toMinor(args.amount, currency, "amount");
			if (amountMinor <= 0) throw new Error("amount must be above zero.");
			const date = resolveDay(args.date, localDate(api.now(), timezone));
			const { row } = store.insertSettlement(
				db,
				{
					date,
					fromKey: from.key,
					fromName: from.name,
					toKey: to.key,
					toName: to.name,
					amountMinor,
					currency,
					note: oneLine(args.note ?? "").slice(0, 300),
					now: api.now(),
				},
				api.callId,
			);
			return settlementResult(row);
		},
	});

	// ----- finding and deleting (deferred: rarely needed) ---------------------------------------------------------------------

	const listSplits = defineTool({
		name: "list_splits",
		deferred: true,
		description:
			"The bills that were split and the payments back, newest first, with their ids (b_... and s_...): to find one to delete with propose_delete_split, or to answer 'what did we split last week'.",
		parameters: Type.Object({
			person: Type.Optional(Type.String({ description: "Only bills this person paid or shared, and their payments." })),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_LISTED, description: `Default ${DEFAULT_LISTED}.` }),
			),
		}),
		replay: "safe",
		async execute(args) {
			const limit = args.limit ?? DEFAULT_LISTED;
			const who = args.person === undefined ? undefined : findKnown(args.person);
			const options = { ...(who === undefined ? {} : { personKey: who.key }), limit };
			const { bills, total } = store.listBills(db, options);
			const { rows, total: payments } = store.listSettlements(db, options);
			const entries = [
				...bills.map((bill) => ({
					date: bill.date,
					at: bill.createdAt,
					line: `${bill.id} · ${dayText(bill.date, timezone)} · ${bill.title} · ${bill.payerName} paid ${formatMoney(bill.totalMinor, bill.currency)} · shared by ${bill.shares.length}`,
				})),
				...rows.map((row) => ({
					date: row.date,
					at: row.createdAt,
					line: `${row.id} · ${dayText(row.date, timezone)} · ${settlementLine(row)}`,
				})),
			]
				.sort((a, b) => (a.date === b.date ? b.at - a.at : a.date < b.date ? 1 : -1))
				.slice(0, limit)
				.map((entry) => entry.line);
			const heading = who === undefined ? "Bills and payments" : `Bills and payments of ${who.name}`;
			const more = total + payments - entries.length;
			if (entries.length === 0)
				return { output: text("No bill or payment matches."), details: asDetails(noteCard(heading, ["Nothing yet."])) };
			return {
				output: text(`${entries.join("\n")}${more > 0 ? `\n… and ${more} more (raise limit, or name a person).` : ""}`),
				details: asDetails(noteCard(heading, entries)),
			};
		},
	});

	const proposeDelete = defineTool({
		name: "propose_delete_split",
		deferred: true,
		description:
			"Ask the owner to approve deleting a bill (b_...) or a payment (s_...) for good: one entered with a wrong name or amount. Nothing is deleted until they tap Approve or reply YES; never say it is deleted before they have. Enter the corrected bill again afterwards with split_bill.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, description: "The bill or payment id, as split_bill or list_splits gave it." }),
		}),
		replay: "safe",
		async execute(args, api) {
			const id = args.id.trim();
			const summary = describeForDeletion(id);
			const state = approvals.propose({
				conversationId: conversationOf(api),
				tool: "delete_split",
				args: { id },
				summary,
				callId: api.callId,
			});
			return {
				output: text(
					`Approval requested (${state.id}): ${state.summary}. ` +
						(state.status === "pending"
							? "Nothing is deleted yet. Tell the owner to tap Approve on the card. Do not say it is deleted until they have answered; list_splits shows whether it went through."
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

	function describeForDeletion(id: string): string {
		const bill = id.startsWith("b_") ? store.getBill(db, id) : undefined;
		if (bill !== undefined) {
			return `Delete the bill '${bill.title}' (${bill.id}): ${formatMoney(bill.totalMinor, bill.currency)} paid by ${bill.payerName}, shared by ${bill.shares.length}`;
		}
		const payment = id.startsWith("s_") ? store.getSettlement(db, id) : undefined;
		if (payment !== undefined) return `Delete the payment ${settlementLine(payment)} (${payment.id})`;
		throw new Error(`No bill or payment has the id '${oneLine(id).slice(0, 30)}'. list_splits shows the ids.`);
	}

	const deleteSplit = defineTool({
		name: "delete_split",
		deferred: true,
		description:
			"Permanently delete a bill or a payment. Blocked unless the owner has approved exactly this deletion: do not call it yourself, use propose_delete_split and wait for their answer. (The assistant normally carries out an approved deletion by itself.)",
		parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
		replay: "safe",
		async execute(args, api) {
			return { output: text(await approvals.runApproved(conversationOf(api), "delete_split", { id: args.id })) };
		},
	});

	return [splitBill, whoOwes, recordSettlement, listSplits, proposeDelete, deleteSplit];
}

/** Deleting a bill or a payment cannot be undone (rule 3): the owner approves it first. */
export function createSplitApprovalActions(deps: Pick<LedgerDeps, "db">): ApprovalAction[] {
	const { db } = deps;
	return [
		{
			tool: "delete_split",
			proposeTool: "propose_delete_split",
			target: (args) => `split:${String(args.id).trim()}`,
			run: (args) => {
				const id = String(args.id).trim();
				if (id.startsWith("b_")) {
					const bill = store.deleteBill(db, id);
					return bill === undefined
						? `The bill ${id} was already gone.`
						: `Deleted the bill '${bill.title}' (${formatMoney(bill.totalMinor, bill.currency)}).`;
				}
				const payment = store.deleteSettlement(db, id);
				return payment === undefined
					? `The payment ${id} was already gone.`
					: `Deleted the payment: ${settlementLine(payment)}.`;
			},
		},
	];
}
