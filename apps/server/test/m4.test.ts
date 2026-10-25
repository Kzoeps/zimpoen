import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { dailyStore, fileStore } from "@assistant/extensions";
import {
	type ApiErrorBody,
	DAILY_ENTRY_KIND,
	type DailyEntryData,
	MAX_UPLOAD_BYTES,
	type ScheduleSettingsResponse,
	type UploadResponse,
} from "@assistant/shared";
import type { TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	base,
	ctx,
	entries,
	type Harness,
	modelAnswers,
	ofKind,
	paConversation,
	post,
	say,
	setup,
	subscription,
} from "./domain-support.ts";
import { removeAllFixtures, waitFor } from "./support.ts";

const harnesses: Harness[] = [];
async function start(env: Record<string, string> = {}) {
	const h = await setup(env);
	harnesses.push(h);
	const server = await h.start();
	await post(server, "/api/push/subscribe", subscription());
	return { h, server };
}
afterEach(async () => {
	for (const h of harnesses.splice(0)) for (const server of h.servers.splice(0)) await server.close();
	await removeAllFixtures();
});

type Started = Awaited<ReturnType<typeof start>>;
type Server = Started["server"];

const local = (date: string, time: string): number => new Date(`${date}T${time}:00+06:00`).getTime();

/** A 1x1 PNG. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** A request the browser would make from the assistant's own page. */
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

function uploadBody(content: string | Uint8Array, name: string, type = "application/octet-stream"): FormData {
	const form = new FormData();
	form.set("file", new File([content], name, { type }));
	return form;
}

async function upload(
	server: Server,
	body: FormData | string,
	headers: Record<string, string> = SAME_ORIGIN,
): Promise<{ status: number; body: unknown }> {
	const response = await fetch(`${base(server)}/api/uploads`, { method: "POST", headers, body });
	return { status: response.status, body: await response.json() };
}

const errorOf = (body: unknown): ApiErrorBody["error"] => (body as ApiErrorBody).error;

describe("POST /api/uploads", () => {
	it("stores the file under <data>/files/<yyyy-mm>/<id>-<safe name>, names it by what it is, and indexes it", async () => {
		const { h, server } = await start();

		const { status, body } = await upload(server, uploadBody(PNG, "../../My Receipt (1).JPG", "image/jpeg"));

		expect(status).toBe(201);
		const { file } = body as UploadResponse;
		// Named by its content (a PNG), not by what the sender called it, and no path of the sender's reaches the disk.
		expect(file).toMatchObject({ mime: "image/png", kind: "image", size: PNG.length, source: "upload" });
		expect(file.id).toMatch(/^fi_[0-9a-f]{8}$/);
		expect(file.name).toBe("My_Receipt_1_.png");
		const row = fileStore.requireFile(server.db, file.id);
		expect(row.path).toBe(join(h.fixture.config.paths.files, "2026-10", `${file.id}-My_Receipt_1_.png`));
		expect(await readFile(row.path)).toStrictEqual(PNG);
		expect((await stat(row.path)).mode & 0o777).toBe(0o600);
		expect(await readdir(join(h.fixture.config.paths.files, "2026-10"))).toStrictEqual([
			`${file.id}-My_Receipt_1_.png`,
		]);
	});

	it("takes a CSV and plain text, and refuses what it cannot take, saying what it takes", async () => {
		const { server } = await start();
		const csv = await upload(
			server,
			uploadBody("date,amount\n2026-03-01,120\n", "March bank.csv", "application/vnd.ms-excel"),
		);
		expect(csv.body).toMatchObject({ file: { kind: "csv", mime: "text/csv", name: "March_bank.csv" } });
		const note = await upload(server, uploadBody("remember the milk", "note.md", "text/markdown"));
		expect(note.body).toMatchObject({ file: { kind: "text", name: "note.txt" } });

		const zip = await upload(
			server,
			uploadBody(Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 1]), "archive.zip", "application/zip"),
		);
		expect([zip.status, errorOf(zip.body).code]).toStrictEqual([415, "invalid_request"]);
		expect(errorOf(zip.body).message).toMatch(/Only images .* PDF, CSV and plain text/);
		const pem = await upload(server, uploadBody("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n", "notes.txt", "text/plain"));
		expect([pem.status, errorOf(pem.body).message]).toStrictEqual([415, expect.stringContaining("private key")]);
		const empty = await upload(server, uploadBody("", "empty.txt", "text/plain"));
		expect(empty.status).toBe(415);
		expect(fileStore.searchFiles(server.db, "", 10).total).toBe(2); // nothing refused was kept
	});

	it("refuses a file over the limit with 413, before it is read, and a body that is not a form", async () => {
		const { h, server } = await start();
		const tooBig = await upload(
			server,
			uploadBody(new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(97), "big.txt", "text/plain"),
		);
		expect([tooBig.status, errorOf(tooBig.body).code]).toStrictEqual([413, "payload_too_large"]);
		expect(errorOf(tooBig.body).message).toContain("20 MB");
		const exact = await upload(
			server,
			uploadBody(new Uint8Array(MAX_UPLOAD_BYTES).fill(97), "exact.txt", "text/plain"),
		);
		expect(exact.status).toBe(201);

		const noField = new FormData();
		noField.set("other", "x");
		const missing = await upload(server, noField);
		expect([missing.status, errorOf(missing.body).message]).toStrictEqual([
			400,
			expect.stringContaining("field named 'file'"),
		]);
		const broken = await upload(server, "--x\r\nnot a form", {
			...SAME_ORIGIN,
			"content-type": "multipart/form-data; boundary=zzz",
		});
		expect(broken.status).toBe(400);
		expect(await readdir(join(h.fixture.config.paths.files))).toStrictEqual(["2026-10"]); // only the exact one is there
		expect(fileStore.searchFiles(server.db, "", 10).total).toBe(1);
	});

	describe("is guarded by the rules that stand in for the JSON-only rule", () => {
		it("refuses a request without Sec-Fetch-Site, or from another site, and takes same-origin and none", async () => {
			const { server } = await start();
			const png = () => uploadBody(PNG, "a.png");

			const missing = await upload(server, png(), {});
			expect([missing.status, errorOf(missing.body).code]).toStrictEqual([403, "forbidden"]);
			expect(errorOf(missing.body).message).toContain("Sec-Fetch-Site: none");
			for (const site of ["cross-site", "same-site"]) {
				const refused = await upload(server, png(), { "sec-fetch-site": site });
				expect([site, refused.status, errorOf(refused.body).code]).toStrictEqual([site, 403, "forbidden"]);
			}
			expect((await upload(server, png(), { "sec-fetch-site": "same-origin" })).status).toBe(201);
			expect((await upload(server, png(), { "sec-fetch-site": "none" })).status).toBe(201);
			expect(fileStore.searchFiles(server.db, "", 10).total).toBe(2);
		});

		it("refuses a Host the server does not answer to, and a rebinding proxy's forwarded host", async () => {
			const { server } = await start();
			// `fetch` will not let a script choose Host, so send the request with node:http.
			const send = async (headers: Record<string, string>): Promise<{ status: number; text: string }> => {
				const form = new Request("http://placeholder/", { method: "POST", body: uploadBody(PNG, "a.png") });
				const body = Buffer.from(await form.arrayBuffer());
				return await new Promise((resolve, reject) => {
					const outgoing = request(
						{
							host: "127.0.0.1",
							port: server.port,
							path: "/api/uploads",
							method: "POST",
							headers: {
								...headers,
								"content-type": form.headers.get("content-type") ?? "",
								"content-length": body.length,
							},
						},
						(response) => {
							const chunks: Buffer[] = [];
							response.on("data", (chunk: Buffer) => chunks.push(chunk));
							response.on("end", () =>
								resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
							);
						},
					);
					outgoing.on("error", reject);
					outgoing.end(body);
				});
			};
			const own = `127.0.0.1:${server.port}`;
			const rebound = await send({ host: "rebound.example", ...SAME_ORIGIN });
			expect(rebound.status).toBe(403);
			expect(rebound.text).toContain("ASSISTANT_PUBLIC_HOST");
			expect((await send({ host: own, "x-forwarded-host": "rebound.example", ...SAME_ORIGIN })).status).toBe(403);
			expect((await send({ host: own, "x-forwarded-host": "localhost:3000", ...SAME_ORIGIN })).status).toBe(201);
			expect((await send({ host: own, ...SAME_ORIGIN })).status).toBe(201);
		});

		it("still refuses JSON here (the route takes a form), and every other write still refuses a form", async () => {
			const { server } = await start();
			const json = await fetch(`${base(server)}/api/uploads`, {
				method: "POST",
				headers: { ...SAME_ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ file: "x" }),
			});
			expect([json.status, errorOf(await json.json()).message]).toStrictEqual([
				415,
				expect.stringContaining("multipart/form-data"),
			]);

			// The exception is this one route: a form posted to anything else is refused by the JSON-only rule.
			for (const path of [
				`/api/conversations/${paConversation(server)}/messages`,
				`/api/conversations/${paConversation(server)}/abort`,
				"/api/push/subscribe",
				"/api/settings/schedule/briefing",
			]) {
				const form = await fetch(`${base(server)}${path}`, {
					method: "POST",
					headers: SAME_ORIGIN,
					body: uploadBody("x", "a.txt"),
				});
				expect([path, form.status]).toStrictEqual([path, 415]);
			}
			const get = await fetch(`${base(server)}/api/uploads`);
			expect(get.status).toBe(404);
		});

		it("is behind authentication like everything else", async () => {
			const { server } = await start({ ASSISTANT_AUTH: "on", ASSISTANT_OWNER_LOGIN: "owner@example.com" });
			const anonymous = await upload(server, uploadBody(PNG, "a.png"));
			expect([anonymous.status, errorOf(anonymous.body).code]).toStrictEqual([401, "unauthorized"]);
			const stranger = await upload(server, uploadBody(PNG, "a.png"), {
				...SAME_ORIGIN,
				"tailscale-user-login": "other@example.com",
			});
			expect(stranger.status).toBe(401);
			const owner = await upload(server, uploadBody(PNG, "a.png"), {
				...SAME_ORIGIN,
				"tailscale-user-login": "owner@example.com",
			});
			expect(owner.status).toBe(201);
			expect(fileStore.searchFiles(server.db, "", 10).total).toBe(1);
		});
	});
});

describe("GET /api/files/:id", () => {
	it("gives an upload back: images shown, everything else a download, nothing the browser may guess about", async () => {
		const { server } = await start();
		const image = ((await upload(server, uploadBody(PNG, "r.png"))).body as UploadResponse).file;
		const csv = ((await upload(server, uploadBody("a,b\n1,2\n", "March bank.csv"))).body as UploadResponse).file;

		const shown = await fetch(`${base(server)}/api/files/${image.id}`);
		expect(shown.status).toBe(200);
		expect(Buffer.from(await shown.arrayBuffer())).toStrictEqual(PNG);
		expect(shown.headers.get("content-type")).toBe("image/png");
		expect(shown.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''r.png");
		expect(shown.headers.get("x-content-type-options")).toBe("nosniff");
		expect(shown.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");

		const download = await fetch(`${base(server)}/api/files/${csv.id}`);
		expect(download.headers.get("content-type")).toBe("text/csv; charset=utf-8");
		expect(download.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''March_bank.csv");
		expect(await download.text()).toBe("a,b\n1,2\n");
	});

	it("serves uploads only: not a file the PA indexed from the owner's folders, not one that left the uploads folder", async () => {
		const { h, server } = await start();
		const docs = join(h.fixture.root, "docs");
		await writeFile(join(docs, "private.txt"), "mine");
		const indexed = fileStore.registerFile(server.db, {
			path: join(docs, "private.txt"),
			name: "private.txt",
			mime: "text/plain",
			kind: "text",
			size: 4,
			source: "path",
			now: 1,
		}).row;
		expect((await fetch(`${base(server)}/api/files/${indexed.id}`)).status).toBe(404);
		expect((await fetch(`${base(server)}/api/files/fi_00000000`)).status).toBe(404);

		// A row that was edited to point outside the uploads folder is not served either.
		server.db.run("UPDATE files_index SET source = 'upload' WHERE id = ?", indexed.id);
		expect((await fetch(`${base(server)}/api/files/${indexed.id}`)).status).toBe(404);
	});
});

describe("the PA reads what was uploaded", () => {
	it("opens an image as an image the model can see, through the same image processor the server runs with", async () => {
		const { server } = await start();
		const { file } = (await upload(server, uploadBody(PNG, "receipt.png"))).body as UploadResponse;

		await say(server, `/tool read_file {"file_id":"${file.id}"}`);

		const result = (await toolResults(server)).at(-1);
		expect(result).toMatchObject({ toolName: "read_file" });
		expect(result?.isError).toBeFalsy();
		const parts = result?.content ?? [];
		expect(parts[0]).toMatchObject({ type: "text" });
		expect(parts.find((part) => part.type === "image")).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("reads a CSV in pages, remembers what it is, and finds it again by those words", async () => {
		const { server } = await start();
		const rows = Array.from({ length: 250 }, (_, i) => `2026-03-${String((i % 28) + 1).padStart(2, "0")},${i}`);
		const { file } = (await upload(server, uploadBody(`date,amount\n${rows.join("\n")}\n`, "export.csv")))
			.body as UploadResponse;

		await say(server, `/tool read_file {"file_id":"${file.id}"}`);
		expect(textOfLast(await toolResults(server))).toContain("lines 1-200 of 251");
		await say(
			server,
			`/tool describe_file {"file_id":"${file.id}","description":"The March bank statement","tags":["bank","march"]}`,
		);
		await say(server, '/tool tool_search {"query":"find files by words in their description"}');
		await say(server, '/tool search_files {"query":"march bank"}');

		expect(textOfLast(await toolResults(server))).toContain(`${file.id} “export.csv”`);
		expect(fileStore.getFile(server.db, file.id)).toMatchObject({
			description: "The March bank statement",
			tags: ["bank", "march"],
		});
	});
});

describe("the PA's reads outside the uploads: the deny list holds", () => {
	async function arrange(h: Harness) {
		const docs = join(h.fixture.root, "docs");
		const outside = join(h.fixture.root, "outside");
		await mkdir(join(docs, ".ssh"), { recursive: true });
		await mkdir(join(docs, "Statements"), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(docs, "march.csv"), "date,amount\n2026-03-01,120\n");
		await writeFile(join(docs, ".env"), "TOKEN=abc");
		await writeFile(join(docs, ".env.production"), "TOKEN=abc");
		await writeFile(join(docs, "id_rsa"), "PRIVATE");
		await writeFile(join(docs, "server.pem"), "PRIVATE");
		await writeFile(join(docs, "SERVER.KEY"), "PRIVATE");
		await writeFile(join(docs, "auth.json"), "{}");
		await writeFile(join(docs, ".ssh", "config"), "Host x");
		await writeFile(join(docs, "Statements", ".npmrc"), "//registry:_authToken=x");
		await writeFile(join(outside, "elsewhere.txt"), "outside the allowlist");
		await symlink(outside, join(docs, "link-out"));
		await symlink(join(docs, ".ssh"), join(docs, "link-to-ssh"));
		await symlink(join(docs, ".env"), join(docs, "harmless.txt"));
		return { docs, outside };
	}

	async function load(server: Server) {
		await say(server, '/tool tool_search {"query":"read a file from a folder by its path"}');
		await say(server, '/tool tool_search {"query":"list the files in a folder"}');
	}

	it("refuses every protected file and path, in any letter case and through links, and indexes none of them", async () => {
		const { h, server } = await start();
		const { docs, outside } = await arrange(h);
		await load(server);

		const refused = [
			join(docs, ".env"),
			join(docs, ".env.production"),
			join(docs, "id_rsa"),
			join(docs, "server.pem"),
			join(docs, "SERVER.KEY"),
			join(docs, "auth.json"),
			join(docs, ".ssh", "config"),
			join(docs, "Statements", ".npmrc"),
			join(docs, "link-to-ssh", "config"),
			join(docs, "harmless.txt"), // a link to .env
			join(h.fixture.config.paths.secrets, "vapid.json"),
			join(h.fixture.config.paths.secrets, "credentials.json"),
			h.fixture.config.paths.appDb,
		];
		for (const path of refused) {
			await say(server, `/tool read_file_path ${JSON.stringify({ path })}`);
			const result = (await toolResults(server)).at(-1);
			expect([path, result?.toolName, result?.isError]).toStrictEqual([path, "read_file_path", true]);
			expect(textOfLast(await toolResults(server)), path).toMatch(/Access denied/);
		}
		// Outside the allowlist: a folder next to it, a link out of it, the system.
		for (const path of [
			join(outside, "elsewhere.txt"),
			join(docs, "link-out", "elsewhere.txt"),
			"/etc/hostname",
			"~/.bashrc",
		]) {
			await say(server, `/tool read_file_path ${JSON.stringify({ path })}`);
			expect(textOfLast(await toolResults(server)), path).toMatch(
				/Access denied: .* is outside the folders the assistant may read/,
			);
		}
		expect(fileStore.searchFiles(server.db, "", 10).total).toBe(0);
	});

	it("hides protected files from a listing, and lists the rest", async () => {
		const { h, server } = await start();
		const { docs } = await arrange(h);
		await load(server);

		await say(server, `/tool list_dir ${JSON.stringify({ path: docs })}`);
		const listing = textOfLast(await toolResults(server));
		expect(listing).toContain("march.csv");
		expect(listing).toContain("Statements/");
		for (const hidden of [".env", "id_rsa", "server.pem", "SERVER.KEY", "auth.json", ".ssh"]) {
			expect(listing, hidden).not.toContain(hidden);
		}
		await say(server, `/tool list_dir ${JSON.stringify({ path: join(docs, ".ssh") })}`);
		expect(textOfLast(await toolResults(server))).toMatch(/Access denied/);
		await say(server, `/tool list_dir ${JSON.stringify({ path: h.fixture.root })}`);
		expect(textOfLast(await toolResults(server))).toMatch(/outside the folders the assistant may read/);
		await say(server, "/tool list_dir {}");
		expect(textOfLast(await toolResults(server))).toContain(`- ${docs}`);
	});

	it("reads what is allowed, and puts it in the index once", async () => {
		const { h, server } = await start();
		const { docs } = await arrange(h);
		await load(server);

		await say(server, `/tool read_file_path ${JSON.stringify({ path: join(docs, "march.csv") })}`);
		expect(textOfLast(await toolResults(server))).toContain("2026-03-01,120");
		await say(server, `/tool read_file_path ${JSON.stringify({ path: join(docs, "Statements", "..", "march.csv") })}`);

		const indexed = fileStore.searchFiles(server.db, "", 10);
		expect(indexed.total).toBe(1);
		expect(indexed.files[0]).toMatchObject({ name: "march.csv", kind: "csv", source: "path" });
	});
});

describe("the morning briefing and the evening wrap-up through the whole server", () => {
	const briefings = async (server: Server) =>
		(await ofKind(server, DAILY_ENTRY_KIND)).map((entry) => entry.data as DailyEntryData);

	async function advanceTo(h: Harness, server: Server, date: string, time: string) {
		h.clock.now = local(date, time);
		server.harness.resume();
	}

	it("lists the jobs with their next run, and takes a new time or an off switch", async () => {
		const { server } = await start();
		const read = async () =>
			(await (await fetch(`${base(server)}/api/settings/schedule`)).json()) as ScheduleSettingsResponse;

		expect(await read()).toMatchObject({
			timezone: "Asia/Thimphu",
			jobs: [
				{
					job: "briefing",
					label: "Morning briefing",
					localTime: "07:30",
					enabled: true,
					nextRunText: "Mon 26 Oct 2026, 07:30",
				},
				{
					job: "wrapup",
					label: "Evening wrap-up",
					localTime: "21:00",
					enabled: true,
					nextRunText: "Sun 25 Oct 2026, 21:00",
				},
			],
		});
		const put = (
			job: string,
			body: unknown,
			headers: Record<string, string> = { "content-type": "application/json" },
		) => fetch(`${base(server)}/api/settings/schedule/${job}`, { method: "PUT", headers, body: JSON.stringify(body) });

		const moved = await put("wrapup", { localTime: "22:15" });
		expect(moved.status).toBe(200);
		expect(((await moved.json()) as ScheduleSettingsResponse).jobs[1]).toMatchObject({
			localTime: "22:15",
			nextRunText: "Sun 25 Oct 2026, 22:15",
		});
		const off = await put("briefing", { enabled: false });
		expect(((await off.json()) as ScheduleSettingsResponse).jobs[0]).toMatchObject({ enabled: false });
		expect((await read()).jobs[0]?.nextRunText).toBeUndefined();

		for (const [job, body, status] of [
			["briefing", { localTime: "7:30" }, 400],
			["briefing", { localTime: "24:00" }, 400],
			["briefing", { enabled: "yes" }, 400],
			["briefing", {}, 400],
			["lunch", { enabled: true }, 404],
		] as const) {
			const refused = await put(job, body);
			expect([job, JSON.stringify(body), refused.status]).toStrictEqual([job, JSON.stringify(body), status]);
			expect(errorOf(await refused.json()).message.length).toBeGreaterThan(10);
		}
		expect((await put("briefing", { enabled: true }, {})).status).toBe(415);
	});

	it("briefs the PA at 07:30 with the day's facts, costs one model run, and pushes a notice without content", async () => {
		const { h, server } = await start();
		await say(server, '/tool add_task {"title":"Pay rent","due":"2026-10-26T09:00"}');
		await say(server, '/tool add_person {"name":"Pema","relation":"sister","birthday":"1990-10-26"}');
		const answers = await modelAnswers(server);
		h.sender.sent.length = 0;

		await advanceTo(h, server, "2026-10-26", "07:30");
		await waitFor(async () => (await briefings(server)).length === 1, { what: "the briefing request" });
		await waitFor(async () => (await modelAnswers(server)) === answers + 1, { what: "the PA's answer" });

		const [data] = await briefings(server);
		expect(data).toMatchObject({ job: "briefing", date: "2026-10-26", dateText: "Mon 26 Oct 2026" });
		expect(data?.sections.map((section) => section.title)).toStrictEqual(["Tasks and reminders today", "Birthdays"]);
		const [entry] = await ofKind(server, DAILY_ENTRY_KIND);
		expect(JSON.stringify(entry?.model)).toContain("Morning briefing request for Mon 26 Oct 2026");
		expect(JSON.stringify(entry?.model)).toContain("Pay rent");
		await waitFor(() => h.sender.sent.length === 1, { what: "the push" });
		expect(h.sender.sent[0]?.payload).toStrictEqual({
			title: "Briefing",
			body: "Your morning briefing",
			url: "/chat/pa",
			tag: "briefing",
		});
		expect(JSON.stringify(h.sender.sent[0]?.payload)).not.toMatch(/rent|Pema/);
	});

	it("posts a card and spends nothing when the day holds nothing", async () => {
		const { h, server } = await start();
		const answers = await modelAnswers(server);

		await advanceTo(h, server, "2026-10-26", "07:30");
		await waitFor(async () => (await briefings(server)).length === 1, { what: "the card" });
		await waitFor(() => h.sender.sent.length === 1, { what: "the push" });

		expect((await briefings(server))[0]).toMatchObject({ date: "2026-10-26", empty: true });
		expect(await modelAnswers(server)).toBe(answers);
		const [entry] = await ofKind(server, DAILY_ENTRY_KIND);
		expect(entry?.model).toBeUndefined();
	});

	it("asks in the evening, takes the answer through save_journal, and brings what carries over to the next morning", async () => {
		const { h, server } = await start();
		await say(server, '/tool add_task {"title":"Pay rent"}');
		await advanceTo(h, server, "2026-10-25", "21:00");
		await waitFor(async () => (await briefings(server)).length === 1, { what: "the wrap-up" });
		expect((await briefings(server))[0]).toMatchObject({ job: "wrapup", date: "2026-10-25" });
		await waitFor(() => dailyStore.getJournal(server.db, "2026-10-25") !== undefined, { what: "the journal day" });
		expect(dailyStore.getJournal(server.db, "2026-10-25")?.userLog).toBeUndefined();

		await say(
			server,
			'/tool save_journal {"date":"2026-10-25","user_log":"Wrote the plan and fixed the bug.","carried_over":["Send the invoice"]}',
		);
		expect(dailyStore.getJournal(server.db, "2026-10-25")).toMatchObject({
			userLog: "Wrote the plan and fixed the bug.",
			carriedOver: ["Send the invoice"],
		});

		await advanceTo(h, server, "2026-10-26", "07:30");
		await waitFor(async () => (await briefings(server)).length === 2, { what: "the next morning's briefing" });
		const morning = (await briefings(server))[1];
		expect(morning?.sections).toContainEqual({ title: "Carried over from yesterday", lines: ["Send the invoice"] });
	});
});

describe("what the log says about the daily jobs at start", () => {
	const dailyLines = (h: Harness) => h.logs.filter((line) => line.includes("[daily]"));

	it("calls the first start a set-up and does not blame a power cut; a restart says nothing", async () => {
		const { h, server } = await start();

		expect(dailyLines(h)).toStrictEqual([
			"info [daily] scheduled for the first time: briefing, wrapup. Change the times in Settings.",
		]);
		expect(h.logs.join("\n")).not.toMatch(/had no live timer/);

		await server.close();
		h.servers.splice(0);
		h.logs.splice(0);
		const restarted = await h.start();
		await post(restarted, "/api/push/subscribe", subscription());

		expect(dailyLines(h)).toStrictEqual([]);
	});

	it("still says so when a job's timer really was lost", async () => {
		const { h, server } = await start();
		// The row says the job is waiting, Durable's side has nothing: what a power cut leaves behind.
		await server.harness.abortTask(dailyStore.requireSchedule(server.db, "briefing").durableTaskId as TaskId, ctx);
		await server.close();
		h.servers.splice(0);
		h.logs.splice(0);

		await h.start();

		expect(dailyLines(h).join("\n")).toMatch(/warn \[daily\] 1 daily job\(s\) had no live timer.*: briefing/);
	});
});

/** The tool results of the PA's thread, oldest first. */
async function toolResults(server: Server) {
	return (await entries(server)).flatMap((entry) =>
		(entry.model ?? []).flatMap((message) => (message.role === "toolResult" ? [message] : [])),
	);
}

/** The text of the newest tool result. */
function textOfLast(results: Awaited<ReturnType<typeof toolResults>>): string {
	return (results.at(-1)?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}
