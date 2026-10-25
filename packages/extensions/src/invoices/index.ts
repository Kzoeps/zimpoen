import { formatMoney } from "@assistant/shared";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { localDate } from "../time.ts";
import { invoicesMigrations } from "./migrations.ts";
import { formatNumber } from "./numbering.ts";
import * as store from "./store.ts";
import { monthLabel } from "./template.ts";
import { createInvoiceTools } from "./tools.ts";

export const INVOICES_EXTENSION_NAME = "invoices";

/**
 * The prompt section: whether the invoice profile is set up, the number the next invoice will take and the last one made.
 * The next number carries the year (or month) of today when the pattern has one, so the section changes with the calendar
 * as the pattern says and with nothing else: no time of day.
 */
export function renderInvoicesSection(deps: Pick<DomainDeps, "db" | "now" | "timezone" | "accountant">): string {
	if (deps.accountant?.invoices === undefined) return "Invoices are not set up on this server.";
	const profile = store.getProfile(deps.db);
	if (profile === undefined || profile.clientName === "") {
		return "Invoice profile: not set up yet. When the owner wants an invoice, ask who it is for and the usual amount, then call set_invoice_profile.";
	}
	const next = formatNumber(profile.numberPattern, profile.nextSeq, localDate(deps.now(), deps.timezone));
	const last = store.latestIssued(deps.db);
	return [
		`Invoice profile: for ${profile.clientName}; ${profile.amountMinor === undefined ? "no usual amount yet" : `usual amount ${formatMoney(profile.amountMinor, profile.currency)}`}; payment due ${profile.paymentTermsDays} days after the issue date.`,
		`Next invoice number: ${next}.`,
		last === undefined
			? "No invoice has been made yet."
			: `Last invoice: ${last.number} for ${monthLabel(last.period)}.`,
	].join("\n");
}

export const invoicesModule: DomainModule = {
	name: "invoices",
	migrations: invoicesMigrations,
	extension: (deps) =>
		defineExtension({
			name: INVOICES_EXTENSION_NAME,
			tools: createInvoiceTools(deps),
			sections: [section("invoices", () => renderInvoicesSection(deps))],
		}),
};

export { DEFAULT_INVOICE_TEMPLATE } from "./default-template.ts";
export { parseHtml } from "./html.ts";
export { checkPattern, DEFAULT_NUMBER_PATTERN, formatNumber, patternProblem } from "./numbering.ts";
export { TemplateError, toWinAnsi } from "./pdf.ts";
export { renderInvoicePdf } from "./render.ts";
export * as invoicesStore from "./store.ts";
export { escapeHtml, longDate, seedInvoiceTemplate, TEMPLATE_FILE, templateFields } from "./template.ts";
