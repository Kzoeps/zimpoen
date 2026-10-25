import { afterEach, describe, expect, it } from "vitest";
import {
	createFakeGoogle,
	type DEFAULT_SYNC,
	type FakeGoogle,
	HistoryExpiredError,
	inboxStore,
	MAX_BODY_CHARS,
	syncAccount,
	syncSettingsOf,
	TokenRevokedError,
} from "../src/index.ts";
import { type Fixture, MINUTE, openFixture, START, TIMEZONE } from "./support.ts";

const HOUR = 60 * MINUTE;
const ALICE = "alice@example.com";
const fixtures: Fixture[] = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.close().catch(() => {});
		await fixture.dispose();
	}
});

async function open(
	sync: Partial<typeof DEFAULT_SYNC> = {},
	google?: FakeGoogle,
): Promise<Fixture & { google: FakeGoogle }> {
	const fixture = await openFixture({ inbox: { sync, ...(google === undefined ? {} : { google }) } });
	fixtures.push(fixture);
	if (fixture.google === undefined) throw new Error("no fake Google");
	fixture.google.addAccount(ALICE, { connectedAt: START });
	inboxStore.insertAccount(fixture.db, { email: ALICE, connectedAt: START, now: START });
	return fixture as Fixture & { google: FakeGoogle };
}

const sync = (f: Fixture, signal?: AbortSignal) =>
	syncAccount(
		{
			db: f.db,
			gateway: f.google as FakeGoogle,
			triage: f.deps.inbox?.triage as never,
			settings: syncSettingsOf({ ...f.deps.inbox, sync: f.deps.inbox?.sync } as never),
			now: f.deps.now,
			timezone: TIMEZONE,
		},
		ALICE,
		signal,
	);

/** What the next sync starts from: a real run saves it in the row when it ends. */
const finish = (f: Fixture, run: Awaited<ReturnType<typeof sync>>) => {
	if (run.historyId !== undefined) inboxStore.setHistoryId(f.db, ALICE, run.historyId);
};

const subjects = (f: Fixture) =>
	inboxStore
		.searchMessages(f.db, { limit: 100 })
		.rows.map((row) => row.subject)
		.sort();

describe("the first sync", () => {
	it("reads the recent mailbox, keeps what the mailbox shows the owner, and classifies it", async () => {
		const f = await open();
		f.google.addMessage(ALICE, {
			subject: "Lunch on Friday?",
			from: "Pema <pema@example.com>",
			text: "Can you make it?",
			internalDate: START - 2 * HOUR,
		});
		f.google.addMessage(ALICE, { subject: "Old news", from: "x@example.com", internalDate: START - 20 * 24 * HOUR });
		f.google.addMessage(ALICE, {
			subject: "I wrote this",
			from: ALICE,
			labelIds: ["SENT"],
			internalDate: START - HOUR,
		});
		f.google.addMessage(ALICE, { subject: "A draft", from: ALICE, labelIds: ["DRAFT"], internalDate: START - HOUR });
		f.google.addMessage(ALICE, {
			subject: "Spam offer",
			from: "x@spam.example",
			labelIds: ["SPAM"],
			internalDate: START - HOUR,
		});

		const run = await sync(f);

		expect(run).toMatchObject({ stored: 1, fullRead: true, more: false, triaged: 1 });
		expect(subjects(f)).toStrictEqual(["Lunch on Friday?"]);
		const [row] = inboxStore.searchMessages(f.db, { limit: 5 }).rows;
		expect(row).toMatchObject({
			account: ALICE,
			fromName: "Pema",
			fromAddr: "pema@example.com",
			date: START - 2 * HOUR,
		});
		expect(row?.triage).toMatchObject({ category: "needs_reply", source: "rules" });
		expect(row?.triagedAt).toBe(START);
		expect(run.historyId).toBe(String(1000 + 5));
	});

	it("takes the newest messages up to the cap and leaves the rest for later", async () => {
		const f = await open({ maxInitialMessages: 3 }, createFakeGoogle({ now: () => START, pageSize: 2 }));
		for (let hour = 1; hour <= 5; hour++) {
			f.google.addMessage(ALICE, { subject: `Mail ${hour}`, from: "a@example.com", internalDate: START - hour * HOUR });
		}
		const run = await sync(f);
		expect(run.stored).toBe(3);
		expect(subjects(f)).toStrictEqual(["Mail 1", "Mail 2", "Mail 3"]);
		// A listing that was cut short says nothing about what it did not reach: nothing is hidden.
		expect(run.removed).toBe(0);
	});

	it("keeps only a bounded amount of text and one line of subject and snippet", async () => {
		const f = await open();
		f.google.addMessage(ALICE, {
			subject: `Hi\n\u202Eevil ${"x".repeat(1000)}`,
			from: `"A\u0000B" <b@example.com>`,
			text: "z".repeat(MAX_BODY_CHARS * 3),
			snippet: "line one\nline two",
		});
		await sync(f);
		const [row] = inboxStore.searchMessages(f.db, { limit: 1 }).rows;
		expect(row?.text.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
		expect(row?.subject).not.toMatch(/[\n\u202E]/);
		expect(row?.subject.length).toBeLessThanOrEqual(300);
		expect(row?.snippet).toBe("line one line two");
		expect(row?.fromName).toBe("A B");
	});
});

describe("later syncs", () => {
	it("take what the history says: new mail, a deleted message, changed labels", async () => {
		const f = await open();
		const keep = f.google.addMessage(ALICE, { subject: "Keep", from: "a@example.com", internalDate: START - HOUR });
		const gone = f.google.addMessage(ALICE, { subject: "Gone", from: "a@example.com", internalDate: START - HOUR });
		const trash = f.google.addMessage(ALICE, {
			subject: "Trash later",
			from: "a@example.com",
			internalDate: START - HOUR,
		});
		finish(f, await sync(f));

		f.google.addMessage(ALICE, { subject: "Fresh", from: "b@example.com", internalDate: START });
		f.google.deleteMessage(ALICE, gone.id);
		f.google.changeLabels(ALICE, trash.id, { add: ["TRASH"], remove: ["INBOX"] });
		f.google.changeLabels(ALICE, keep.id, { add: ["STARRED"], remove: ["UNREAD"] });
		const run = await sync(f);

		expect(run).toMatchObject({ stored: 1, removed: 1, relabeled: 2, fullRead: false, triaged: 1 });
		expect(subjects(f)).toStrictEqual(["Fresh", "Keep"]);
		const labels = inboxStore.getMessageByGmailId(f.db, ALICE, keep.id)?.labels;
		expect(labels).toContain("STARRED");
		expect(labels).not.toContain("UNREAD");
		// Gone and trashed mail stays as rows (a restored one comes back) and is hidden from everything the owner sees.
		expect(inboxStore.getMessageByGmailId(f.db, ALICE, gone.id)?.hidden).toBe(true);
		expect(inboxStore.getMessageByGmailId(f.db, ALICE, trash.id)?.hidden).toBe(true);
	});

	it("bring a message back that was restored from the trash", async () => {
		const f = await open();
		const message = f.google.addMessage(ALICE, { subject: "Oops", from: "a@example.com", internalDate: START - HOUR });
		finish(f, await sync(f));
		f.google.changeLabels(ALICE, message.id, { add: ["TRASH"] });
		finish(f, await sync(f));
		expect(subjects(f)).toStrictEqual([]);

		f.google.changeLabels(ALICE, message.id, { remove: ["TRASH"], add: ["INBOX"] });
		await sync(f);
		expect(subjects(f)).toStrictEqual(["Oops"]);
	});

	it("ignore a change to mail the store never kept", async () => {
		const f = await open();
		const old = f.google.addMessage(ALICE, {
			subject: "Ancient",
			from: "a@example.com",
			internalDate: START - 30 * 24 * HOUR,
		});
		finish(f, await sync(f));
		f.google.changeLabels(ALICE, old.id, { add: ["STARRED"] });
		f.google.deleteMessage(ALICE, old.id);
		const run = await sync(f);
		expect(run).toMatchObject({ stored: 0, relabeled: 0 });
	});

	it("do not keep mail the owner only sent, but keep a message they sent to themselves", async () => {
		const f = await open();
		finish(f, await sync(f));
		f.google.addMessage(ALICE, { subject: "Sent", from: ALICE, labelIds: ["SENT"] });
		f.google.addMessage(ALICE, { subject: "Note to self", from: ALICE, labelIds: ["SENT", "INBOX"] });
		await sync(f);
		expect(subjects(f)).toStrictEqual(["Note to self"]);
	});

	it("read the mailbox again when Gmail no longer has the history, and lose nothing the owner decided", async () => {
		const f = await open();
		const first = f.google.addMessage(ALICE, {
			subject: "Newsletter from a friend",
			from: "friend@example.com",
			internalDate: START - HOUR,
		});
		const doomed = f.google.addMessage(ALICE, {
			subject: "Deleted while away",
			from: "a@example.com",
			internalDate: START - HOUR,
		});
		finish(f, await sync(f));
		const stored = inboxStore.getMessageByGmailId(f.db, ALICE, first.id);
		if (stored === undefined) throw new Error("not stored");
		inboxStore.markByOwner(f.db, {
			callId: "call-mark",
			messageId: stored.id,
			result: { category: "newsletter", urgency: 1, needsHuman: false, source: "owner" },
			now: START,
		});
		f.google.addMessage(ALICE, { subject: "Arrived while away", from: "b@example.com", internalDate: START });
		f.google.deleteMessage(ALICE, doomed.id);
		f.google.expireHistory(ALICE);

		const run = await sync(f);

		expect(run).toMatchObject({ fullRead: true, stored: 1, removed: 1 });
		expect(subjects(f)).toStrictEqual(["Arrived while away", "Newsletter from a friend"]);
		expect(inboxStore.getMessageByGmailId(f.db, ALICE, first.id)?.triage).toMatchObject({
			category: "newsletter",
			source: "owner",
		});
	});

	it("take a backlog bigger than one run in several, without moving the cursor past what was not read", async () => {
		const f = await open({ maxMessagesPerRun: 2 }, createFakeGoogle({ now: () => START, pageSize: 2 }));
		finish(f, await sync(f));
		for (let n = 1; n <= 5; n++)
			f.google.addMessage(ALICE, { subject: `Backlog ${n}`, from: "a@example.com", internalDate: START - n * MINUTE });

		const one = await sync(f);
		expect(one).toMatchObject({ stored: 2, more: true });
		expect(one.historyId).toBeUndefined();
		const two = await sync(f);
		expect(two).toMatchObject({ stored: 2, more: true });
		const three = await sync(f);
		expect(three).toMatchObject({ stored: 1, more: false });
		expect(three.historyId).toBeDefined();
		expect(subjects(f)).toHaveLength(5);
	});

	it("stop at once for a token Google refused, without touching what is kept", async () => {
		const f = await open();
		f.google.addMessage(ALICE, { subject: "Before", from: "a@example.com" });
		finish(f, await sync(f));
		f.google.revoke(ALICE);
		await expect(sync(f)).rejects.toBeInstanceOf(TokenRevokedError);
		expect(subjects(f)).toStrictEqual(["Before"]);
	});

	it("stop when the server is closing", async () => {
		const f = await open();
		f.google.addMessage(ALICE, { subject: "One", from: "a@example.com" });
		const controller = new AbortController();
		controller.abort(new Error("closing"));
		await expect(sync(f, controller.signal)).rejects.toThrow("closing");
	});

	it("surface a history that is gone as the error the sync recovers from", async () => {
		const f = await open();
		finish(f, await sync(f));
		f.google.expireHistory(ALICE);
		await expect(
			f.google.gmail.listHistory(ALICE, inboxStore.getAccount(f.db, ALICE)?.historyId ?? "0", undefined),
		).rejects.toBeInstanceOf(HistoryExpiredError);
	});
});

/** Gmail will not hand over one message (too large to read, an answer that cannot be stored), every time until `stop()`. */
function refuse(
	f: Fixture & { google: FakeGoogle },
	id: string,
	error: Error = new Error("Google's answer is larger than this program reads."),
) {
	const original = f.google.gmail.getMessage.bind(f.google.gmail);
	const asked: string[] = [];
	let refusing = true;
	f.google.gmail.getMessage = async (account, wanted, options) => {
		asked.push(wanted);
		if (refusing && wanted === id) throw error;
		return original(account, wanted, options);
	};
	return {
		asked,
		stop: () => {
			refusing = false;
		},
	};
}

describe("a message Gmail will not hand over", () => {
	const arrive = (f: Fixture & { google: FakeGoogle }, count: number, prefix = "Healthy") =>
		Array.from({ length: count }, (_, n) =>
			f.google.addMessage(ALICE, {
				subject: `${prefix} ${n + 1}`,
				from: "b@example.com",
				internalDate: START - n * MINUTE,
			}),
		);

	it("does not stop the mail behind it, and the cursor moves on", async () => {
		const f = await open();
		finish(f, await sync(f));
		const bad = f.google.addMessage(ALICE, { subject: "Far too large", from: "p@example.com", internalDate: START });
		refuse(f, bad.id);
		arrive(f, 11);

		const run = await sync(f);

		// Before the fix this threw, kept the cursor where it was, and stored three mails per run.
		expect(run).toMatchObject({ stored: 11, unread: 1, skipped: 0 });
		expect(run.historyId).toBeDefined();
		expect(run.warning).toMatch(/^1 mail could not be read yet and will be tried again\. \(Google's answer is larger/);
		expect(subjects(f)).toHaveLength(11);
		expect(subjects(f)).not.toContain("Far too large");
	});

	it("is asked for again at each sync from its own list, not from the history, until it has failed enough times", async () => {
		const f = await open({ maxReadAttempts: 3 });
		finish(f, await sync(f));
		const bad = f.google.addMessage(ALICE, { subject: "Far too large", from: "p@example.com", internalDate: START });
		const refusal = refuse(f, bad.id);
		arrive(f, 2);

		const first = await sync(f);
		finish(f, first);
		const second = await sync(f);
		finish(f, second);
		const third = await sync(f);
		finish(f, third);
		const fourth = await sync(f);

		expect([first.unread, second.unread, third.unread, fourth.unread]).toStrictEqual([1, 1, 0, 0]);
		expect([first.skipped, second.skipped, third.skipped, fourth.skipped]).toStrictEqual([0, 0, 1, 0]);
		expect(third.warning).toMatch(/^1 mail could not be read after 3 tries and will be left out\./);
		expect(fourth.warning).toBeUndefined();
		// Three tries (the history only listed it once: the other two came from the failure list), and none after the giving up.
		expect(refusal.asked.filter((id) => id === bad.id)).toHaveLength(3);
		expect(inboxStore.skippedReads(f.db, ALICE, 0)).toMatchObject([
			{ gmailId: bad.id, attempts: 3, lastError: expect.stringContaining("larger") },
		]);
		expect(inboxStore.retryableReads(f.db, ALICE)).toStrictEqual([]);
	});

	it("is not asked for again by a full read of the mailbox once it was given up on", async () => {
		const f = await open({ maxReadAttempts: 1 });
		const bad = f.google.addMessage(ALICE, {
			subject: "Far too large",
			from: "p@example.com",
			internalDate: START - HOUR,
		});
		const refusal = refuse(f, bad.id);
		arrive(f, 2);
		const first = await sync(f);
		expect(first).toMatchObject({ fullRead: true, stored: 2, skipped: 1 });

		f.google.expireHistory(ALICE);
		f.google.addMessage(ALICE, { subject: "Fresh", from: "c@example.com", internalDate: START });
		const again = await sync(f);

		expect(again).toMatchObject({ fullRead: true, stored: 1, skipped: 0, unread: 0 });
		expect(refusal.asked.filter((id) => id === bad.id)).toHaveLength(1);
	});

	it("is forgotten as a failure once it can be read", async () => {
		const f = await open();
		finish(f, await sync(f));
		const flaky = f.google.addMessage(ALICE, { subject: "Flaky", from: "p@example.com", internalDate: START });
		const refusal = refuse(f, flaky.id, new Error("Google answered 500."));
		const first = await sync(f);
		finish(f, first);
		expect(first).toMatchObject({ stored: 0, unread: 1 });

		refusal.stop();
		const second = await sync(f);

		expect(second).toMatchObject({ stored: 1, unread: 0, skipped: 0 });
		expect(second.warning).toBeUndefined();
		expect(subjects(f)).toStrictEqual(["Flaky"]);
		expect(inboxStore.retryableReads(f.db, ALICE)).toStrictEqual([]);
	});

	it("does not blame a message for a refused sign-in or a closing server", async () => {
		const f = await open();
		finish(f, await sync(f));
		const bad = f.google.addMessage(ALICE, { subject: "Whatever", from: "p@example.com", internalDate: START });
		refuse(f, bad.id, new TokenRevokedError(ALICE));
		await expect(sync(f)).rejects.toBeInstanceOf(TokenRevokedError);

		const controller = new AbortController();
		f.google.gmail.getMessage = async () => {
			controller.abort(new Error("closing"));
			throw new Error("The server is closing.");
		};
		await expect(sync(f, controller.signal)).rejects.toThrow();

		expect(inboxStore.retryableReads(f.db, ALICE)).toStrictEqual([]);
		expect(inboxStore.skippedReads(f.db, ALICE, 0)).toStrictEqual([]);
	});

	it("forgets a failure that is older than the mail a sync reads", async () => {
		const f = await open({ initialDays: 14 });
		finish(f, await sync(f));
		const bad = f.google.addMessage(ALICE, { subject: "Far too large", from: "p@example.com", internalDate: START });
		refuse(f, bad.id);
		finish(f, await sync(f));
		expect(inboxStore.retryableReads(f.db, ALICE)).toStrictEqual([bad.id]);

		expect(inboxStore.pruneReadFailures(f.db, START + 1)).toBe(1);
		expect(inboxStore.retryableReads(f.db, ALICE)).toStrictEqual([]);
	});
});

describe("the calendar", () => {
	const event = (
		id: string,
		title: string,
		hoursFromNow: number,
		extra: Partial<{ attendees: string[]; location: string }> = {},
	) => ({
		id,
		title,
		start: START + hoursFromNow * HOUR,
		end: START + (hoursFromNow + 1) * HOUR,
		allDay: false,
		attendees: extra.attendees ?? [],
		location: extra.location ?? "",
		updated: START,
	});

	it("keeps the events from yesterday to two weeks ahead and makes the store match the calendar", async () => {
		const f = await open();
		f.google.setEvents(ALICE, [
			event("e1", "Sprint planning", 20, { attendees: ["Tashi@Client.example"], location: "Room 2" }),
			event("e2", "Later", 24 * 5),
			event("e3", "Far away", 24 * 40),
		]);
		const run = await sync(f);
		expect(run.calendar).toStrictEqual({ kept: 2, removed: 0 });
		const events = inboxStore.eventsBetween(f.db, { from: START, to: START + 10 * 24 * HOUR, limit: 10 }).rows;
		expect(events.map((row) => row.title)).toStrictEqual(["Sprint planning", "Later"]);
		expect(events[0]).toMatchObject({ attendees: ["tashi@client.example"], location: "Room 2" });

		// One moved, one cancelled.
		f.google.setEvents(ALICE, [event("e1", "Sprint planning (moved)", 30), event("e3", "Far away", 24 * 40)]);
		const again = await sync(f);
		expect(again.calendar).toStrictEqual({ kept: 1, removed: 1 });
		expect(
			inboxStore
				.eventsBetween(f.db, { from: START, to: START + 10 * 24 * HOUR, limit: 10 })
				.rows.map((row) => row.title),
		).toStrictEqual(["Sprint planning (moved)"]);
	});

	it("is a warning, not a failure, when only the calendar cannot be read", async () => {
		const f = await open();
		f.google.addMessage(ALICE, { subject: "Mail still comes", from: "a@example.com" });
		const original = f.google.calendar.listEvents;
		f.google.calendar.listEvents = async () => {
			throw new Error("Calendar API has not been used in project 123 before");
		};
		const run = await sync(f);
		f.google.calendar.listEvents = original;
		expect(run.stored).toBe(1);
		expect(run.warning).toMatch(/^Calendar: Calendar API has not been used/);
	});
});
