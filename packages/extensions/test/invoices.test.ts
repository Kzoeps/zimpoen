import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { coreMigrations, migrate, openAppDb } from "@assistant/db";
import type { AccountantNoteCard, InvoiceCard, InvoiceListCard, ToolCard } from "@assistant/shared";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkPattern,
	collectMigrations,
	DEFAULT_INVOICE_TEMPLATE,
	filesModule,
	formatNumber,
	invoicesStore,
	parseHtml,
	patternProblem,
	renderInvoicePdf,
	renderInvoicesSection,
	seedInvoiceTemplate,
	TemplateError,
	toWinAnsi,
} from "../src/index.ts";
import { type Fixture, openFixture, textOf } from "./support.ts";

const dirs: string[] = [];
const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.close().catch(() => {});
		await fixture.dispose();
	}
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function folders() {
	const root = await mkdtemp(join(tmpdir(), "assistant-inv-"));
	dirs.push(root);
	const templatesDir = join(root, "templates");
	const outDir = join(root, "workspace", "invoices");
	await mkdir(templatesDir, { recursive: true });
	await seedInvoiceTemplate(templatesDir);
	return { root, templatesDir, outDir };
}

async function open(setup = true) {
	const where = await folders();
	const f = await openFixture({
		accountant: { currency: "BTN", invoices: { outDir: where.outDir, templatesDir: where.templatesDir } },
	});
	fixtures.push(f);
	if (setup) {
		await f.callTool(
			"set_invoice_profile",
			{
				client_name: "Acme Pte Ltd",
				client_address: "12 Main Street\nSingapore 049483",
				sender_name: "Dorje Tsering",
				sender_details: "Norzin Lam\nThimphu",
				description: "Consulting services for {period}",
				amount: 50_000,
				payment_details: "Bank: BoB\nAccount: 123456789",
			},
			"profile-1",
		);
	}
	return { f, ...where };
}

const card = <T extends ToolCard>(result: ToolExecutionResult): T => result.details as unknown as T;
let calls = 0;
const nextId = (): string => `call-${++calls}`;
const generate = (f: Fixture, args: Record<string, unknown> = {}, id = nextId()) =>
	f.callTool("generate_invoice", args, id);

/** The text drawn on a PDF's pages, one string per draw call, read from the page streams (inflated when compressed). */
function pdfText(buffer: Buffer): string {
	const raw = buffer.toString("latin1");
	const streams: string[] = [];
	for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
		const body = Buffer.from(match[1] as string, "latin1");
		try {
			streams.push(inflateSync(body).toString("latin1"));
		} catch {
			streams.push(match[1] as string);
		}
	}
	const drawn: string[] = [];
	for (const content of streams) {
		for (const op of content.matchAll(/\[((?:<[0-9a-fA-F]*>|\s|-?\d+(?:\.\d+)?)*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
			const hex =
				op[1] === undefined
					? [op[2] as string]
					: [...op[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((piece) => piece[1] as string);
			drawn.push(hex.map((piece) => Buffer.from(piece, "hex").toString("latin1")).join(""));
		}
	}
	return drawn.join("\n");
}

const pageCount = (buffer: Buffer): number => (buffer.toString("latin1").match(/\/Type \/Page\b(?!s)/g) ?? []).length;

/** A solid-colour PNG, made here so that no binary file sits in the repository. */
function png(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer): Buffer => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const out = Buffer.alloc(8 + data.length + 4);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body), 8 + data.length);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x66)]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const FACTS = {
	number: "INV-2026-001",
	period: "2026-10",
	issueDate: "2026-10-25",
	dueDate: "2026-11-24",
	amountMinor: 5_000_000,
	currency: "BTN",
	reference: "",
	notes: "",
	description: "Consulting services for {period}",
	termsDays: 30,
	profile: {
		senderName: "Dorje Tsering",
		senderDetails: "Norzin Lam\nThimphu",
		clientName: "Acme Pte Ltd",
		clientAddress: "12 Main Street\nSingapore 049483",
		paymentDetails: "Bank: BoB",
	},
};

describe("invoice numbers", () => {
	it("fills the year, the month and the running number, padded as the pattern says", () => {
		expect(formatNumber("INV-{YYYY}-{seq:03}", 7, "2026-10-25")).toBe("INV-2026-007");
		expect(formatNumber("{YY}{MM}-{seq}", 7, "2026-03-02")).toBe("2603-7");
		expect(formatNumber("A#{seq:05}", 1234567, "2026-10-25")).toBe("A#1234567");
	});

	it("refuses a pattern with no running number, with two, or with a character a file name cannot have", () => {
		expect(patternProblem("INV-{YYYY}")).toMatch(/needs \{seq\}/);
		expect(patternProblem("{seq}-{seq}")).toMatch(/can appear once/);
		expect(patternProblem("INV/{seq}")).toMatch(/'\/' cannot be in an invoice number pattern/);
		expect(patternProblem("INV {seq}")).toMatch(/' ' cannot be/);
		expect(patternProblem("INV-{year}-{seq}")).toMatch(/'\{' cannot be/);
		expect(patternProblem("")).toMatch(/1 to 40/);
		expect(() => checkPattern("nope")).toThrow(/Example: INV-\{YYYY\}-\{seq:03\}/);
		expect(patternProblem("INV-{YYYY}-{seq:03}")).toBeUndefined();
	});
});

describe("reading the template", () => {
	it("builds a tree from the subset, drops script and style with their text, and keeps the text of unknown tags", () => {
		const parsed = parseHtml(
			'<!doctype html><html><head><meta name="page-size" content="Letter"><title>T &amp; U</title><style>p{color:red}</style></head>' +
				"<body><script>alert(1)</script><p>one<p>two <blink>kept</blink> &amp; &#65;&#x42;<br>x<ul><li>a<li>b</ul>" +
				"<table><tr><td>1<td>2<tr><td>3</table></body></html>",
		);
		expect(parsed.pageSize).toBe("Letter");
		expect(parsed.title).toBe("T & U");
		const dump = (nodes: typeof parsed.nodes): string =>
			nodes
				.map((node) => (node.type === "text" ? node.text : `<${node.tag}>${dump(node.children)}</${node.tag}>`))
				.join("");
		expect(dump(parsed.nodes)).toBe(
			"<html><head></head><body><p>one</p><p>two <blink>kept</blink> & AB<br></br>x</p><ul><li>a</li><li>b</li></ul>" +
				"<table><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></table></body></html>",
		);
		expect(dump(parsed.nodes)).not.toContain("alert");
		expect(dump(parsed.nodes)).not.toContain("color:red");
	});

	it("never throws on broken markup", () => {
		expect(() => parseHtml("<div><p>unclosed <b>bold <i>both</div></span><<>> & < 3 <td")).not.toThrow();
		expect(parseHtml("1 < 2 and 3 > 2").nodes).toEqual([{ type: "text", text: "1 < 2 and 3 > 2" }]);
	});
});

describe("the PDF", () => {
	it("is a real, non-empty PDF with the invoice's words on it, and escapes what a field holds", async () => {
		const { templatesDir } = await folders();
		const pdf = await renderInvoicePdf({
			templatesDir,
			compress: false,
			facts: { ...FACTS, profile: { ...FACTS.profile, clientName: "Acme <script>alert(1)</script> & Sons" } },
		});
		expect(pdf.length).toBeGreaterThan(1500);
		expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
		expect(pdf.toString("latin1")).toMatch(/\/Title \d+ 0 R/);
		const words = pdfText(pdf);
		for (const expected of [
			"INVOICE",
			"INV-2026-001",
			"25 October 2026",
			"24 November 2026",
			"Dorje Tsering",
			"12 Main Street",
			"Consulting services for October 2026",
			"Nu. 50,000.00",
			"Bank: BoB",
			"(30 days)",
		]) {
			expect(words).toContain(expected);
		}
		// The markup in the client's name is text on the page, never markup.
		expect(words).toContain("Acme <script>alert(1)</script> & Sons");
		expect(pageCount(pdf)).toBe(1);
		expect(pdf.toString("latin1")).toContain("/MediaBox [0 0 595.28 841.89]");
	});

	it("compresses by default, and the text is still in it", async () => {
		const { templatesDir } = await folders();
		const pdf = await renderInvoicePdf({ templatesDir, facts: FACTS });
		expect(pdf.toString("latin1")).toContain("/FlateDecode");
		expect(pdfText(pdf)).toContain("INV-2026-001");
	});

	it("takes the page size from the template, and a template of the owner's own", async () => {
		const { templatesDir } = await folders();
		await writeFile(
			join(templatesDir, "invoice.html"),
			'<meta name="page-size" content="Letter"><h2>{{client.name}}</h2><p align="right">{{invoice.number}} / {{{invoice.notes_html}}}</p>',
		);
		const pdf = await renderInvoicePdf({ templatesDir, compress: false, facts: { ...FACTS, notes: "a & b\nsecond" } });
		expect(pdf.toString("latin1")).toContain("/MediaBox [0 0 612 792]");
		const words = pdfText(pdf);
		expect(words).toContain("Acme Pte Ltd");
		expect(words).toContain("INV-2026-001 / a & b");
		expect(words).toContain("second");
	});

	it("flows onto a second page when the content is long", async () => {
		const { templatesDir } = await folders();
		await writeFile(
			join(templatesDir, "invoice.html"),
			`<h1>{{invoice.number}}</h1>${Array.from({ length: 120 }, (_, index) => `<p>Line number ${index + 1} of the work that was done this month for the client.</p>`).join("")}`,
		);
		const pdf = await renderInvoicePdf({ templatesDir, compress: false, facts: FACTS });
		expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
		const words = pdfText(pdf);
		expect(words).toContain("Line number 1 of");
		expect(words).toContain("Line number 120 of");
	});

	it("draws a watermark across every page, over the template, and not without one being asked for", async () => {
		const { templatesDir } = await folders();
		await writeFile(
			join(templatesDir, "invoice.html"),
			`<h1>{{invoice.number}}</h1>${Array.from({ length: 120 }, (_, index) => `<p>Line number ${index + 1} of the work that was done this month for the client.</p>`).join("")}`,
		);
		const marked = await renderInvoicePdf({ templatesDir, compress: false, facts: FACTS, watermark: "PREVIEW" });
		const pages = pageCount(marked);
		expect(pages).toBeGreaterThanOrEqual(2);
		expect(pdfText(marked).match(/PREVIEW/g)).toHaveLength(pages); // once on every page
		expect(pdfText(marked)).toContain("Line number 120 of"); // the page's own content is all still there
		expect(pdfText(await renderInvoicePdf({ templatesDir, compress: false, facts: FACTS }))).not.toContain("PREVIEW");
	});

	it("wraps a long cell inside its column and keeps a table row on one page", async () => {
		const { templatesDir } = await folders();
		await writeFile(
			join(templatesDir, "invoice.html"),
			'<table width="100%"><tr><td width="30%">{{invoice.description}} {{invoice.description}} {{invoice.description}}</td><td align="right">{{total}}</td></tr></table>',
		);
		const pdf = await renderInvoicePdf({ templatesDir, compress: false, facts: FACTS });
		expect(pageCount(pdf)).toBe(1);
		expect(pdfText(pdf)).toContain("Nu. 50,000.00");
	});

	it("draws a logo from the templates folder or a data: image, and refuses every other source", async () => {
		const { templatesDir, root } = await folders();
		await writeFile(join(templatesDir, "logo.png"), png(40, 20));
		await writeFile(
			join(templatesDir, "invoice.html"),
			'<img src="logo.png" width="80"><img src="data:image/png;base64,' +
				png(4, 4).toString("base64") +
				'"><p>{{invoice.number}}</p>',
		);
		const pdf = await renderInvoicePdf({ templatesDir, compress: false, facts: FACTS });
		expect(pdf.toString("latin1")).toContain("/Subtype /Image");
		expect(pdfText(pdf)).toContain("INV-2026-001");

		for (const [src, problem] of [
			["https://example.com/logo.png", /Nothing is fetched from the web/],
			["/etc/passwd", /only a file in the templates folder/],
			["../secret.png", /outside the templates folder|is not in the templates folder/],
			["missing.png", /is not in the templates folder/],
		] as const) {
			await writeFile(join(templatesDir, "invoice.html"), `<img src="${src}">`);
			await expect(renderInvoicePdf({ templatesDir, facts: FACTS })).rejects.toThrow(problem);
		}
		// A link inside the folder that points outside is followed and refused.
		await writeFile(join(root, "outside.png"), png(2, 2));
		await symlink(join(root, "outside.png"), join(templatesDir, "link.png"));
		await writeFile(join(templatesDir, "invoice.html"), '<img src="link.png">');
		await expect(renderInvoicePdf({ templatesDir, facts: FACTS })).rejects.toThrow(/outside the templates folder/);
		// A file that is not an image.
		await writeFile(join(templatesDir, "fake.png"), "not a png");
		await writeFile(join(templatesDir, "invoice.html"), '<img src="fake.png">');
		await expect(renderInvoicePdf({ templatesDir, facts: FACTS })).rejects.toThrow(/not a PNG or JPEG/);
	});

	it("says what is wrong with a template that has a bad tag, a field that does not exist, or no file", async () => {
		const { templatesDir } = await folders();
		const render = () => renderInvoicePdf({ templatesDir, facts: FACTS });
		await writeFile(join(templatesDir, "invoice.html"), "<p>{{invoice.numer}}</p>");
		await expect(render()).rejects.toThrow(
			/uses \{\{invoice\.numer\}\}, which is not a field\. The fields are: invoice\.number, invoice\.period/,
		);
		await writeFile(join(templatesDir, "invoice.html"), "{{#lines}}<p>{{descripton}}</p>{{/lines}}");
		await expect(render()).rejects.toThrow(/\{\{descripton\}\}/);
		await writeFile(join(templatesDir, "invoice.html"), "{{#lines}}<p>{{description}} {{amount}}</p>");
		await expect(render()).rejects.toThrow(/has a mistake: Unclosed section "lines"/);
		await writeFile(join(templatesDir, "invoice.html"), "{{> header}}");
		await expect(render()).rejects.toThrow(/partials are not supported/);
		await writeFile(
			join(templatesDir, "invoice.html"),
			"{{{ invoice.notes_html }}}{{#sender.lines}}{{.}}{{/sender.lines}}{{^invoice.reference}}none{{/invoice.reference}}",
		);
		await expect(render()).resolves.toBeInstanceOf(Buffer);
		await rm(join(templatesDir, "invoice.html"));
		await expect(render()).rejects.toThrow(/There is no invoice template at .*invoice\.html.*docs\/setup-invoice\.md/);
		await expect(render()).rejects.toBeInstanceOf(TemplateError);
	});

	it("refuses a template that is a link to a file outside the templates folder, and takes one that is a link inside it", async () => {
		const { root, templatesDir } = await folders();
		const outside = join(root, "secret.html");
		await writeFile(outside, "<p>NOT FOR THE TEMPLATE {{invoice.number}}</p>");
		await rm(join(templatesDir, "invoice.html"));
		await symlink(outside, join(templatesDir, "invoice.html"));
		await expect(renderInvoicePdf({ templatesDir, compress: false, facts: FACTS })).rejects.toThrow(
			/is a link to a file outside the templates folder, which is not allowed/,
		);

		await rm(join(templatesDir, "invoice.html"));
		await writeFile(join(templatesDir, "real.html"), "<p>INSIDE {{invoice.number}}</p>");
		await symlink(join(templatesDir, "real.html"), join(templatesDir, "invoice.html"));
		expect(pdfText(await renderInvoicePdf({ templatesDir, compress: false, facts: FACTS }))).toContain(
			"INSIDE INV-2026-001",
		);
	});

	it("draws the Latin-1 text of names and shows what Helvetica cannot draw as a question mark", () => {
		expect(toWinAnsi("Zürich café – “quoted” € 5")).toBe("Zürich café – “quoted” € 5");
		expect(toWinAnsi("Pema པད་མ Dorji")).toBe("Pema ???? Dorji");
		expect(toWinAnsi("₹500")).toBe("Rs.500");
		expect(toWinAnsi("e\u0301")).toBe("é");
	});

	it("ships a default template that fills every field it uses", () => {
		expect(DEFAULT_INVOICE_TEMPLATE).toContain("{{invoice.number}}");
		expect(DEFAULT_INVOICE_TEMPLATE).toContain('<meta name="page-size" content="A4">');
	});
});

describe("the seeded template", () => {
	it("is written once and never over the owner's own", async () => {
		const root = await mkdtemp(join(tmpdir(), "assistant-inv-"));
		dirs.push(root);
		const dir = join(root, "templates");
		const first = await seedInvoiceTemplate(dir);
		expect(first.created).toBe(true);
		expect(await readFile(first.path, "utf8")).toBe(DEFAULT_INVOICE_TEMPLATE);
		await writeFile(first.path, "<p>mine</p>");
		const second = await seedInvoiceTemplate(dir);
		expect(second.created).toBe(false);
		expect(await readFile(first.path, "utf8")).toBe("<p>mine</p>");
	});
});

describe("set_invoice_profile", () => {
	it("saves what is given, keeps the rest, and says what the next invoice will be called", async () => {
		const { f } = await open(false);
		await expect(f.callTool("set_invoice_profile", {}, nextId())).rejects.toThrow(/Nothing to change/);
		const first = await f.callTool("set_invoice_profile", { client_name: "Acme", amount: 50_000 }, nextId());
		expect(textOf(first)).toContain("Client: Acme");
		expect(textOf(first)).toContain("Usual amount: Nu. 50,000.00");
		expect(textOf(first)).toContain("Numbering INV-{YYYY}-{seq:03}; the next invoice is INV-2026-001");
		const second = await f.callTool("set_invoice_profile", { payment_terms_days: 14, next_number: 12 }, nextId());
		expect(textOf(second)).toContain("Client: Acme");
		expect(textOf(second)).toContain("Payment due 14 days after the issue date");
		expect(textOf(second)).toContain("the next invoice is INV-2026-012");
		expect(card<AccountantNoteCard>(second).heading).toBe("Invoice profile saved");
		expect(invoicesStore.getProfile(f.db)).toMatchObject({
			clientName: "Acme",
			amountMinor: 5_000_000,
			currency: "BTN",
			nextSeq: 12,
		});
	});

	it("checks the pattern, the amount's decimals and a currency change that would change what the amount means", async () => {
		const { f } = await open();
		await expect(f.callTool("set_invoice_profile", { number_pattern: "INV-{YYYY}" }, nextId())).rejects.toThrow(
			/needs \{seq\}/,
		);
		await expect(f.callTool("set_invoice_profile", { amount: 10.005 }, nextId())).rejects.toThrow(
			/more decimals than BTN has/,
		);
		await expect(f.callTool("set_invoice_profile", { currency: "usd" }, nextId())).rejects.toThrow(
			/Changing the currency to USD would change what it means/,
		);
		await f.callTool("set_invoice_profile", { currency: "usd", amount: 500 }, nextId());
		expect(invoicesStore.getProfile(f.db)).toMatchObject({ currency: "USD", amountMinor: 50_000 });
		await f.callTool("set_invoice_profile", { amount: null }, nextId());
		expect(invoicesStore.getProfile(f.db)?.amountMinor).toBeUndefined();
	});

	it("is applied once per call: a replay does not undo a later edit", async () => {
		const { f } = await open();
		await f.callTool("set_invoice_profile", { client_name: "First client" }, "edit-1");
		await f.callTool("set_invoice_profile", { client_name: "Second client" }, "edit-2");
		const replay = await f.callTool("set_invoice_profile", { client_name: "First client" }, "edit-1");
		expect(textOf(replay)).toContain("Client: Second client");
		expect(invoicesStore.getProfile(f.db)?.clientName).toBe("Second client");
	});
});

describe("generate_invoice", () => {
	it("makes the PDF, takes the first number, and gives a download card with the file", async () => {
		const { f, outDir } = await open();
		const result = await generate(f);
		const invoice = card<InvoiceCard>(result);
		expect(invoice).toMatchObject({
			type: "invoice",
			event: "created",
			invoice: {
				number: "INV-2026-001",
				periodText: "October 2026",
				issueText: "25 October 2026",
				dueText: "24 November 2026",
				clientName: "Acme Pte Ltd",
				amountMinor: 5_000_000,
				currency: "BTN",
				file: { name: "INV-2026-001.pdf", mime: "application/pdf" },
			},
		});
		expect(textOf(result)).toContain(
			"Invoice INV-2026-001 for October 2026 is ready: Nu. 50,000.00 to Acme Pte Ltd, issued Sun 25 Oct 2026, due Tue 24 Nov 2026.",
		);
		expect(textOf(result)).toContain("It has not been sent anywhere");

		const path = join(outDir, "INV-2026-001.pdf");
		const bytes = await readFile(path);
		expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
		expect(invoice.invoice.file?.size).toBe(bytes.length);
		const row = f.db.get<{ source: string; kind: string; mime: string; path: string }>(
			"SELECT source, kind, mime, path FROM files_index WHERE id = ?",
			invoice.invoice.file?.id ?? "",
		);
		expect(row).toEqual({ source: "generated", kind: "pdf", mime: "application/pdf", path });
		const words = pdfText(bytes);
		expect(words).toContain("INV-2026-001");
		expect(words).toContain("Consulting services for October 2026");
		expect(invoicesStore.getProfile(f.db)?.nextSeq).toBe(2);
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});

	it("numbers invoices in order and never reuses a number", async () => {
		const { f } = await open();
		const numbers: string[] = [];
		for (const month of ["2026-08", "2026-09", "2026-10"]) {
			numbers.push(card<InvoiceCard>(await generate(f, { month, amount: 40_000 })).invoice.number);
		}
		expect(numbers).toEqual(["INV-2026-001", "INV-2026-002", "INV-2026-003"]);
		// Raising the running number is allowed; going back onto a number that was used is refused when an invoice is made.
		await f.callTool("set_invoice_profile", { next_number: 2 }, nextId());
		await expect(generate(f, { month: "2026-07" })).rejects.toThrow(
			/The number INV-2026-002 was already used by the invoice for September 2026\. Raise the running number/,
		);
		expect(invoicesStore.listIssued(f.db, 10).total).toBe(3);
		await f.callTool("set_invoice_profile", { next_number: 10 }, nextId());
		expect(card<InvoiceCard>(await generate(f, { month: "2026-07" })).invoice.number).toBe("INV-2026-010");
	});

	it("is idempotent per call: a replay is the same invoice, even days later and without the template", async () => {
		const { f, templatesDir, outDir } = await open();
		const first = await generate(f, {}, "gen-1");
		await rm(join(templatesDir, "invoice.html"));
		f.clock.now += 40 * 24 * 3600 * 1000;
		const replay = await generate(f, { amount: 1 }, "gen-1");
		expect(card<InvoiceCard>(replay).event).toBe("existing");
		expect(card<InvoiceCard>(replay).invoice).toEqual(card<InvoiceCard>(first).invoice);
		expect(textOf(replay)).toBe(textOf(first));
		expect(invoicesStore.listIssued(f.db, 10).total).toBe(1);
		expect(invoicesStore.getProfile(f.db)?.nextSeq).toBe(2);
		expect(existsSync(join(outDir, "INV-2026-002.pdf"))).toBe(false);
	});

	it("takes the number once when two calls run at the same time", async () => {
		const { f } = await open();
		const results = await Promise.all([
			generate(f, { month: "2026-09" }, "a"),
			generate(f, { month: "2026-10" }, "b"),
			generate(f, { month: "2026-08" }, "c"),
		]);
		const numbers = results.map((result) => card<InvoiceCard>(result).invoice.number).sort();
		expect(numbers).toEqual(["INV-2026-001", "INV-2026-002", "INV-2026-003"]);
		expect(invoicesStore.getProfile(f.db)?.nextSeq).toBe(4);
	});

	it("refuses a second invoice for a month unless asked, and then gives it a new number", async () => {
		const { f } = await open();
		await generate(f);
		await expect(generate(f)).rejects.toThrow(
			/Invoice INV-2026-001 for October 2026 was already made on 2026-10-25\. .* again: true/,
		);
		const again = await generate(f, { again: true });
		expect(card<InvoiceCard>(again).invoice.number).toBe("INV-2026-002");
	});

	it("uses what the call overrides: amount, month, dates, the line, the note and a reference", async () => {
		const { f, outDir } = await open();
		const result = await generate(f, {
			month: "2026-09",
			amount: 42_500.5,
			overrides: {
				issue_date: "2026-09-30",
				due_date: "2026-10-14",
				description: "Retainer for {month}",
				notes: "Paid in two parts",
				reference: "PO-77",
			},
		});
		const invoice = card<InvoiceCard>(result).invoice;
		expect(invoice).toMatchObject({
			number: "INV-2026-001",
			periodText: "September 2026",
			issueText: "30 September 2026",
			dueText: "14 October 2026",
			amountMinor: 4_250_050,
		});
		const words = pdfText(await readFile(join(outDir, "INV-2026-001.pdf")));
		expect(words).toContain("Retainer for September");
		expect(words).toContain("Nu. 42,500.50");
		expect(words).toContain("Paid in two parts");
		expect(words).toContain("PO-77");
		expect(words).toContain("(14 days)");
		expect(invoicesStore.issuedByNumber(f.db, "INV-2026-001")).toMatchObject({
			issueDate: "2026-09-30",
			dueDate: "2026-10-14",
			period: "2026-09",
		});
	});

	it("says what is missing: a profile, a client, an amount; and checks the month and the dates", async () => {
		const { f } = await open(false);
		await expect(generate(f)).rejects.toThrow(
			/no invoice profile with a client yet.*set_invoice_profile with client_name/,
		);
		await f.callTool("set_invoice_profile", { client_name: "Acme" }, nextId());
		await expect(generate(f)).rejects.toThrow(/There is no amount: the profile has no usual amount\. Ask the owner/);
		await expect(generate(f, { amount: 100, month: "October" })).rejects.toThrow(/month must be YYYY-MM/);
		await expect(generate(f, { amount: 100, month: "2031-01" })).rejects.toThrow(/not more than a year ahead/);
		await expect(generate(f, { amount: 100, overrides: { issue_date: "25/10/2026" } })).rejects.toThrow(
			/issue_date must be a day written YYYY-MM-DD/,
		);
		await expect(generate(f, { amount: 100, overrides: { issue_date: "2026-02-30" } })).rejects.toThrow(/YYYY-MM-DD/);
		await expect(generate(f, { amount: 100, overrides: { due_date: "2026-10-01" } })).rejects.toThrow(
			/due date 2026-10-01 is before the issue date/,
		);
		await expect(generate(f, { amount: 100.001 })).rejects.toThrow(/more decimals than BTN has/);
		expect(invoicesStore.listIssued(f.db, 10).total).toBe(0);
		// A client the owner took away again is no client: the invoice would be addressed to nobody.
		await f.callTool("set_invoice_profile", { client_name: "   " }, nextId());
		await expect(generate(f, { amount: 100 })).rejects.toThrow(/no invoice profile with a client yet/);
		expect(invoicesStore.listIssued(f.db, 10).total).toBe(0);
	});

	it("uses no number and leaves no file when the template fails, and the first invoice is still number 1", async () => {
		const { f, templatesDir, outDir } = await open();
		await writeFile(join(templatesDir, "invoice.html"), "<p>{{invoice.numer}}</p>");
		await expect(generate(f)).rejects.toThrow(/not a field/);
		expect(invoicesStore.getProfile(f.db)?.nextSeq).toBe(1);
		expect(existsSync(join(outDir, "INV-2026-001.pdf"))).toBe(false);
		await writeFile(join(templatesDir, "invoice.html"), DEFAULT_INVOICE_TEMPLATE);
		expect(card<InvoiceCard>(await generate(f)).invoice.number).toBe("INV-2026-001");
	});

	it("refuses to make invoices on a server with no templates folder", async () => {
		const f = await openFixture({ accountant: { currency: "BTN" } });
		fixtures.push(f);
		await f.callTool("set_invoice_profile", { client_name: "Acme", amount: 100 }, nextId());
		await expect(generate(f)).rejects.toThrow(/Invoices are not set up on this server/);
	});

	it("lists invoices, newest first, with their files", async () => {
		const { f } = await open();
		expect(textOf(await f.callTool("list_invoices", {}, nextId()))).toBe("No invoice has been made yet.");
		await generate(f, { month: "2026-09" });
		await generate(f, { month: "2026-10" });
		const listing = await f.callTool("list_invoices", { limit: 1 }, nextId());
		expect(textOf(listing)).toContain("INV-2026-002 · October 2026 · Nu. 50,000.00 · Acme Pte Ltd · issued 2026-10-25");
		expect(textOf(listing)).toContain("… and 1 older.");
		const list = card<InvoiceListCard>(listing);
		expect(list.total).toBe(2);
		expect(list.invoices[0]?.file?.name).toBe("INV-2026-002.pdf");
	});
});

describe("preview_invoice", () => {
	it("makes a PDF marked PREVIEW without taking a number, recording an invoice or touching the invoices folder", async () => {
		const { f, outDir } = await open();
		const result = await f.callTool("preview_invoice", {}, "pre-1");

		const shown = card<InvoiceCard>(result);
		expect(shown).toMatchObject({
			type: "invoice",
			event: "preview",
			invoice: {
				number: "INV-2026-001",
				amountMinor: 5_000_000,
				file: { mime: "application/pdf", name: "preview-INV-2026-001.pdf" },
			},
		});
		expect(textOf(result)).toContain("Preview of the invoice for October 2026: Nu. 50,000.00 to Acme Pte Ltd");
		expect(textOf(result)).toContain(
			"PREVIEW is written across every page. It is not an invoice: no number is reserved (the next real invoice would be INV-2026-001)",
		);
		const row = f.db.get<{ path: string; source: string }>(
			"SELECT path, source FROM files_index WHERE id = ?",
			shown.invoice.file?.id ?? "",
		);
		expect(row?.source).toBe("generated");
		expect(row?.path.startsWith(join(outDir, "previews", "preview-INV-2026-001-"))).toBe(true);
		const bytes = await readFile(row?.path ?? "");
		expect(pdfText(bytes)).toContain("PREVIEW");
		expect(pdfText(bytes)).toContain("Consulting services for October 2026");
		expect(shown.invoice.file?.size).toBe(bytes.length);

		// No number was taken, nothing was recorded, and the folder of real invoices has no file in it.
		expect(invoicesStore.getProfile(f.db)?.nextSeq).toBe(1);
		expect(invoicesStore.listIssued(f.db, 10).total).toBe(0);
		expect(existsSync(join(outDir, "INV-2026-001.pdf"))).toBe(false);
		const real = await generate(f);
		expect(card<InvoiceCard>(real).invoice.number).toBe("INV-2026-001"); // the first real invoice still has number 1
		expect(pdfText(await readFile(join(outDir, "INV-2026-001.pdf")))).not.toContain("PREVIEW");
	});

	it("shows a new template as many times as it takes: each call is its own file, a replay is the same one, and no number goes", async () => {
		const { f, templatesDir, outDir } = await open();
		await writeFile(join(templatesDir, "invoice.html"), "<h1>TRY ONE {{invoice.number}}</h1>");
		const first = card<InvoiceCard>(await f.callTool("preview_invoice", {}, "try-1"));
		await writeFile(join(templatesDir, "invoice.html"), "<h1>TRY TWO {{invoice.number}}</h1>");
		const second = card<InvoiceCard>(await f.callTool("preview_invoice", {}, "try-2"));
		const replay = card<InvoiceCard>(await f.callTool("preview_invoice", {}, "try-1"));

		expect(second.invoice.file?.id).not.toBe(first.invoice.file?.id);
		expect(replay.invoice.file?.id).toBe(first.invoice.file?.id);
		const path = (id: string | undefined) =>
			f.db.get<{ path: string }>("SELECT path FROM files_index WHERE id = ?", id ?? "")?.path ?? "";
		expect(pdfText(await readFile(path(first.invoice.file?.id)))).toContain("TRY TWO"); // a replay renders again, from the template as it is now
		expect(pdfText(await readFile(path(second.invoice.file?.id)))).toContain("TRY TWO");
		expect(invoicesStore.getProfile(f.db)?.nextSeq).toBe(1);
		expect(existsSync(join(outDir, "INV-2026-001.pdf"))).toBe(false);
	});

	it("previews a month that already has an invoice, and says so, where generate_invoice would refuse", async () => {
		const { f } = await open();
		await generate(f);
		const result = await f.callTool("preview_invoice", { amount: 60_000 }, "pre-2");

		expect(card<InvoiceCard>(result)).toMatchObject({
			event: "preview",
			invoice: { number: "INV-2026-002", amountMinor: 6_000_000 },
		});
		expect(textOf(result)).toContain(
			"Invoice INV-2026-001 for October 2026 was already made on 2026-10-25. generate_invoice refuses a second one for that month unless again: true.",
		);
		await f.callTool("set_invoice_profile", { next_number: 1 }, nextId());
		const clash = await f.callTool("preview_invoice", {}, "pre-3");
		expect(textOf(clash)).toContain("The number INV-2026-001 was already used by the invoice for October 2026");
		expect(textOf(clash)).toContain("generate_invoice would refuse until then");
	});

	it("says what is missing like generate_invoice does, uses the owner's overrides, and fails on a template mistake without a file", async () => {
		const { f, templatesDir, outDir } = await open(false);
		await expect(f.callTool("preview_invoice", {}, "pre-4")).rejects.toThrow(/no invoice profile with a client/);
		await f.callTool("set_invoice_profile", { client_name: "Acme" }, nextId());
		await expect(f.callTool("preview_invoice", {}, "pre-5")).rejects.toThrow(/There is no amount/);
		const result = await f.callTool(
			"preview_invoice",
			{ month: "2026-09", amount: 123.5, overrides: { description: "Special work", reference: "PO-77" } },
			"pre-6",
		);
		expect(card<InvoiceCard>(result).invoice).toMatchObject({ periodText: "September 2026", amountMinor: 12_350 });
		const path =
			f.db.get<{ path: string }>(
				"SELECT path FROM files_index WHERE id = ?",
				card<InvoiceCard>(result).invoice.file?.id ?? "",
			)?.path ?? "";
		expect(pdfText(await readFile(path))).toContain("Special work");

		await writeFile(join(templatesDir, "invoice.html"), "<p>{{invoice.numer}}</p>");
		await expect(f.callTool("preview_invoice", { amount: 100 }, "pre-7")).rejects.toThrow(
			/{{invoice.numer}}, which is not a field/,
		);
		expect(await readdir(join(outDir, "previews"))).toHaveLength(1); // the one that worked; the failed template left no file
	});

	it("is refused on a server with no templates folder, as generate_invoice is", async () => {
		const bare = await openFixture({ accountant: { currency: "BTN" } });
		fixtures.push(bare);
		await bare.callTool("set_invoice_profile", { client_name: "Acme", amount: 100 }, "p");
		await expect(bare.callTool("preview_invoice", {}, "pre-8")).rejects.toThrow(
			/Invoices are not set up on this server/,
		);
	});
});

describe("the prompt section", () => {
	it("tells whether invoices are set up, and the next number and the last invoice once they are", async () => {
		const noFolder = await openFixture({ accountant: { currency: "BTN" } });
		fixtures.push(noFolder);
		expect(renderInvoicesSection(noFolder.deps)).toBe("Invoices are not set up on this server.");

		const { f } = await open(false);
		expect(renderInvoicesSection(f.deps)).toMatch(/^Invoice profile: not set up yet\./);
		await f.callTool("set_invoice_profile", { client_name: "Acme", amount: 50_000 }, nextId());
		const before = renderInvoicesSection(f.deps);
		expect(before).toBe(
			[
				"Invoice profile: for Acme; usual amount Nu. 50,000.00; payment due 30 days after the issue date.",
				"Next invoice number: INV-2026-001.",
				"No invoice has been made yet.",
			].join("\n"),
		);
		await generate(f);
		expect(renderInvoicesSection(f.deps)).toBe(
			[
				"Invoice profile: for Acme; usual amount Nu. 50,000.00; payment due 30 days after the issue date.",
				"Next invoice number: INV-2026-002.",
				"Last invoice: INV-2026-001 for October 2026.",
			].join("\n"),
		);
	});
});

describe("files/002_generated_source", () => {
	it("rebuilds the file index to accept generated files and keeps the rows it had", async () => {
		const root = await mkdtemp(join(tmpdir(), "assistant-inv-"));
		dirs.push(root);
		const db = openAppDb(join(root, "app.sqlite"));
		const all = [...coreMigrations, ...collectMigrations([filesModule])];
		const first = all.filter((migration) => migration.id !== "files/002_generated_source");
		migrate(db, first);
		db.run(
			"INSERT INTO files_index (id, path, name, mime, kind, size, source, description, tags, added_at, updated_at) VALUES ('fi_00000001', '/a/b.png', 'b.png', 'image/png', 'image', 5, 'upload', 'a logo', 'logo', 1, 2)",
		);
		expect(() =>
			db.run(
				"INSERT INTO files_index (id, path, name, mime, kind, size, source, added_at, updated_at) VALUES ('fi_00000002', '/x.pdf', 'x.pdf', 'application/pdf', 'pdf', 1, 'generated', 1, 1)",
			),
		).toThrow();
		migrate(db, all);
		expect(
			db.get(
				"SELECT id, path, source, description, tags, added_at, updated_at FROM files_index WHERE id = 'fi_00000001'",
			),
		).toEqual({
			id: "fi_00000001",
			path: "/a/b.png",
			source: "upload",
			description: "a logo",
			tags: "logo",
			added_at: 1,
			updated_at: 2,
		});
		db.run(
			"INSERT INTO files_index (id, path, name, mime, kind, size, source, added_at, updated_at) VALUES ('fi_00000002', '/x.pdf', 'x.pdf', 'application/pdf', 'pdf', 1, 'generated', 1, 1)",
		);
		expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files_index")?.n).toBe(2);
		expect(() =>
			db.run(
				"INSERT INTO files_index (id, path, name, mime, kind, size, source, added_at, updated_at) VALUES ('fi_00000003', '/y', 'y', 'x/y', 'other', 1, 'invented', 1, 1)",
			),
		).toThrow();
		db.close();
	});
});
