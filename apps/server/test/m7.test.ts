import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileStore, ledgerStore, splitsStore } from "@assistant/extensions";
import {
	type ApprovalCard,
	type InvoiceCard,
	type MessagesPage,
	NOTICE_ENTRY_KIND,
	type SendMessageResponse,
	type SpendingCard,
	type ToolCard,
	toolCardOf,
} from "@assistant/shared";
import { AgentDoc, type ConversationId, type EntryRecord, type SubmissionId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { StartServerOptions } from "../src/server.ts";
import { base, ctx, type Harness, post, setup, subscription } from "./domain-support.ts";
import { removeAllFixtures } from "./support.ts";

const harnesses: Harness[] = [];
async function start(env: Record<string, string> = {}, options?: Partial<StartServerOptions>) {
	const h = await setup(env);
	harnesses.push(h);
	const server = await h.start(undefined, options);
	await post(server, "/api/push/subscribe", subscription());
	return { h, server };
}
afterEach(async () => {
	for (const h of harnesses.splice(0)) for (const server of h.servers.splice(0)) await server.close();
	await removeAllFixtures();
});

type Server = Awaited<ReturnType<typeof start>>["server"];
type AgentId = "pa" | "inbox" | "health" | "accountant";

const conversationOf = (server: Server, agent: AgentId): number =>
	server.db.get<{ conversation_id: number }>("SELECT conversation_id FROM agents WHERE id = ?", agent)
		?.conversation_id ?? -1;

let counter = 0;
/** Say something to an agent and wait until the run it started has finished. */
async function sayTo(server: Server, agent: AgentId, text: string): Promise<SendMessageResponse> {
	const { status, body } = await post<SendMessageResponse>(
		server,
		`/api/conversations/${conversationOf(server, agent)}/messages`,
		{ content: text, requestId: `m7-${++counter}` },
	);
	expect(status).toBe(202);
	const submission = await server.harness.submission(body.submissionId as SubmissionId, ctx);
	await submission?.wait(ctx);
	return body;
}

async function entriesOf(server: Server, agent: AgentId): Promise<EntryRecord[]> {
	const response = await fetch(`${base(server)}/api/conversations/${conversationOf(server, agent)}/messages?limit=200`);
	return ((await response.json()) as MessagesPage).entries as EntryRecord[];
}

const toolResults = async (server: Server, agent: AgentId) =>
	(await entriesOf(server, agent)).flatMap((entry) =>
		(entry.model ?? []).filter((message) => message.role === "toolResult"),
	);

/** The typed cards the tool results of an agent's thread carry, oldest first. */
async function cardsOf(server: Server, agent: AgentId): Promise<ToolCard[]> {
	return (await toolResults(server, agent)).flatMap((message) => {
		const card = toolCardOf(message.details);
		return card === undefined ? [] : [card];
	});
}

const lastText = async (server: Server, agent: AgentId): Promise<string> =>
	JSON.stringify((await toolResults(server, agent)).at(-1)?.content);

const offered = async (server: Server, agent: AgentId): Promise<string[]> => {
	const conversation = await server.harness.conversation(conversationOf(server, agent) as ConversationId, ctx);
	return ((await conversation?.agent(ctx))?.tools ?? []).map((tool) => tool.name).sort();
};

const EVERYDAY = [
	"add_account",
	"add_expense",
	"add_income",
	"add_transfer",
	"balances",
	"codemode",
	"confirm_import",
	"current_time",
	"describe_file",
	"generate_invoice",
	"import_csv",
	"list_txns",
	"preview_invoice",
	"read_file",
	"recall",
	"record_settlement",
	"remember",
	"set_balance",
	"set_invoice_profile",
	"spending_summary",
	"split_bill",
	"tool_search",
	"who_owes",
];

describe("the Accountant agent through the whole server", () => {
	it("applies the accountant tables and gives the Accountant its tools, the approval hook, tool_search and code mode, and nobody else", async () => {
		const { server } = await start();

		const ids = server.db.all<{ id: string }>("SELECT id FROM _migrations ORDER BY id").map((row) => row.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				"ledger/001_core",
				"ledger/002_imports",
				"ledger/003_call_ledger",
				"ledger/004_undo",
				"splits/001_bills",
				"invoices/001_invoices",
				"files/002_generated_source",
			]),
		);
		const doc = await server.harness.snapshot(AgentDoc, conversationOf(server, "accountant") as ConversationId, ctx);
		expect(doc?.extensions).toStrictEqual([
			"profile",
			"ledger",
			"splits",
			"invoices",
			"files",
			"approvals",
			"tool-search",
			expect.stringMatching(/code/),
			"memory",
		]);
		expect(await offered(server, "accountant")).toStrictEqual(EVERYDAY);
		for (const agent of ["pa", "health", "inbox"] as const) {
			const tools = await offered(server, agent);
			expect(tools, agent).not.toContain("add_expense");
			expect(tools, agent).not.toContain("split_bill");
			expect(tools, agent).not.toContain("generate_invoice");
			expect(tools, agent).not.toContain("codemode");
		}
	});

	it("is the only agent that can record an expense: the PA's call is refused before it runs", async () => {
		const { server } = await start();
		await sayTo(server, "accountant", '/tool add_account {"name":"Cash","kind":"cash"}');

		await sayTo(server, "pa", '/tool add_expense {"amount":100}');

		const refused = (await toolResults(server, "pa")).at(-1);
		expect(refused).toMatchObject({ toolName: "add_expense", isError: true });
		expect(JSON.stringify(refused?.content)).toContain("Tool add_expense is not available");
		expect(ledgerStore.queryTxns(server.db, {}).total).toBe(0);
	});

	it("records, sums and splits through the dev model, and every result is a typed card the thread can draw", async () => {
		const { server } = await start();

		await sayTo(server, "accountant", '/tool add_account {"name":"BoB savings","kind":"bank","balance":10000}');
		await sayTo(
			server,
			"accountant",
			'/tool add_expense {"amount":1250.5,"merchant":"Druk Mart","category":"groceries"}',
		);
		await sayTo(server, "accountant", '/tool add_expense {"amount":300,"merchant":"Taxi","category":"transport"}');
		await sayTo(server, "accountant", '/tool spending_summary {"range":"this_month","group_by":"category"}');
		await sayTo(server, "accountant", "/tool balances");
		await sayTo(
			server,
			"accountant",
			'/tool split_bill {"title":"Dinner","payer":"Pema","people":["me","Pema","Tashi"],"total":1000}',
		);
		await sayTo(server, "accountant", "/tool who_owes");

		const cards = await cardsOf(server, "accountant");
		expect(cards.map((card) => card.type)).toStrictEqual([
			"accountant_note",
			"txn",
			"txn",
			"spending",
			"balances",
			"split",
			"who_owes",
		]);
		const spending = cards[3] as SpendingCard;
		expect(spending).toMatchObject({ totalMinor: 155_050, count: 2 });
		expect(spending.groups.map((group) => [group.label, group.amountMinor, group.tenths])).toStrictEqual([
			["groceries", 125_050, 807],
			["transport", 30_000, 193],
		]);
		expect(cards[4]).toMatchObject({ accounts: [{ account: "BoB savings", amountMinor: 844_950 }] });
		expect(cards[5]).toMatchObject({
			totalMinor: 100_000,
			shares: [
				{ person: "You", owedMinor: 33_334 },
				{ person: "Pema", owedMinor: 33_333, paid: true },
				{ person: "Tashi", owedMinor: 33_333 },
			],
		});
		expect(cards[6]).toMatchObject({
			debts: [
				{ debtor: "You", creditor: "Pema", amountMinor: 33_334 },
				{ debtor: "Tashi", creditor: "Pema", amountMinor: 33_333 },
			],
		});
		expect(splitsStore.listBills(server.db, { limit: 5 }).total).toBe(1);
	});

	it("offers the rarely used tools only after a search, and the guard holds until the owner approves a deletion", async () => {
		const { server } = await start();
		await sayTo(server, "accountant", '/tool add_account {"name":"Cash","kind":"cash","balance":500}');
		await sayTo(server, "accountant", '/tool add_expense {"amount":120,"merchant":"Lunch"}');
		const id = ledgerStore.queryTxns(server.db, {}).rows[0]?.id ?? "";

		await sayTo(server, "accountant", `/tool delete_txn {"txn_id":"${id}"}`);
		expect((await toolResults(server, "accountant")).at(-1)).toMatchObject({ toolName: "delete_txn", isError: true });
		expect(await lastText(server, "accountant")).toContain("not available");
		await sayTo(server, "accountant", '/tool tool_search {"query":"delete an entry"}');
		expect(await offered(server, "accountant")).toEqual(expect.arrayContaining(["propose_delete_txn", "delete_txn"]));
		await sayTo(server, "accountant", `/tool delete_txn {"txn_id":"${id}"}`);
		expect(await lastText(server, "accountant")).toMatch(/Blocked: delete_txn/);
		expect(ledgerStore.getTxn(server.db, id)).toBeDefined();

		await sayTo(server, "accountant", `/tool propose_delete_txn {"txn_id":"${id}"}`);
		const card = (await cardsOf(server, "accountant")).find(
			(candidate): candidate is ApprovalCard => candidate.type === "approval",
		);
		expect(card?.summary).toContain(`Delete the entry ${id}`);
		expect(ledgerStore.getTxn(server.db, id)).toBeDefined(); // waiting for the owner

		await sayTo(server, "accountant", "YES");

		expect(ledgerStore.getTxn(server.db, id)).toBeUndefined();
		const [notice] = (await entriesOf(server, "accountant")).filter((entry) => entry.kind === NOTICE_ENTRY_KIND);
		expect(notice?.data).toMatchObject({ approval: { via: "yes" } });
	});

	it("runs a code mode script over the ledger's query tools, without handing it the paid model calls", async () => {
		const { server } = await start();
		await sayTo(server, "accountant", '/tool add_account {"name":"Cash","kind":"cash"}');
		await sayTo(server, "accountant", '/tool add_expense {"amount":100.25,"merchant":"A"}');
		await sayTo(server, "accountant", '/tool add_expense {"amount":50.5,"merchant":"B"}');

		const code = [
			"const page = await tools.ledger_query({ kind: 'expense' });",
			"const rows = page.rows ?? page.txns ?? page;",
			"let sum = 0;",
			"for (const row of rows) sum += row.amount_minor;",
			"return { rows: rows.length, sum, models: typeof models };",
		].join("\n");
		await sayTo(server, "accountant", `/tool codemode ${JSON.stringify({ code })}`);

		const result = (await toolResults(server, "accountant")).at(-1);
		expect(result).toMatchObject({ toolName: "codemode", isError: false });
		const output = JSON.stringify(result?.content);
		expect(output).toContain("Script completed");
		expect(output).toMatch(/\\"rows\\": ?2/);
		expect(output).toMatch(/\\"sum\\": ?-15075/);
		expect(output).toContain("undefined");
	});

	it("ends a script that never ends at the server's time limit, also when the model asks for a day", async () => {
		const { server } = await start({}, { codemodeLimits: { defaultTimeoutMs: 800, maxTimeoutMs: 1500 } });
		const run = async (code: string) => {
			await sayTo(server, "accountant", `/tool codemode ${JSON.stringify({ code })}`);
			return (await toolResults(server, "accountant")).at(-1);
		};

		const plain = await run("while (true) {}");
		expect(plain).toMatchObject({ toolName: "codemode", isError: true });
		expect(JSON.stringify(plain?.content)).toContain("Execution timed out after 800 ms");

		const greedy = await run('// @options: {"timeout_ms": 86400000}\nwhile (true) {}');
		expect(greedy).toMatchObject({ toolName: "codemode", isError: true });
		expect(JSON.stringify(greedy?.content)).toContain("Execution timed out after 1500 ms");
	});
});

describe("the monthly invoice through the whole server", () => {
	it("writes the default template once, makes a PDF in the workspace and serves it as a download", async () => {
		const { h, server } = await start();
		const { templates, workspace } = h.fixture.config.paths;
		const template = join(templates, "invoice.html");
		expect(await readFile(template, "utf8")).toContain("{{invoice.number}}");
		expect((await stat(template)).mode & 0o777).toBe(0o600);
		expect(h.logs.some((line) => line.includes("[invoices] wrote the default invoice template"))).toBe(true);

		await sayTo(
			server,
			"accountant",
			'/tool set_invoice_profile {"client_name":"Acme Pte Ltd","client_address":"12 Main Street","sender_name":"Dorje","amount":50000}',
		);
		await sayTo(server, "accountant", "/tool generate_invoice");

		const card = (await cardsOf(server, "accountant")).at(-1) as InvoiceCard;
		expect(card).toMatchObject({ type: "invoice", event: "created", invoice: { number: "INV-2026-001" } });
		const file = card.invoice.file;
		expect(file).toMatchObject({ name: "INV-2026-001.pdf", mime: "application/pdf" });
		const row = fileStore.getFile(server.db, file?.id ?? "");
		expect(row).toMatchObject({
			source: "generated",
			kind: "pdf",
			path: join(workspace, "invoices", "INV-2026-001.pdf"),
		});

		const response = await fetch(`${base(server)}/api/files/${file?.id}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''INV-2026-001.pdf");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toContain("sandbox");
		const bytes = Buffer.from(await response.arrayBuffer());
		expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
		expect(bytes.length).toBe(file?.size);
	});

	it("keeps the owner's template across restarts and uses it for the next invoice", async () => {
		const { h, server } = await start();
		const template = join(h.fixture.config.paths.templates, "invoice.html");
		await writeFile(template, "<h1>MY TEMPLATE {{invoice.number}}</h1>");
		await server.close();
		h.servers.splice(0);

		const again = await h.start();
		expect(await readFile(template, "utf8")).toBe("<h1>MY TEMPLATE {{invoice.number}}</h1>");
		await sayTo(again, "accountant", '/tool set_invoice_profile {"client_name":"Acme","amount":100}');
		await sayTo(again, "accountant", "/tool generate_invoice");
		const card = (await cardsOf(again, "accountant")).at(-1) as InvoiceCard;
		expect(card.invoice.number).toBe("INV-2026-001");
		const pdf = await readFile(join(h.fixture.config.paths.workspace, "invoices", "INV-2026-001.pdf"));
		expect(pdf.toString("latin1")).toContain("/Type /Page");
	});

	it("explains a template mistake instead of making an invoice, and uses no number", async () => {
		const { h, server } = await start();
		await writeFile(join(h.fixture.config.paths.templates, "invoice.html"), "<p>{{invoice.numer}}</p>");
		await sayTo(server, "accountant", '/tool set_invoice_profile {"client_name":"Acme","amount":100}');

		await sayTo(server, "accountant", "/tool generate_invoice");

		expect((await toolResults(server, "accountant")).at(-1)).toMatchObject({
			toolName: "generate_invoice",
			isError: true,
		});
		expect(await lastText(server, "accountant")).toContain("{{invoice.numer}}, which is not a field");
		expect(server.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM invoice_issued")?.n).toBe(0);
	});
});

describe("GET /api/files/:id for files the assistant made", () => {
	/**
	 * One file per row, and each row is read back before it is relied on: `registerFile` ignores a second row for a path it
	 * already has, so two rows over one file would leave the second one missing and its 404 would prove nothing.
	 */
	async function files() {
		const { h, server } = await start();
		const { workspace, files: uploads } = h.fixture.config.paths;
		await mkdir(join(workspace, "invoices"), { recursive: true });
		await mkdir(join(workspace, "other"), { recursive: true });
		await mkdir(uploads, { recursive: true });
		const outside = join(h.fixture.root, "docs");
		const place = async (path: string, content: string): Promise<string> => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content);
			return path;
		};
		let count = 0;
		const add = async (path: string, source: "upload" | "path" | "generated", name = "file.pdf") => {
			const id = `fi_aaaa${String(++count).padStart(4, "0")}`;
			fileStore.registerFile(server.db, {
				id,
				path,
				name,
				mime: "application/pdf",
				kind: "pdf",
				size: 5,
				source,
				now: 1,
			});
			expect(fileStore.getFile(server.db, id), `${id} (${source}) was registered`).toMatchObject({ path, source });
			return id;
		};
		const status = async (id: string) => (await fetch(`${base(server)}/api/files/${id}`)).status;
		return { h, server, workspace, uploads, outside, place, add, status };
	}

	it("serves a generated file only from inside the workspace and an upload only from inside the uploads folder", async () => {
		const { workspace, uploads, outside, place, add, status } = await files();
		const generated = await add(await place(join(workspace, "invoices", "ok.pdf"), "%PDF-1.3 inside"), "generated");
		const generatedOutside = await add(await place(join(outside, "outside.pdf"), "%PDF-1.3 outside"), "generated");
		const uploadOutside = await add(await place(join(outside, "outside-upload.pdf"), "outside"), "upload");
		const uploadIntoWorkspace = await add(await place(join(workspace, "other", "viaup.pdf"), "%PDF-1.3 ws"), "upload");
		const indexed = await add(await place(join(workspace, "invoices", "indexed.pdf"), "%PDF-1.3 ix"), "path");
		const uploadInside = await add(await place(join(uploads, "mine.pdf"), "%PDF-1.3 mine"), "upload");

		expect(await status(generated)).toBe(200);
		expect(await status(uploadInside)).toBe(200);
		expect(await status(generatedOutside)).toBe(404); // generated, but not in the workspace
		expect(await status(uploadOutside)).toBe(404); // an upload outside the uploads folder
		expect(await status(uploadIntoWorkspace)).toBe(404); // an upload that points into the workspace
		expect(await status(indexed)).toBe(404); // indexed from the owner's folders (a `path` row): not the browser's business, wherever the file is
	});

	it("does not follow a link out of the folder, and does not take a folder that only starts with the same name", async () => {
		const { workspace, uploads, outside, place, add, status } = await files();
		const secret = await place(join(outside, "secret.pdf"), "%PDF-1.3 secret");
		await mkdir(join(workspace, "invoices"), { recursive: true });
		await symlink(secret, join(workspace, "invoices", "link.pdf"));
		await symlink(secret, join(uploads, "link-up.pdf"));
		const sibling = await place(`${workspace}2/stray.pdf`, "%PDF-1.3 sibling");
		const linked = await add(join(workspace, "invoices", "link.pdf"), "generated");
		const linkedUpload = await add(join(uploads, "link-up.pdf"), "upload");
		const stray = await add(sibling, "generated");

		expect(await status(linked)).toBe(404); // a link in the workspace to a file outside it
		expect(await status(linkedUpload)).toBe(404);
		expect(await status(stray)).toBe(404); // "<workspace>2" is not inside "<workspace>"
		// The link itself is a fine path for a file that lives inside: a control, so that the 404s above are about where it leads.
		await place(join(workspace, "invoices", "real.pdf"), "%PDF-1.3 real");
		await symlink(join(workspace, "invoices", "real.pdf"), join(workspace, "invoices", "alias.pdf"));
		expect(await status(await add(join(workspace, "invoices", "alias.pdf"), "generated"))).toBe(200);
	});
});
