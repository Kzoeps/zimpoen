import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreMigrations, migrate, openAppDb } from "@assistant/db";
import { afterEach, describe, expect, it } from "vitest";
import {
	createChromiumRenderer,
	documentsModule,
	documentsStore,
	fillTemplate,
	inlineLocalImages,
	listTemplates,
	saveTemplate,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "assistant-docs-"));
	dirs.push(dir);
	return dir;
}

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

describe("templates", () => {
	it("fills fields and repeats line items, escaping what the data says", () => {
		const html = fillTemplate(
			"<h1>{{client.name}}</h1>{{#items}}<tr><td>{{description}}</td><td>{{amount}}</td></tr>{{/items}}",
			{
				client: { name: "Acme <Pte>" },
				items: [
					{ description: "Design", amount: "500" },
					{ description: "Build", amount: "900" },
				],
			},
			"invoice",
		);
		expect(html).toBe(
			"<h1>Acme &lt;Pte&gt;</h1><tr><td>Design</td><td>500</td></tr><tr><td>Build</td><td>900</td></tr>",
		);
	});

	it("names a field the data lacks instead of printing a blank, also inside a list", () => {
		expect(() => fillTemplate("<p>{{total}}</p>", {}, "quote")).toThrow("uses total, which the data does not have");
		expect(() => fillTemplate("{{#items}}{{price}}{{/items}}", { items: [{ name: "x" }] }, "quote")).toThrow(
			"uses price",
		);
		expect(fillTemplate("{{#items}}{{price}}{{/items}}", { items: [] }, "quote")).toBe("");
	});

	it("saves any number of templates and lists them with their description", async () => {
		const dir = await tempDir();
		await saveTemplate(dir, "invoice", "<!-- description: Monthly invoice to Acme -->\n<p>{{number}}</p>");
		await saveTemplate(dir, "quote", "<p>{{client}}</p>");
		expect(await saveTemplate(dir, "quote", "<p>{{client}}!</p>")).toStrictEqual({ replaced: true });

		expect(await listTemplates(dir)).toMatchObject([
			{ name: "invoice", description: "Monthly invoice to Acme" },
			{ name: "quote", description: "" },
		]);
		await expect(saveTemplate(dir, "../escape", "<p></p>")).rejects.toThrow("is not a template name");
		await expect(saveTemplate(dir, "broken", "{{#items}}")).rejects.toThrow("has a mistake");
	});
});

describe("local images", () => {
	it("inlines images from the templates folder and refuses anything outside it", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "logo.png"), PNG);
		const inlined = await inlineLocalImages('<img src="logo.png"><img src="https://example.com/x.png">', dir);
		expect(inlined).toContain(`src="data:image/png;base64,${PNG.toString("base64")}"`);
		expect(inlined).toContain('src="https://example.com/x.png"'); // left for the browser, which blocks it

		const outside = await tempDir();
		await writeFile(join(outside, "secret.png"), PNG);
		await symlink(join(outside, "secret.png"), join(dir, "link.png"));
		await expect(inlineLocalImages('<img src="link.png">', dir)).rejects.toThrow("outside the templates folder");
		await expect(inlineLocalImages('<img src="../x.png">', dir)).rejects.toThrow();
		await expect(inlineLocalImages('<img src="notes.txt">', dir)).rejects.toThrow("cannot be used");
	});
});

describe("number series", () => {
	async function db() {
		const app = openAppDb(join(await tempDir(), "app.sqlite"));
		return app;
	}

	it("continues the invoice numbers of the old invoice module", async () => {
		const app = await db();
		const [legacy, ...rest] = documentsModule.migrations;
		migrate(app, [...coreMigrations, legacy as (typeof rest)[number]]);
		app.run(
			"INSERT INTO invoice_profile (id, currency, number_pattern, next_seq, updated_at) VALUES (1, 'BTN', 'INV-{YYYY}-{seq:03}', 14, 0)",
		);
		migrate(app, [...coreMigrations, ...documentsModule.migrations]);

		const { taken } = documentsStore.takeNumber(app, {
			series: "invoice",
			date: "2026-11-02",
			label: "Acme",
			callId: "c1",
			now: 1,
		});
		expect(taken.number).toBe("INV-2026-014");
	});

	it("never gives a number twice, and gives a replayed call the number it took", async () => {
		const app = await db();
		migrate(app, [...coreMigrations, ...documentsModule.migrations]);
		const take = (callId: string) =>
			documentsStore.takeNumber(app, { series: "receipt", date: "2026-11-02", label: "", callId, now: 1 });

		expect(take("a").taken.number).toBe("INV-2026-001");
		expect(take("b").taken.number).toBe("INV-2026-002");
		expect(take("a")).toMatchObject({ replayed: true, taken: { number: "INV-2026-001" } });

		documentsStore.setSeries(app, { series: "receipt", pattern: "R{seq}", now: 2 });
		expect(take("c").taken.number).toBe("R3");
		expect(() => documentsStore.setSeries(app, { series: "receipt", next: 2, now: 3 })).toThrow("already taken");
	});
});

const CHROME = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
const chrome = (
	await Promise.all(
		CHROME.map((path) =>
			access(path).then(
				() => path,
				() => undefined,
			),
		),
	)
).find((path) => path !== undefined);

describe.skipIf(chrome === undefined)("the Chromium renderer", () => {
	it("renders CSS, local images and non-Latin text to a PDF", async () => {
		const dir = await tempDir();
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "logo.png"), PNG);
		const pdf = await createChromiumRenderer(chrome as string).render(
			'<html><head><style>body{display:grid}</style></head><body><img src="logo.png"><h1>Hello ༄ Dzongkha</h1><script>document.body.innerHTML="hacked"</script></body></html>',
			{ paper: "A4", landscape: false, assetsDir: dir },
		);
		expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
		expect(pdf.length).toBeGreaterThan(1000);
	}, 30_000);
});
