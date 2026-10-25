import type { GmailClient, HistoryChange } from "@assistant/extensions";
import { HistoryExpiredError } from "@assistant/extensions";
import { createGoogleGet, type GoogleHttpOptions } from "./http.ts";
import { parseGmailMessage, type RawGmailMessage } from "./mime.ts";

export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

type HistoryRecord = {
	messagesAdded?: Array<{ message?: { id?: string; labelIds?: string[] } }>;
	messagesDeleted?: Array<{ message?: { id?: string } }>;
	labelsAdded?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
	labelsRemoved?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
};

/**
 * Gmail's read-only REST API (`gmail.readonly`): the profile, a listing, one message in full, and the history of changes. The
 * methods are `GET`s of `users/me`, so the account is the one the access token belongs to.
 */
export function createGmailClient(options: GoogleHttpOptions): GmailClient {
	const get = createGoogleGet(options);
	const url = (path: string, params: Array<[string, string | undefined]> = []): URL => {
		const built = new URL(`${GMAIL_BASE}${path}`);
		for (const [key, value] of params) if (value !== undefined) built.searchParams.append(key, value);
		return built;
	};

	return {
		async profile(account, requestOptions) {
			const body = (await get(account, url("/profile"), requestOptions)) as {
				emailAddress?: string;
				historyId?: string;
			};
			if (typeof body.historyId !== "string") throw new Error("Gmail's profile has no history id.");
			return { emailAddress: body.emailAddress ?? account, historyId: body.historyId };
		},

		async listMessageIds(account, query, requestOptions) {
			const body = (await get(
				account,
				url("/messages", [
					["q", query.q],
					["maxResults", "100"],
					["pageToken", query.pageToken],
				]),
				requestOptions,
			)) as { messages?: Array<{ id?: string }>; nextPageToken?: string };
			return {
				ids: (body.messages ?? []).flatMap((message) => (typeof message.id === "string" ? [message.id] : [])),
				...(body.nextPageToken === undefined ? {} : { nextPageToken: body.nextPageToken }),
			};
		},

		async getMessage(account, id, requestOptions) {
			let missing = false;
			const body = await get(
				account,
				url(`/messages/${encodeURIComponent(id)}`, [["format", "full"]]),
				requestOptions,
				(status) => {
					if (status === 404) missing = true;
				},
			).catch((error: unknown) => {
				if (missing) return undefined;
				throw error;
			});
			return body === undefined ? undefined : parseGmailMessage(body as RawGmailMessage);
		},

		async listHistory(account, startHistoryId, pageToken, requestOptions) {
			let expired = false;
			const params: Array<[string, string | undefined]> = [
				["startHistoryId", startHistoryId],
				["historyTypes", "messageAdded"],
				["historyTypes", "messageDeleted"],
				["historyTypes", "labelAdded"],
				["historyTypes", "labelRemoved"],
				["maxResults", "500"],
				["pageToken", pageToken],
			];
			const body = (await get(account, url("/history", params), requestOptions, (status) => {
				if (status === 404) expired = true;
			}).catch((error: unknown) => {
				if (expired) throw new HistoryExpiredError(account);
				throw error;
			})) as { history?: HistoryRecord[]; historyId?: string; nextPageToken?: string };
			const changes: HistoryChange[] = [];
			for (const record of body.history ?? []) {
				for (const item of record.messagesAdded ?? []) {
					if (typeof item.message?.id === "string")
						changes.push({ type: "added", id: item.message.id, labelIds: item.message.labelIds ?? [] });
				}
				for (const item of record.messagesDeleted ?? []) {
					if (typeof item.message?.id === "string") changes.push({ type: "deleted", id: item.message.id });
				}
				changes.push(...labelChanges(record));
			}
			return {
				changes,
				historyId: body.historyId ?? startHistoryId,
				...(body.nextPageToken === undefined ? {} : { nextPageToken: body.nextPageToken }),
			};
		},
	};
}

/** Label additions and removals of one history record, one change per message. */
function labelChanges(record: HistoryRecord): HistoryChange[] {
	const byMessage = new Map<string, { added: string[]; removed: string[] }>();
	const entry = (id: string) => {
		let found = byMessage.get(id);
		if (found === undefined) {
			found = { added: [], removed: [] };
			byMessage.set(id, found);
		}
		return found;
	};
	for (const item of record.labelsAdded ?? [])
		if (typeof item.message?.id === "string") entry(item.message.id).added.push(...(item.labelIds ?? []));
	for (const item of record.labelsRemoved ?? [])
		if (typeof item.message?.id === "string") entry(item.message.id).removed.push(...(item.labelIds ?? []));
	return [...byMessage.entries()].map(([id, change]) => ({ type: "labels" as const, id, ...change }));
}
