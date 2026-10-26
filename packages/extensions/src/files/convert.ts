import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Turning documents into what the model can take: text and page images. pi-ai only sends text and images to a model, so
 * a PDF is read as its text plus pictures of its pages, and an Office document is first made into a PDF.
 *
 * The work is done by poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) and LibreOffice (`soffice`), run with fixed
 * arguments (never a shell), a time limit and a scratch directory that is removed afterwards. A missing program is
 * reported with what to install, not as a crash.
 */

const run = promisify(execFile);

/** Office documents LibreOffice turns into PDF, by extension. Each is a ZIP file (or OLE for the old formats). */
export const OFFICE_DOCUMENTS: Readonly<Record<string, string>> = {
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	odp: "application/vnd.oasis.opendocument.presentation",
	doc: "application/msword",
	xls: "application/vnd.ms-excel",
	ppt: "application/vnd.ms-powerpoint",
	rtf: "application/rtf",
};

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 64 * 1024 * 1024;
/** Pages are drawn at this resolution: readable for a model, small enough to send several. */
const PAGE_DPI = 110;

export class ConverterMissing extends Error {
	constructor(program: string, pkg: string) {
		super(`${program} is not installed on the server, so this document cannot be read. Install ${pkg} and try again.`);
		this.name = "ConverterMissing";
	}
}

async function tool(program: string, pkg: string, args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await run(program, args, {
			cwd,
			timeout: TIMEOUT_MS,
			maxBuffer: MAX_OUTPUT,
			encoding: "utf8",
			// LibreOffice writes its profile to HOME: keep it in the scratch directory, away from the owner's own.
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8" },
		});
		return stdout;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConverterMissing(program, pkg);
		if ((error as { killed?: boolean }).killed) throw new Error(`${program} took longer than ${TIMEOUT_MS / 1000} s.`);
		const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
		throw new Error(`${program} could not read the document${stderr === "" ? "" : `: ${stderr.slice(0, 300)}`}.`);
	}
}

async function withScratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "zimpoen-doc-"));
	try {
		return await work(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** An Office document as a PDF. */
export async function officeToPdf(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
	if (OFFICE_DOCUMENTS[ext] === undefined) throw new Error(`.${ext} is not a document type that can be converted.`);
	return withScratch(async (dir) => {
		const input = join(dir, `document.${ext}`);
		await writeFile(input, bytes);
		await tool(
			"soffice",
			"LibreOffice",
			["--headless", "--norestore", "--convert-to", "pdf", "--outdir", dir, input],
			dir,
		);
		return new Uint8Array(await readFile(join(dir, "document.pdf")));
	});
}

export type PdfPages = {
	pageCount: number;
	first: number;
	last: number;
	/** The text of each page from `first` to `last`, in order. */
	texts: string[];
	/** PNGs of the pages from `first` up to `imagesUpTo` (none when 0). */
	images: Array<{ page: number; png: Uint8Array }>;
};

/** Text of pages `first`..`last` and PNG pictures of the first `imageCount` of them. */
export async function readPdfPages(
	bytes: Uint8Array,
	options: { first: number; maxPages: number; imageCount: number },
): Promise<PdfPages> {
	return withScratch(async (dir) => {
		const input = join(dir, "document.pdf");
		await writeFile(input, bytes);
		const info = await tool("pdfinfo", "poppler-utils", [input], dir);
		const pageCount = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
		if (pageCount === 0) throw new Error("The PDF has no pages, or is damaged.");
		if (options.first > pageCount) {
			throw new Error(`page ${options.first} is past the end: the PDF has ${pageCount} page(s).`);
		}
		const first = options.first;
		const last = Math.min(pageCount, first + options.maxPages - 1);
		const text = await tool(
			"pdftotext",
			"poppler-utils",
			["-layout", "-enc", "UTF-8", "-f", String(first), "-l", String(last), input, "-"],
			dir,
		);
		// pdftotext ends every page with a form feed.
		const texts = text.split("\f").slice(0, last - first + 1);
		const imageLast = Math.min(last, first + options.imageCount - 1);
		const images: PdfPages["images"] = [];
		if (options.imageCount > 0) {
			await tool(
				"pdftoppm",
				"poppler-utils",
				["-png", "-r", String(PAGE_DPI), "-f", String(first), "-l", String(imageLast), input, join(dir, "page")],
				dir,
			);
			// pdftoppm pads the page number to the width of the page count: page-1.png, page-01.png, page-001.png.
			const files = (await readdir(dir)).filter((name) => /^page-\d+\.png$/.test(name));
			for (const name of files) {
				const page = Number(/(\d+)\.png$/.exec(name)?.[1]);
				images.push({ page, png: new Uint8Array(await readFile(join(dir, name))) });
			}
			images.sort((a, b) => a.page - b.page);
		}
		return { pageCount, first, last, texts, images };
	});
}
