import { access, constants, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createChromiumRenderer, type DocumentsDeps } from "@assistant/extensions";
import type { Config } from "./config.ts";

/** Where Chrome or Chromium usually is, tried in order when `ASSISTANT_CHROMIUM_PATH` is not set. */
const CANDIDATES = [
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/snap/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/**
 * What the documents tools need: where PDFs go (`<workspace>/documents`), the templates folder, and a renderer on the
 * Chromium this machine has. Undefined when there is none: the server still starts and make_pdf says what to install.
 */
export async function documentsDeps(
	config: Config,
	warn: (message: string) => void,
): Promise<DocumentsDeps | undefined> {
	const executable = await findChromium(config.chromiumPath);
	if (executable === undefined) {
		warn(
			config.chromiumPath === undefined
				? "[documents] no Chrome or Chromium found, so PDFs cannot be made. Install chromium or set ASSISTANT_CHROMIUM_PATH."
				: `[documents] ASSISTANT_CHROMIUM_PATH=${config.chromiumPath} is not an executable file, so PDFs cannot be made.`,
		);
		return undefined;
	}
	const folder = join(config.paths.workspace, "documents");
	await mkdir(folder, { recursive: true, mode: 0o700 });
	// File paths are stored with links resolved, as the file policy compares them.
	return {
		outDir: await realpath(folder),
		templatesDir: config.paths.templates,
		renderer: createChromiumRenderer(executable),
	};
}

async function findChromium(configured: string | undefined): Promise<string | undefined> {
	for (const path of configured === undefined ? CANDIDATES : [configured]) {
		if (
			await access(path, constants.X_OK).then(
				() => true,
				() => false,
			)
		)
			return path;
	}
	return undefined;
}
