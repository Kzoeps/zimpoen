import { TIME_OF_DAY } from "@assistant/extensions";
import {
	type ApprovalDecision,
	DEFAULT_ACTIVITY_PAGE,
	DEFAULT_HISTORY_PAGE,
	type DisconnectGoogleRequest,
	isAgentId,
	isMemoryKind,
	isMemoryScope,
	isThinkingLevel,
	MAX_ACTIVITY_PAGE,
	MAX_HISTORY_PAGE,
	MAX_MEMORY_CHARS,
	MAX_MEMORY_LIST,
	MAX_MESSAGE_CHARS,
	MAX_WEEKLY_TOKENS,
	type MemoryKind,
	type MemoryScope,
	type ModelSelection,
	PROFILE_SLOTS,
	type PushSubscribeRequest,
	REQUEST_ID_PATTERN,
	type SendMessageRequest,
	type SuggestionDecision,
	THINKING_LEVELS,
	type UpdateAgentSettingsRequest,
	type UpdateBudgetRequest,
	type UpdateMemoryRequest,
	type UpdatePreferencesRequest,
	type UpdateScheduleRequest,
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
 * A multipart upload cannot satisfy this rule, so `POST /api/uploads` is an explicit, single exception: it is registered
 * before this middleware, and carries rules of its own (`uploads.ts`, `docs/design-notes.md`). Do not widen the rule.
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

/** `POST /api/suggestions/:id`: add the suggested follow-up (the PA is asked to), or dismiss it. */
export function parseSuggestionDecision(body: Record<string, unknown>): SuggestionDecision {
	const { decision } = body;
	if (decision !== "add" && decision !== "dismiss") throw invalidRequest("'decision' must be 'add' or 'dismiss'.");
	return decision;
}

/** `DELETE /api/settings/google/accounts`: the address of the account to disconnect, in the body (an address is not a safe thing to put in a path). */
export function parseDisconnectGoogle(body: Record<string, unknown>): DisconnectGoogleRequest {
	const { email } = body;
	if (typeof email !== "string" || email.length === 0 || email.length > 200 || !email.includes("@")) {
		throw invalidRequest("'email' must be the address of a connected account.");
	}
	return { email: email.trim().toLowerCase() };
}

/** `PUT /api/settings/schedule/:job`: a time of day, whether the job runs, or both. */
export function parseUpdateSchedule(body: Record<string, unknown>): UpdateScheduleRequest {
	const { localTime, enabled } = body;
	if (localTime !== undefined && (typeof localTime !== "string" || !TIME_OF_DAY.test(localTime))) {
		throw invalidRequest("'localTime' must be a 24-hour time written HH:MM, for example 07:30.");
	}
	if (enabled !== undefined && typeof enabled !== "boolean") throw invalidRequest("'enabled' must be true or false.");
	if (localTime === undefined && enabled === undefined) throw invalidRequest("Send 'localTime', 'enabled' or both.");
	return {
		...(localTime === undefined ? {} : { localTime }),
		...(enabled === undefined ? {} : { enabled }),
	};
}

/** A real calendar day written `YYYY-MM-DD`, or a 400 that names the parameter. */
function parseDay(raw: string, name: string): string {
	// `Date` is NaN for a month 13 or a day 32 (and `toISOString` throws on it), and rolls 30 February over into March.
	const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : undefined;
	const valid =
		date !== undefined &&
		!Number.isNaN(date.getTime()) &&
		date.toISOString().slice(0, 10) === raw &&
		raw >= "2000-01-01";
	if (!valid)
		throw invalidRequest(
			`'${name}' must be a day written YYYY-MM-DD, for example 2026-10-26, got '${raw.slice(0, 20)}'.`,
		);
	return raw;
}

/** An optional whole number from 1 to `max`, or `fallback`. */
function parseLimit(raw: string | undefined, max: number, fallback: number): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!/^\d+$/.test(raw) || value < 1 || value > max)
		throw invalidRequest(`'limit' must be a whole number from 1 to ${max}.`);
	return value;
}

export type ActivityRequest = { agent?: string; from?: string; to?: string; cursor?: string; limit: number };

/** `GET /api/activity?agent=&from=&to=&cursor=&limit=`. An agent that is not one is a 400, not an empty list. */
export function parseActivityQuery(c: Context): ActivityRequest {
	const agent = c.req.query("agent");
	if (agent !== undefined && agent !== "all" && !isAgentId(agent)) {
		throw invalidRequest(`'agent' must be one of pa, inbox, health, accountant or all, got '${agent.slice(0, 20)}'.`);
	}
	const from = c.req.query("from");
	const to = c.req.query("to");
	const cursor = c.req.query("cursor");
	if (cursor !== undefined && cursor.length > 400) throw invalidRequest("'cursor' is not one this server gave out.");
	const first = from === undefined ? undefined : parseDay(from, "from");
	const last = to === undefined ? undefined : parseDay(to, "to");
	if (first !== undefined && last !== undefined && first > last) throw invalidRequest("'from' is after 'to'.");
	return {
		...(agent === undefined || agent === "all" ? {} : { agent }),
		...(first === undefined ? {} : { from: first }),
		...(last === undefined ? {} : { to: last }),
		...(cursor === undefined || cursor === "" ? {} : { cursor }),
		limit: parseLimit(c.req.query("limit"), MAX_ACTIVITY_PAGE, DEFAULT_ACTIVITY_PAGE),
	};
}

export type MemoryRequest = { scope?: MemoryScope; kind?: MemoryKind; q?: string; limit: number };

/** `GET /api/memory?scope=&kind=&q=&limit=`. */
export function parseMemoryQuery(c: Context): MemoryRequest {
	const scope = c.req.query("scope");
	const kind = c.req.query("kind");
	const q = c.req.query("q")?.trim();
	if (scope !== undefined && scope !== "all" && !isMemoryScope(scope)) {
		throw invalidRequest(`'scope' must be shared, pa, inbox, health, accountant or all, got '${scope.slice(0, 20)}'.`);
	}
	if (kind !== undefined && kind !== "all" && !isMemoryKind(kind)) {
		throw invalidRequest(`'kind' must be preference, fact or all, got '${kind.slice(0, 20)}'.`);
	}
	if (q !== undefined && q.length > 200) throw invalidRequest("'q' is at most 200 characters.");
	return {
		...(scope === undefined || scope === "all" ? {} : { scope: scope as MemoryScope }),
		...(kind === undefined || kind === "all" ? {} : { kind: kind as MemoryKind }),
		...(q === undefined || q === "" ? {} : { q }),
		limit: parseLimit(c.req.query("limit"), MAX_MEMORY_LIST, 100),
	};
}

/** `PATCH /api/memory/:id`: a new text, a pin, a new scope (the line moves to another agent's memory, or to every agent's), or any of them. A line's kind does not change. */
export function parseUpdateMemory(body: Record<string, unknown>): UpdateMemoryRequest {
	const { text, pinned, scope } = body;
	if (text !== undefined && (typeof text !== "string" || text.trim() === "" || text.length > MAX_MEMORY_CHARS * 20)) {
		throw invalidRequest(`'text' must be a non-empty line of at most ${MAX_MEMORY_CHARS} characters.`);
	}
	if (pinned !== undefined && typeof pinned !== "boolean") throw invalidRequest("'pinned' must be true or false.");
	if (scope !== undefined && !isMemoryScope(scope)) {
		throw invalidRequest(
			`'scope' must be shared, pa, inbox, health or accountant, got '${String(scope).slice(0, 20)}'.`,
		);
	}
	if (text === undefined && pinned === undefined && scope === undefined)
		throw invalidRequest("Send 'text', 'pinned', 'scope' or any of them.");
	return {
		...(text === undefined ? {} : { text }),
		...(pinned === undefined ? {} : { pinned }),
		...(scope === undefined ? {} : { scope }),
	};
}

/** `PUT /api/profile/preferences`: `tone` and `explanations`; a string sets it, null (or empty text) clears it. */
export function parseUpdatePreferences(body: Record<string, unknown>): UpdatePreferencesRequest {
	const change: UpdatePreferencesRequest = {};
	for (const slot of PROFILE_SLOTS) {
		const value = body[slot];
		if (value === undefined) continue;
		if (value !== null && (typeof value !== "string" || value.length > MAX_MEMORY_CHARS * 20)) {
			throw invalidRequest(`'${slot}' must be text of at most ${MAX_MEMORY_CHARS} characters, or null to clear it.`);
		}
		change[slot] = value;
	}
	const unknown = Object.keys(body).filter((key) => !(PROFILE_SLOTS as readonly string[]).includes(key));
	if (unknown.length > 0)
		throw invalidRequest(
			`Unknown field '${unknown[0]?.slice(0, 30)}'. The preferences are ${PROFILE_SLOTS.join(" and ")}.`,
		);
	if (Object.keys(change).length === 0) throw invalidRequest(`Send ${PROFILE_SLOTS.join(", ")} or both.`);
	return change;
}

/** `PUT /api/settings/budget/:agent`: a whole number of tokens a week, or null to remove the limit. */
export function parseUpdateBudget(body: Record<string, unknown>): UpdateBudgetRequest {
	const { weeklyTokens } = body;
	if (weeklyTokens === null) return { weeklyTokens: null };
	if (
		typeof weeklyTokens !== "number" ||
		!Number.isSafeInteger(weeklyTokens) ||
		weeklyTokens < 1 ||
		weeklyTokens > MAX_WEEKLY_TOKENS
	) {
		throw invalidRequest(
			`'weeklyTokens' must be a whole number of tokens from 1 to ${MAX_WEEKLY_TOKENS}, or null for no limit.`,
		);
	}
	return { weeklyTokens };
}
