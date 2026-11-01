import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, sep } from "node:path";
import { chromium } from "playwright-core";

export type PaperFormat = "A4" | "Letter";

export type RenderOptions = {
	paper: PaperFormat;
	landscape: boolean;
	/** Relative image paths (`src="logo.png"`) resolve inside this folder; nothing outside it can be read. */
	assetsDir: string;
};

/** Turns a whole HTML document into PDF bytes. The documents tools take one, so tests can pass a fake. */
export type PdfRenderer = {
	render(html: string, options: RenderOptions): Promise<Buffer>;
};

/** A document the owner can fix: the message says what is wrong and what to do. */
export class DocumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DocumentError";
	}
}

const RENDER_TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
};

/**
 * Renders with a headless Chromium the server already has (`executablePath`). The page runs no scripts and fetches
 * nothing: every request except `data:` URLs is aborted, and local images are inlined from `assetsDir` first. A browser is
 * started for each document and closed after it, so nothing stays running between documents.
 */
export function createChromiumRenderer(executablePath: string): PdfRenderer {
	return {
		async render(html, options) {
			const inlined = await inlineLocalImages(html, options.assetsDir);
			const browser = await chromium
				.launch({ executablePath, headless: true, timeout: RENDER_TIMEOUT_MS })
				.catch((error) => {
					throw new Error(
						`Could not start Chromium at ${executablePath} (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). Set ASSISTANT_CHROMIUM_PATH to a working Chrome or Chromium.`,
					);
				});
			try {
				const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
				await context.route("**/*", (route) =>
					route.request().url().startsWith("data:") ? route.continue() : route.abort("blockedbyclient"),
				);
				const page = await context.newPage();
				await page.setContent(inlined, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
				return await page.pdf({
					format: options.paper,
					landscape: options.landscape,
					printBackground: true,
					preferCSSPageSize: true,
					margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
				});
			} finally {
				await browser.close().catch(() => {});
			}
		},
	};
}

/** Replace `src="file.png"` (and `url(file.png)` in CSS) with data URLs read from `dir`. Web addresses are left to be blocked. */
export async function inlineLocalImages(html: string, dir: string): Promise<string> {
	const refs = new Set<string>();
	for (const match of html.matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.add(match[1] as string);
	for (const match of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) refs.add(match[1] as string);
	const local = [...refs].filter(
		(ref) => !/^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith("//") && !ref.startsWith("#"),
	);
	if (local.length === 0) return html;

	let root: string;
	try {
		root = await realpath(dir);
	} catch {
		throw new DocumentError(`The document uses ${local[0]}, but the templates folder ${dir} does not exist.`);
	}
	let out = html;
	for (const ref of local) {
		const type = IMAGE_TYPES[extname(ref).toLowerCase()];
		if (type === undefined || isAbsolute(ref)) {
			throw new DocumentError(
				`'${ref.slice(0, 60)}' cannot be used: images must be PNG, JPEG, GIF, WebP or SVG files in the templates folder (src="logo.png"), or data: URLs.`,
			);
		}
		let real: string;
		try {
			real = await realpath(join(root, ref));
		} catch {
			throw new DocumentError(
				`The image '${ref.slice(0, 60)}' is not in the templates folder (${root}). Put it there.`,
			);
		}
		if (!real.startsWith(`${root}${sep}`)) {
			throw new DocumentError(`The image '${ref.slice(0, 60)}' is outside the templates folder, which is not allowed.`);
		}
		const bytes = await readFile(real);
		if (bytes.length > MAX_IMAGE_BYTES) throw new DocumentError(`The image '${ref.slice(0, 60)}' is larger than 5 MB.`);
		out = out.split(ref).join(`data:${type};base64,${bytes.toString("base64")}`);
	}
	return out;
}
