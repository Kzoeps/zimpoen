import type { AppDb } from "@assistant/db";
import { ATTENTION_CATEGORIES, type TriageResult } from "@assistant/shared";
import { addDays, atLocalTime, localDate } from "../time.ts";
import { forEachLimited } from "./pool.ts";
import * as store from "./store.ts";
import { addressList, clip, parseAddress, safeLine, safeText } from "./text.ts";
import { classifyMail } from "./triage/index.ts";
import {
	type GoogleGateway,
	type HistoryChange,
	HistoryExpiredError,
	type SyncSettings,
	TokenRevokedError,
	type Triage,
	type TriageInput,
} from "./types.ts";

/** What the store keeps of a mail's text, in characters. `read_mail` hands it out in smaller pieces. */
export const MAX_BODY_CHARS = 8000;
const MAX_SUBJECT_CHARS = 300;
const MAX_SNIPPET_CHARS = 300;
/** What a classifier is shown of the text. */
const TRIAGE_TEXT_CHARS = 2000;
const DAY_MS = 24 * 60 * 60_000;

export type SyncDeps = {
	db: AppDb;
	gateway: GoogleGateway;
	triage: Triage;
	settings: SyncSettings;
	/** The Harness clock. */
	now: () => number;
	timezone: string;
	/** Told when a classification fell back to the rules, and when Jev answered again. */
	onTriageError?: (error: unknown | undefined) => void;
};

/** What one sync of one account did. */
export type SyncRun = {
	/** New mails kept. */
	stored: number;
	/** Mails hidden because Gmail deleted them (or they are gone from the mailbox). */
	removed: number;
	/** Mails whose labels changed. */
	relabeled: number;
	/** Mails classified. */
	triaged: number;
	/** Mails Gmail would not hand over this time: they are asked for again at the next sync. */
	unread: number;
	/** Mails given up on after {@link SyncSettings.maxReadAttempts} syncs failed on them: left out, and shown in Settings. */
	skipped: number;
	/** The mailbox was read from scratch: the first sync, or Gmail had dropped the history. */
	fullRead: boolean;
	/** The history Gmail still has, to start the next sync from. Absent while more is waiting. */
	historyId?: string;
	/** More new mail is waiting than one run takes: come back soon. */
	more: boolean;
	calendar?: { kept: number; removed: number };
	/** The sync worked, and something did not: the calendar failed, or a message could not be read. Said beside the account. */
	warning?: string;
};

/** A message that belongs in the mailbox the owner reads: not a draft, a chat, or mail the owner only sent. */
export function isMailboxMessage(labels: readonly string[]): boolean {
	if (labels.includes("DRAFT") || labels.includes("CHAT")) return false;
	return !(labels.includes("SENT") && !labels.includes("INBOX"));
}

/** What a classifier is shown of a stored mail. */
export function triageInputOf(row: store.MessageRow): TriageInput {
	return {
		account: row.account,
		fromName: row.fromName,
		fromAddress: row.fromAddr,
		to: row.toAddrs,
		subject: row.subject,
		snippet: row.snippet,
		text: clip(row.text, TRIAGE_TEXT_CHARS),
		labels: row.labels,
		bulk: row.bulk,
		date: row.date,
	};
}

/**
 * Bring one account up to date: the mail (the first time, or after Gmail dropped its history: the last
 * `initialDays` days, newest first; otherwise what the history says changed), the triage of what is new, and the calendar.
 * Idempotent: a mail already kept is skipped, so a sync that was cut off (a crash, a closing server) simply runs again. Throws when
 * the mailbox cannot be listed (the network, a refused token: {@link TokenRevokedError}); a message that cannot be read (it is
 * counted and asked for again, then left out) and a calendar that cannot be read are a `warning` of a sync that otherwise worked.
 */
export async function syncAccount(deps: SyncDeps, account: string, signal?: AbortSignal): Promise<SyncRun> {
	const row = store.getAccount(deps.db, account);
	if (row === undefined) throw new Error(`There is no account ${account} to sync. This should be impossible.`);

	store.pruneReadFailures(deps.db, deps.now() - deps.settings.initialDays * DAY_MS);
	let run: SyncRun;
	if (row.historyId === undefined) {
		run = await readMailbox(deps, account, signal);
	} else {
		try {
			run = await readChanges(deps, account, row.historyId, signal);
		} catch (error) {
			if (!(error instanceof HistoryExpiredError)) throw error;
			run = await readMailbox(deps, account, signal);
		}
	}
	run.triaged = await triagePending(deps, signal);

	try {
		run.calendar = await syncCalendar(deps, account, signal);
	} catch (error) {
		if (signal?.aborted === true || error instanceof TokenRevokedError) throw error;
		const calendar = `Calendar: ${clip(errorText(error), 200)}`;
		run.warning = run.warning === undefined ? calendar : `${run.warning} ${calendar}`;
	}
	return run;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What reading a batch of messages came to. */
type Fetched = {
	stored: number;
	/** Failed this time and asked for again at the next sync. */
	unread: number;
	/** Failed too often: left out from now on. */
	skipped: number;
	lastError?: string;
};

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The warning of a sync that could not read every message it wanted, or nothing when it could. */
function readWarning(fetched: Fetched, maxAttempts: number): { warning?: string } {
	if (fetched.unread === 0 && fetched.skipped === 0) return {};
	const parts: string[] = [];
	if (fetched.unread > 0)
		parts.push(`${plural(fetched.unread, "mail", "mails")} could not be read yet and will be tried again.`);
	if (fetched.skipped > 0) {
		parts.push(
			`${plural(fetched.skipped, "mail", "mails")} could not be read after ${maxAttempts} tries and will be left out.`,
		);
	}
	return { warning: `${parts.join(" ")} (${clip(fetched.lastError ?? "unknown error", 200)})` };
}

/**
 * Read these messages from Gmail and keep the ones that belong in the mailbox. A message that cannot be read does not stop
 * the others: it is counted (`inbox_read_failure`), asked for again at the next sync, and given up on after
 * `maxReadAttempts` failed syncs, so one message that fails every time (a mail too large to read, an answer this program
 * cannot store) never holds back the mail behind it. Only a closing server and a refused sign-in end the whole run.
 */
async function fetchAndStore(
	deps: SyncDeps,
	account: string,
	ids: readonly string[],
	signal: AbortSignal | undefined,
): Promise<Fetched> {
	const fetched: Fetched = { stored: 0, unread: 0, skipped: 0 };
	await forEachLimited(
		ids,
		deps.settings.fetchConcurrency,
		async (id) => {
			try {
				if (await readOne(deps, account, id, signal)) fetched.stored += 1;
				store.clearReadFailure(deps.db, account, id);
			} catch (error) {
				if (signal?.aborted === true || error instanceof TokenRevokedError) throw error;
				const failure = store.recordReadFailure(deps.db, {
					account,
					gmailId: id,
					error: clip(errorText(error), 300),
					now: deps.now(),
					giveUpAfter: deps.settings.maxReadAttempts,
				});
				fetched.lastError = failure.lastError;
				if (failure.skippedAt === undefined) fetched.unread += 1;
				else fetched.skipped += 1;
			}
		},
		signal,
	);
	return fetched;
}

/** One message from Gmail into the store. True when it is new. A message that is gone, or not part of the mailbox, is nothing to keep. */
async function readOne(deps: SyncDeps, account: string, id: string, signal: AbortSignal | undefined): Promise<boolean> {
	const message = await deps.gateway.gmail.getMessage(account, id, { signal });
	if (message === undefined || !isMailboxMessage(message.labelIds)) return false;
	const from = parseAddress(message.from);
	return store.saveMessage(
		deps.db,
		{
			account,
			gmailId: message.id,
			threadId: message.threadId,
			fromName: from.name,
			fromAddr: from.address,
			toAddrs: addressList(message.to),
			subject: safeLine(message.subject, MAX_SUBJECT_CHARS),
			date: message.internalDate,
			labels: message.labelIds,
			bulk: message.bulk,
			snippet: safeLine(message.snippet, MAX_SNIPPET_CHARS),
			text: safeText(message.text, MAX_BODY_CHARS),
		},
		deps.now(),
	).inserted;
}

/** The first sync, and the one after Gmail dropped the history: read the recent mailbox, newest first, up to the cap. */
async function readMailbox(deps: SyncDeps, account: string, signal: AbortSignal | undefined): Promise<SyncRun> {
	const { gmail } = deps.gateway;
	const { settings } = deps;
	// The cursor is taken before the listing: what arrives while it is read is then in the history of the next sync.
	const profile = await gmail.profile(account, { signal });
	const query = `newer_than:${settings.initialDays}d -in:sent -in:drafts -in:chats`;
	const listed: string[] = [];
	let pageToken: string | undefined;
	do {
		const page = await gmail.listMessageIds(account, { q: query, pageToken }, { signal });
		listed.push(...page.ids);
		pageToken = page.nextPageToken;
	} while (pageToken !== undefined && listed.length <= settings.maxInitialMessages);
	const truncated = listed.length > settings.maxInitialMessages || pageToken !== undefined;
	const ids = listed.slice(0, settings.maxInitialMessages);

	const known = new Set(ids.filter((id) => store.hasMessage(deps.db, account, id)));
	store.unhide(deps.db, account, [...known]);
	const skipped = store.skippedAmong(deps.db, account, ids);
	const missing = ids.filter((id) => !known.has(id) && !skipped.has(id));
	const fetched = await fetchAndStore(deps, account, missing, signal);

	// What the listing no longer has is gone from the mailbox. A listing that was cut short says nothing about the rest.
	// The margin keeps a mail that sits right at the edge of "newer than N days" from being taken for a deleted one.
	const removed = truncated
		? 0
		: store.hideUnlisted(deps.db, account, new Set(ids), deps.now() - (settings.initialDays - 1) * DAY_MS, deps.now());
	return {
		stored: fetched.stored,
		removed,
		relabeled: 0,
		triaged: 0,
		unread: fetched.unread,
		skipped: fetched.skipped,
		fullRead: true,
		historyId: profile.historyId,
		more: false,
		...readWarning(fetched, settings.maxReadAttempts),
	};
}

/** Every later sync: what the history says changed since the last one. */
async function readChanges(
	deps: SyncDeps,
	account: string,
	startHistoryId: string,
	signal: AbortSignal | undefined,
): Promise<SyncRun> {
	const { gmail } = deps.gateway;
	const added = new Map<string, true>();
	const deleted = new Set<string>();
	const labelChanges: Array<Extract<HistoryChange, { type: "labels" }>> = [];
	let latest = startHistoryId;
	let pageToken: string | undefined;
	do {
		const page = await gmail.listHistory(account, startHistoryId, pageToken, { signal });
		for (const change of page.changes) {
			if (change.type === "added") {
				if (isMailboxMessage(change.labelIds)) added.set(change.id, true);
			} else if (change.type === "deleted") {
				deleted.add(change.id);
				added.delete(change.id);
			} else {
				labelChanges.push(change);
			}
		}
		latest = page.historyId;
		pageToken = page.nextPageToken;
	} while (pageToken !== undefined);

	let removed = 0;
	for (const id of deleted) if (store.markDeleted(deps.db, account, id, deps.now())) removed += 1;
	let relabeled = 0;
	for (const change of labelChanges) {
		if (deleted.has(change.id)) continue;
		if (store.applyLabelChange(deps.db, account, change.id, change)) relabeled += 1;
	}

	const wanted = wantedMessages(deps, account, [...added.keys()]);
	const more = wanted.length > deps.settings.maxMessagesPerRun;
	const fetched = await fetchAndStore(deps, account, wanted.slice(0, deps.settings.maxMessagesPerRun), signal);
	// Only a sync that took everything moves the cursor; one that left some behind starts from the same place next time
	// (the mails it kept are skipped, so the next run goes on with the rest). A message that could not be read does not hold
	// the cursor back: it is in `inbox_read_failure`, and the next sync asks for it from there.
	return {
		stored: fetched.stored,
		removed,
		relabeled,
		triaged: 0,
		unread: fetched.unread,
		skipped: fetched.skipped,
		fullRead: false,
		more,
		...(more ? {} : { historyId: latest }),
		...readWarning(fetched, deps.settings.maxReadAttempts),
	};
}

/** The new mail to read: what the history added that is not kept yet, then the messages an earlier sync failed on. Given-up ones are never asked for. */
function wantedMessages(deps: SyncDeps, account: string, added: readonly string[]): string[] {
	const fresh = added.filter((id) => !store.hasMessage(deps.db, account, id));
	const skipped = store.skippedAmong(deps.db, account, fresh);
	const wanted = new Set(fresh.filter((id) => !skipped.has(id)));
	for (const id of store.retryableReads(deps.db, account)) if (!store.hasMessage(deps.db, account, id)) wanted.add(id);
	return [...wanted];
}

/** Classify what is new (newest first, so a backlog never delays the mail that just came), then look again at what the rules stood in for. */
async function triagePending(deps: SyncDeps, signal: AbortSignal | undefined): Promise<number> {
	const { db, settings } = deps;
	const learned = store.listRules(db);
	const startedAt = deps.now();
	let triaged = 0;
	let answered = false;
	let failure: unknown;

	const classify = async (row: store.MessageRow, again: boolean): Promise<void> => {
		const before = row.triage;
		// A slow Jev is not allowed to stretch the sync: once the time it is given is spent, the rest is sorted by the rules.
		const spent = deps.now() - startedAt >= settings.maxTriageMs;
		const result: TriageResult = await classifyMail(deps.triage, learned, triageInputOf(row), {
			signal,
			rulesOnly: spent,
			onFallback: ({ error }) => {
				failure = error;
			},
		});
		if (again && result.provisional === true) return; // Jev is still unreachable: leave it for the next sync
		if (result.source === "jev") answered = true;
		// A mail that was in a digest already (the rules judged it worth attention) is not news a second time when Jev agrees.
		const wasNews = before !== undefined && ATTENTION_CATEGORIES.includes(before.category);
		const isNews = ATTENTION_CATEGORIES.includes(result.category);
		// The clock is read right before the write, with nothing in between: a digest selects mail by this instant.
		const at = again && wasNews && isNews && row.triagedAt !== undefined ? row.triagedAt : deps.now();
		store.setTriage(db, row.id, result, at);
		triaged += 1;
	};

	await forEachLimited(
		store.toTriage(db, settings.maxTriagePerRun),
		settings.triageConcurrency,
		(row) => classify(row, false),
		signal,
	);
	// Jev just failed for the mail above: asking it again for the same mail in the same run only doubles the wait.
	if (deps.triage.mode === "jev" && failure === undefined) {
		const remaining = Math.max(0, settings.maxTriagePerRun - triaged);
		await forEachLimited(
			store.provisionalMessages(db, remaining),
			settings.triageConcurrency,
			(row) => classify(row, true),
			signal,
		);
	}
	if (failure !== undefined) deps.onTriageError?.(failure);
	else if (answered) deps.onTriageError?.(undefined);
	return triaged;
}

/** The account's events from the start of yesterday to `calendarDays` ahead. */
async function syncCalendar(
	deps: SyncDeps,
	account: string,
	signal: AbortSignal | undefined,
): Promise<{ kept: number; removed: number }> {
	const today = localDate(deps.now(), deps.timezone);
	const from = atLocalTime(addDays(today, -1), "00:00", deps.timezone);
	const to = atLocalTime(addDays(today, deps.settings.calendarDays + 1), "00:00", deps.timezone);
	const events = await deps.gateway.calendar.listEvents(account, { from, to }, { signal });
	return store.replaceEvents(
		deps.db,
		account,
		{ from, to },
		events.map((event) => ({
			account,
			eventId: event.id,
			title: safeLine(event.title, 200) || "(no title)",
			startAt: event.start,
			endAt: event.end,
			allDay: event.allDay,
			attendees: event.attendees.slice(0, 20).map((address) => safeLine(address.toLowerCase(), 200)),
			location: safeLine(event.location, 200),
			updated: event.updated,
		})),
	);
}
