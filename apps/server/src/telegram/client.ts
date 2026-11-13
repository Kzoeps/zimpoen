/**
 * A minimal Telegram Bot API client. The token is part of every address, so no address or token ever reaches a log or
 * an error message. `fetch` is injectable: tests play Telegram, and nothing here opens a connection by itself.
 */

export type TelegramUser = { id: number };
export type TelegramChat = { id: number; type: string };
export type TelegramVoice = { file_id: string; duration: number; file_size?: number; mime_type?: string };
export type TelegramMessage = {
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	voice?: TelegramVoice;
	audio?: TelegramVoice;
};
export type TelegramUpdate = { update_id: number; message?: TelegramMessage };

export class TelegramError extends Error {
	readonly code: number;
	constructor(message: string, code: number) {
		super(message);
		this.name = "TelegramError";
		this.code = code;
	}
}

export type TelegramClient = {
	getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
	sendMessage(chatId: number, text: string): Promise<void>;
	/** The file's bytes, refused above `maxBytes` before and after reading. */
	download(fileId: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
};

export function createTelegramClient(
	token: string,
	options: { base?: string; fetch?: typeof fetch } = {},
): TelegramClient {
	const base = options.base ?? "https://api.telegram.org";
	const fetcher = options.fetch ?? fetch;

	async function call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 30_000) {
		const timeout = AbortSignal.timeout(timeoutMs);
		let response: Response;
		try {
			response = await fetcher(`${base}/bot${token}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(params),
				redirect: "error",
				signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new TelegramError(`Telegram could not be reached (${method}).`, 0);
		}
		let body: { ok?: boolean; result?: T; description?: string; error_code?: number };
		try {
			body = (await response.json()) as typeof body;
		} catch {
			throw new TelegramError(`Telegram answered ${response.status} to ${method}.`, response.status);
		}
		if (body.ok === true) return body.result as T;
		const code = body.error_code ?? response.status;
		throw new TelegramError(
			`Telegram refused ${method} (${code}): ${String(body.description ?? "").slice(0, 200)}`,
			code,
		);
	}

	return {
		async getUpdates(offset, timeoutSeconds, signal) {
			return await call<TelegramUpdate[]>(
				"getUpdates",
				{ offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
				signal,
				(timeoutSeconds + 15) * 1000,
			);
		},
		async sendMessage(chatId, text) {
			await call("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
		},
		async download(fileId, maxBytes, signal) {
			const file = await call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId }, signal);
			if (file.file_path === undefined) throw new TelegramError("Telegram gave no path for the file.", 0);
			if ((file.file_size ?? 0) > maxBytes) throw new TelegramError("The file is too big.", 413);
			const timeout = AbortSignal.timeout(60_000);
			let response: Response;
			try {
				response = await fetcher(`${base}/file/bot${token}/${file.file_path}`, {
					redirect: "error",
					signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
				});
			} catch (error) {
				if (signal?.aborted) throw error;
				throw new TelegramError("Telegram could not be reached (file download).", 0);
			}
			if (!response.ok)
				throw new TelegramError(`Telegram answered ${response.status} to the file download.`, response.status);
			if (Number(response.headers.get("content-length") ?? 0) > maxBytes)
				throw new TelegramError("The file is too big.", 413);
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.length > maxBytes) throw new TelegramError("The file is too big.", 413);
			return bytes;
		},
	};
}

/** Telegram's limit for one message's text. */
export const MESSAGE_LIMIT = 4096;

/** Split `text` into pieces of at most `limit` characters, at a line break or space when one is near the end. */
export function chunk(text: string, limit = MESSAGE_LIMIT): string[] {
	const pieces: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
		if (cut < limit / 2) cut = limit;
		// Never split a surrogate pair.
		const code = rest.charCodeAt(cut - 1);
		if (cut === limit && code >= 0xd800 && code <= 0xdbff) cut -= 1;
		pieces.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest.length > 0) pieces.push(rest);
	return pieces;
}
