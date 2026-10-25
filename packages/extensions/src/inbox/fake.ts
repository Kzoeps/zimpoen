import {
	type CalendarClient,
	type CalendarEvent,
	type GmailClient,
	type GmailMessage,
	type GoogleGateway,
	type HistoryChange,
	HistoryExpiredError,
	type TokenAccount,
	type TokenProvider,
	TokenRevokedError,
} from "./types.ts";

/**
 * A scripted Google, in memory: the mailboxes, their history, the calendars and the sign-ins, behind the same interfaces
 * the real clients have. It is what `ASSISTANT_GOOGLE_MODE=fake` runs (development makes no call to Google) and what the
 * tests sync against. It behaves the way Gmail does where the sync depends on it: a history that moves with every change,
 * a history that expires (`expireHistory`), listings newest first and in pages, a token that is refused (`revoke`).
 */

type Mailbox = {
	messages: Map<string, GmailMessage>;
	history: Array<{ historyId: number; change: HistoryChange }>;
	/** The mailbox's current history id. */
	historyId: number;
	/** History from before this id is gone. */
	oldestHistoryId: number;
	events: CalendarEvent[];
	revoked: boolean;
	connectedAt: number;
	nextId: number;
};

export type NewFakeMessage = Partial<Omit<GmailMessage, "from" | "subject">> & { from: string; subject: string };

export type FakeGoogle = GoogleGateway & {
	addAccount(email: string, options?: { connectedAt?: number }): void;
	/** A message arrives. Returns it as the client will hand it out. */
	addMessage(email: string, message: NewFakeMessage): GmailMessage;
	deleteMessage(email: string, id: string): void;
	changeLabels(email: string, id: string, change: { add?: readonly string[]; remove?: readonly string[] }): void;
	/** Gmail forgets the history up to now: the next incremental sync gets a 404. */
	expireHistory(email: string): void;
	setEvents(email: string, events: readonly CalendarEvent[]): void;
	/** Google refuses the account's refresh token from now on. */
	revoke(email: string): void;
	/** The owner connected the account again. */
	reconnect(email: string, connectedAt?: number): void;
	/** The next call about this account fails with `error` (a network error, a 500). */
	failNext(email: string, error?: Error): void;
	/** Every call made, in order: what the sync asked of Google. */
	readonly calls: ReadonlyArray<{ api: "gmail" | "calendar" | "tokens"; method: string; account: string }>;
};

export type FakeGoogleOptions = {
	/** The clock for `newer_than:` and for the `internalDate` of a message that has none. */
	now?: () => number;
	/** How many ids or history changes a page holds: small in a test about paging. Default 100. */
	pageSize?: number;
};

export function createFakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
	const now = options.now ?? Date.now;
	const pageSize = options.pageSize ?? 100;
	const boxes = new Map<string, Mailbox>();
	const failures = new Map<string, Error>();
	const calls: Array<{ api: "gmail" | "calendar" | "tokens"; method: string; account: string }> = [];

	function box(email: string): Mailbox {
		const found = boxes.get(email);
		if (found === undefined) throw new Error(`The fake Google has no account ${email}. Call addAccount first.`);
		return found;
	}

	/** What every call to Google does first: note it, and fail the way the script says. */
	function enter(api: "gmail" | "calendar" | "tokens", method: string, email: string): Mailbox {
		calls.push({ api, method, account: email });
		const mailbox = box(email);
		if (mailbox.revoked) throw new TokenRevokedError(email);
		const failure = failures.get(email);
		if (failure !== undefined) {
			failures.delete(email);
			throw failure;
		}
		return mailbox;
	}

	function record(mailbox: Mailbox, change: HistoryChange): void {
		mailbox.historyId += 1;
		mailbox.history.push({ historyId: mailbox.historyId, change });
	}

	const gmail: GmailClient = {
		async profile(account) {
			const mailbox = enter("gmail", "profile", account);
			return { emailAddress: account, historyId: String(mailbox.historyId) };
		},

		async listMessageIds(account, query) {
			const mailbox = enter("gmail", "listMessageIds", account);
			const days = /newer_than:(\d+)d/.exec(query.q)?.[1];
			const since = days === undefined ? 0 : now() - Number(days) * 24 * 60 * 60_000;
			const excluded = (flag: string, label: string, message: GmailMessage): boolean =>
				query.q.includes(flag) && message.labelIds.includes(label);
			const matching = [...mailbox.messages.values()]
				.filter((message) => message.internalDate >= since)
				.filter((message) => !message.labelIds.includes("TRASH") && !message.labelIds.includes("SPAM"))
				.filter((message) => !excluded("-in:sent", "SENT", message))
				.filter((message) => !excluded("-in:drafts", "DRAFT", message))
				.filter((message) => !excluded("-in:chats", "CHAT", message))
				.sort((a, b) => b.internalDate - a.internalDate || b.id.localeCompare(a.id));
			const start = query.pageToken === undefined ? 0 : Number(query.pageToken);
			const page = matching.slice(start, start + pageSize);
			const next = start + pageSize;
			return {
				ids: page.map((message) => message.id),
				...(next < matching.length ? { nextPageToken: String(next) } : {}),
			};
		},

		async getMessage(account, id) {
			return enter("gmail", "getMessage", account).messages.get(id);
		},

		async listHistory(account, startHistoryId, pageToken) {
			const mailbox = enter("gmail", "listHistory", account);
			if (Number(startHistoryId) < mailbox.oldestHistoryId) throw new HistoryExpiredError(account);
			const after = mailbox.history.filter((entry) => entry.historyId > Number(startHistoryId));
			const start = pageToken === undefined ? 0 : Number(pageToken);
			const page = after.slice(start, start + pageSize);
			const next = start + pageSize;
			return {
				changes: page.map((entry) => entry.change),
				historyId: String(mailbox.historyId),
				...(next < after.length ? { nextPageToken: String(next) } : {}),
			};
		},
	};

	const calendar: CalendarClient = {
		async listEvents(account, range) {
			const mailbox = enter("calendar", "listEvents", account);
			return mailbox.events
				.filter((event) => event.start < range.to && event.end > range.from)
				.map((event) => ({ ...event }));
		},
	};

	const tokens: TokenProvider = {
		async accounts(): Promise<TokenAccount[]> {
			return [...boxes.entries()].map(([email, mailbox]) => ({
				email,
				status: mailbox.revoked ? "needs_reconnect" : "ok",
				connectedAt: mailbox.connectedAt,
			}));
		},
		async accessToken(account) {
			enter("tokens", "accessToken", account);
			return "fake-access-token";
		},
		async remove(account) {
			calls.push({ api: "tokens", method: "remove", account });
			boxes.delete(account);
		},
	};

	return {
		mode: "fake",
		clientConfigured: true,
		gmail,
		calendar,
		tokens,
		calls,

		addAccount(email, accountOptions = {}) {
			boxes.set(email, {
				messages: new Map(),
				history: [],
				historyId: 1000,
				oldestHistoryId: 0,
				events: [],
				revoked: false,
				connectedAt: accountOptions.connectedAt ?? now(),
				nextId: 1,
			});
		},

		addMessage(email, message) {
			const mailbox = box(email);
			const id = message.id ?? `m${String(mailbox.nextId++).padStart(4, "0")}`;
			const full: GmailMessage = {
				id,
				threadId: message.threadId ?? `t${id}`,
				labelIds: message.labelIds ?? ["INBOX", "UNREAD"],
				snippet: message.snippet ?? (message.text ?? "").slice(0, 120),
				internalDate: message.internalDate ?? now(),
				from: message.from,
				to: message.to ?? email,
				subject: message.subject,
				bulk: message.bulk ?? false,
				text: message.text ?? "",
			};
			mailbox.messages.set(id, full);
			record(mailbox, { type: "added", id, labelIds: full.labelIds });
			return full;
		},

		deleteMessage(email, id) {
			const mailbox = box(email);
			mailbox.messages.delete(id);
			record(mailbox, { type: "deleted", id });
		},

		changeLabels(email, id, change) {
			const mailbox = box(email);
			const message = mailbox.messages.get(id);
			if (message === undefined) throw new Error(`The fake Google has no message ${id} in ${email}.`);
			const labels = new Set(message.labelIds);
			for (const label of change.remove ?? []) labels.delete(label);
			for (const label of change.add ?? []) labels.add(label);
			mailbox.messages.set(id, { ...message, labelIds: [...labels] });
			record(mailbox, { type: "labels", id, added: change.add ?? [], removed: change.remove ?? [] });
		},

		expireHistory(email) {
			const mailbox = box(email);
			mailbox.oldestHistoryId = mailbox.historyId + 1;
			mailbox.history = [];
		},

		setEvents(email, events) {
			box(email).events = events.map((event) => ({ ...event }));
		},

		revoke(email) {
			box(email).revoked = true;
		},

		reconnect(email, connectedAt) {
			const mailbox = box(email);
			mailbox.revoked = false;
			mailbox.connectedAt = connectedAt ?? Math.max(now(), mailbox.connectedAt + 1);
		},

		failNext(email, error = new Error("The fake Google failed on purpose.")) {
			failures.set(email, error);
		},
	};
}

const HOUR = 60 * 60_000;

/**
 * A believable first mailbox for development (`ASSISTANT_GOOGLE_MODE=fake`): two accounts, mail of every kind a triage has to
 * tell apart, and a few events with people invited. Deterministic, and dated relative to `now`, so the digests and the
 * calendar always have something to show.
 */
export function seedDemoMailbox(google: FakeGoogle, now: number): void {
	const personal = "demo.owner@example.com";
	const work = "demo.work@example.com";
	google.addAccount(personal, { connectedAt: now - 3 * 24 * HOUR });
	google.addAccount(work, { connectedAt: now - 3 * 24 * HOUR });

	const mail = (email: string, hoursAgo: number, message: NewFakeMessage): void => {
		google.addMessage(email, {
			id: `demo-${email.slice(5, 9)}-${hoursAgo}-${message.subject.length}`,
			internalDate: now - hoursAgo * HOUR,
			...message,
		});
	};
	mail(personal, 2, {
		from: "Dabtonog Realty <sales@dabtonog.example>",
		subject: "Re: plot in Thimphu: can you confirm the visit on Thursday?",
		text: "Dear owner, thank you for your interest in the plot. Could you confirm that Thursday at 15:00 still suits you for the site visit? Please let me know by tomorrow so that we can arrange the key.",
	});
	mail(personal, 5, {
		from: "Bank of Bhutan <alerts@bob.example>",
		subject: "Your statement for October is ready",
		text: "Your monthly statement is available in the app. No action is needed.",
		labelIds: ["INBOX", "CATEGORY_UPDATES"],
		bulk: true,
	});
	mail(personal, 7, {
		from: "Pema Dorji <pema@example.com>",
		subject: "Following up on the dinner plan",
		text: "Hi, just checking in on the dinner plan for Saturday. Any update from your side?",
	});
	mail(personal, 9, {
		from: "The Weekly Digest <news@weekly.example>",
		subject: "Ten things in tech this week",
		text: "This week in tech: ... Unsubscribe at any time.",
		labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
		bulk: true,
	});
	mail(work, 3, {
		from: "GitHub <notifications@github.example>",
		subject: "[assistant] Pull request #42 was merged",
		text: "The pull request was merged into main.",
		labelIds: ["INBOX", "CATEGORY_UPDATES"],
		bulk: true,
	});
	mail(work, 4, {
		from: "Tashi Wangchuk <tashi@client.example>",
		subject: "Invoice question: overdue payment for September",
		text: "Hello, our records show the September invoice is still unpaid and now overdue. Can you check and reply today?",
		labelIds: ["INBOX", "IMPORTANT"],
	});

	const event = (
		id: string,
		title: string,
		startHours: number,
		lengthHours: number,
		attendees: string[],
		location = "",
	): CalendarEvent => ({
		id,
		title,
		start: now + startHours * HOUR,
		end: now + (startHours + lengthHours) * HOUR,
		allDay: false,
		attendees,
		location,
		updated: now - 24 * HOUR,
	});
	google.setEvents(personal, [
		event("demo-event-1", "Site visit: Dabtonog Realty", 26, 1, ["sales@dabtonog.example"], "Thimphu"),
	]);
	google.setEvents(work, [
		event("demo-event-2", "Sprint planning", 20, 1, ["tashi@client.example", "pema@example.com"]),
		event("demo-event-3", "Focus time", 2, 2, []),
	]);
}
