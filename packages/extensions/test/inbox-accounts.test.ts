import { NOTICE_ENTRY_KIND, type NoticeEntryData } from "@assistant/shared";
import type { TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { backoffMs, createJevTriage, DEFAULT_SYNC, inboxModule, inboxStore } from "../src/index.ts";
import { ctx, type Fixture, MINUTE, openFixture, START, waitFor } from "./support.ts";

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const INTERVAL = 10 * MINUTE;
const fixtures: Fixture[] = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.close().catch(() => {});
		await fixture.dispose();
	}
});

async function open(options: Parameters<typeof openFixture>[0] = {}): Promise<Fixture> {
	const fixture = await openFixture({ inbox: { sync: { intervalMs: INTERVAL } }, ...options });
	fixtures.push(fixture);
	return fixture;
}

/** What the server does at start: the accounts from the saved sign-ins, then the timers, then Durable runs what is due. */
async function startInbox(f: Fixture) {
	const start = await inboxModule.start(f.deps);
	const timers = await inboxModule.scheduler(f.deps).reconcile();
	f.advance(0);
	return { start, timers };
}

const account = (f: Fixture, email = ALICE) => {
	const row = inboxStore.getAccount(f.db, email);
	if (row === undefined) throw new Error(`no account ${email}`);
	return row;
};
const syncedAt = (f: Fixture, email = ALICE) => inboxStore.getAccount(f.db, email)?.lastOkAt;
const notices = async (f: Fixture) =>
	(await f.entriesOfKind(NOTICE_ENTRY_KIND)).map((entry) => entry.data as unknown as NoticeEntryData);

describe("the sync of an account, as a timer", () => {
	it("gives a saved sign-in its row and its timer, syncs at once, and again after every interval", async () => {
		const f = await open();
		f.google?.addAccount(ALICE, { connectedAt: START });
		f.google?.addMessage(ALICE, { subject: "First", from: "a@example.com", internalDate: START - MINUTE });

		const { start } = await startInbox(f);
		expect(start.accounts.added).toStrictEqual([ALICE]);
		await waitFor(() => syncedAt(f) === START, "the first sync");
		expect(inboxStore.searchMessages(f.db, { limit: 5 }).total).toBe(1);
		expect(account(f)).toMatchObject({ failures: 0, nextSyncAt: START + INTERVAL, historyId: expect.any(String) });

		// Nothing is due before the interval is over.
		f.advance(INTERVAL - MINUTE);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(syncedAt(f)).toBe(START);

		f.google?.addMessage(ALICE, { subject: "Second", from: "b@example.com" });
		f.advance(MINUTE);
		await waitFor(() => syncedAt(f) === START + INTERVAL, "the second sync");
		expect(inboxStore.searchMessages(f.db, { limit: 5 }).total).toBe(2);
		expect(account(f).nextSyncAt).toBe(START + 2 * INTERVAL);
	});

	it("syncs every account on its own row, and one that fails does not hold up the other", async () => {
		const f = await open();
		f.google?.addAccount(ALICE, { connectedAt: START });
		f.google?.addAccount(BOB, { connectedAt: START });
		f.google?.addMessage(ALICE, { subject: "For Alice", from: "a@example.com" });
		f.google?.addMessage(BOB, { subject: "For Bob", from: "b@example.com" });
		f.google?.failNext(ALICE);

		await startInbox(f);
		await waitFor(() => syncedAt(f, BOB) === START && account(f).failures === 1, "both runs");
		expect(account(f)).toMatchObject({ failures: 1, lastError: expect.stringContaining("failed on purpose") });
		expect(inboxStore.searchMessages(f.db, { account: BOB, limit: 5 }).total).toBe(1);
		expect(inboxStore.searchMessages(f.db, { account: ALICE, limit: 5 }).total).toBe(0);
	});

	it("waits longer after every failure in a row, and starts over after a success", async () => {
		const f = await open();
		f.google?.addAccount(ALICE, { connectedAt: START });
		f.google?.failNext(ALICE);
		await startInbox(f);
		await waitFor(() => account(f).failures === 1, "the first failure");
		expect(account(f).nextSyncAt).toBe(START + INTERVAL);

		f.google?.failNext(ALICE);
		f.advance(INTERVAL);
		await waitFor(() => account(f).failures === 2, "the second failure");
		expect(account(f).nextSyncAt).toBe(START + INTERVAL + 2 * INTERVAL);

		f.advance(2 * INTERVAL);
		await waitFor(() => account(f).failures === 0 && account(f).lastError === undefined, "a good sync");
		expect(account(f).nextSyncAt).toBe(START + 3 * INTERVAL + INTERVAL);
		expect(f.reports.filter((report) => report.info.type === "task_error")).toHaveLength(2);
	});

	it("keeps its pace when one message cannot be read, gives up on it, and says so in Settings", async () => {
		const f = await open({ inbox: { sync: { intervalMs: INTERVAL, maxReadAttempts: 2 } } });
		f.google?.addAccount(ALICE, { connectedAt: START });
		const bad = f.google?.addMessage(ALICE, {
			subject: "Far too large",
			from: "p@example.com",
			internalDate: START - MINUTE,
		});
		f.google?.addMessage(ALICE, { subject: "Fine", from: "a@example.com", internalDate: START - 2 * MINUTE });
		const original = f.google?.gmail.getMessage.bind(f.google.gmail);
		if (f.google === undefined || original === undefined || bad === undefined) throw new Error("no fake Google");
		f.google.gmail.getMessage = async (account, id, options) => {
			if (id === bad.id) throw new Error("Google's answer is larger than this program reads.");
			return original(account, id, options);
		};

		await startInbox(f);
		await waitFor(() => syncedAt(f) === START, "the first sync");
		// The mail that can be read is kept, the account is not failing, and it is not slowed down.
		expect(inboxStore.searchMessages(f.db, { limit: 5 }).rows.map((row) => row.subject)).toStrictEqual(["Fine"]);
		expect(account(f)).toMatchObject({
			failures: 0,
			nextSyncAt: START + INTERVAL,
			lastError: expect.stringMatching(/^1 mail could not be read yet/),
		});
		expect((await inboxModule.accounts(f.deps).settings()).accounts[0]?.skipped).toBeUndefined();

		f.advance(INTERVAL);
		await waitFor(() => syncedAt(f) === START + INTERVAL, "the second sync");

		expect(account(f)).toMatchObject({
			failures: 0,
			nextSyncAt: START + 2 * INTERVAL,
			lastError: expect.stringMatching(/left out/),
		});
		expect((await inboxModule.accounts(f.deps).settings()).accounts[0]?.skipped).toStrictEqual({
			count: 1,
			lastError: "Google's answer is larger than this program reads.",
		});
	});

	it("caps the wait at the slowest backoff", () => {
		const settings = { intervalMs: INTERVAL, maxBackoffMs: DEFAULT_SYNC.maxBackoffMs };
		expect([1, 2, 3, 4, 5, 9].map((failures) => backoffMs(settings, failures) / MINUTE)).toStrictEqual([
			10, 20, 40, 60, 60, 60,
		]);
	});

	it("never blocks the PA: a sync that is slow is a background task, and the PA still answers", async () => {
		const f = await open();
		f.google?.addAccount(ALICE, { connectedAt: START });
		f.google?.addMessage(ALICE, { subject: "Slow", from: "a@example.com" });
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = f.google?.gmail.getMessage.bind(f.google.gmail);
		if (f.google === undefined || original === undefined) throw new Error("no google");
		f.google.gmail.getMessage = async (...args) => {
			await held;
			return await original(...args);
		};
		await startInbox(f);
		await waitFor(() => f.google?.calls.some((call) => call.method === "listMessageIds"), "the sync to start");

		f.faux.setResponses([{ role: "assistant", content: [{ type: "text", text: "Still here." }] } as never]);
		await f.say("hello while the mail syncs");
		expect((await f.entriesOfKind("pi.assistant")).length).toBeGreaterThan(0);
		expect(syncedAt(f)).toBeUndefined();

		release();
		await waitFor(() => syncedAt(f) === START, "the sync to end");
	});
});

describe("when Google refuses the sign-in", () => {
	it("stops the account, tells the owner in the PA's thread and on the phone, and does not try again", async () => {
		const f = await open();
		f.google?.addAccount(ALICE, { connectedAt: START });
		await startInbox(f);
		await waitFor(() => syncedAt(f) === START, "the first sync");

		f.google?.revoke(ALICE);
		f.advance(INTERVAL);
		await waitFor(
			async () => account(f).status === "needs_reconnect" && (await notices(f)).length > 0,
			"the account to be marked and the owner told",
		);

		const [notice] = (await notices(f)).filter((data) => data.text.includes(ALICE));
		expect(notice).toMatchObject({ level: "error" });
		expect(notice?.text).toContain("pnpm connect:google");
		expect(f.pushes).toContainEqual(expect.objectContaining({ tag: "google-reconnect", url: "/settings" }));
		// A push never says which account, or anything else a push service should not see.
		expect(JSON.stringify(f.pushes)).not.toContain(ALICE);

		// No timer is waiting for it: a sweep makes none and nothing is asked of Google.
		const calls = f.google?.calls.length;
		expect((await inboxModule.scheduler(f.deps).reconcile()).rescheduled).toStrictEqual([]);
		f.advance(5 * INTERVAL);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(f.google?.calls.length).toBe(calls);
		expect(await notices(f)).toHaveLength(1);
	});

	it("notices a token that is saved as refused, once, even when no sync saw it", async () => {
		const f = await open();
		f.google?.addAccount(ALICE, { connectedAt: START });
		await startInbox(f);
		await waitFor(() => syncedAt(f) === START, "the first sync");
		f.google?.revoke(ALICE);

		const report = await inboxModule.accounts(f.deps).refresh();
		expect(report.revoked).toStrictEqual([ALICE]);
		expect(await inboxModule.accounts(f.deps).refresh()).toMatchObject({ revoked: [] });
		expect((await notices(f)).filter((data) => data.text.includes(ALICE))).toHaveLength(1);
	});

	it("syncs again once the owner has connected the account again", async () => {
		const f = await open();
		f.google?.addAccount(ALICE, { connectedAt: START });
		f.google?.revoke(ALICE);
		await startInbox(f);
		expect(account(f).status).toBe("needs_reconnect");

		f.google?.addMessage(ALICE, { subject: "After reconnecting", from: "a@example.com" });
		f.google?.reconnect(ALICE, START + 5 * MINUTE);
		const report = await inboxModule.accounts(f.deps).refresh();
		expect(report.reconnected).toStrictEqual([ALICE]);
		f.advance(0);
		await waitFor(() => syncedAt(f) !== undefined, "the sync after reconnecting");
		expect(account(f)).toMatchObject({ status: "connected", failures: 0, connectedAt: START + 5 * MINUTE });
		expect(inboxStore.searchMessages(f.db, { limit: 5 }).total).toBe(1);
	});
});

describe("what Settings is told about the classifier", () => {
	it("says that Jev is paused, and until when, once it has failed enough times in a row", async () => {
		const jev = createJevTriage({
			apiKey: "k",
			fetch: (async () => new Response("", { status: 503 })) as typeof fetch,
			retryDelaysMs: [],
			circuit: { failures: 1, coolDownMs: 15 * MINUTE },
			now: () => START,
		});
		const f = await open({ inbox: { triage: jev } });
		expect((await inboxModule.accounts(f.deps).settings()).triage).toStrictEqual({ mode: "jev" });

		await jev
			.classify({
				account: ALICE,
				fromName: "",
				fromAddress: "a@example.com",
				to: ALICE,
				subject: "Hi",
				snippet: "",
				text: "",
				labels: [],
				bulk: false,
				date: START,
			})
			.catch(() => undefined);

		const { triage } = await inboxModule.accounts(f.deps).settings();
		expect(triage).toMatchObject({ mode: "jev", pausedUntil: START + 15 * MINUTE });
		expect(triage.pausedUntilText).toMatch(/\d{2}:\d{2}/);
	});
});

describe("disconnecting", () => {
	it("forgets the sign-in and stops the sync, and keeps the mail", async () => {
		const f = await open();
		f.google?.addAccount(ALICE, { connectedAt: START });
		f.google?.addMessage(ALICE, { subject: "Stays", from: "a@example.com" });
		await startInbox(f);
		await waitFor(() => syncedAt(f) === START, "the first sync");

		expect(await inboxModule.accounts(f.deps).disconnect(ALICE)).toBe(true);
		expect(f.google?.calls.at(-1)).toMatchObject({ api: "tokens", method: "remove", account: ALICE });
		expect(account(f).status).toBe("disconnected");
		expect(inboxStore.pendingTimers(f.db)).toStrictEqual([]);
		expect(inboxStore.searchMessages(f.db, { limit: 5 }).total).toBe(1);
		expect(await inboxModule.accounts(f.deps).disconnect("nobody@example.com")).toBe(false);
		expect((await inboxModule.accounts(f.deps).settings()).accounts).toMatchObject([
			{ email: ALICE, status: "disconnected", messages: 1 },
		]);
	});

	it("stops the account whose sign-in has disappeared from the file", async () => {
		const f = await open();
		f.google?.addAccount(ALICE, { connectedAt: START });
		await startInbox(f);
		await f.google?.tokens.remove(ALICE);
		expect((await inboxModule.accounts(f.deps).refresh()).disconnected).toStrictEqual([ALICE]);
	});
});

describe("across a restart", () => {
	it("keeps the timer, and makes it again when Durable lost it", async () => {
		const f = await open();
		f.google?.addAccount(ALICE, { connectedAt: START });
		await startInbox(f);
		await waitFor(() => syncedAt(f) === START, "the first sync");
		const google = f.google;

		const restarted = await f.restart();
		fixtures.push(restarted);
		expect(restarted.google).not.toBe(google);
		expect(await inboxModule.scheduler(restarted.deps).reconcile()).toMatchObject({ rescheduled: [], failures: [] });

		// A power cut can take the timer from Durable's database: the row still wants one.
		const lost = account(restarted).durableTaskId ?? 0;
		await restarted.harness.abortTask(lost as TaskId, ctx);
		inboxStore.detachDurableTask(restarted.db, ALICE, lost);
		const repaired = await inboxModule.scheduler(restarted.deps).reconcile();
		expect(repaired.rescheduled).toStrictEqual([ALICE]);
	});
});
