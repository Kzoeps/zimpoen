import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AccountantNoteCard, formatMoney, type InvoiceCard, type InvoiceItem } from "@assistant/shared";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import * as fileStore from "../files/store.ts";
import { currencyCode } from "../ledger/common.ts";
import type { DomainDeps } from "../module.ts";
import { toMinor } from "../money.ts";
import { addDays, localDate } from "../time.ts";
import { asDetails, dayText, text } from "../tool-support.ts";
import { checkPattern, DEFAULT_NUMBER_PATTERN, formatNumber } from "./numbering.ts";
import { renderInvoicePdf } from "./render.ts";
import * as store from "./store.ts";
import { type InvoiceFacts, longDate, monthLabel } from "./template.ts";

export type InvoiceToolDeps = Pick<DomainDeps, "db" | "timezone" | "accountant">;

type GenerateArgs = {
	month?: string | undefined;
	amount?: number | undefined;
	again?: boolean | undefined;
	overrides?:
		| {
				issue_date?: string | undefined;
				due_date?: string | undefined;
				description?: string | undefined;
				notes?: string | undefined;
				reference?: string | undefined;
		  }
		| undefined;
};

/** Written across every page of a preview; the folder under the invoices' where previews go, so that they never mix with the real ones. */
const PREVIEW_WATERMARK = "PREVIEW";
const PREVIEWS_FOLDER = "previews";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LISTED = 24;

/** Text a call gave for a profile field, trimmed, with line breaks kept (addresses and payment details have several lines). */
const block = (value: string, max: number): string =>
	[...value]
		.map((char) => {
			const code = char.codePointAt(0) as number;
			return code === 10 || (code >= 32 && code !== 127) ? char : " ";
		})
		.join("")
		.replace(/[ \t]+$/gm, "")
		.trim()
		.slice(0, max);

const daysBetween = (from: string, to: string): number =>
	Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * One call at a time. Durable may run two tool calls of one round at once, and a running number must be taken by exactly
 * one of them; there is one server per data directory, so a lock inside the process is enough.
 */
function createMutex() {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(work: () => Promise<T>): Promise<T> => {
		const run = tail.then(work, work);
		tail = run.catch(() => {});
		return run;
	};
}

const noteCard = (heading: string, lines: string[]): AccountantNoteCard => ({
	type: "accountant_note",
	heading,
	lines,
});

/**
 * The tools of the invoices: a profile of what stays the same, and a monthly invoice rendered from the owner's template to a
 * PDF in the workspace. Nothing here sends anything anywhere (rule 1): the result is a download card in the chat. Numbers are
 * taken in one transaction with the invoice row, so a number is never used twice; the PDF is made first, so a template that
 * fails uses none.
 */
export function createInvoiceTools(deps: InvoiceToolDeps): ToolRegistration[] {
	const { db, timezone } = deps;
	const defaultCurrency = deps.accountant?.currency ?? "BTN";
	const exclusive = createMutex();

	// ----- the profile -----------------------------------------------------------------------------------------------------

	const profileLines = (profile: store.ProfileRow, today: string): string[] => {
		const lines = [
			`Client: ${profile.clientName === "" ? "not set" : profile.clientName}`,
			profile.amountMinor === undefined
				? "Usual amount: not set"
				: `Usual amount: ${formatMoney(profile.amountMinor, profile.currency)}`,
			`Line on the invoice: ${profile.description === "" ? "Services for {period} (the default)" : profile.description}`,
			`Payment due ${profile.paymentTermsDays} days after the issue date`,
			`Numbering ${profile.numberPattern}; the next invoice is ${formatNumber(profile.numberPattern, profile.nextSeq, today)}`,
		];
		if (profile.senderName !== "") lines.push(`Sender: ${profile.senderName}`);
		return lines;
	};

	const setProfile = defineTool({
		name: "set_invoice_profile",
		description:
			"Save or change what stays the same on the owner's monthly invoice: the client, the usual amount, the line text, the payment terms, the owner's own details, and how invoices are numbered. " +
			"Give only what the owner said; everything else is kept. Call it again to change something. The invoice itself is made with generate_invoice.",
		parameters: Type.Object({
			client_name: Type.Optional(Type.String({ maxLength: 120, description: "Who the invoice is addressed to." })),
			client_address: Type.Optional(
				Type.String({ maxLength: 400, description: "The client's address, one line per line break." }),
			),
			sender_name: Type.Optional(
				Type.String({ maxLength: 120, description: "The owner's name or company, as the invoice shows it." }),
			),
			sender_details: Type.Optional(
				Type.String({ maxLength: 400, description: "The owner's address, e-mail and so on, one line per line break." }),
			),
			description: Type.Optional(
				Type.String({
					maxLength: 200,
					description:
						"The line the invoice charges for. {period} (October 2026), {month} and {year} are replaced: 'Consulting services for {period}'.",
				}),
			),
			amount: Type.Optional(
				Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()], {
					description: `The usual amount in major units, as stated: 50000 for Nu. 50,000.00. null forgets it.`,
				}),
			),
			currency: Type.Optional(Type.String({ description: `A three-letter code. Default ${defaultCurrency}.` })),
			payment_terms_days: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: 365,
					description: "Days from the issue date until payment is due. Default 30.",
				}),
			),
			payment_details: Type.Optional(
				Type.String({ maxLength: 500, description: "How to pay: bank, account number, one line per line break." }),
			),
			notes: Type.Optional(
				Type.String({ maxLength: 500, description: "A note printed at the bottom of every invoice." }),
			),
			number_pattern: Type.Optional(
				Type.String({
					maxLength: 40,
					description: `How invoices are numbered: {YYYY}, {YY}, {MM} (of the issue date) and {seq} or {seq:03} (the running number, zero padded). Default ${DEFAULT_NUMBER_PATTERN}.`,
				}),
			),
			next_number: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"The running number the next invoice takes, when the owner has already used some: 14 makes the next one ...-014.",
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			return exclusive(async () => {
				const before = store.getProfile(db);
				const currency =
					args.currency === undefined ? (before?.currency ?? defaultCurrency) : currencyCode(args.currency);
				if (
					args.currency !== undefined &&
					before?.amountMinor !== undefined &&
					currency !== before.currency &&
					args.amount === undefined
				) {
					throw new Error(
						`The usual amount is ${formatMoney(before.amountMinor, before.currency)}. Changing the currency to ${currency} would change what it means: pass amount too (or amount: null to forget it).`,
					);
				}
				const change: store.ProfileChange = {
					...(args.client_name === undefined ? {} : { clientName: block(args.client_name, 120) }),
					...(args.client_address === undefined ? {} : { clientAddress: block(args.client_address, 400) }),
					...(args.sender_name === undefined ? {} : { senderName: block(args.sender_name, 120) }),
					...(args.sender_details === undefined ? {} : { senderDetails: block(args.sender_details, 400) }),
					...(args.description === undefined ? {} : { description: block(args.description, 200) }),
					...(args.amount === undefined
						? {}
						: { amountMinor: args.amount === null ? null : toMinor(args.amount, currency, "amount") }),
					...(args.currency === undefined ? {} : { currency }),
					...(args.payment_terms_days === undefined ? {} : { paymentTermsDays: args.payment_terms_days }),
					...(args.payment_details === undefined ? {} : { paymentDetails: block(args.payment_details, 500) }),
					...(args.notes === undefined ? {} : { notes: block(args.notes, 500) }),
					...(args.number_pattern === undefined ? {} : { numberPattern: checkPattern(args.number_pattern.trim()) }),
					...(args.next_number === undefined ? {} : { nextSeq: args.next_number }),
				};
				if (Object.keys(change).length === 0) {
					throw new Error("Nothing to change: give at least one field, for example client_name or amount.");
				}
				const now = api.now();
				// Rule 8: the call is recorded with the change; a replay finds it there and changes nothing, so it cannot undo a later edit.
				const applied = store.applyProfileChange(db, {
					change,
					currency,
					callId: api.callId,
					tool: "set_invoice_profile",
					subject: "profile",
					now,
				});
				const lines = [
					"Invoice profile saved.",
					...profileLines(store.getProfile(db) as store.ProfileRow, localDate(now, timezone)),
				];
				const latest = store.latestIssued(db);
				if (applied && args.next_number !== undefined && latest !== undefined && args.next_number <= latest.seq) {
					lines.push(
						`Note: invoice ${latest.number} already used running number ${latest.seq}. An invoice is refused when its number was used, so this only works if the pattern gives a different number.`,
					);
				}
				return {
					output: text(lines.join("\n")),
					details: asDetails(noteCard("Invoice profile saved", lines.slice(1))),
				};
			});
		},
	});

	const getProfile = defineTool({
		name: "get_invoice_profile",
		deferred: true,
		description:
			"What is saved for the monthly invoice: client, usual amount, line text, terms, numbering and the next number.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			const profile = store.getProfile(db);
			if (profile === undefined) {
				return {
					output: text(
						"No invoice profile yet. Ask the owner for the client's name and the usual amount, then call set_invoice_profile.",
					),
				};
			}
			const lines = profileLines(profile, localDate(api.now(), timezone));
			return { output: text(lines.join("\n")), details: asDetails(noteCard("Invoice profile", lines)) };
		},
	});

	// ----- making an invoice -----------------------------------------------------------------------------------------------

	const itemOf = (row: store.IssuedRow): InvoiceItem => {
		const file = fileStore.getFile(db, row.fileId);
		return {
			number: row.number,
			periodText: monthLabel(row.period),
			issueText: longDate(row.issueDate),
			dueText: longDate(row.dueDate),
			clientName: row.clientName,
			amountMinor: row.amountMinor,
			currency: row.currency,
			...(file === undefined ? {} : { file: { id: file.id, name: file.name, mime: file.mime, size: file.size } }),
		};
	};

	const invoiceResult = (row: store.IssuedRow, event: InvoiceCard["event"]) => {
		const item = itemOf(row);
		const lines = [
			`Invoice ${row.number} for ${item.periodText} is ready: ${formatMoney(row.amountMinor, row.currency)} to ${row.clientName}, issued ${dayText(row.issueDate, timezone)}, due ${dayText(row.dueDate, timezone)}.`,
			item.file === undefined
				? "The PDF file is no longer where it was made; generate it again with again: true if the owner needs it."
				: `The PDF (${item.file.name}) is in the chat for the owner to download. It has not been sent anywhere: the assistant never sends an invoice, the owner does.`,
		];
		const card: InvoiceCard = { type: "invoice", event, invoice: item };
		return { output: text(lines.join("\n")), details: asDetails(card) };
	};

	/** What is needed to make an invoice, or the error that says what to do first. */
	function readyProfile(): store.ProfileRow {
		const profile = store.getProfile(db);
		if (profile === undefined || profile.clientName === "") {
			throw new Error(
				"There is no invoice profile with a client yet. Ask the owner who the invoice is for (and the usual amount), then call set_invoice_profile with client_name.",
			);
		}
		checkPattern(profile.numberPattern);
		return profile;
	}

	const generate = defineTool({
		name: "generate_invoice",
		description:
			"Make this month's invoice as a PDF from the owner's template, with the next invoice number, the issue and due dates and the amount; the PDF appears in the chat as a download. " +
			"It never sends anything anywhere. Ask the owner for the amount if the profile has none or if this month's differs. A month that already has an invoice is refused unless again: true.",
		parameters: Type.Object({
			month: Type.Optional(
				Type.String({
					description:
						"The month the invoice is for, YYYY-MM. Default this month. Call current_time to turn 'last month' into one.",
				}),
			),
			amount: Type.Optional(
				Type.Number({
					exclusiveMinimum: 0,
					description: "This invoice's amount in major units; the profile's usual amount otherwise.",
				}),
			),
			again: Type.Optional(
				Type.Boolean({
					description:
						"Make another invoice for a month that has one already (it gets a new number). Only when the owner asks for it.",
				}),
			),
			overrides: Type.Optional(
				Type.Object({
					issue_date: Type.Optional(Type.String({ description: "The invoice date, YYYY-MM-DD. Default today." })),
					due_date: Type.Optional(
						Type.String({ description: "YYYY-MM-DD. Default: the issue date plus the payment terms." }),
					),
					description: Type.Optional(Type.String({ maxLength: 200, description: "The line on this invoice only." })),
					notes: Type.Optional(Type.String({ maxLength: 500, description: "The note on this invoice only." })),
					reference: Type.Optional(
						Type.String({ maxLength: 80, description: "A purchase order or reference number to print." }),
					),
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			return exclusive(async () => {
				// Rule 8: before anything reads the clock, a replay is answered from the invoice its first run made.
				const earlier = store.issuedByCallId(db, api.callId);
				if (earlier !== undefined) return invoiceResult(earlier, "existing");

				const invoices = deps.accountant?.invoices;
				if (invoices === undefined) {
					throw new Error(
						"Invoices are not set up on this server (no templates folder). The owner has to configure it; see docs/setup-invoice.md.",
					);
				}
				const now = api.now();
				const { facts, seq } = planInvoice(args, readyProfile(), now);
				// The PDF first: a template that fails uses no number and leaves no file.
				const pdf = await renderInvoicePdf({ facts, templatesDir: invoices.templatesDir });
				const path = await writePdf(invoices.outDir, facts.number, pdf);
				const file = fileStore.registerFile(db, {
					path,
					name: `${facts.number}.pdf`,
					mime: "application/pdf",
					kind: "pdf",
					size: pdf.length,
					source: "generated",
					now,
				}).row;
				// The number is taken with the invoice, in one transaction: a crash before it leaves a file the replay overwrites.
				const row = store.insertIssued(
					db,
					{
						number: facts.number,
						seq,
						period: facts.period,
						issueDate: facts.issueDate,
						dueDate: facts.dueDate,
						amountMinor: facts.amountMinor,
						currency: facts.currency,
						clientName: facts.profile.clientName,
						description: facts.description,
						fileId: file.id,
						filePath: path,
						now,
					},
					api.callId,
				);
				return invoiceResult(row, "created");
			});
		},
	});

	/**
	 * What one invoice says, and the running number it takes: the month, the dates, the amount and the number, each checked,
	 * with an error that says what to do when one cannot be. Nothing is written and nothing is taken. For a `preview` the two
	 * refusals that only protect the numbering (a month that has an invoice, a number that is used) are warnings instead:
	 * trying a template on a month that is done is the point of a preview.
	 */
	function planInvoice(
		args: GenerateArgs,
		profile: store.ProfileRow,
		now: number,
		mode: "issue" | "preview" = "issue",
	): { facts: InvoiceFacts; seq: number; warnings: string[] } {
		const warnings: string[] = [];
		const today = localDate(now, timezone);
		const period = args.month === undefined ? today.slice(0, 7) : args.month.trim();
		if (!MONTH.test(period) || period < "2000-01" || period > addDays(today, 366).slice(0, 7)) {
			throw new Error(
				`month must be YYYY-MM, such as ${today.slice(0, 7)}, and not more than a year ahead; got '${String(args.month).slice(0, 20)}'.`,
			);
		}
		const issueDate = pickDay(args.overrides?.issue_date, today, "overrides.issue_date");
		const dueDate = pickDay(
			args.overrides?.due_date,
			addDays(issueDate, profile.paymentTermsDays),
			"overrides.due_date",
		);
		if (dueDate < issueDate) throw new Error(`The due date ${dueDate} is before the issue date ${issueDate}.`);
		const amountMinor =
			args.amount === undefined ? profile.amountMinor : toMinor(args.amount, profile.currency, "amount");
		if (amountMinor === undefined || amountMinor <= 0) {
			throw new Error(
				"There is no amount: the profile has no usual amount. Ask the owner what to charge for this month and pass amount (set_invoice_profile can save it as the usual one).",
			);
		}
		const sameMonth = store.issuedForPeriod(db, period);
		if (sameMonth !== undefined && args.again !== true) {
			const message = `Invoice ${sameMonth.number} for ${monthLabel(period)} was already made on ${sameMonth.issueDate}.`;
			if (mode === "issue") {
				throw new Error(
					`${message} Tell the owner; if they really want another one for the same month, call again with again: true. It then gets a new number.`,
				);
			}
			warnings.push(`${message} generate_invoice refuses a second one for that month unless again: true.`);
		}
		const seq = profile.nextSeq;
		const number = formatNumber(profile.numberPattern, seq, issueDate);
		const used = store.issuedByNumber(db, number);
		if (used !== undefined) {
			const message = `The number ${number} was already used by the invoice for ${monthLabel(used.period)}. Raise the running number with set_invoice_profile (next_number), or change the numbering pattern.`;
			if (mode === "issue") throw new Error(message);
			warnings.push(`${message} generate_invoice would refuse until then.`);
		}
		const facts: InvoiceFacts = {
			number,
			period,
			issueDate,
			dueDate,
			amountMinor,
			currency: profile.currency,
			reference: block(args.overrides?.reference ?? "", 80),
			notes: args.overrides?.notes === undefined ? profile.notes : block(args.overrides.notes, 500),
			description:
				args.overrides?.description === undefined
					? profile.description || "Services for {period}"
					: block(args.overrides.description, 200),
			termsDays: daysBetween(issueDate, dueDate),
			profile,
		};
		return { facts, seq, warnings };
	}

	/** `<outDir>/<name>.pdf`, written through a temporary name and renamed, so a crash leaves no half file under a real name. */
	async function writePdf(outDir: string, name: string, pdf: Buffer): Promise<string> {
		const path = join(outDir, `${name}.pdf`);
		await mkdir(outDir, { recursive: true, mode: 0o700 });
		const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(temporary, pdf, { mode: 0o600 });
			await rename(temporary, path);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
		return path;
	}

	/** A day the call gave, or `fallback`. */
	function pickDay(value: string | undefined, fallback: string, name: string): string {
		if (value === undefined) return fallback;
		const day = value.trim();
		if (
			!DAY.test(day) ||
			Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ||
			new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
		) {
			throw new Error(`${name} must be a day written YYYY-MM-DD; got '${value.slice(0, 20)}'.`);
		}
		return day;
	}

	const preview = defineTool({
		name: "preview_invoice",
		description:
			"Show what an invoice would look like, as a PDF marked PREVIEW across every page: for a new or changed template, a different amount, or a look before generate_invoice. " +
			"It takes no invoice number, records nothing and makes no invoice; the PDF is a preview, not an invoice, and goes nowhere. Same arguments as generate_invoice (month, amount, overrides).",
		parameters: Type.Object({
			month: Type.Optional(
				Type.String({ description: "The month the invoice would be for, YYYY-MM. Default this month." }),
			),
			amount: Type.Optional(
				Type.Number({
					exclusiveMinimum: 0,
					description: "The amount in major units; the profile's usual amount otherwise.",
				}),
			),
			overrides: Type.Optional(
				Type.Object({
					issue_date: Type.Optional(Type.String({ description: "The invoice date, YYYY-MM-DD. Default today." })),
					due_date: Type.Optional(
						Type.String({ description: "YYYY-MM-DD. Default: the issue date plus the payment terms." }),
					),
					description: Type.Optional(Type.String({ maxLength: 200, description: "The line on this invoice only." })),
					notes: Type.Optional(Type.String({ maxLength: 500, description: "The note on this invoice only." })),
					reference: Type.Optional(
						Type.String({ maxLength: 80, description: "A purchase order or reference number to print." }),
					),
				}),
			),
		}),
		replay: "safe",
		async execute(args, api) {
			const invoices = deps.accountant?.invoices;
			if (invoices === undefined) {
				throw new Error(
					"Invoices are not set up on this server (no templates folder). The owner has to configure it; see docs/setup-invoice.md.",
				);
			}
			const now = api.now();
			const { facts, warnings } = planInvoice(args, readyProfile(), now, "preview");
			const pdf = await renderInvoicePdf({ facts, templatesDir: invoices.templatesDir, watermark: PREVIEW_WATERMARK });
			// One file per call, under previews/: a replay writes the same file again, and no preview is ever taken for an invoice.
			const name = `preview-${facts.number}-${createHash("sha256").update(api.callId).digest("hex").slice(0, 8)}`;
			const path = await writePdf(join(invoices.outDir, PREVIEWS_FOLDER), name, pdf);
			const file = fileStore.registerFile(db, {
				path,
				name: `preview-${facts.number}.pdf`,
				mime: "application/pdf",
				kind: "pdf",
				size: pdf.length,
				source: "generated",
				now,
			}).row;
			const item: InvoiceItem = {
				number: facts.number,
				periodText: monthLabel(facts.period),
				issueText: longDate(facts.issueDate),
				dueText: longDate(facts.dueDate),
				clientName: facts.profile.clientName,
				amountMinor: facts.amountMinor,
				currency: facts.currency,
				file: { id: file.id, name: file.name, mime: file.mime, size: file.size },
			};
			const lines = [
				`Preview of the invoice for ${item.periodText}: ${formatMoney(facts.amountMinor, facts.currency)} to ${facts.profile.clientName}, issued ${dayText(facts.issueDate, timezone)}, due ${dayText(facts.dueDate, timezone)}.`,
				`${PREVIEW_WATERMARK} is written across every page. It is not an invoice: no number is reserved (the next real invoice would be ${facts.number}), nothing was recorded and nothing was sent. The PDF (${file.name}) is in the chat for the owner to look at; generate_invoice makes the real one.`,
				...warnings,
			];
			const card: InvoiceCard = { type: "invoice", event: "preview", invoice: item };
			return { output: text(lines.join("\n")), details: asDetails(card) };
		},
	});

	const list = defineTool({
		name: "list_invoices",
		deferred: true,
		description: "The invoices made so far, newest first, with their numbers, months, amounts and PDFs.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LISTED, description: "Default 12." })),
		}),
		replay: "safe",
		async execute(args) {
			const { rows, total } = store.listIssued(db, args.limit ?? 12);
			if (rows.length === 0) return { output: text("No invoice has been made yet.") };
			const lines = rows.map(
				(row) =>
					`${row.number} · ${monthLabel(row.period)} · ${formatMoney(row.amountMinor, row.currency)} · ${row.clientName} · issued ${row.issueDate}`,
			);
			return {
				output: text(`${lines.join("\n")}${total > rows.length ? `\n… and ${total - rows.length} older.` : ""}`),
				details: asDetails({ type: "invoice_list", heading: "Invoices", invoices: rows.map(itemOf), total }),
			};
		},
	});

	return [setProfile, generate, preview, getProfile, list];
}
