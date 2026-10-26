import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWebClient, createWebSetup, type WebService } from "../src/web.ts";

const dirs: string[] = [];
const services: WebService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "assistant-web-"));
	dirs.push(dir);
	return dir;
}

const quiet = { info: () => {}, warn: () => {} };
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((part) => part.text ?? "").join("");

describe("the web setup", () => {
	it("tries a provider with a key first, then the keyless ones, and ignores what is not a key", async () => {
		const dir = await tempDir();
		const keys = join(dir, "search.json");
		await writeFile(keys, JSON.stringify({ BRAVE_API_KEY: "k1", PATH: "/evil", notakey: "x", EMPTY_API_KEY: "" }), {
			mode: 0o644,
		});
		const warnings: string[] = [];

		services.push(
			await createWebSetup({
				dir: join(dir, "web"),
				keysPath: keys,
				logger: { info: () => {}, warn: (line: string) => warnings.push(line) },
			}),
		);

		const config = JSON.parse(await readFile(join(dir, "web", "web-search.json"), "utf8"));
		expect(config).toStrictEqual({
			searchRouting: {
				providers: ["brave", "exa", "duckduckgo"],
				fallbackOn: ["transient", "quota", "network", "invalid-response"],
			},
			allowBrowserCookies: false,
		});
		expect((await stat(keys)).mode & 0o777).toBe(0o600);
		expect(warnings.join("\n")).toMatch(/ignored 'PATH'[\s\S]*ignored 'notakey'[\s\S]*ignored 'EMPTY_API_KEY'/);
	});

	it("searches keyless when there is no key file", async () => {
		const dir = await tempDir();
		services.push(await createWebSetup({ dir: join(dir, "web"), keysPath: join(dir, "none.json"), logger: quiet }));
		const config = JSON.parse(await readFile(join(dir, "web", "web-search.json"), "utf8"));
		expect(config.searchRouting.providers).toStrictEqual(["exa", "duckduckgo"]);
	});

	it("runs pi-web-access, which refuses to read this machine, its network or the tailnet", async () => {
		const dir = await tempDir();
		const web = await createWebSetup({ dir: join(dir, "web"), keysPath: join(dir, "none.json"), logger: quiet });
		services.push(web);

		for (const url of ["http://127.0.0.1:8787/api/agents", "http://192.168.1.1/", "http://100.100.100.100/"]) {
			const result = await web.call("fetch_content", { url });
			expect(result.isError, url).toBe(true);
			expect(textOf(result), url).toMatch(/Blocked/i);
		}
	}, 60_000);
});

describe("the web client", () => {
	const fake = (dir: string, env: Record<string, string> = {}) =>
		createWebClient({
			command: process.execPath,
			args: [join(import.meta.dirname, "support", "fake-web-mcp.ts")],
			env: { PATH: process.env.PATH ?? "", ...env },
			cwd: dir,
			logger: quiet,
		});

	it("gives the child only the environment it is handed", async () => {
		const dir = await tempDir();
		process.env.FAKE_KEY_LEAK = "should-not-pass";
		const web = fake(dir, { FAKE_KEY: "given" });
		services.push(web);

		expect(textOf(await web.call("web_search", { query: "x" }))).toMatch(/env given$/);
		delete process.env.FAKE_KEY_LEAK;
	}, 30_000);

	it("starts the child again after it has died", async () => {
		const dir = await tempDir();
		const web = fake(dir);
		services.push(web);

		const first = textOf(await web.call("web_search", { query: "crash" }));
		await new Promise((resolve) => setTimeout(resolve, 300));
		const second = textOf(await web.call("web_search", { query: "again" }));

		expect(second).toMatch(/^pid \d+/);
		expect(second.split(" ")[1]).not.toBe(first.split(" ")[1]);
	}, 30_000);

	it("refuses calls once it is closed", async () => {
		const web = fake(await tempDir());
		await web.close();
		await expect(web.call("web_search", { query: "x" })).rejects.toThrow(/shut down/);
	});
});
