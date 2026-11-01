import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import Mustache from "mustache";
import { DocumentError } from "./render.ts";
import { writeFileAtomicText } from "./write.ts";

/**
 * Saved document templates: any number of `<name>.html` files in `<data>/templates`, written by the owner or by an agent
 * with save_template. A template is a whole HTML page with Mustache fields (`{{client.name}}`, `{{#items}}…{{/items}}`).
 * The first comment in the file, `<!-- description: ... -->`, says what it is for.
 */

export const MAX_TEMPLATE_BYTES = 512 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DESCRIPTION = /<!--\s*description:\s*([\s\S]*?)-->/i;

export type TemplateInfo = { name: string; description: string; size: number };

export function checkTemplateName(name: string): string {
	if (!NAME.test(name)) {
		throw new DocumentError(
			`'${name.slice(0, 40)}' is not a template name: use 1 to 40 lowercase letters, digits and dashes, such as invoice or monthly-report.`,
		);
	}
	return name;
}

export async function listTemplates(dir: string): Promise<TemplateInfo[]> {
	let names: string[];
	try {
		names = (await readdir(dir)).filter((file) => file.endsWith(".html")).sort();
	} catch {
		return [];
	}
	const out: TemplateInfo[] = [];
	for (const file of names) {
		const name = file.slice(0, -".html".length);
		if (!NAME.test(name)) continue;
		const { source, size } = await readTemplate(dir, name);
		out.push({ name, size, description: oneLine(DESCRIPTION.exec(source)?.[1] ?? "") });
	}
	return out;
}

export async function readTemplate(dir: string, name: string): Promise<{ source: string; size: number }> {
	checkTemplateName(name);
	const path = join(dir, `${name}.html`);
	let real: string;
	try {
		real = await realpath(path);
	} catch {
		throw new DocumentError(`There is no template '${name}'. list_templates shows the ones there are.`);
	}
	if (!real.startsWith(`${await realpath(dir)}${sep}`)) {
		throw new DocumentError(`${path} links outside the templates folder, which is not allowed.`);
	}
	const size = (await stat(real)).size;
	if (size > MAX_TEMPLATE_BYTES) throw new DocumentError(`The template '${name}' is larger than 512 KB.`);
	return { source: await readFile(real, "utf8"), size };
}

export async function saveTemplate(dir: string, name: string, source: string): Promise<{ replaced: boolean }> {
	checkTemplateName(name);
	if (Buffer.byteLength(source) > MAX_TEMPLATE_BYTES) throw new DocumentError("A template can be at most 512 KB.");
	checkMustache(source, name);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${name}.html`);
	const replaced = await stat(path).then(
		() => true,
		() => false,
	);
	await writeFileAtomicText(path, source);
	return { replaced };
}

/** Fill a template's fields. A field the data does not have is an error that names it, never a silent blank. */
export function fillTemplate(source: string, data: Record<string, unknown>, name: string): string {
	checkMustache(source, name);
	const missing = missingFields(Mustache.parse(source) as unknown as Token[], [data]);
	if (missing.length > 0) {
		throw new DocumentError(
			`The template '${name}' uses ${[...new Set(missing)].slice(0, 8).join(", ")}, which the data does not have. Add them to data (use "" for an empty one).`,
		);
	}
	return Mustache.render(source, data, {}, { escape: escapeHtml });
}

function checkMustache(source: string, name: string): void {
	try {
		Mustache.parse(source);
	} catch (error) {
		throw new DocumentError(
			`The template '${name}' has a mistake: ${error instanceof Error ? error.message : String(error)}.`,
		);
	}
}

type Token = [string, string, number, number, Token[]?];

/** The `{{name}}` and `{{{name}}}` fields that no level of the data stack has. Sections push their value. */
function missingFields(tokens: readonly Token[], stack: readonly unknown[]): string[] {
	const out: string[] = [];
	for (const token of tokens) {
		const [type, name] = token;
		if (type === "name" || type === "&") {
			if (name !== "." && lookup(stack, name) === undefined) out.push(name);
		} else if (type === "#") {
			const value = lookup(stack, name);
			const inner = (token[4] ?? []) as Token[];
			const frames = Array.isArray(value) ? value : value === undefined || value === false ? [] : [value];
			for (const frame of frames) out.push(...missingFields(inner, [...stack, frame]));
		}
		// Inverted sections ({{^x}}) render only when x is empty, and their fields are checked when they would render.
		else if (type === "^" && !truthy(lookup(stack, name))) {
			out.push(...missingFields((token[4] ?? []) as Token[], stack));
		}
	}
	return out;
}

function lookup(stack: readonly unknown[], name: string): unknown {
	const parts = name.split(".");
	for (let i = stack.length - 1; i >= 0; i--) {
		let value: unknown = stack[i];
		if (typeof value !== "object" || value === null || !((parts[0] as string) in value)) continue;
		for (const part of parts) {
			value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[part] : undefined;
		}
		return value;
	}
	return undefined;
}

const truthy = (value: unknown): boolean => (Array.isArray(value) ? value.length > 0 : Boolean(value));

export function escapeHtml(value: unknown): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 200);
