import { defineExtension, section } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { localDate } from "../time.ts";
import { documentsMigrations } from "./migrations.ts";
import { formatNumber } from "./numbering.ts";
import * as store from "./store.ts";
import { createDocumentTools } from "./tools.ts";

export const DOCUMENTS_EXTENSION_NAME = "documents";

/** The prompt section: whether PDFs can be made, and the next number of each series. Changes only when a number is taken. */
export function renderDocumentsSection(deps: Pick<DomainDeps, "db" | "now" | "timezone" | "documents">): string {
	if (deps.documents === undefined)
		return "Documents: PDFs cannot be made on this server (no Chrome or Chromium found).";
	const series = store.listSeries(deps.db);
	const today = localDate(deps.now(), deps.timezone);
	const lines = ["Documents: make_pdf makes PDFs; list_templates shows the saved designs."];
	if (series.length === 0) lines.push("No number series yet.");
	for (const row of series) {
		const last = store.recentNumbers(deps.db, row.series, 1)[0];
		lines.push(
			`Next ${row.series} number: ${formatNumber(row.pattern, row.nextSeq, today)}${last === undefined ? "" : ` (last: ${last.number}${last.label === "" ? "" : `, ${last.label}`})`}.`,
		);
	}
	return lines.join("\n");
}

export const documentsModule: DomainModule = {
	name: "documents",
	migrations: documentsMigrations,
	extension: (deps) =>
		defineExtension({
			name: DOCUMENTS_EXTENSION_NAME,
			tools: createDocumentTools(deps),
			sections: [section("documents", () => renderDocumentsSection(deps))],
		}),
};

export { checkPattern, DEFAULT_NUMBER_PATTERN, formatNumber, patternProblem } from "./numbering.ts";
export { createChromiumRenderer, DocumentError, inlineLocalImages, type PdfRenderer } from "./render.ts";
export * as documentsStore from "./store.ts";
export { fillTemplate, listTemplates, saveTemplate } from "./templates.ts";
