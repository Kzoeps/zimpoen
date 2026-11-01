import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { afterEach, describe, expect, it } from "vitest";
import { runUpdateModels, withCatalogFile } from "../src/model-catalog.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "assistant-catalog-"));
	dirs.push(dir);
	return dir;
}

const BUNDLED_AT = Date.parse("2026-10-21T00:00:00Z");
const NEWER = "Fri, 30 Oct 2026 10:00:00 GMT";

const terra = {
	id: "gpt-test-terra",
	name: "Test Terra",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
	type: "chat",
};

function catalogServer(status: number, body: unknown, lastModified?: string): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: lastModified === undefined ? {} : { "last-modified": lastModified },
		})) as typeof fetch;
}

async function update(data: string, server: typeof fetch) {
	const lines: string[] = [];
	const code = await runUpdateModels({
		env: { ASSISTANT_DATA_DIR: data },
		print: (line) => void lines.push(line),
		fetch: server,
	});
	return { code, lines };
}

describe("pnpm models:update and the catalog file", () => {
	it("adds the downloaded models to the bundled OpenAI list at startup", async () => {
		const data = await dataDir();
		const { code, lines } = await update(data, catalogServer(200, { models: [terra] }, NEWER));
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("gpt-test-terra");

		const bundledCount = openaiProvider().getModels().length;
		const { provider, status } = await withCatalogFile(openaiProvider(), join(data, "model-catalog.json"), BUNDLED_AT);
		expect(status).toMatchObject({ kind: "applied", added: ["gpt-test-terra"] });
		expect(provider.getModels().map((m) => m.id)).toContain("gpt-test-terra");
		expect(provider.getModels()).toHaveLength(bundledCount + 1);
	});

	it("keeps the old file and fails when pi.dev cannot be reached", async () => {
		const data = await dataDir();
		await update(data, catalogServer(200, { models: [terra] }, NEWER));
		const before = await readFile(join(data, "model-catalog.json"), "utf8");

		const { code, lines } = await update(data, catalogServer(503, {}));
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("503");
		expect(await readFile(join(data, "model-catalog.json"), "utf8")).toBe(before);
	});

	it("ignores a catalog older than the bundled models, so a pi-ai upgrade wins", async () => {
		const data = await dataDir();
		await update(data, catalogServer(200, { models: [terra] }, "Mon, 05 Oct 2026 10:00:00 GMT"));
		const { provider, status } = await withCatalogFile(openaiProvider(), join(data, "model-catalog.json"), BUNDLED_AT);
		expect(status.kind).toBe("older");
		expect(provider.getModels().map((m) => m.id)).not.toContain("gpt-test-terra");
	});

	it("starts on the bundled models when the file is missing or broken", async () => {
		const data = await dataDir();
		const path = join(data, "model-catalog.json");
		expect((await withCatalogFile(openaiProvider(), path, BUNDLED_AT)).status.kind).toBe("missing");

		await writeFile(path, "{ not json");
		const broken = await withCatalogFile(openaiProvider(), path, BUNDLED_AT);
		expect(broken.status.kind).toBe("invalid");
		expect(broken.provider.getModels()).toHaveLength(openaiProvider().getModels().length);
	});
});
