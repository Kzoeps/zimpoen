import type { AppDb } from "@assistant/db";
import { getAgentRow } from "@assistant/db";
import { addDays, atLocalTime, clip, formatLocal, safeLine } from "@assistant/extensions";
import {
	type ActivityItem,
	type ActivityResponse,
	type AgentId,
	DAILY_ENTRY_KIND,
	type DailyEntryData,
	isAgentId,
	REMINDER_ENTRY_KIND,
} from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable";

/**
 * The activity log (M8): what the agents did, worked out from the threads when asked. Nothing is written for it, so it
 * cannot disagree with the conversation, and it needs no migration.
 *
 * An item is a tool an agent called (the result entry says which, what it answered and when) or a card a timer posted
 * for an agent (a reminder, the briefing). Each agent's thread is read newest first, in pages, and the four are merged by
 * time. A page's cursor holds where each thread was left, so the next page begins exactly after the last item shown.
 */

/** Tools whose calls say nothing about what was done: looking up the time, loading a tool. */
const QUIET_TOOLS: ReadonlySet<string> = new Set(["current_time", "tool_search"]);

const SUMMARY_CHARS = 160;
const PAGE_ENTRIES = 100;
/** The most entries read from one thread for one request: a very long thread says it was cut short instead of holding the server. */
export const MAX_SCANNED_ENTRIES = 5000;

export type ActivityAgent = { id: AgentId; name: string; avatar: string };

export type ActivityQuery = {
	/** One agent, or all of them. */
	agent?: AgentId;
	/** The first and last local day to show, `2026-10-26`, both inclusive. */
	from?: string;
	to?: string;
	/** From the previous page's `next`. */
	cursor?: string;
	limit: number;
};

export type ActivityReader = { read(query: ActivityQuery): Promise<ActivityResponse> };

type Derived = Omit<ActivityItem, "atText">;

const textOf = (content: readonly { type: string; text?: string }[]): string =>
	content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");

/**
 * The first line that says something, as the one line the list shows. A line that only introduces a list ("2 lines
 * match:") says nothing alone, so the line under it comes with it. Durable wraps what went wrong in a call in
 * `<harness>` tags with `[error]` in front of the reason: for a failed call it is the reason that says something.
 */
function summaryOf(text: string, failed: boolean): string {
	const lines = text
		.split("\n")
		.map((line) => (failed ? line.replace(/^\s*\[error\]\s*/, "") : line))
		.filter((line) => line.trim() !== "" && line.trim() !== "<harness>" && line.trim() !== "</harness>");
	const first = lines[0] ?? "";
	if (first === "") return "(no text)";
	const next = lines[1];
	return safeLine(first.trimEnd().endsWith(":") && next !== undefined ? `${first} ${next}` : first, SUMMARY_CHARS);
}

const FOLLOWUP_STAGE = { nudge: "Due now", ask: "Asked how it went", reask: "Asked again how it went" } as const;

/** What a card of the timers is, as an activity item; undefined for a card that records nothing the agent did. */
function systemItem(entry: EntryRecord): { name: string; summary: string; at: number } | undefined {
	const data = entry.data as Record<string, unknown> | undefined;
	const firedAt = data?.firedAt;
	if (typeof firedAt !== "number") return undefined;
	const str = (key: string): string => (typeof data?.[key] === "string" ? (data[key] as string) : "");
	switch (entry.kind) {
		case REMINDER_ENTRY_KIND:
			return { name: "reminder", summary: `Reminder: ${clip(str("title"), 120)}`, at: firedAt };
		case "app.agenda":
			return { name: "agenda", summary: `Agenda posted: ${clip(str("title"), 120)}`, at: firedAt };
		case "app.followup": {
			const stage = FOLLOWUP_STAGE[str("stage") as keyof typeof FOLLOWUP_STAGE] ?? "Follow-up";
			return { name: "follow-up", summary: `${stage}: ${clip(str("title"), 120)}`, at: firedAt };
		}
		case "app.birthday":
			return {
				name: "birthday",
				summary: `${str("stage") === "remind" ? "Reminder to wish" : "Asked whether you wished"} ${clip(str("name"), 80)}`,
				at: firedAt,
			};
		case DAILY_ENTRY_KIND: {
			const daily = data as unknown as Partial<DailyEntryData>;
			const label = JOB_LABEL[String(daily.job)] ?? "Daily job";
			const how =
				daily.degraded !== undefined
					? " (plain card: the weekly token limit was reached)"
					: daily.empty === true
						? " (nothing to report)"
						: "";
			return { name: String(daily.job ?? "daily"), summary: `${label} for ${str("dateText")}${how}`, at: firedAt };
		}
		default:
			return undefined;
	}
}

const JOB_LABEL: Record<string, string> = {
	briefing: "Morning briefing",
	wrapup: "Evening wrap-up",
	digest_midday: "Inbox digest",
	digest_evening: "Inbox digest",
};

/** The activity item an entry stands for, or undefined when it is not one (a chat message, a system prompt, a notice). */
export function itemOf(entry: EntryRecord, agent: AgentId, conversationId: number): Derived | undefined {
	const message = entry.model?.[0];
	if (message?.role === "toolResult") {
		if (QUIET_TOOLS.has(message.toolName)) return undefined;
		return {
			id: `${agent}:${entry.id}`,
			agent,
			at: message.timestamp,
			source: "tool",
			name: message.toolName,
			summary: summaryOf(textOf(message.content), message.isError === true),
			...(message.isError ? { failed: true as const } : {}),
			conversationId,
			entryId: Number(entry.id),
		};
	}
	const system = entry.kind.startsWith("app.") ? systemItem(entry) : undefined;
	if (system === undefined) return undefined;
	return {
		id: `${agent}:${entry.id}`,
		agent,
		at: system.at,
		source: "system",
		name: system.name,
		summary: safeLine(system.summary, SUMMARY_CHARS),
		conversationId,
		entryId: Number(entry.id),
	};
}

/** Where each thread was left: the oldest entry of it already shown. Decoded defensively: a cursor is only as good as the client's memory. */
function decodeCursor(raw: string | undefined): Partial<Record<AgentId, number>> | undefined {
	if (raw === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const positions: Partial<Record<AgentId, number>> = {};
		for (const [agent, position] of Object.entries(parsed)) {
			if (isAgentId(agent) && Number.isSafeInteger(position) && (position as number) > 0)
				positions[agent] = position as number;
		}
		return positions;
	} catch {
		return undefined;
	}
}

const encodeCursor = (positions: Partial<Record<AgentId, number>>): string =>
	Buffer.from(JSON.stringify(positions), "utf8").toString("base64url");

type Stream = {
	agent: AgentId;
	next(): Promise<Derived | undefined>;
	/** The thread was read to its start or to the first day that is out of range. */
	readonly finished: boolean;
	/** The scan cap was reached before that. */
	readonly capped: boolean;
};

export function createActivityReader(deps: {
	harness: Harness;
	db: AppDb;
	agents: readonly ActivityAgent[];
	timezone: string;
}): ActivityReader {
	const { harness, db, timezone } = deps;

	/** One thread, newest first, within the day range, as a pull-based stream. */
	async function openStream(
		agent: AgentId,
		below: number | undefined,
		range: { fromMs: number | undefined; toMs: number | undefined },
	): Promise<Stream | undefined> {
		const row = getAgentRow(db, agent);
		if (row === undefined) return undefined;
		const conversation = await harness.conversation(row.conversationId as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) return undefined;

		let buffer: EntryRecord[] = [];
		let maxEntryId: number | undefined = below === undefined ? undefined : below - 1;
		let exhausted = false;
		let scanned = 0;
		const stream = { finished: false, capped: false };

		async function refill(): Promise<void> {
			if (exhausted) return;
			if (scanned >= MAX_SCANNED_ENTRIES) {
				exhausted = true;
				stream.capped = true;
				return;
			}
			const page = await conversation?.entries(
				{ order: "descending", ...(maxEntryId === undefined ? {} : { maxEntryId: maxEntryId as EntryId }) },
				PAGE_ENTRIES,
				undefined,
				BACKGROUND_CONTEXT,
			);
			buffer = [...(page?.items ?? [])];
			scanned += buffer.length;
			const oldest = buffer.at(-1);
			if (oldest === undefined || page?.next === undefined) exhausted = true;
			else maxEntryId = Number(oldest.id) - 1;
		}

		return {
			agent,
			get finished() {
				return stream.finished;
			},
			get capped() {
				return stream.capped;
			},
			async next() {
				for (;;) {
					if (buffer.length === 0) {
						await refill();
						if (buffer.length === 0) {
							stream.finished = !stream.capped;
							return undefined;
						}
					}
					const entry = buffer.shift() as EntryRecord;
					const item = itemOf(entry, agent, row.conversationId);
					if (item === undefined) continue;
					if (range.toMs !== undefined && item.at > range.toMs) continue;
					if (range.fromMs !== undefined && item.at < range.fromMs) {
						// Only a tool's time is when its entry was written, so only a tool says that everything after it (older) is older
						// still. A card a timer posted again late (after a power cut) carries the time it was due and may sit among newer entries.
						if (item.source !== "tool") continue;
						buffer = [];
						exhausted = true;
						stream.finished = true;
						return undefined;
					}
					return item;
				}
			},
		};
	}

	return {
		async read(query) {
			const positions = decodeCursor(query.cursor) ?? {};
			const range = {
				fromMs: query.from === undefined ? undefined : atLocalTime(query.from, "00:00", timezone),
				toMs: query.to === undefined ? undefined : atLocalTime(addDays(query.to, 1), "00:00", timezone) - 1,
			};
			const wanted = deps.agents.filter((agent) => query.agent === undefined || agent.id === query.agent);
			const streams: Stream[] = [];
			for (const agent of wanted) {
				const stream = await openStream(agent.id, positions[agent.id], range);
				if (stream !== undefined) streams.push(stream);
			}

			// The head of each stream is the newest thing it has not yet given; the merge takes the newest head.
			const heads = new Map<Stream, Derived | undefined>();
			for (const stream of streams) heads.set(stream, await stream.next());
			const items: Derived[] = [];
			const taken: Partial<Record<AgentId, number>> = {};
			while (items.length < query.limit) {
				let best: { stream: Stream; item: Derived } | undefined;
				for (const [stream, item] of heads) {
					if (item === undefined) continue;
					if (
						best === undefined ||
						item.at > best.item.at ||
						(item.at === best.item.at &&
							(item.agent < best.item.agent || (item.agent === best.item.agent && item.entryId > best.item.entryId)))
					) {
						best = { stream, item };
					}
				}
				if (best === undefined) break;
				items.push(best.item);
				taken[best.item.agent] = best.item.entryId;
				heads.set(best.stream, await best.stream.next());
			}

			const more = [...heads.values()].some((item) => item !== undefined);
			const capped = streams.some((stream) => stream.capped);
			return {
				timezone,
				items: items.map((item) => ({ ...item, atText: formatLocal(item.at, timezone) })),
				...(more ? { next: encodeCursor({ ...positions, ...taken }) } : {}),
				...(capped ? { truncated: true as const } : {}),
			};
		},
	};
}
