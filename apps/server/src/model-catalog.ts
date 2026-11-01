import { readFile } from "node:fs/promises";
import type { Provider } from "@earendil-works/pi-ai/models";
import { getModelType } from "@earendil-works/pi-ai/models";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { writeFileAtomic } from "./atomic-file.ts";
import { type Env, resolveDataPaths } from "./config.ts";

/**
 * pi-ai ships each provider's model list frozen at release time. Pi's CLI adds newer models from pi.dev's catalog
 * (`pi update --models`). This module does the same for the server, once, on demand: `pnpm models:update` downloads the
 * OpenAI catalog to `<data>/model-catalog.json`, and the server merges that file over the bundled list at startup. The
 * server itself never fetches it.
 */

export const CATALOG_URL = "https://pi.dev/api/models/providers/openai?types=chat,image,classifier";
const MODEL_TYPES = ["chat", "image", "classifier"];

type AnyModel = ReturnType<NonNullable<Provider["getAllModels"]>>[number];

export type ModelCatalogFile = {
	/** The catalog's Last-Modified, epoch ms (0 when the server sent none). */
	lastModified: number;
	/** When `pnpm models:update` downloaded it, epoch ms. */
	fetchedAt: number;
	models: AnyModel[];
};

/** What the server did with the catalog file at startup, for the log. */
export type ModelCatalogStatus =
	| { kind: "missing" }
	| { kind: "applied"; added: string[]; lastModified: number }
	| { kind: "older"; lastModified: number }
	| { kind: "invalid"; message: string };

/** The catalog's entries for `providerId`. Throws when the body is not a model list. */
export function parseCatalog(providerId: string, value: unknown): AnyModel[] {
	const entries = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.models)
			? value.models
			: isRecord(value)
				? Object.values(value)
				: undefined;
	if (entries === undefined) throw new Error(`the ${providerId} catalog is not a list of models`);
	return entries
		.filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.id === "string")
		.filter((entry) => entry.type === undefined || MODEL_TYPES.includes(String(entry.type)))
		.map((entry) => ({ ...entry, provider: providerId }) as AnyModel);
}

/**
 * Read `<data>/model-catalog.json` and merge it over `provider`'s bundled models. A catalog that is not newer than the
 * bundled data is ignored (after a pi-ai upgrade the bundled definitions win); a missing or broken file leaves the
 * provider as it is. Never throws: the server must start on the bundled models.
 */
export async function withCatalogFile(
	provider: Provider,
	path: string,
	bundledAt: number | undefined = getBuiltinModelDataGeneratedAt(),
): Promise<{ provider: Provider; status: ModelCatalogStatus }> {
	let file: ModelCatalogFile;
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(parsed) || typeof parsed.lastModified !== "number") throw new Error("lastModified is missing");
		file = {
			lastModified: parsed.lastModified,
			fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
			models: parseCatalog(provider.id, parsed.models),
		};
	} catch (error) {
		if (isNotFound(error)) return { provider, status: { kind: "missing" } };
		const message = error instanceof Error ? error.message : String(error);
		return { provider, status: { kind: "invalid", message } };
	}
	if (bundledAt !== undefined && file.lastModified <= bundledAt) {
		return { provider, status: { kind: "older", lastModified: file.lastModified } };
	}

	const bundled = provider.getAllModels?.() ?? provider.getModels();
	const known = new Set(bundled.map(keyOf));
	const all = mergeModels(bundled, file.models);
	const chat = all.filter((model) => getModelType(model) === "chat");
	return {
		provider: {
			...provider,
			getModels: () => chat as ReturnType<Provider["getModels"]>,
			getAllModels: () => all,
		},
		status: {
			kind: "applied",
			added: file.models.filter((model) => !known.has(keyOf(model))).map((model) => model.id),
			lastModified: file.lastModified,
		},
	};
}

export type UpdateModelsOptions = {
	env: Env;
	print: (line: string) => void;
	/** Replaces `globalThis.fetch` in tests. */
	fetch?: typeof fetch;
	now?: () => number;
};

/** `pnpm models:update`: download the OpenAI catalog once and save it. Returns the exit code. */
export async function runUpdateModels(options: UpdateModelsOptions): Promise<number> {
	const { paths } = resolveDataPaths(options.env);
	const doFetch = options.fetch ?? fetch;
	let file: ModelCatalogFile;
	try {
		const response = await doFetch(CATALOG_URL, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`pi.dev answered ${response.status} ${response.statusText}`.trim());
		const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
		file = {
			lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
			fetchedAt: (options.now ?? Date.now)(),
			models: parseCatalog("openai", await response.json()),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		options.print(`Could not download the model catalog from ${CATALOG_URL}: ${message}`);
		options.print("Nothing was changed. The server keeps using the models it has. Try again later.");
		return 1;
	}

	await writeFileAtomic(paths.modelCatalog, `${JSON.stringify(file, null, "\t")}\n`, 0o644);
	const chat = file.models.filter((model) => getModelType(model) === "chat").map((model) => model.id);
	options.print(`Saved ${file.models.length} OpenAI models to ${paths.modelCatalog}.`);
	options.print(`Chat models: ${chat.join(", ")}`);
	options.print("Restart the server to use them.");
	return 0;
}

function mergeModels(bundled: readonly AnyModel[], extra: readonly AnyModel[]): AnyModel[] {
	const merged = new Map<string, AnyModel>();
	for (const model of [...bundled, ...extra]) merged.set(keyOf(model), model);
	return [...merged.values()];
}

const keyOf = (model: AnyModel): string => `${getModelType(model)}\0${model.id}`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}
