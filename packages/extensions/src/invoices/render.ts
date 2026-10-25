import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { parseHtml } from "./html.ts";
import { imageSources, renderPdf, TemplateError } from "./pdf.ts";
import { type InvoiceFacts, renderTemplate, TEMPLATE_FILE, templateFields } from "./template.ts";

const MAX_TEMPLATE_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The template as the owner left it, read fresh at every invoice so an edit takes effect at once. */
async function readTemplate(templatesDir: string): Promise<{ source: string; path: string }> {
	const path = join(templatesDir, TEMPLATE_FILE);
	let root: string;
	let real: string;
	try {
		root = await realpath(templatesDir);
		real = await realpath(path);
	} catch {
		throw new TemplateError(
			`There is no invoice template at ${path}. The server writes a default one when it starts; copy your own there as ${TEMPLATE_FILE} (docs/setup-invoice.md).`,
		);
	}
	if (!real.startsWith(`${root}${sep}`)) {
		throw new TemplateError(
			`${path} is a link to a file outside the templates folder, which is not allowed. Copy the file there instead.`,
		);
	}
	const buffer = await readFile(real);
	if (buffer.length > MAX_TEMPLATE_BYTES) {
		throw new TemplateError(
			`The invoice template is ${Math.round(buffer.length / 1024)} KB; the most allowed is ${MAX_TEMPLATE_BYTES / 1024} KB.`,
		);
	}
	return { source: buffer.toString("utf8"), path };
}

const DATA_IMAGE = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * The images a template uses, by their `src`: a file below the templates folder (links resolved, so nothing outside it can
 * be read) or a `data:` PNG or JPEG. Anything else, such as a web address, is refused: nothing is ever fetched.
 */
async function loadImages(templatesDir: string, sources: readonly string[]): Promise<Map<string, Buffer>> {
	const images = new Map<string, Buffer>();
	if (sources.length === 0) return images;
	const root = await realpath(templatesDir);
	for (const src of sources) {
		const data = DATA_IMAGE.exec(src);
		if (data !== null) {
			const bytes = Buffer.from((data[2] as string).replace(/\s+/g, ""), "base64");
			if (bytes.length > MAX_IMAGE_BYTES)
				throw new TemplateError(`An image in the template is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
			images.set(src, bytes);
			continue;
		}
		if (/^[a-z][a-z0-9+.-]*:/i.test(src) || isAbsolute(src) || src.startsWith("//")) {
			throw new TemplateError(
				`The image '${src.slice(0, 60)}' cannot be used: only a file in the templates folder (src="logo.png") or a data: PNG or JPEG is allowed. Nothing is fetched from the web.`,
			);
		}
		let real: string;
		try {
			real = await realpath(join(root, src));
		} catch {
			throw new TemplateError(
				`The image '${src.slice(0, 60)}' is not in the templates folder (${root}). Put the file there.`,
			);
		}
		if (!real.startsWith(`${root}${sep}`)) {
			throw new TemplateError(`The image '${src.slice(0, 60)}' is outside the templates folder, which is not allowed.`);
		}
		const bytes = await readFile(real);
		if (bytes.length > MAX_IMAGE_BYTES)
			throw new TemplateError(`The image '${src.slice(0, 60)}' is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
		images.set(src, bytes);
	}
	return images;
}

/** The invoice as a PDF: the owner's template, its fields filled in, laid out on a page. Nothing is written or sent. */
export async function renderInvoicePdf(input: {
	facts: InvoiceFacts;
	templatesDir: string;
	/** Off only in tests, which read the text out of the page streams. */
	compress?: boolean;
	/** Across every page, for a preview that must not be mistaken for an invoice. */
	watermark?: string;
}): Promise<Buffer> {
	const { source, path } = await readTemplate(input.templatesDir);
	const html = renderTemplate(source, templateFields(input.facts), `(${path})`);
	const parsed = parseHtml(html);
	const images = await loadImages(input.templatesDir, imageSources(parsed.nodes));
	return await renderPdf(parsed, {
		images,
		title: `Invoice ${input.facts.number}`,
		...(input.facts.profile.senderName === "" ? {} : { author: input.facts.profile.senderName }),
		...(input.compress === undefined ? {} : { compress: input.compress }),
		...(input.watermark === undefined ? {} : { watermark: input.watermark }),
	});
}

export { TemplateError };
