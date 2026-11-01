import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { safeName } from "../files/sniff.ts";
import * as fileStore from "../files/store.ts";
import type { DocumentsDeps, DomainDeps } from "../module.ts";
import { localDate } from "../time.ts";
import { asDetails, text } from "../tool-support.ts";
import { DocumentError, type PaperFormat } from "./render.ts";
import * as store from "./store.ts";
import { fillTemplate, listTemplates, readTemplate, saveTemplate } from "./templates.ts";
import { writeFileAtomicBytes } from "./write.ts";

export type DocumentToolDeps = Pick<DomainDeps, "db" | "timezone" | "documents">;

const MAX_HTML_CHARS = 400_000;

/**
 * General documents: the model writes the HTML (or fills a saved template) and gets a PDF in the chat. Invoices, quotes,
 * letters and receipts are all just documents; what an invoice must say lives in the agent's instructions, not here.
 * Numbers that must never repeat come from next_number, taken in a transaction. Nothing is ever sent anywhere.
 */
export function createDocumentTools(deps: DocumentToolDeps): ToolRegistration[] {
	const { db, timezone } = deps;
	const setup = (): DocumentsDeps => {
		if (deps.documents === undefined) {
			throw new Error(
				"Documents are not set up on this server: it found no Chrome or Chromium. The owner can install one or set ASSISTANT_CHROMIUM_PATH (docs/SETUP.md).",
			);
		}
		return deps.documents;
	};

	const makePdf = defineTool({
		name: "make_pdf",
		description:
			"Make a PDF from HTML and put it in the chat for the owner to download: an invoice, quote, receipt, letter, report, anything. " +
			"Either give html, a complete page you wrote (inline <style> and any CSS work; no scripts, no web images), or template plus data to fill a saved template. " +
			"Nothing is sent anywhere. Call it again with changes when the owner wants a different version.",
		parameters: Type.Object({
			filename: Type.String({
				minLength: 1,
				maxLength: 80,
				description: "The file's name without .pdf, such as INV-2026-014 or Quote-Acme-November.",
			}),
			html: Type.Optional(Type.String({ maxLength: MAX_HTML_CHARS, description: "The whole document as HTML." })),
			template: Type.Optional(
				Type.String({ description: "A saved template's name (list_templates), instead of html." }),
			),
			data: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description:
						"The values for the template's {{fields}}, as JSON. Lists ({{#items}}...{{/items}}) are arrays of objects.",
				}),
			),
			paper: Type.Optional(Type.Union([Type.Literal("A4"), Type.Literal("Letter")], { description: "Default A4." })),
			landscape: Type.Optional(Type.Boolean({ description: "Default false." })),
		}),
		replay: "safe",
		async execute(args, api) {
			const earlier = store.madeByCall(db, api.callId);
			if (earlier !== undefined) return made(fileStore.requireFile(db, earlier), true);

			const documents = setup();
			const html = await documentHtml(documents, args);
			const pdf = await documents.renderer.render(html, {
				paper: (args.paper ?? "A4") as PaperFormat,
				landscape: args.landscape ?? false,
				assetsDir: documents.templatesDir,
			});
			await mkdir(documents.outDir, { recursive: true, mode: 0o700 });
			const path = await freePath(documents.outDir, safeName(args.filename, "pdf"));
			await writeFileAtomicBytes(path, pdf);
			const now = api.now();
			const row = db.transaction(() => {
				const file = fileStore.registerFile(db, {
					path,
					name: path.slice(documents.outDir.length + 1),
					mime: "application/pdf",
					kind: "pdf",
					size: pdf.length,
					source: "generated",
					now,
				}).row;
				store.recordMade(db, api.callId, file.id, now);
				return file;
			});
			return made(row, false);
		},
	});

	function made(row: fileStore.FileRow, replayed: boolean) {
		return {
			output: text(
				`${replayed ? "Already made" : "Made"} ${row.name} (${Math.round(row.size / 1024)} KB, file ${row.id}). It is in the chat for the owner to download; nothing was sent anywhere. read_file with the id shows its pages if you want to check the layout.`,
			),
			details: asDetails({ type: "file", event: "registered", file: fileStore.toSummary(row) }),
		};
	}

	const list = defineTool({
		name: "list_templates",
		deferred: true,
		description:
			"The saved document templates (invoice, quote and so on) with what each is for. read_template shows one; make_pdf fills one.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			const templates = await listTemplates(setup().templatesDir);
			if (templates.length === 0) return { output: text("No templates are saved yet.") };
			return {
				output: text(
					templates
						.map(
							(t) => `${t.name}${t.description === "" ? "" : `: ${t.description}`} (${Math.round(t.size / 1024)} KB)`,
						)
						.join("\n"),
				),
			};
		},
	});

	const read = defineTool({
		name: "read_template",
		deferred: true,
		description: "A saved template's HTML, to see its {{fields}} before filling it or to start a new one from it.",
		parameters: Type.Object({ name: Type.String() }),
		replay: "safe",
		async execute(args) {
			const { source } = await readTemplate(setup().templatesDir, args.name);
			return { output: text(source) };
		},
	});

	const save = defineTool({
		name: "save_template",
		deferred: true,
		description:
			"Save HTML with {{fields}} as a reusable template (for example the owner's invoice design), or replace one. " +
			"Start the file with <!-- description: what it is for --> so list_templates can say. Save one only when the owner wants a design kept.",
		parameters: Type.Object({
			name: Type.String({ description: "Lowercase letters, digits and dashes: invoice, quote, monthly-report." }),
			html: Type.String({ maxLength: MAX_HTML_CHARS }),
		}),
		replay: "safe",
		async execute(args) {
			const { replaced } = await saveTemplate(setup().templatesDir, args.name, args.html);
			return { output: text(`${replaced ? "Replaced" : "Saved"} the template '${args.name}'.`) };
		},
	});

	const next = defineTool({
		name: "next_number",
		description:
			"Take the next number of a series (invoice, quote, receipt...) for good, such as INV-2026-014. Take it only for a document you are about to make for real, never for a draft: a number is never given twice. " +
			"A series that does not exist yet starts at 1 with the pattern INV-{YYYY}-{seq:03}; set_number_series changes that.",
		parameters: Type.Object({
			series: Type.String({ description: "invoice, quote, receipt..." }),
			label: Type.Optional(Type.String({ maxLength: 120, description: "What it is for: 'Acme, October consulting'." })),
		}),
		replay: "safe",
		async execute(args, api) {
			const now = api.now();
			const { taken, replayed } = store.takeNumber(db, {
				series: store.checkSeries(args.series),
				date: localDate(now, timezone),
				label: (args.label ?? "").trim(),
				callId: api.callId,
				now,
			});
			return {
				output: text(`${replayed ? "Already took" : "Took"} ${taken.number} (${taken.series} number ${taken.seq}).`),
			};
		},
	});

	const setSeries = defineTool({
		name: "set_number_series",
		deferred: true,
		description:
			"Create a number series or change its pattern or next number, for example to continue from invoices made by hand ('my next invoice is 14'). " +
			"Pattern fields: {YYYY} {YY} {MM} (of the day the number is taken) and {seq} or {seq:03} (zero padded), with letters, digits and . _ # -.",
		parameters: Type.Object({
			series: Type.String(),
			pattern: Type.Optional(Type.String({ description: "Such as INV-{YYYY}-{seq:03} or Q{seq}." })),
			next: Type.Optional(Type.Integer({ minimum: 1, description: "The running number the next document takes." })),
		}),
		replay: "safe",
		async execute(args, api) {
			const row = store.setSeries(db, {
				series: store.checkSeries(args.series),
				...(args.pattern === undefined ? {} : { pattern: args.pattern }),
				...(args.next === undefined ? {} : { next: args.next }),
				now: api.now(),
			});
			return { output: text(`The ${row.series} series uses ${row.pattern}; its next number is ${row.nextSeq}.`) };
		},
	});

	return [makePdf, list, read, save, next, setSeries];
}

async function documentHtml(
	documents: DocumentsDeps,
	args: { html?: string | undefined; template?: string | undefined; data?: Record<string, unknown> | undefined },
): Promise<string> {
	if ((args.html === undefined) === (args.template === undefined)) {
		throw new DocumentError("Give either html (a whole document) or template with data, not both and not neither.");
	}
	if (args.html !== undefined) return args.html;
	const name = args.template as string;
	const { source } = await readTemplate(documents.templatesDir, name);
	return fillTemplate(source, args.data ?? {}, name);
}

/** `name.pdf`, or `name-2.pdf` and so on when a file of that name is already there: a document never overwrites another. */
async function freePath(dir: string, name: string): Promise<string> {
	const stem = name.slice(0, -".pdf".length);
	for (let n = 1; ; n++) {
		const path = join(dir, n === 1 ? name : `${stem}-${n}.pdf`);
		const taken = await stat(path).then(
			() => true,
			() => false,
		);
		if (!taken) return path;
	}
}
