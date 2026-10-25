import { defineExtension, section } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { filesMigrations } from "./migrations.ts";
import * as store from "./store.ts";
import { createFileTools } from "./tools.ts";

export const FILES_EXTENSION_NAME = "files";

/** How many of the newest files the prompt section names. */
const LISTED_IN_PROMPT = 5;

/**
 * The prompt section: which folders the PA may read and the newest files it knows, by id, name and type. It has no clock,
 * so it renders the same bytes until a file is added. That is how a file the owner just attached is found without a
 * search, and how the model knows `read_file_path` exists at all. Descriptions are left out on purpose (see below).
 */
export function renderFilesSection(deps: Pick<DomainDeps, "db" | "files">): string | undefined {
	const { total, recent } = store.recentFiles(deps.db, LISTED_IN_PROMPT);
	const roots = deps.files?.readPaths ?? [];
	if (total === 0 && roots.length === 0) return undefined;
	const lines: string[] = [];
	if (roots.length > 0) {
		lines.push(`Folders you may read (list_dir, read_file_path): ${roots.join(", ")}.`);
	}
	lines.push(
		total === 0
			? "No files are indexed yet. The owner attaches files to messages; each message names the file id to read_file."
			: `Files the assistant knows: ${total}. The newest:`,
	);
	for (const row of recent) {
		// Only what the server itself knows: a description is text the model wrote after reading a file that anyone may have
		// written, and a system-role section must not carry it. `search_files` shows descriptions, as tool output.
		lines.push(`- ${row.id} ${row.name} (${row.mime})`);
	}
	if (total > recent.length) lines.push("(search_files finds the others.)");
	return lines.join("\n");
}

export const filesModule: DomainModule = {
	name: "files",
	migrations: filesMigrations,
	extension: (deps) =>
		defineExtension({
			name: FILES_EXTENSION_NAME,
			tools: createFileTools(deps),
			sections: [section("files", () => renderFilesSection(deps))],
		}),
};

export { type ReadOutcome, readForModel } from "./read.ts";
export { type Detected, detectBinary, imageSize, judgeUpload, SNIFF_BYTES, safeName } from "./sniff.ts";
export * as fileStore from "./store.ts";
