import type { GoogleMode, TriageMode, TriageResult } from "@assistant/shared";

/**
 * The boundary between the Inbox module and Google (PLAN §5.2 M5). The module knows these interfaces and nothing about
 * HTTP: the server wires the real clients (`apps/server/src/google/`, plain `fetch` against Google's REST endpoints) in
 * production and the scripted ones (`./fake.ts`) in development and in tests. Every method only reads (PLAN rule 1): there
 * is no method that sends, replies, labels, archives or deletes, so there is nothing for a tool to call.
 */

export type RequestOptions = {
	/** Aborts the request: the server is closing, or the sync was cancelled. */
	signal?: AbortSignal | undefined;
	/** For an access token: ignore the one kept and ask Google for a new one (the old one was refused). */
	refresh?: boolean | undefined;
};

/** What the module keeps of a Gmail message, after the client decoded it. Header values are plain text (encoded words resolved). */
export type GmailMessage = {
	id: string;
	threadId: string;
	labelIds: readonly string[];
	snippet: string;
	/** Gmail's `internalDate`: when the message arrived, epoch ms. */
	internalDate: number;
	/** The raw `From` header: `Name <address>`. */
	from: string;
	to: string;
	subject: string;
	/** The message says it is bulk mail: a `List-Unsubscribe` header, `Precedence: bulk` or `list`, `Auto-Submitted`. */
	bulk: boolean;
	/** The readable text of the body (`text/plain`, or `text/html` turned into text). The module cuts it again. */
	text: string;
};

/** What changed in the mailbox since a history id. */
export type HistoryChange =
	| { type: "added"; id: string; labelIds: readonly string[] }
	| { type: "deleted"; id: string }
	| { type: "labels"; id: string; added: readonly string[]; removed: readonly string[] };

export type HistoryPage = {
	changes: HistoryChange[];
	/** The mailbox's history id after this page: where the next sync starts once every page is read. */
	historyId: string;
	nextPageToken?: string;
};

/** Gmail no longer has the history from the id it was asked for (it keeps about a week): the mailbox has to be read again. */
export class HistoryExpiredError extends Error {
	constructor(account: string) {
		super(`Gmail no longer has the history of ${account} from where the last sync stopped; reading the mailbox again.`);
		this.name = "HistoryExpiredError";
	}
}

export interface GmailClient {
	profile(account: string, options?: RequestOptions): Promise<{ emailAddress: string; historyId: string }>;
	/** Message ids matching a Gmail search query, newest first. */
	listMessageIds(
		account: string,
		query: { q: string; pageToken?: string | undefined },
		options?: RequestOptions,
	): Promise<{ ids: string[]; nextPageToken?: string }>;
	/** One message in full, or undefined when it no longer exists (deleted between the list and the read). */
	getMessage(account: string, id: string, options?: RequestOptions): Promise<GmailMessage | undefined>;
	/** Throws {@link HistoryExpiredError} when `startHistoryId` is too old. */
	listHistory(
		account: string,
		startHistoryId: string,
		pageToken: string | undefined,
		options?: RequestOptions,
	): Promise<HistoryPage>;
}

export type CalendarEvent = {
	id: string;
	title: string;
	/** Epoch ms. An all-day event starts at the owner's local midnight of its first day and ends at midnight after its last. */
	start: number;
	end: number;
	allDay: boolean;
	/** Addresses of the other people invited. */
	attendees: string[];
	location: string;
	/** When the event last changed, epoch ms. */
	updated: number;
};

export interface CalendarClient {
	/** Events that overlap `[from, to)` on the account's primary calendar, cancelled ones left out, repeating events expanded. */
	listEvents(account: string, range: { from: number; to: number }, options?: RequestOptions): Promise<CalendarEvent[]>;
}

/** Google no longer accepts the account's refresh token (revoked, or a testing-mode token that expired). The owner reconnects. */
export class TokenRevokedError extends Error {
	readonly account: string;

	constructor(account: string) {
		super(`Google no longer accepts the saved sign-in of ${account}. Run pnpm connect:google to connect it again.`);
		this.name = "TokenRevokedError";
		this.account = account;
	}
}

export type TokenAccount = {
	email: string;
	/** `needs_reconnect` once Google refused the token; connecting again makes it `ok`. */
	status: "ok" | "needs_reconnect";
	/** When the owner approved this sign-in, epoch ms. A later one than the module has seen means they reconnected. */
	connectedAt: number;
};

export interface TokenProvider {
	/** Every account that has a saved sign-in. */
	accounts(): Promise<TokenAccount[]>;
	/** A usable access token. Throws {@link TokenRevokedError} when Google refuses the refresh token. */
	accessToken(account: string, options?: RequestOptions): Promise<string>;
	/** Forget the account's saved sign-in. Local only: nothing is revoked at Google. */
	remove(account: string): Promise<void>;
}

/** What the Inbox module reads Google through. */
export type GoogleGateway = {
	mode: GoogleMode;
	/** A client id and secret are saved (`<data>/secrets/google-oauth.json`): an account can be connected. Always true in `fake` mode. Read when asked: the owner may save the file while the server runs. */
	readonly clientConfigured: boolean;
	gmail: GmailClient;
	calendar: CalendarClient;
	tokens: TokenProvider;
};

/** What a classifier is shown of a mail. Everything is already bounded; `text` is at most a couple of thousand characters. */
export type TriageInput = {
	account: string;
	fromName: string;
	fromAddress: string;
	to: string;
	subject: string;
	snippet: string;
	text: string;
	labels: readonly string[];
	bulk: boolean;
	/** Epoch ms. */
	date: number;
};

/** A classifier of mail: Jev, or the local rules. It throws when it cannot answer; the module then uses the rules. */
export interface Triage {
	readonly mode: TriageMode;
	classify(input: TriageInput, options?: RequestOptions): Promise<TriageResult>;
	/**
	 * Until when the classifier is not asked (epoch ms), because it failed several times in a row: mail is sorted by the local
	 * rules until then. Undefined when it is asked as usual, and for a classifier that cannot fail.
	 */
	pausedUntil?(): number | undefined;
}

/** How the sync runs. The defaults are for real use; tests shorten them. */
export type SyncSettings = {
	/** Between two syncs of one account. */
	intervalMs: number;
	/** The slowest a failing account is tried again. The wait doubles with every failure in a row, from `intervalMs`. */
	maxBackoffMs: number;
	/** How far back the first sync reads. */
	initialDays: number;
	/** The most messages the first sync (and a re-read after Gmail dropped the history) takes, newest first. */
	maxInitialMessages: number;
	/** The most messages one incremental sync takes; the rest comes with the next one. */
	maxMessagesPerRun: number;
	/** Messages fetched at once. */
	fetchConcurrency: number;
	/** Messages classified at once, and the most per run. */
	triageConcurrency: number;
	maxTriagePerRun: number;
	/**
	 * The longest one sync spends waiting on the classifier (Jev). When it is up, the rest of the new mail is sorted by the
	 * local rules and flagged provisional, and Jev looks at it again at a later sync: a slow Jev delays nothing else.
	 */
	maxTriageMs: number;
	/** How many syncs may fail on one message before it is left out (and shown in Settings): see `inbox_read_failure`. */
	maxReadAttempts: number;
	/** Calendar: from the start of yesterday to this many days ahead. */
	calendarDays: number;
};

export const DEFAULT_SYNC: SyncSettings = {
	intervalMs: 10 * 60_000,
	maxBackoffMs: 60 * 60_000,
	initialDays: 14,
	maxInitialMessages: 1000,
	maxMessagesPerRun: 300,
	fetchConcurrency: 4,
	triageConcurrency: 4,
	maxTriagePerRun: 60,
	maxTriageMs: 90_000,
	maxReadAttempts: 5,
	calendarDays: 14,
};

/** What the Inbox module needs of the server, on top of {@link import("../module.ts").DomainDeps}. */
export type InboxDeps = {
	google: GoogleGateway;
	/** Jev when a key is saved, the local rules otherwise. */
	triage: Triage;
	sync?: Partial<SyncSettings>;
};
