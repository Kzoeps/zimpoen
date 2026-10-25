import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatAmount, formatMoney } from "@assistant/shared";
import Mustache from "mustache";
import { DEFAULT_INVOICE_TEMPLATE } from "./default-template.ts";
import { TemplateError } from "./pdf.ts";
import type { ProfileRow } from "./store.ts";

/** The template's file name inside `<data>/templates`. */
export const TEMPLATE_FILE = "invoice.html";

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

/** `25 October 2026` for `2026-10-25`: the same words whatever the machine's locale. */
export function longDate(day: string): string {
	return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

export const monthLabel = (period: string): string => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

export const escapeHtml = (text: string): string =>
	text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

/** Text as HTML this program escaped itself: line breaks become `<br>`. For the fields whose names end in `_html`. */
const htmlLines = (text: string): string => escapeHtml(text).replace(/\r?\n/g, "<br>");

const linesOf = (text: string): string[] =>
	text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");

/** What one invoice says, before it is turned into the fields of the template. */
export type InvoiceFacts = {
	number: string;
	/** The month it is for, `2026-10`. */
	period: string;
	issueDate: string;
	dueDate: string;
	amountMinor: number;
	currency: string;
	reference: string;
	/** The profile's notes, or the call's. */
	notes: string;
	/** The line on the invoice, with `{period}`, `{month}` and `{year}` not yet replaced. */
	description: string;
	termsDays: number;
	profile: Pick<ProfileRow, "senderName" | "senderDetails" | "clientName" | "clientAddress" | "paymentDetails">;
};

/** `Consulting for {period}` as `Consulting for October 2026`. */
export function fillDescription(description: string, period: string): string {
	return description
		.replace(/\{period\}/g, monthLabel(period))
		.replace(/\{month\}/g, MONTHS[Number(period.slice(5, 7)) - 1] ?? "")
		.replace(/\{year\}/g, period.slice(0, 4));
}

/**
 * Everything a template can use. `docs/setup-invoice.md` documents each field; this is the one place that defines them.
 * Fields are plain text: `{{field}}` escapes them for HTML; the `_html` fields are already escaped for `{{{field}}}`.
 */
export function templateFields(facts: InvoiceFacts) {
	const description = fillDescription(facts.description, facts.period);
	const amount = formatMoney(facts.amountMinor, facts.currency);
	const sender = facts.profile;
	return {
		invoice: {
			number: facts.number,
			period: monthLabel(facts.period),
			month: MONTHS[Number(facts.period.slice(5, 7)) - 1] ?? "",
			year: facts.period.slice(0, 4),
			issue_date: longDate(facts.issueDate),
			due_date: longDate(facts.dueDate),
			issue_date_iso: facts.issueDate,
			due_date_iso: facts.dueDate,
			terms_days: String(facts.termsDays),
			description,
			reference: facts.reference,
			notes: facts.notes,
			notes_html: htmlLines(facts.notes),
			amount,
			amount_plain: formatAmount(facts.amountMinor, facts.currency),
			currency: facts.currency,
			currency_label: facts.currency === "BTN" ? "Nu." : facts.currency,
		},
		sender: {
			name: sender.senderName,
			details: sender.senderDetails,
			details_html: htmlLines(sender.senderDetails),
			lines: linesOf(sender.senderDetails),
		},
		client: {
			name: sender.clientName,
			address: sender.clientAddress,
			address_html: htmlLines(sender.clientAddress),
			lines: linesOf(sender.clientAddress),
		},
		payment_details: sender.paymentDetails,
		payment_details_html: htmlLines(sender.paymentDetails),
		lines: [{ description, quantity: "1", unit_price: amount, amount }],
		total: amount,
	};
}

export type TemplateFields = ReturnType<typeof templateFields>;

/** The dotted names of every field, for the message that lists them. */
function fieldNames(value: unknown, prefix = ""): string[] {
	if (Array.isArray(value)) return [prefix];
	if (value !== null && typeof value === "object") {
		return Object.entries(value).flatMap(([key, inner]) => fieldNames(inner, prefix === "" ? key : `${prefix}.${key}`));
	}
	return [prefix];
}

type Span = [type: string, value: string, start: number, end: number, children?: Span[]];

/** Looks a dotted name up the chain of scopes the way Mustache does; undefined when no scope has it. */
function lookup(name: string, scopes: readonly unknown[]): { found: boolean; value: unknown } {
	const path = name.split(".");
	for (let index = scopes.length - 1; index >= 0; index--) {
		let value: unknown = scopes[index];
		const first = path[0] as string;
		if (value === null || typeof value !== "object" || !(first in value)) continue;
		for (const segment of path) {
			if (value === null || typeof value !== "object" || !(segment in value)) return { found: false, value: undefined };
			value = (value as Record<string, unknown>)[segment];
		}
		return { found: true, value };
	}
	return { found: false, value: undefined };
}

/** The first thing in the template that is not a field: Mustache itself would print nothing for it, and the typo would go unseen. */
function unknownField(spans: readonly Span[], scopes: readonly unknown[]): string | undefined {
	for (const span of spans) {
		const [type, name] = span;
		if (type === ">") return `{{>${name}}}, a partial: partials are not supported`;
		if (type === "text" || type === "!" || name === ".") continue;
		const found = lookup(name, scopes);
		if (!found.found) {
			return type === "#" || type === "^" ? `{{${type}${name}}}` : type === "&" ? `{{{${name}}}}` : `{{${name}}}`;
		}
		if (span[4] !== undefined) {
			const value = found.value;
			const inner = Array.isArray(value) ? value[0] : value;
			const next = inner !== null && typeof inner === "object" ? [...scopes, inner] : scopes;
			const problem = unknownField(span[4], next);
			if (problem !== undefined) return problem;
		}
	}
	return undefined;
}

/**
 * Fill the template's fields. A mistake in the template (a section that is not closed, a field that does not exist) is a
 * {@link TemplateError} that says which, so a typo cannot silently print nothing on an invoice.
 */
export function renderTemplate(source: string, fields: TemplateFields, where: string): string {
	let spans: Span[];
	try {
		spans = Mustache.parse(source) as unknown as Span[];
	} catch (error) {
		throw new TemplateError(
			`The invoice template ${where} has a mistake: ${error instanceof Error ? error.message : String(error)}. Fix it (docs/setup-invoice.md describes the fields).`,
		);
	}
	const wrong = unknownField(spans, [fields]);
	if (wrong !== undefined) {
		throw new TemplateError(
			`The invoice template ${where} uses ${wrong}, which is not a field. The fields are: ${fieldNames(fields).join(", ")}. Fix the name (docs/setup-invoice.md describes them).`,
		);
	}
	return Mustache.render(source, fields);
}

/** Write the default template to `<dir>/invoice.html` unless a file is there: the owner's own is never overwritten. */
export async function seedInvoiceTemplate(dir: string): Promise<{ created: boolean; path: string }> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, TEMPLATE_FILE);
	try {
		await writeFile(path, DEFAULT_INVOICE_TEMPLATE, { flag: "wx", mode: 0o600 });
		return { created: true, path };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false, path };
		throw error;
	}
}
