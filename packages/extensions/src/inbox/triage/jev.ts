import type { TriageResult } from "@assistant/shared";
import type { RequestOptions, Triage, TriageInput } from "../types.ts";
import { createBreaker } from "./breaker.ts";
import { JEV_ENDPOINT, JevContractError, jevHeaders, jevRequest, parseJevResponse } from "./jev-contract.ts";

/** Jev cannot be reached right now (the network, a timeout, 429 or a 5xx): trying again later may work. */
export class JevUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JevUnavailableError";
	}
}

/** Jev refused the key (401 or 403). Trying again changes nothing until the key does. */
export class JevAuthError extends Error {
	constructor(status: number) {
		super(`Jev refused the key (HTTP ${status}). Check JEV_API_KEY in <data>/secrets/jev.json (docs/setup-jev.md).`);
		this.name = "JevAuthError";
	}
}

/**
 * Jev is paused: it failed several times in a row, so it is not asked again until the cool-down is over. It is an
 * "unavailable" error on purpose: whoever treats Jev being out of reach as "sort by the local rules and try again later"
 * treats this the same way, and does so at once instead of after a timeout.
 */
export class JevPausedError extends JevUnavailableError {
	/** When Jev is asked again, epoch ms. */
	readonly until: number;

	constructor(until: number, failures: number, lastError: string) {
		super(
			`Jev is paused after ${failures} failures in a row; mail is sorted by the local rules until it is asked again. The last failure: ${lastError}`,
		);
		this.name = "JevPausedError";
		this.until = until;
	}
}

export type JevOptions = {
	apiKey: string;
	/** Replaces `fetch`, so that a test can play the server. The URL is not an option: a request only ever goes to {@link JEV_ENDPOINT}. */
	fetch?: typeof fetch;
	/** How long one request may take. Default 20 s. */
	timeoutMs?: number;
	/** Waits before each retry of a request that failed for a reason that may pass. Default 0.5 s, then 2 s; `[]` for none. */
	retryDelaysMs?: readonly number[];
	/**
	 * After this many mails in a row that Jev failed on (it timed out, was down, refused the key or answered something this
	 * program cannot read) it is not asked for `coolDownMs`. Defaults: 3 mails, 15 minutes. One mail's failure is the whole
	 * request with its retries, so about a minute at the slowest.
	 */
	circuit?: { failures?: number; coolDownMs?: number };
	/** The clock of the circuit breaker, epoch ms. Default `Date.now`. */
	now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 2000];
const DEFAULT_CIRCUIT = { failures: 3, coolDownMs: 15 * 60_000 };

/** A failure of Jev itself, as opposed to a request that was cancelled: only these open the circuit. */
const isJevFailure = (error: unknown): boolean =>
	error instanceof JevUnavailableError || error instanceof JevAuthError || error instanceof JevContractError;

/** The most of an answer that is read. The answer is three small values. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** The body of a response, at most `max` bytes: a server that sends more is cut off, not buffered. */
async function readLimited(response: Response, max: number): Promise<string> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size <= max) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

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

/**
 * Classify mail with Jev (TypeSafe), `https://api.typesafe.ai/v1/systemone`, the official host and no other: the URL is a
 * constant, a redirect is refused (so the key is never sent anywhere else), and the request and answer shapes live in
 * `jev-contract.ts`. What leaves the machine per mail is the sender, the subject and the first 1500 characters of the text.
 */
export function createJevTriage(options: JevOptions): Triage {
	const send = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
	const breaker = createBreaker({
		failures: options.circuit?.failures ?? DEFAULT_CIRCUIT.failures,
		coolDownMs: options.circuit?.coolDownMs ?? DEFAULT_CIRCUIT.coolDownMs,
		now: options.now ?? Date.now,
		counts: isJevFailure,
		refuse: ({ until, failures, lastError }) => new JevPausedError(until, failures, lastError),
	});

	async function once(input: TriageInput, requestOptions: RequestOptions | undefined): Promise<TriageResult> {
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = requestOptions?.signal === undefined ? timeout : AbortSignal.any([requestOptions.signal, timeout]);
		let response: Response;
		try {
			response = await send(JEV_ENDPOINT, {
				method: "POST",
				headers: jevHeaders(options.apiKey),
				body: JSON.stringify(jevRequest(input)),
				redirect: "error",
				signal,
			});
		} catch (error) {
			if (requestOptions?.signal?.aborted === true) throw error;
			throw new JevUnavailableError(
				timeout.aborted
					? `Jev did not answer within ${timeoutMs / 1000} seconds.`
					: `Jev could not be reached (${error instanceof Error ? error.message : String(error)}).`,
			);
		}
		const text = await readLimited(response, MAX_RESPONSE_BYTES);
		if (response.status === 401 || response.status === 403) throw new JevAuthError(response.status);
		if (response.status === 429 || response.status >= 500) {
			throw new JevUnavailableError(`Jev answered HTTP ${response.status}; it may be busy or down.`);
		}
		if (!response.ok) {
			throw new JevContractError(
				`Jev refused the request (HTTP ${response.status}). The request shape in jev-contract.ts may not match docs.typesafe.ai.`,
			);
		}
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new JevContractError(
				"Jev's answer is not JSON. Check the endpoint in jev-contract.ts against docs.typesafe.ai.",
			);
		}
		const answer = parseJevResponse(body);
		return { ...answer, source: "jev", reason: "Jev" };
	}

	/** One mail, with the retries of a request that failed for a reason that may pass. */
	async function withRetries(input: TriageInput, requestOptions: RequestOptions | undefined): Promise<TriageResult> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await once(input, requestOptions);
			} catch (error) {
				const delay = delays[attempt];
				if (!(error instanceof JevUnavailableError) || delay === undefined) throw error;
				await sleep(delay, requestOptions?.signal);
			}
		}
	}

	return {
		mode: "jev",
		classify: (input, requestOptions) => breaker.run(() => withRetries(input, requestOptions)),
		pausedUntil: breaker.pausedUntil,
	};
}
