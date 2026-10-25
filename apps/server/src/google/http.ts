import { HistoryExpiredError, type RequestOptions, type TokenProvider } from "@assistant/extensions";

/** Google answered something that is not a success. `reason` is Google's own words, which usually say what to do. */
export class GoogleApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "GoogleApiError";
		this.status = status;
	}
}

export type GoogleHttpOptions = {
	tokens: TokenProvider;
	fetch: typeof fetch;
	/** Waits before each retry of a request that failed for a reason that may pass. Default 0.5 s, then 2 s; `[]` for none. */
	retryDelaysMs?: readonly number[];
};

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 2000];
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted === true) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

/** What Google said was wrong, as one sentence (its error object carries a message). */
function describeError(status: number, body: string): string {
	try {
		const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
		if (typeof message === "string" && message !== "") return `Google answered ${status}: ${message.slice(0, 300)}`;
	} catch {
		// Not JSON: the status says enough.
	}
	return `Google answered ${status}.`;
}

/**
 * GET a Google REST resource as JSON with the account's access token. Only GET: nothing in this program can change a
 * mailbox or a calendar (PLAN rule 1). A 401 gets one more try with a fresh token; 429 and 5xx a few tries with a wait; a
 * refused refresh token is {@link TokenRevokedError} from the token provider and is not caught here.
 */
export function createGoogleGet(options: GoogleHttpOptions) {
	const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

	return async function get(
		account: string,
		url: URL,
		requestOptions: RequestOptions | undefined,
		onStatus?: (status: number) => void,
	): Promise<unknown> {
		let refreshed = false;
		for (let attempt = 0; ; attempt++) {
			const token = await options.tokens.accessToken(account, {
				...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
				...(refreshed ? { refresh: true } : {}),
			});
			let response: Response;
			try {
				response = await options.fetch(url, {
					method: "GET",
					headers: { authorization: `Bearer ${token}`, accept: "application/json" },
					...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
				});
			} catch (error) {
				if (requestOptions?.signal?.aborted === true) throw error;
				const delay = delays[attempt];
				if (delay === undefined)
					throw new Error(`Google could not be reached (${error instanceof Error ? error.message : String(error)}).`);
				await sleep(delay, requestOptions?.signal);
				continue;
			}
			const body = await readLimited(response);
			if (response.ok) return body === "" ? {} : JSON.parse(body);
			onStatus?.(response.status);
			if (response.status === 401 && !refreshed) {
				refreshed = true;
				continue;
			}
			const delay = delays[attempt];
			if ((response.status === 429 || response.status >= 500) && delay !== undefined) {
				await sleep(delay, requestOptions?.signal);
				continue;
			}
			throw new GoogleApiError(response.status, describeError(response.status, body));
		}
	};
}

async function readLimited(response: Response): Promise<string> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new Error("Google's answer is larger than this program reads.");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks).toString("utf8");
}

export { HistoryExpiredError };
