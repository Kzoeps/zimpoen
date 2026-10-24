import {
	type ApprovalDecision,
	DEFAULT_HISTORY_PAGE,
	isThinkingLevel,
	MAX_HISTORY_PAGE,
	MAX_MESSAGE_CHARS,
	type ModelSelection,
	type PushSubscribeRequest,
	REQUEST_ID_PATTERN,
	type SendMessageRequest,
	THINKING_LEVELS,
	type UpdateAgentSettingsRequest,
} from "@assistant/shared";
import type { Context, MiddlewareHandler } from "hono";
import { ApiError, invalidRequest } from "./errors.ts";

/**
 * Every state-changing request must declare `Content-Type: application/json`.
 *
 * This is the CSRF rule. Tailscale identifies the owner by device, not by cookie, so a page on any other site could
 * make the owner's browser send a request to this API that the server would accept as the owner's. A request with a
 * JSON content type is not a "simple" cross-origin request: the browser must first ask permission (a preflight), and
 * this server never grants it. It works together with the checks in `guard.ts` (allowed `Host`, `Sec-Fetch-Site`), and
 * needs no token or cookie.
 *
 * Consequence for M2: a multipart upload cannot satisfy this rule, so `POST /api/uploads` will be an explicit,
 * single exception that relies on those `guard.ts` checks instead (see `docs/design-notes.md`). Do not widen the rule.
 */
export const requireJsonContentType: MiddlewareHandler = async (c, next) => {
	if (
		STATE_CHANGING_METHODS.has(c.req.method) &&
		!/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? "")
	) {
		throw new ApiError(
			415,
			"invalid_request",
			`${c.req.method} requests must send the header 'Content-Type: application/json'.`,
		);
	}
	await next();
};

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A positive integer path or query value, or a 400 that names the parameter. */
export function parseId(raw: string, name: string): number {
	const value = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
		throw invalidRequest(`${name} must be a positive whole number, got '${raw}'.`);
	}
	return value;
}

export async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		throw new ApiError(400, "invalid_json", "The request body is not valid JSON. Send a JSON object.");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw invalidRequest("The request body must be a JSON object.");
	}
	return body as Record<string, unknown>;
}

export function parseSendMessage(body: Record<string, unknown>): SendMessageRequest {
	const { content, requestId, whenBusy } = body;
	if (typeof content !== "string" || content.trim() === "") {
		throw invalidRequest("'content' must be a non-empty string.");
	}
	if (content.length > MAX_MESSAGE_CHARS) {
		throw invalidRequest(
			`'content' is ${content.length} characters; the limit is ${MAX_MESSAGE_CHARS}. Shorten it or send it in parts.`,
		);
	}
	if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
		throw invalidRequest(
			"'requestId' is required: a client-generated unique string of 1 to 128 letters, digits, '_', '.', ':' or '-' " +
				"(for example crypto.randomUUID()). Resending the same requestId never sends the message twice.",
		);
	}
	if (whenBusy !== undefined && whenBusy !== "steer" && whenBusy !== "followUp") {
		throw invalidRequest("'whenBusy' must be 'steer' or 'followUp' when given.");
	}
	return { content, requestId, ...(whenBusy === undefined ? {} : { whenBusy }) };
}

export type HistoryQuery = { before?: number; limit: number };

export function parseHistoryQuery(c: Context): HistoryQuery {
	const before = c.req.query("before");
	const limit = c.req.query("limit");
	const parsedLimit = limit === undefined ? DEFAULT_HISTORY_PAGE : parseId(limit, "limit");
	if (parsedLimit > MAX_HISTORY_PAGE) {
		throw invalidRequest(`limit must be at most ${MAX_HISTORY_PAGE}, got ${parsedLimit}.`);
	}
	return { limit: parsedLimit, ...(before === undefined ? {} : { before: parseId(before, "before") }) };
}

export function parseUpdateSettings(body: Record<string, unknown>): UpdateAgentSettingsRequest {
	const { model, thinkingLevel } = body;
	const parsedModel = model === undefined ? undefined : parseModelSelection(model);
	if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) {
		throw invalidRequest(`'thinkingLevel' must be one of: ${THINKING_LEVELS.join(", ")}.`);
	}
	if (parsedModel === undefined && thinkingLevel === undefined) {
		throw invalidRequest("Send 'model', 'thinkingLevel' or both.");
	}
	return {
		...(parsedModel === undefined ? {} : { model: parsedModel }),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
	};
}

function parseModelSelection(value: unknown): ModelSelection {
	const { provider, modelId } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
	if (typeof provider !== "string" || provider === "" || typeof modelId !== "string" || modelId === "") {
		throw invalidRequest('\'model\' must be an object like { "provider": "openai", "modelId": "gpt-6.1-sol" }.');
	}
	return { provider, modelId };
}

const MAX_ENDPOINT_CHARS = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A Web Push subscription as `PushSubscription.toJSON()` writes it. Checked the way a sender needs it, not loosely. */
export function parsePushSubscribe(body: Record<string, unknown>): PushSubscribeRequest {
	const { endpoint, keys } = body;
	if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT_CHARS) {
		throw invalidRequest(`'endpoint' must be the subscription's URL (at most ${MAX_ENDPOINT_CHARS} characters).`);
	}
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw invalidRequest("'endpoint' is not a URL. Send the endpoint of PushSubscription.toJSON().");
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
		throw invalidRequest("'endpoint' must be an https URL without credentials, as push services give out.");
	}
	if (!isPublicHostName(url.hostname)) {
		throw invalidRequest(
			`'endpoint' must point at a push service on the public internet, a name like fcm.googleapis.com, not '${url.hostname}'. ` +
				"The server sends a request to every endpoint it stores, so addresses and local names are refused.",
		);
	}
	const { p256dh, auth } = (typeof keys === "object" && keys !== null ? keys : {}) as Record<string, unknown>;
	if (!isBase64Url(p256dh, 65)) {
		throw invalidRequest("'keys.p256dh' must be the browser's public key: 65 bytes, base64url encoded.");
	}
	if (!isBase64Url(auth, 16)) {
		throw invalidRequest("'keys.auth' must be the browser's auth secret: 16 bytes, base64url encoded.");
	}
	return { endpoint, keys: { p256dh, auth } };
}

/**
 * Whether `hostname` (as `URL` normalises it) could be a push service: a name, not an address, and not a name that only
 * means something inside a network. Vendors use names (fcm.googleapis.com, updates.push.services.mozilla.com,
 * web.push.apple.com). Not a defence against a public name that resolves to a private address; the endpoint can only be
 * sent by the owner (identity, `Host`, `Sec-Fetch-Site` and JSON-only rules apply), so this keeps a mistake or a stolen
 * session from aiming the server at the machine's own network.
 */
function isPublicHostName(hostname: string): boolean {
	if (hostname.startsWith("[") || /^[\d.]+$/.test(hostname)) return false;
	if (!hostname.includes(".")) return false;
	return !/\.(local|localhost|internal|lan|home\.arpa|ts\.net)$/.test(hostname);
}

function isBase64Url(value: unknown, bytes: number): value is string {
	return typeof value === "string" && BASE64URL.test(value) && Buffer.from(value, "base64url").length === bytes;
}

export function parsePushUnsubscribe(body: Record<string, unknown>): { endpoint: string } {
	const { endpoint } = body;
	if (typeof endpoint !== "string" || endpoint === "" || endpoint.length > MAX_ENDPOINT_CHARS) {
		throw invalidRequest("'endpoint' must be the URL of the subscription to remove.");
	}
	return { endpoint };
}

export function parseDecision(body: Record<string, unknown>): ApprovalDecision {
	const { decision } = body;
	if (decision !== "approve" && decision !== "deny") {
		throw invalidRequest("'decision' must be 'approve' or 'deny'.");
	}
	return decision;
}
