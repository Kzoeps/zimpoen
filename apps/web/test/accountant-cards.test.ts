import type {
	AccountantNoteCard,
	BalancesCard,
	EntryRecord,
	ImportPreviewCard,
	ImportResultCard,
	InvoiceCard,
	InvoiceListCard,
	SpendingCard,
	SplitCard,
	TxnCard,
	TxnListCard,
	WhoOwesCard,
} from "@assistant/shared";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	AccountantNoteView,
	BalancesView,
	ImportPreviewView,
	ImportResultView,
	InvoiceListView,
	InvoiceView,
	oweSentence,
	SpendingView,
	SplitView,
	TxnListView,
	TxnView,
	WhoOwesView,
} from "../src/components/accountant-cards.tsx";
import { cardSummary } from "../src/lib/card-text.ts";
import { toUiMessages, type UiCard, type UiMessage } from "../src/lib/ui-messages.ts";

function render<Card>(component: (props: { card: Card }) => ReactElement, card: Card): string {
	return renderToStaticMarkup(createElement(component, { card }));
}

const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

const lunch = {
	id: "x_aaaa0001",
	date: "2026-10-25",
	dateText: "Sun 25 Oct 2026",
	amountMinor: -45_000,
	currency: "BTN",
	account: "BoB savings",
	kind: "expense" as const,
	category: "food",
	merchant: "Druk <Mart>",
	receipt: { id: "fi_aaaa0001", name: "receipt.jpg", mime: "image/jpeg" },
};

describe("entries", () => {
	it("shows an expense with its amount, category, account and receipt, and escapes what the merchant is called", () => {
		const markup = render(TxnView, { type: "txn", txns: [lunch] } satisfies TxnCard);
		expect(markup).toContain("Expense recorded");
		expect(markup).toContain('<span class="money money--out">-Nu. 450.00</span>');
		expect(markup).toContain("Druk &lt;Mart&gt;");
		expect(markup).not.toContain("<Mart>");
		expect(markup).toContain("Sun 25 Oct 2026 · BoB savings");
		expect(markup).toContain('<span class="badge">food</span>');
		expect(markup).toContain('href="/api/files/fi_aaaa0001"');
		expect(markup).toContain("x_aaaa0001");
	});

	it("says income came in, a transfer moved, and an entry that looks like an earlier one", () => {
		const income = render(TxnView, {
			type: "txn",
			txns: [{ ...lunch, kind: "income", amountMinor: 5_000_000, merchant: "Acme" }],
			similarTo: "x_bbbb0002",
		});
		expect(income).toContain("Income recorded");
		expect(income).toContain('<span class="money money--in">+Nu. 50,000.00</span>');
		expect(income).toContain("An entry like this one was already there (x_bbbb0002).");
		const transfer = render(TxnView, {
			type: "txn",
			txns: [
				{ ...lunch, id: "x_1", kind: "transfer", amountMinor: -50_000, merchant: undefined, receipt: undefined },
				{
					...lunch,
					id: "x_2",
					kind: "transfer",
					account: "Cash",
					amountMinor: 50_000,
					merchant: undefined,
					receipt: undefined,
				},
			],
		});
		expect(transfer).toContain("Transfer recorded");
		expect(count(transfer, 'class="txn"')).toBe(2);
		expect(transfer).toContain("BoB savings");
		expect(transfer).toContain("Cash");
	});

	it("lists entries with the totals over all of them and how many are not shown", () => {
		const markup = render(TxnListView, {
			type: "txn_list",
			heading: "Entries, last 30 days",
			txns: [lunch],
			total: 12,
			sums: [{ currency: "BTN", outMinor: 123_456, inMinor: 5_000_000 }],
		} satisfies TxnListCard);
		expect(markup).toContain("Entries, last 30 days");
		expect(markup).toContain("(12)");
		expect(markup).toContain("…and 11 more");
		expect(markup).toContain("All 12: out Nu. 1,234.56 · in Nu. 50,000.00");
		expect(render(TxnListView, { type: "txn_list", heading: "Entries", txns: [], total: 0, sums: [] })).toContain(
			"No entries.",
		);
	});
});

describe("balances", () => {
	const card: BalancesCard = {
		type: "balances",
		accounts: [
			{
				account: "BoB savings",
				kind: "bank",
				currency: "BTN",
				amountMinor: 8_449_500,
				basis: "snapshot",
				asOfText: "Sun 25 Oct 2026",
				entriesSince: 2,
			},
			{ account: "Cash", kind: "cash", currency: "BTN", amountMinor: 120_000, basis: "entries", entriesSince: 3 },
			{
				account: "Wise",
				kind: "wallet",
				currency: "USD",
				amountMinor: 50_000,
				basis: "snapshot",
				asOfText: "Fri 23 Oct 2026",
				entriesSince: 0,
			},
		],
		totals: [
			{ currency: "BTN", amountMinor: 8_569_500 },
			{ currency: "USD", amountMinor: 50_000 },
		],
		converted: { currency: "BTN", amountMinor: 12_769_500, missing: ["EUR"] },
	};

	it("shows what each account holds and how that was worked out", () => {
		const markup = render(BalancesView, card);
		expect(markup).toContain("Nu. 84,495.00");
		expect(markup).toContain("as of Sun 25 Oct 2026, and 2 entries since");
		expect(markup).toContain("from entries only: no balance stated yet");
		expect(markup).toContain("USD 500.00");
		expect(markup).not.toContain("and 0 entries");
	});

	it("totals per currency when there are several, and says which currency had no rate", () => {
		const markup = render(BalancesView, card);
		expect(markup).toContain("Total BTN");
		expect(markup).toContain("Total USD");
		expect(markup).toContain("All in BTN");
		expect(markup).toContain("Nu. 127,695.00");
		expect(markup).toContain("No rate given for EUR: left out.");
		expect(
			render(BalancesView, {
				...card,
				totals: [card.totals[0] as { currency: string; amountMinor: number }],
				converted: undefined,
			}),
		).not.toContain("Total BTN");
	});
});

describe("spending", () => {
	const card: SpendingCard = {
		type: "spending",
		heading: "Spending by category",
		rangeText: "October 2026",
		groupBy: "category",
		currency: "BTN",
		totalMinor: 155_050,
		count: 6,
		incomeMinor: 5_000_000,
		groups: [
			{ label: "groceries", amountMinor: 125_050, count: 3, tenths: 807 },
			{ label: "transport", amountMinor: 30_000, count: 3, tenths: 193 },
		],
		others: [{ currency: "USD", totalMinor: 2_000, count: 1 }],
	};

	it("draws a bar as wide as each group's share, with the amount and the share beside it", () => {
		const markup = render(SpendingView, card);
		expect(markup).toContain("Nu. 1,550.50");
		expect(markup).toContain('style="width:80.7%"');
		expect(markup).toContain('style="width:19.3%"');
		expect(markup).toContain("80.7%");
		expect(markup).toContain("19.3%");
		expect(markup).toContain('aria-label="groceries: 80.7%"');
		expect(count(markup, 'class="bar__fill"')).toBe(2);
		expect(markup).toContain("6 entries");
		expect(markup).toContain("Nu. 50,000.00 came in over the same days");
		expect(markup).toContain("Also USD 20.00 in 1 entry (not converted).");
	});

	it("says so when nothing was spent", () => {
		const markup = render(SpendingView, { ...card, totalMinor: 0, count: 0, incomeMinor: 0, groups: [], others: [] });
		expect(markup).toContain("Nothing spent.");
		expect(markup).not.toContain("bar__fill");
	});
});

describe("a statement to import", () => {
	const preview: ImportPreviewCard = {
		type: "import_preview",
		importId: "im_aaaa0001",
		fileName: "bob-october.csv",
		account: "BoB savings",
		currency: "BTN",
		encoding: "UTF-8",
		delimiter: ",",
		dateOrder: "DMY",
		columns: [
			{ header: "Date", role: "date" },
			{ header: "Details", role: "description" },
			{ header: "Debit", role: "debit" },
			{ header: "Credit", role: "credit" },
			{ header: "Balance", role: "ignored" },
		],
		rows: 3,
		skipped: 1,
		duplicates: 1,
		outMinor: 155_050,
		outCount: 2,
		inMinor: 12_000_000,
		inCount: 1,
		uncategorized: 2,
		firstDate: "2026-10-01",
		lastDate: "2026-10-13",
		sample: [
			{ dateText: "Thu 1 Oct 2026", amountMinor: 12_000_000, description: "SALARY OCTOBER", duplicate: false },
			{
				dateText: "Fri 2 Oct 2026",
				amountMinor: -125_050,
				description: "DRUK MART 77123",
				category: "groceries",
				duplicate: true,
			},
		],
		problems: ["Row 9 has no date."],
	};

	it("says what was found and what importing would do, with the confirm button it is given", () => {
		const markup = renderToStaticMarkup(
			createElement(ImportPreviewView, {
				card: preview,
				action: createElement("button", { type: "button" }, "Confirm import"),
			}),
		);
		expect(markup).toContain("3 entries into BoB savings");
		expect(markup).toContain("2026-10-01 to 2026-10-13");
		expect(markup).toContain("UTF-8 · separator “,” · dates day first");
		expect(markup).toContain("Debit → money out");
		expect(markup).toContain("Balance → ignored");
		expect(markup).toContain("Nu. 1,550.50");
		expect(markup).toContain("Nu. 120,000.00");
		expect(markup).toContain("Already there");
		expect(markup).toContain("Unreadable rows");
		expect(markup).toContain("SALARY OCTOBER");
		expect(markup).toContain('class="txn txn--duplicate"');
		expect(markup).toContain("Row 9 has no date.");
		expect(markup).toContain("Confirm import</button>");
	});

	it("says loudly what looks wrong, and lists the rows that look like entries the owner already has", () => {
		const flagged: ImportPreviewCard = {
			...preview,
			warnings: ["Every one of the 12 rows is money IN and none goes out. Check the Dr/Cr column."],
			matchCount: 12,
			matches: [
				{
					line: 7,
					dateText: "Mon 5 Oct 2026",
					amountMinor: -45_000,
					description: "DRUK <MART> 123456",
					entry: { id: "x_bbbb0002", dateText: "Mon 5 Oct 2026", merchant: "Druk Mart", source: "chat" },
				},
				{
					line: 9,
					dateText: "Tue 6 Oct 2026",
					amountMinor: -12_000,
					description: "CAFE",
					entry: { id: "x_bbbb0003", dateText: "Tue 6 Oct 2026", merchant: "", source: "receipt" },
				},
			],
			sample: [{ ...(preview.sample[0] as ImportPreviewCard["sample"][number]), match: true }],
			columns: [...preview.columns.slice(0, 2), { header: "Dr/Cr", role: "direction" as const }],
		};
		const markup = renderToStaticMarkup(createElement(ImportPreviewView, { card: flagged }));
		expect(markup).toContain('aria-label="Warnings"');
		expect(markup).toContain("Every one of the 12 rows is money IN and none goes out.");
		expect(markup).toContain("12 rows look like entries you already have");
		expect(markup).toContain("they are left out");
		expect(markup).toContain("line 7 · Mon 5 Oct 2026 · like Druk Mart on Mon 5 Oct 2026 (typed) · x_bbbb0002");
		expect(markup).toContain("line 9 · Tue 6 Oct 2026 · like an entry on Tue 6 Oct 2026 (receipt) · x_bbbb0003");
		expect(markup).toContain("DRUK &lt;MART&gt; 123456");
		expect(markup).toContain("…and 10 more");
		expect(markup).toContain("Look like entries you have");
		expect(markup).toContain("looks like an entry you have");
		// The role is named by what it does, not by the file's own header (which may be the same words).
		expect(markup).toContain("Dr/Cr → in or out");
		// A preview from before these fields existed draws as it did.
		const plain = renderToStaticMarkup(createElement(ImportPreviewView, { card: preview }));
		expect(plain).not.toContain("Warnings");
		expect(plain).not.toContain("you already have");
	});

	it("loses its button once the import was confirmed", () => {
		const markup = renderToStaticMarkup(
			createElement(ImportPreviewView, {
				card: preview,
				answered: true,
				action: createElement("button", { type: "button" }, "Confirm import"),
			}),
		);
		expect(markup).not.toContain("<button");
		expect(markup).toContain("Confirmed: see the result below.");
	});

	it("reports what an import did, and that a second one did nothing", () => {
		const result: ImportResultCard = {
			type: "import_result",
			importId: "im_aaaa0001",
			account: "BoB savings",
			currency: "BTN",
			inserted: 3,
			duplicates: 1,
			outMinor: 155_050,
			inMinor: 12_000_000,
			already: false,
		};
		expect(render(ImportResultView, result)).toContain("3 entries in BoB savings");
		expect(render(ImportResultView, result)).toContain("1 already there, not added again");
		expect(render(ImportResultView, { ...result, skippedMatches: 2 })).toContain(
			"2 left out: they look like entries you already have",
		);
		const again = render(ImportResultView, { ...result, already: true });
		expect(again).toContain("Already imported");
		expect(again).toContain("Nothing changed: ");
	});

	it("marks the preview answered once a later result says that import was confirmed, and no other", () => {
		const entry = (id: number, card: unknown): EntryRecord =>
			({
				id,
				conversationId: 2,
				kind: "pi.tool-result",
				model: [
					{
						role: "toolResult",
						toolCallId: `c${id}`,
						toolName: "t",
						content: [],
						details: card,
						isError: false,
						timestamp: id * 1000,
					},
				],
			}) as unknown as EntryRecord;
		const other: ImportPreviewCard = { ...preview, importId: "im_bbbb0002" };
		const result: ImportResultCard = {
			type: "import_result",
			importId: "im_aaaa0001",
			account: "BoB savings",
			currency: "BTN",
			inserted: 3,
			duplicates: 0,
			outMinor: 0,
			inMinor: 0,
			already: false,
		};
		const messages: UiMessage[] = toUiMessages({
			entries: [entry(1, preview), entry(2, other), entry(3, result)],
			draft: undefined,
			unanswered: [],
		});
		const previews = messages.flatMap((message): UiCard[] =>
			message.role === "system" && message.card.type === "import_preview" ? [message.card] : [],
		);
		expect(
			previews.map((card) => [
				card.type === "import_preview" ? card.importId : "",
				card.type === "import_preview" ? card.answered === true : false,
			]),
		).toEqual([
			["im_aaaa0001", true],
			["im_bbbb0002", false],
		]);
	});
});

describe("a split bill", () => {
	const card: SplitCard = {
		type: "split",
		billId: "b_aaaa0001",
		title: "Lunch",
		dateText: "Sun 25 Oct 2026",
		payer: "Pema",
		currency: "BTN",
		totalMinor: 125_350,
		items: [
			{ description: "Momos", amountMinor: 45_000, sharedBy: ["You", "Pema"] },
			{ description: "Thukpa", amountMinor: 30_000, sharedBy: ["Tashi"] },
		],
		extras: [{ label: "Service charge", amountMinor: 10_900 }],
		shares: [
			{ person: "You", itemsMinor: 39_834, extrasMinor: 5_975, owedMinor: 45_809, paid: false },
			{ person: "Pema", itemsMinor: 30_833, extrasMinor: 4_625, owedMinor: 35_458, paid: true },
			{ person: "Tashi", itemsMinor: 38_333, extrasMinor: 5_750, owedMinor: 44_083, paid: false },
		],
		equal: false,
	};

	it("is a table of what each person had, the extras and what they owe, with the payer marked and the total at the foot", () => {
		const markup = render(SplitView, card);
		expect(markup).toContain("Lunch");
		expect(markup).toContain("Nu. 1,253.50 paid by Pema");
		expect(count(markup, "<tr")).toBe(5);
		expect(markup).toContain("Nu. 458.09");
		expect(markup).toContain("Nu. 354.58");
		expect(markup).toContain("Nu. 440.83");
		expect(markup).toContain('<span class="badge">paid</span>');
		expect(markup).toMatch(
			/<tfoot><tr><th scope="row">Total<\/th><td class="split__col"><\/td><td class="split__col"><\/td><td class="split__owed">Nu\. 1,253\.50<\/td>/,
		);
		expect(markup).toContain("Service charge: Nu. 109.00");
		expect(markup).toContain("Momos: Nu. 450.00");
		expect(markup).toContain("b_aaaa0001");
	});

	it("lists two extras that carry the same label, both of them", () => {
		const markup = render(SplitView, {
			...card,
			extras: [
				{ label: "Service charge", amountMinor: 10_900 },
				{ label: "Service charge", amountMinor: 500 },
			],
		});
		expect(markup).toContain("Service charge: Nu. 109.00");
		expect(markup).toContain("Service charge: Nu. 5.00");
	});

	it("leaves out the columns an equal split does not have", () => {
		const markup = render(SplitView, {
			...card,
			equal: true,
			items: [],
			extras: [],
			shares: [
				{ person: "You", itemsMinor: 33_334, extrasMinor: 0, owedMinor: 33_334, paid: false },
				{ person: "Pema", itemsMinor: 33_333, extrasMinor: 0, owedMinor: 33_333, paid: true },
			],
			totalMinor: 66_667,
		});
		expect(markup).toContain("shared equally");
		expect(markup).not.toContain("Items");
		expect(markup).not.toContain("Extras");
		expect(markup).not.toContain("The bill");
		expect(count(markup, '<th scope="col">')).toBe(2);
	});
});

describe("who owes whom", () => {
	it("says it the way the tools do, the owner spoken to", () => {
		expect(oweSentence({ debtor: "Pema", creditor: "You", amountMinor: 50_000, currency: "BTN" })).toBe(
			"Pema owes you Nu. 500.00",
		);
		expect(oweSentence({ debtor: "You", creditor: "Pema", amountMinor: 50_000, currency: "BTN" })).toBe(
			"You owe Pema Nu. 500.00",
		);
		expect(oweSentence({ debtor: "Tashi", creditor: "Pema", amountMinor: 700, currency: "USD" })).toBe(
			"Tashi owes Pema USD 7.00",
		);
		const markup = render(WhoOwesView, {
			type: "who_owes",
			heading: "Who owes whom",
			debts: [
				{ debtor: "Pema", creditor: "You", amountMinor: 50_000, currency: "BTN" },
				{ debtor: "You", creditor: "Karma", amountMinor: 3_000, currency: "BTN" },
			],
		} satisfies WhoOwesCard);
		expect(markup).toContain("Pema owes you Nu. 500.00");
		expect(markup).toContain("You owe Karma Nu. 30.00");
		expect(render(WhoOwesView, { type: "who_owes", heading: "Who owes whom", debts: [] })).toContain(
			"Nothing is owed.",
		);
	});
});

describe("invoices", () => {
	const invoice = {
		number: "INV-2026-001",
		periodText: "October 2026",
		issueText: "25 October 2026",
		dueText: "24 November 2026",
		clientName: "Acme <Pte> Ltd",
		amountMinor: 5_000_000,
		currency: "BTN",
		file: { id: "fi_cccc0003", name: "INV-2026-001.pdf", mime: "application/pdf", size: 3_400 },
	};

	it("is a download of the PDF and says it was sent nowhere", () => {
		const markup = render(InvoiceView, { type: "invoice", event: "created", invoice } satisfies InvoiceCard);
		expect(markup).toContain("Invoice ready");
		expect(markup).toContain("INV-2026-001 · October 2026");
		expect(markup).toContain("Nu. 50,000.00");
		expect(markup).toContain("Acme &lt;Pte&gt; Ltd");
		expect(markup).toContain('href="/api/files/fi_cccc0003"');
		expect(markup).toContain('download="INV-2026-001.pdf"');
		expect(markup).toContain("Download PDF");
		expect(markup).toContain("3 KB");
		expect(markup).toContain("Not sent anywhere: download it and send it yourself.");
		expect(render(InvoiceView, { type: "invoice", event: "existing", invoice })).toContain("Invoice (made earlier)");
	});

	it("marks a preview as one: PREVIEW on the card, a download that says so, and no claim that it is an invoice", () => {
		const markup = render(InvoiceView, { type: "invoice", event: "preview", invoice } satisfies InvoiceCard);
		expect(markup).toContain("Invoice preview");
		expect(markup).toContain('<span class="badge badge--preview">PREVIEW</span>');
		expect(markup).toContain('class="card card--money card--preview"');
		expect(markup).toContain('aria-label="Preview of invoice INV-2026-001"');
		expect(markup).toContain("Download preview PDF");
		expect(markup).toContain(
			"Not an invoice: no number was taken, and INV-2026-001 is only what the next real one would be called.",
		);
		expect(markup).not.toContain("Invoice ready");
		expect(markup).not.toContain("Not sent anywhere");
		const real = render(InvoiceView, { type: "invoice", event: "created", invoice });
		expect(real).not.toContain("PREVIEW");
		expect(real).not.toContain("card--preview");
	});

	it("says when the file is gone, and lists invoices with a download each", () => {
		const { file: _file, ...bare } = invoice;
		expect(render(InvoiceView, { type: "invoice", event: "created", invoice: bare })).toContain(
			"The PDF is no longer on the server.",
		);
		const list = render(InvoiceListView, {
			type: "invoice_list",
			heading: "Invoices",
			invoices: [invoice, { ...invoice, number: "INV-2026-002", file: { ...invoice.file, id: "fi_cccc0004" } }],
			total: 5,
		} satisfies InvoiceListCard);
		expect(list).toContain("INV-2026-002");
		expect(count(list, "Download PDF")).toBe(2);
		expect(list).toContain("…and 3 older");
	});
});

describe("notes and the thread's one-line summaries", () => {
	it("draws a note's lines", () => {
		const markup = render(AccountantNoteView, {
			type: "accountant_note",
			heading: "Account BoB",
			lines: ["bank, BTN", "Balance Nu. 100.00"],
		} satisfies AccountantNoteCard);
		expect(markup).toContain("Account BoB");
		expect(count(markup, "<li>")).toBe(2);
	});

	it("summarises every card in a line, for a screen reader and a notification", () => {
		expect(cardSummary({ type: "txn", txns: [lunch] })).toBe("Expense recorded: Nu. 450.00, Druk <Mart>");
		expect(cardSummary({ type: "who_owes", heading: "Who owes whom", debts: [] })).toBe("Who owes whom: 0");
		expect(
			cardSummary({
				type: "invoice",
				event: "created",
				invoice: {
					number: "INV-2026-001",
					periodText: "x",
					issueText: "x",
					dueText: "x",
					clientName: "x",
					amountMinor: 5_000_000,
					currency: "BTN",
				},
			}),
		).toBe("Invoice INV-2026-001: Nu. 50,000.00");
		expect(
			cardSummary({
				type: "invoice",
				event: "preview",
				invoice: {
					number: "INV-2026-002",
					periodText: "x",
					issueText: "x",
					dueText: "x",
					clientName: "x",
					amountMinor: 100,
					currency: "BTN",
				},
			}),
		).toBe("Invoice preview INV-2026-002: Nu. 1.00");
		const importCard = {
			type: "import_preview",
			importId: "im_aaaa0001",
			fileName: "f.csv",
			account: "BoB",
			currency: "BTN",
			encoding: "UTF-8",
			delimiter: ",",
			dateOrder: "DMY",
			columns: [],
			rows: 3,
			skipped: 0,
			duplicates: 0,
			outMinor: 0,
			outCount: 0,
			inMinor: 0,
			inCount: 0,
			uncategorized: 0,
			sample: [],
			problems: [],
		} as const satisfies ImportPreviewCard;
		expect(cardSummary(importCard)).toBe("Import preview: 3 rows into BoB");
		expect(cardSummary({ ...importCard, matchCount: 2 })).toBe("Import preview: 3 rows into BoB, 2 left out");
	});
});
