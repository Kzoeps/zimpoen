import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppDb, migrate, openAppDb } from "@assistant/db";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { createTelegramBridge, type PaGateway } from "../src/telegram/bridge.ts";
import { chunk, type TelegramClient, type TelegramUpdate } from "../src/telegram/client.ts";
import { readTelegramToken } from "../src/telegram/setup.ts";
import { telegramMigrations } from "../src/telegram/store.ts";
import { createTranscriber, type Runner, TRANSCRIPT_LABEL, VoiceError } from "../src/telegram/voice.ts";
import { setup } from "./domain-support.ts";
import { removeAllFixtures, waitFor } from "./support.ts";

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
	await removeAllFixtures();
});

async function tempDb(): Promise<AppDb> {
	const dir = await mkdtemp(join(tmpdir(), "zimpoen-tg-"));
	dirs.push(dir);
	const db = openAppDb(join(dir, "app.sqlite"));
	cleanups.push(() => db.close());
	migrate(db, telegramMigrations);
	return db;
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function fakeClient() {
	const sent: Array<{ chatId: number; text: string }> = [];
	const client: TelegramClient = {
		getUpdates: async () => [],
		sendMessage: async (chatId, text) => void sent.push({ chatId, text }),
		download: async () => new Uint8Array([1, 2, 3]),
	};
	return { client, sent };
}

function fakePa(answer = "Done.") {
	const sends: Array<{ content: string; requestId: string }> = [];
	const pa: PaGateway = {
		async send(content, requestId) {
			sends.push({ content, requestId });
			return content === "YES"
				? { submissionId: sends.length, approved: true, summary: "Create the routine 'Tasks check'" }
				: { submissionId: sends.length, approved: false };
		},
		reply: async () => answer,
	};
	return { pa, sends };
}

const OWNER = 111;
const message = (
	updateId: number,
	chatId: number,
	extra: Record<string, unknown>,
	type = "private",
): TelegramUpdate => ({
	update_id: updateId,
	message: { message_id: updateId, chat: { id: chatId, type }, ...extra },
});

async function boundBridge(options: { answer?: string; transcribe?: (a: Uint8Array) => Promise<string> } = {}) {
	const db = await tempDb();
	const { client, sent } = fakeClient();
	const { pa, sends } = fakePa(options.answer);
	const bridge = createTelegramBridge({
		db,
		client,
		pa,
		logger: quiet,
		...(options.transcribe === undefined ? {} : { transcribe: options.transcribe }),
	});
	const code = bridge.startCode() as string;
	await bridge.handle(message(1, OWNER, { text: `/start ${code}` }));
	sent.length = 0;
	return { db, bridge, sent, sends };
}

describe("telegram binding", () => {
	it("binds the private chat that sends the right code, once, and ignores every other chat", async () => {
		const db = await tempDb();
		const { client, sent } = fakeClient();
		const { pa, sends } = fakePa();
		const bridge = createTelegramBridge({ db, client, pa, logger: quiet });
		const code = bridge.startCode() as string;
		expect(code).toMatch(/^[0-9a-f]{12}$/);

		await bridge.handle(message(1, 999, { text: "/start wrong" }));
		await bridge.handle(message(2, 777, { text: `/start ${code}` }, "group"));
		await bridge.handle(message(3, 999, { text: "hello" }));
		expect(sent).toEqual([]);

		await bridge.handle(message(4, OWNER, { text: `/start ${code}` }));
		expect(sent.map((s) => s.chatId)).toEqual([OWNER]);
		expect(bridge.startCode()).toBeUndefined();

		// The code is burnt: another chat cannot take over, and nothing it says reaches the PA.
		await bridge.handle(message(5, 999, { text: `/start ${code}` }));
		await bridge.handle(message(6, 999, { text: "hi" }));
		expect(sends).toEqual([]);
		expect(sent).toHaveLength(1);
	});
});

describe("telegram messages", () => {
	it("passes owner text to the PA as tg:<update_id> and sends the reply back in 4096-char pieces", async () => {
		const long = `${"a".repeat(4000)}\n${"b".repeat(4000)}`;
		const { bridge, sent, sends } = await boundBridge({ answer: long });
		await bridge.handle(message(10, OWNER, { text: "  what's on today? " }));
		expect(sends).toEqual([{ content: "what's on today?", requestId: "tg:10" }]);
		await waitFor(() => sent.length === 2, { what: "the reply" });
		expect(sent.every((s) => s.chatId === OWNER && s.text.length <= 4096)).toBe(true);
		expect(sent.map((s) => s.text).join("\n")).toBe(long);
	});

	it("answers YES through the approval path without waiting for a run", async () => {
		const { bridge, sent, sends, db } = await boundBridge();
		await bridge.handle(message(11, OWNER, { text: "YES" }));
		expect(sends[0]?.requestId).toBe("tg:11");
		expect(sent).toEqual([{ chatId: OWNER, text: "Approved: Create the routine 'Tasks check'" }]);
		expect(db.get("SELECT * FROM telegram_reply")).toBeUndefined();
	});

	it("puts only the labelled transcript of a voice note in the thread", async () => {
		const { bridge, sends } = await boundBridge({ transcribe: async () => "buy milk tomorrow" });
		await bridge.handle(message(12, OWNER, { voice: { file_id: "f1", duration: 4 } }));
		expect(sends).toEqual([{ content: `${TRANSCRIPT_LABEL} buy milk tomorrow`, requestId: "tg:12" }]);
	});

	it("refuses voice notes over the duration cap, and says how to enable them when whisper is off", async () => {
		const capped = await boundBridge({ transcribe: async () => "x" });
		await capped.bridge.handle(message(13, OWNER, { voice: { file_id: "f", duration: 3600 } }));
		expect(capped.sends).toEqual([]);
		expect(capped.sent[0]?.text).toMatch(/too long/);

		const off = await boundBridge();
		await off.bridge.handle(message(14, OWNER, { voice: { file_id: "f", duration: 3 } }));
		expect(off.sends).toEqual([]);
		expect(off.sent[0]?.text).toMatch(/ZIMPOEN_WHISPER_BIN/);
	});

	it("persists the poll offset and resumes owed replies after a restart", async () => {
		const db = await tempDb();
		const { client, sent } = fakeClient();
		const batches: TelegramUpdate[][] = [];
		let offsets: number[] = [];
		client.getUpdates = async (offset, _t, signal) => {
			offsets.push(offset);
			const next = batches.shift();
			if (next !== undefined) return next;
			await new Promise((resolve) => signal?.addEventListener("abort", resolve));
			return [];
		};
		let release: (text: string) => void = () => {};
		const first: PaGateway = {
			send: async () => ({ submissionId: 7, approved: false }),
			reply: () => new Promise<string>((resolve) => (release = resolve)),
		};
		const bridge = createTelegramBridge({ db, client, pa: first, logger: quiet });
		const code = bridge.startCode() as string;
		batches.push([message(20, OWNER, { text: `/start ${code}` }), message(21, OWNER, { text: "hi" })]);
		bridge.start();
		await waitFor(() => offsets.length === 2, { what: "the second poll" });
		expect(offsets).toEqual([0, 22]);
		await bridge.close();
		release("late"); // the run ended after shutdown: nothing is sent by the closed bridge
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(sent.map((s) => s.text)).not.toContain("late");
		expect(db.get<{ status: string }>("SELECT status FROM telegram_reply WHERE update_id = 21")?.status).toBe(
			"waiting",
		);

		offsets = [];
		const second = createTelegramBridge({
			db,
			client,
			pa: { send: first.send, reply: async (id) => `reply to ${id}` },
			logger: quiet,
		});
		second.start();
		await waitFor(() => sent.some((s) => s.text === "reply to 7"), { what: "the resumed reply" });
		expect(offsets[0]).toBe(22);
		await second.close();
	});
});

describe("telegram failures", () => {
	it("retries a reply whose send failed before any piece went out", async () => {
		const db = await tempDb();
		const { client, sent } = fakeClient();
		const { pa } = fakePa("hello back");
		const send = client.sendMessage;
		let failures = 2;
		client.sendMessage = async (chatId, text) => {
			if (text === "hello back" && failures-- > 0) throw new Error("429");
			await send(chatId, text);
		};
		const bridge = createTelegramBridge({ db, client, pa, logger: quiet, retryMs: 1, sleep: async () => {} });
		await bridge.handle(message(1, OWNER, { text: `/start ${bridge.startCode()}` }));
		await bridge.handle(message(2, OWNER, { text: "hi" }));
		await waitFor(() => sent.some((s) => s.text === "hello back"), { what: "the retried reply" });
		expect(sent.filter((s) => s.text === "hello back")).toHaveLength(1);
		expect(db.get<{ status: string }>("SELECT status FROM telegram_reply")?.status).toBe("sent");
	});

	it("tells the owner when a message could not be passed on, and polls on", async () => {
		const db = await tempDb();
		const { client, sent } = fakeClient();
		const batches: TelegramUpdate[][] = [];
		const offsets: number[] = [];
		client.getUpdates = async (offset, _t, signal) => {
			offsets.push(offset);
			const next = batches.shift();
			if (next !== undefined) return next;
			await new Promise((resolve) => signal?.addEventListener("abort", resolve));
			return [];
		};
		const pa: PaGateway = {
			send: async () => {
				throw new Error("The PA has no conversation yet.");
			},
			reply: async () => "",
		};
		const bridge = createTelegramBridge({ db, client, pa, logger: quiet });
		batches.push([message(1, OWNER, { text: `/start ${bridge.startCode()}` }), message(2, OWNER, { text: "hi" })]);
		bridge.start();
		await waitFor(() => offsets.length === 2, { what: "the next poll" });
		await bridge.close();
		expect(sent.at(-1)?.text).toMatch(/send it again/);
		expect(offsets).toEqual([0, 3]);
	});

	it("a redelivered update after a crash before its reply row reaches the PA once and replies once", async () => {
		const db = await tempDb();
		const { client, sent } = fakeClient();
		const requests = new Map<string, number>();
		const pa: PaGateway = {
			// Durable dedups by requestId: the same id returns the same submission.
			async send(_content, requestId) {
				if (!requests.has(requestId)) requests.set(requestId, requests.size + 1);
				return { submissionId: requests.get(requestId) as number, approved: false };
			},
			reply: async (id) => `reply ${id}`,
		};
		const crashing = createTelegramBridge({ db, client, pa, logger: quiet });
		await crashing.handle(message(1, OWNER, { text: `/start ${crashing.startCode()}` }));
		// The crash: send happened, but no reply row was written and the offset was not saved.
		await pa.send("hi", "tg:2");
		expect(db.get("SELECT * FROM telegram_reply")).toBeUndefined();

		const restarted = createTelegramBridge({ db, client, pa, logger: quiet });
		await restarted.handle(message(2, OWNER, { text: "hi" }));
		await waitFor(() => sent.some((s) => s.text === "reply 1"), { what: "the reply" });
		expect(requests.size).toBe(1);
		expect(sent.filter((s) => s.text === "reply 1")).toHaveLength(1);
	});

	it("says when a long message was cut, and asks for audio files as voice notes", async () => {
		const { bridge, sent, sends } = await boundBridge();
		await bridge.handle(message(3, OWNER, { text: "x".repeat(20_001) }));
		expect(sends[0]?.content).toHaveLength(20_000);
		expect(sent[0]?.text).toMatch(/only the first 20000/);
		await bridge.handle(message(4, OWNER, { audio: { file_id: "f", duration: 3 } }));
		expect(sends).toHaveLength(1);
	});
});

describe("telegram voice", () => {
	it("runs ffmpeg then whisper-cli with fixed argv and returns the trimmed text", async () => {
		const calls: Array<{ file: string; args: readonly string[] }> = [];
		const run: Runner = async (file, args) => {
			calls.push({ file, args });
			return { stdout: file === "/opt/whisper-cli" ? "\n  Hello   there. \n" : "" };
		};
		const transcribe = createTranscriber({ whisper: { bin: "/opt/whisper-cli", model: "/opt/ggml-base.bin" }, run });
		expect(await transcribe(new Uint8Array([1]))).toBe("Hello there.");
		expect(calls.map((c) => c.file)).toEqual(["ffmpeg", "/opt/whisper-cli"]);
		expect(calls[0]?.args).toEqual(expect.arrayContaining(["-ar", "16000", "-ac", "1"]));
		expect(calls[0]?.args.slice(4, 9)).toEqual(["-protocol_whitelist", "file", "-f", "ogg", "-i"]);
		expect(calls[1]?.args.slice(0, 2)).toEqual(["-m", "/opt/ggml-base.bin"]);
	});
});

describe("telegram voice errors", () => {
	it("keeps whisper's stderr for the log, not the error text", async () => {
		const run: Runner = async (file) => {
			if (file === "ffmpeg") return { stdout: "" };
			throw Object.assign(new Error("exit 127"), { stderr: "libcuda.so: cannot open shared object file" });
		};
		const transcribe = createTranscriber({ whisper: { bin: "/w", model: "/m" }, run });
		const error = await transcribe(new Uint8Array([1])).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VoiceError);
		expect((error as VoiceError).message).not.toMatch(/libcuda/);
		expect((error as VoiceError).detail).toMatch(/libcuda/);
	});
});

describe("telegram config", () => {
	const ctx = { cwd: "/tmp", homeDir: "/home/x" };
	const env = { ASSISTANT_AUTH: "off", ASSISTANT_READ_PATHS: "/tmp" };

	it("is off by default and needs both whisper settings", () => {
		expect(parseConfig(env, ctx).telegram).toEqual({ enabled: false });
		expect(
			parseConfig({ ...env, ZIMPOEN_TELEGRAM: "on", ZIMPOEN_WHISPER_BIN: "/b", ZIMPOEN_WHISPER_MODEL: "/m" }, ctx)
				.telegram,
		).toEqual({ enabled: true, whisper: { bin: "/b", model: "/m" } });
		expect(() => parseConfig({ ...env, ZIMPOEN_WHISPER_BIN: "/b" }, ctx)).toThrow(/ZIMPOEN_WHISPER_MODEL/);
		expect(() => parseConfig({ ...env, ZIMPOEN_TELEGRAM: "yes" }, ctx)).toThrow(/ZIMPOEN_TELEGRAM/);
	});

	it("reads the token file and explains a bad one", async () => {
		const dir = await mkdtemp(join(tmpdir(), "zimpoen-tg-"));
		dirs.push(dir);
		const path = join(dir, "telegram.json");
		await expect(readTelegramToken(path)).rejects.toThrow(/cannot be read/);
		await writeFile(path, JSON.stringify({ token: "nope" }));
		await expect(readTelegramToken(path)).rejects.toThrow(/no bot token/);
		await writeFile(path, JSON.stringify({ token: "123:abcdefghijklmnopqrstuvwxyz" }));
		await chmod(path, 0o644);
		const warnings: string[] = [];
		expect(await readTelegramToken(path, { warn: (line: string) => void warnings.push(line) })).toBe(
			"123:abcdefghijklmnopqrstuvwxyz",
		);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(warnings[0]).toMatch(/0600/);
	});
});

describe("chunk", () => {
	it("keeps short text whole and splits long text under the limit", () => {
		expect(chunk("hi")).toEqual(["hi"]);
		expect(chunk("x".repeat(9000)).map((p) => p.length)).toEqual([4096, 4096, 808]);
	});
});

describe("telegram on a running server", () => {
	it("starts nothing when off", async () => {
		const h = await setup();
		let calls = 0;
		const server = await h.start(undefined, {
			telegram: {
				fetch: async () => {
					calls++;
					return Response.json({});
				},
			},
		});
		cleanups.push(() => server.close());
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(calls).toBe(0);
	});

	it("binds, takes a message to the PA and sends the PA's reply back", async () => {
		const h = await setup({ ZIMPOEN_TELEGRAM: "on" });
		await writeFile(h.fixture.config.paths.telegram, JSON.stringify({ token: "123:abcdefghijklmnopqrstuvwxyz" }));
		const queue: TelegramUpdate[][] = [];
		const sent: Array<{ chat_id: number; text: string }> = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			if (url.endsWith("/sendMessage")) sent.push(body as { chat_id: number; text: string });
			if (url.endsWith("/getUpdates")) {
				const next = queue.shift();
				if (next === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
				return Response.json({ ok: true, result: next ?? [] });
			}
			return Response.json({ ok: true, result: {} });
		};
		const server = await h.start(undefined, { telegram: { fetch: fakeFetch } });
		cleanups.push(() => server.close());
		const code = server.db.get<{ value: string }>("SELECT value FROM telegram_state WHERE key = 'start_code'")?.value;
		expect(h.logs.some((line) => line.includes(`/start ${code}`))).toBe(true);

		queue.push([message(1, OWNER, { text: `/start ${code}` }), message(2, OWNER, { text: "hello from telegram" })]);
		await waitFor(() => sent.length >= 2, { what: "the PA's reply on Telegram" });
		expect(sent.every((s) => s.chat_id === OWNER)).toBe(true);
		expect(sent[1]?.text).toContain("hello from telegram");
	});
});
