import { randomBytes } from "node:crypto";
import type { AppDb } from "@assistant/db";
import { chunk, type TelegramClient, type TelegramMessage, type TelegramUpdate } from "./client.ts";
import * as store from "./store.ts";
import { MAX_VOICE_BYTES, MAX_VOICE_SECONDS, TRANSCRIPT_LABEL, type Transcriber, VoiceError } from "./voice.ts";

/** What the bridge needs of the PA: send it the owner's words, and read the reply when its run ends. */
export type PaGateway = {
	/**
	 * An owner message, once per `requestId`. A bare YES that answers the waiting approval is handled by the approval
	 * service (`approved: true`) and starts no run.
	 */
	send(content: string, requestId: string): Promise<{ submissionId: number; approved: boolean }>;
	/** The PA's final text for the run, or a short sentence saying why there is none. Waits for the run to end. */
	reply(submissionId: number): Promise<string>;
};

export type BridgeLogger = Pick<Console, "info" | "warn" | "error">;

export type TelegramBridgeOptions = {
	db: AppDb;
	client: TelegramClient;
	pa: PaGateway;
	/** Absent when whisper.cpp is not configured: voice notes then get a note saying how to turn them on. */
	transcribe?: Transcriber;
	now?: () => number;
	logger?: BridgeLogger;
	/** Seconds one getUpdates call waits for news. */
	pollSeconds?: number;
	/** First wait before resending a reply that failed (doubles each time). Default 2 s. */
	retryMs?: number;
	/** Waits between failed polls and sends; tests pass a fast one. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type TelegramBridge = {
	/** Start the long poll and resume replies a restart interrupted. */
	start(): void;
	/** The one-time code `/start <code>` binds with, or undefined once a chat is bound. */
	startCode(): string | undefined;
	/** Handle one update (exported for tests; the poll loop calls it). */
	handle(update: TelegramUpdate): Promise<void>;
	close(): Promise<void>;
};

/** The longest message passed on to the PA, as the web composer allows. */
const MAX_CONTENT_CHARS = 20_000;
const MAX_BACKOFF_MS = 60_000;
/** Tries to send one reply before leaving it for the next start. */
const DELIVERY_ATTEMPTS = 5;

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		});
	});

/**
 * The Telegram bridge (upgrade plan §5, phase 1b): one private chat, bound with `/start <code>`, talks to the PA. Every
 * other chat is ignored without an answer. Replies go only to the bound chat, which is the owner (the named exception
 * to PLAN rule 1).
 */
export function createTelegramBridge(options: TelegramBridgeOptions): TelegramBridge {
	const { db, client, pa } = options;
	const now = options.now ?? Date.now;
	const logger = options.logger ?? console;
	const pollSeconds = options.pollSeconds ?? 30;
	const sleep = options.sleep ?? defaultSleep;
	const retryMs = options.retryMs ?? 2000;
	const stop = new AbortController();
	let loop: Promise<void> | undefined;

	function ensureStartCode(): string | undefined {
		if (store.getBoundChat(db) !== undefined) return undefined;
		let code = store.getStartCode(db);
		if (code === undefined) {
			code = randomBytes(6).toString("hex");
			store.setStartCode(db, code);
		}
		return code;
	}

	async function say(chatId: number, text: string): Promise<void> {
		for (const piece of chunk(text)) await client.sendMessage(chatId, piece);
	}

	/**
	 * Send the reply to `row` once its run ends. A send that failed before any piece went out is released and retried
	 * with backoff (then left `waiting` for the next start); once a piece went out, the row stays claimed, so a crash or
	 * failure mid-reply never sends the start twice.
	 */
	async function deliver(row: Omit<store.ReplyRow, "status">): Promise<void> {
		let text: string;
		try {
			text = await pa.reply(row.submissionId);
		} catch (error) {
			// Closing ends the wait; the row stays `waiting` and the next start delivers it.
			if (!stop.signal.aborted) logger.warn(`[telegram] no reply for update ${row.updateId}: ${reason(error)}`);
			return;
		}
		const pieces = chunk(text.trim() === "" ? "(The assistant finished without a written reply.)" : text);
		for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt++) {
			if (stop.signal.aborted || !store.claimReply(db, row.updateId)) return;
			let sent = 0;
			try {
				for (const piece of pieces) {
					await client.sendMessage(row.chatId, piece);
					sent++;
				}
				store.markSent(db, row.updateId);
				return;
			} catch (error) {
				if (sent > 0) {
					logger.warn(`[telegram] reply to update ${row.updateId} broke off after ${sent} piece(s): ${reason(error)}`);
					return;
				}
				store.releaseReply(db, row.updateId);
				logger.warn(
					`[telegram] could not send the reply to update ${row.updateId} (attempt ${attempt + 1}): ${reason(error)}`,
				);
				await sleep(retryMs * 2 ** attempt, stop.signal);
			}
		}
	}

	async function onStart(message: TelegramMessage, code: string): Promise<void> {
		const expected = store.getStartCode(db);
		if (expected === undefined || code !== expected) return; // a wrong code gets no answer, as any stranger does
		if (!store.bind(db, message.chat.id)) return;
		logger.info("[telegram] bound to a private chat; every other chat is ignored.");
		await say(message.chat.id, "Connected. Messages and voice notes here go to Zimpoen.");
	}

	async function contentOf(message: TelegramMessage, chatId: number): Promise<string | undefined> {
		if (message.audio !== undefined) {
			await say(chatId, "Send it as a voice note (hold the mic button); audio files are not transcribed.");
			return undefined;
		}
		const voice = message.voice;
		if (voice !== undefined) {
			if (options.transcribe === undefined) {
				await say(chatId, "Voice notes are off. Set ZIMPOEN_WHISPER_BIN and ZIMPOEN_WHISPER_MODEL and restart.");
				return undefined;
			}
			if (voice.duration > MAX_VOICE_SECONDS || (voice.file_size ?? 0) > MAX_VOICE_BYTES) {
				await say(chatId, `That voice note is too long. Keep it under ${MAX_VOICE_SECONDS / 60} minutes.`);
				return undefined;
			}
			try {
				const audio = await client.download(voice.file_id, MAX_VOICE_BYTES, stop.signal);
				const words = await options.transcribe(audio, stop.signal);
				if (words === "") {
					await say(chatId, "I could not make out any words in that voice note.");
					return undefined;
				}
				return `${TRANSCRIPT_LABEL} ${words}`;
			} catch (error) {
				if (stop.signal.aborted) throw error;
				await say(chatId, error instanceof VoiceError ? error.message : "The voice note could not be fetched.");
				logger.warn(
					`[telegram] voice note failed: ${reason(error)}${error instanceof VoiceError && error.detail ? ` (${error.detail})` : ""}`,
				);
				return undefined;
			}
		}
		const text = message.text?.trim();
		if (text === undefined || text === "") return undefined;
		if (text.length > MAX_CONTENT_CHARS) {
			await say(
				chatId,
				`That message was longer than ${MAX_CONTENT_CHARS} characters; only the first ${MAX_CONTENT_CHARS} were passed on.`,
			);
		}
		return text.slice(0, MAX_CONTENT_CHARS);
	}

	async function handle(update: TelegramUpdate): Promise<void> {
		const message = update.message;
		if (message === undefined || message.chat.type !== "private") return;
		const bound = store.getBoundChat(db);
		const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(message.text?.trim() ?? "");
		if (bound === undefined) {
			if (start?.[1] !== undefined) await onStart(message, start[1]);
			return;
		}
		if (message.chat.id !== bound || start !== null) return;

		const content = await contentOf(message, bound);
		if (content === undefined) return;
		const { submissionId, approved } = await pa.send(content, `tg:${update.update_id}`);
		if (approved) {
			await say(bound, "Approved.");
			return;
		}
		const row = { updateId: update.update_id, chatId: bound, submissionId };
		store.addReply(db, row, now());
		void deliver(row);
	}

	/** Tell the bound owner (only) that their message was not passed on, so they can resend it. Never throws. */
	async function tellFailed(update: TelegramUpdate): Promise<void> {
		const bound = store.getBoundChat(db);
		if (bound === undefined || update.message?.chat.id !== bound) return;
		await say(bound, "Sorry, I could not pass that on to Zimpoen. Please send it again.").catch((error: unknown) =>
			logger.warn(`[telegram] could not say so: ${reason(error)}`),
		);
	}

	async function poll(): Promise<void> {
		let backoff = 1000;
		while (!stop.signal.aborted) {
			let updates: TelegramUpdate[];
			try {
				updates = await client.getUpdates(store.getOffset(db), pollSeconds, stop.signal);
				backoff = 1000;
			} catch (error) {
				if (stop.signal.aborted) return;
				logger.warn(`[telegram] poll failed, retrying in ${backoff / 1000}s: ${reason(error)}`);
				await sleep(backoff, stop.signal);
				backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
				continue;
			}
			for (const update of updates) {
				if (stop.signal.aborted) return;
				try {
					await handle(update);
				} catch (error) {
					if (stop.signal.aborted) return;
					// The update is passed over rather than retried forever; the owner sees no reply and can resend.
					logger.error(`[telegram] update ${update.update_id} failed: ${reason(error)}`);
					await tellFailed(update);
				}
				store.setOffset(db, update.update_id + 1);
			}
		}
	}

	return {
		start() {
			if (loop !== undefined) return;
			const code = ensureStartCode();
			if (code !== undefined)
				logger.info(`[telegram] not bound yet. Send this to the bot in a private chat: /start ${code}`);
			for (const row of store.waitingReplies(db)) void deliver(row);
			loop = poll();
		},
		startCode: () => ensureStartCode(),
		handle,
		async close() {
			stop.abort();
			// Replies still waiting on a run are not awaited: their rows stay `waiting` and the next start resumes them.
			await loop;
		},
	};
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
