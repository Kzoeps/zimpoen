import { chmod, writeFile } from "node:fs/promises";
import { createFakeGoogle, type FakeGoogle, inboxStore } from "@assistant/extensions";
import {
	type AgentAnswerCard,
	type GoogleSettingsResponse,
	type MessagesPage,
	NOTICE_ENTRY_KIND,
	type NoticeEntryData,
	type ScheduleSettingsResponse,
	type SendMessageResponse,
	SUGGESTION_ENTRY_KIND,
	type SuggestionEntryData,
	type ToolCard,
	toolCardOf,
} from "@assistant/shared";
import { AgentDoc, type ConversationId, type EntryRecord, type SubmissionId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { GoogleAccountStore } from "../src/google/accounts.ts";
import {
	base,
	ctx,
	type Harness,
	MINUTE,
	modelAnswers,
	ofKind,
	post,
	START,
	setup,
	subscription,
} from "./domain-support.ts";
import { removeAllFixtures, waitFor } from "./support.ts";

const harnesses: Harness[] = [];
async function start(env: Record<string, string> = {}, more: Parameters<Harness["start"]>[1] = {}) {
	const h = await setup(env);
	harnesses.push(h);
	const server = await h.start(undefined, more);
	await post(server, "/api/push/subscribe", subscription());
	return { h, server };
}
afterEach(async () => {
	for (const h of harnesses.splice(0)) for (const server of h.servers.splice(0)) await server.close();
	await removeAllFixtures();
});

type Server = Awaited<ReturnType<typeof start>>["server"];
type AgentId = "pa" | "inbox" | "health" | "accountant";
const ALICE = "alice@example.com";

const conversationOf = (server: Server, agent: AgentId): number =>
	server.db.get<{ conversation_id: number }>("SELECT conversation_id FROM agents WHERE id = ?", agent)
		?.conversation_id ?? -1;

let counter = 0;
async function sayTo(server: Server, agent: AgentId, text: string): Promise<SendMessageResponse> {
	const { status, body } = await post<SendMessageResponse>(
		server,
		`/api/conversations/${conversationOf(server, agent)}/messages`,
		{
			content: text,
			requestId: `m5-${++counter}`,
		},
	);
	expect(status).toBe(202);
	const submission = await server.harness.submission(body.submissionId as SubmissionId, ctx);
	await submission?.wait(ctx);
	return body;
}

async function entriesOf(server: Server, agent: AgentId): Promise<EntryRecord[]> {
	const response = await fetch(`${base(server)}/api/conversations/${conversationOf(server, agent)}/messages?limit=200`);
	return ((await response.json()) as MessagesPage).entries as EntryRecord[];
}

const toolResults = async (server: Server, agent: AgentId) =>
	(await entriesOf(server, agent)).flatMap((entry) =>
		(entry.model ?? []).filter((message) => message.role === "toolResult"),
	);

const cardsOf = async (server: Server, agent: AgentId): Promise<ToolCard[]> =>
	(await toolResults(server, agent)).flatMap((message) => {
		const card = toolCardOf((message as { details?: unknown }).details);
		return card === undefined ? [] : [card];
	});

const offered = async (server: Server, agent: AgentId): Promise<string[]> => {
	const conversation = await server.harness.conversation(conversationOf(server, agent) as ConversationId, ctx);
	return ((await conversation?.agent(ctx))?.tools ?? []).map((tool) => tool.name).sort();
};

const settings = async (server: Server): Promise<GoogleSettingsResponse> =>
	(await (await fetch(`${base(server)}/api/settings/google`)).json()) as GoogleSettingsResponse;

const send = (
	server: Server,
	path: string,
	method: string,
	body?: unknown,
	headers: Record<string, string> = { "content-type": "application/json" },
) =>
	fetch(`${base(server)}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** A fake mailbox with one mail that needs an answer, ready for `start`. */
function mailbox(h: Harness, subject = "Plot viewing on Thursday: can you confirm?"): FakeGoogle {
	const google = createFakeGoogle({ now: () => h.clock.now });
	google.addAccount(ALICE, { connectedAt: START });
	google.addMessage(ALICE, {
		subject,
		from: "Dabtonog Realty <sales@dabtonog.example>",
		text: "Can you confirm Thursday at 15:00? Please let me know by tomorrow.",
		internalDate: START - 60 * MINUTE,
	});
	return google;
}

const synced = (server: Server, email = ALICE) => inboxStore.getAccount(server.db, email)?.lastOkAt !== undefined;

describe("the Inbox through the whole server", () => {
	it("applies the inbox and delegate tables, and gives each agent its own tools: the Inbox has its own seven and recall (it may read memory, never write it) and nothing else, only the PA can ask another agent", async () => {
		const { server } = await start();

		const ids = server.db.all<{ id: string }>("SELECT id FROM _migrations ORDER BY id").map((row) => row.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				"inbox/001_accounts_mail",
				"inbox/002_rules_suggestions",
				"inbox/003_digest_state",
				"inbox/004_read_failures",
				"inbox/005_suggestion_expiry",
				"delegate/001_asks",
			]),
		);
		const extensionsOf = async (agent: AgentId) =>
			(await server.harness.snapshot(AgentDoc, conversationOf(server, agent) as ConversationId, ctx))?.extensions;
		expect(await extensionsOf("inbox")).toStrictEqual(["profile", "inbox", "memory-read"]);
		expect(await extensionsOf("pa")).toStrictEqual([
			"profile",
			"tasks",
			"followups",
			"people",
			"daily",
			"files",
			"delegate",
			"approvals",
			"tool-search",
			"memory",
		]);
		expect(await extensionsOf("health")).toStrictEqual(["profile", "health", "approvals", "tool-search", "memory"]);

		expect(await offered(server, "inbox")).toStrictEqual([
			"current_time",
			"list_events",
			"mark_triage",
			"propose_sender_rule",
			"read_mail",
			"recall",
			"search_mail",
			"suggest_followup",
		]);
		expect(await offered(server, "pa")).toContain("ask_agent");
		for (const agent of ["inbox", "health", "accountant"] as const)
			expect(await offered(server, agent), agent).not.toContain("ask_agent");
	});

	it("refuses what the Inbox agent has no tool for before it runs: files, tasks, other agents, a search for more tools", async () => {
		const { server } = await start();

		for (const [tool, args] of [
			["ask_agent", '{"agent":"health","question":"weight?"}'],
			["read_file", '{"id":"fi_aaaaaaaa"}'],
			["read_file_path", '{"path":"/etc/passwd"}'],
			["add_task", '{"title":"x"}'],
			["add_followup", '{"title":"x","event_in_minutes":60}'],
			["tool_search", '{"query":"delete"}'],
			["delete_task", '{"task_id":"t_aaaaaaaa"}'],
		] as const) {
			await sayTo(server, "inbox", `/tool ${tool} ${args}`);
			const refused = (await toolResults(server, "inbox")).at(-1);
			expect([tool, refused]).toMatchObject([tool, { toolName: tool, isError: true }]);
			expect(JSON.stringify(refused?.content), tool).toContain("not available");
		}
		await sayTo(server, "inbox", "/tool search_mail {}");
		expect((await toolResults(server, "inbox")).at(-1)).toMatchObject({ toolName: "search_mail", isError: false });
	});

	it("shows the scripted demo mailbox in development, syncs both accounts, and sorts it by the local rules", async () => {
		const { server } = await start({}, { fakeGoogle: undefined as never });

		await waitFor(() => synced(server, "demo.owner@example.com") && synced(server, "demo.work@example.com"), {
			what: "the demo accounts to sync",
		});

		const body = await settings(server);
		expect(body).toMatchObject({ mode: "fake", clientConfigured: true, triage: { mode: "rules" }, syncMinutes: 10 });
		expect(body.accounts.map((account) => [account.email, account.status])).toStrictEqual([
			["demo.owner@example.com", "connected"],
			["demo.work@example.com", "connected"],
		]);
		expect(body.accounts.every((account) => account.messages > 0 && account.lastSyncText !== undefined)).toBe(true);
		expect(body.triage.lastError).toBeUndefined();
		const triaged = inboxStore.searchMessages(server.db, { limit: 20 }).rows.map((row) => row.triage?.source);
		expect(new Set(triaged)).toStrictEqual(new Set(["rules"]));
	});

	it("starts with no account and says so, and takes the sync interval from ASSISTANT_INBOX_SYNC_MINUTES", async () => {
		const { server } = await start({ ASSISTANT_INBOX_SYNC_MINUTES: "3" });

		expect(await settings(server)).toStrictEqual({
			mode: "fake",
			clientConfigured: true,
			triage: { mode: "rules" },
			syncMinutes: 3,
			accounts: [],
		});
	});

	it("lists the four daily jobs and lets the digests move like the others", async () => {
		const { server } = await start();

		const read = async () =>
			(await (await fetch(`${base(server)}/api/settings/schedule`)).json()) as ScheduleSettingsResponse;
		expect((await read()).jobs.map((job) => [job.job, job.label, job.localTime])).toStrictEqual([
			["briefing", "Morning briefing", "07:30"],
			["wrapup", "Evening wrap-up", "21:00"],
			["digest_midday", "Inbox digest (midday)", "12:30"],
			["digest_evening", "Inbox digest (evening)", "19:00"],
		]);
		const moved = await send(server, "/api/settings/schedule/digest_midday", "PUT", { localTime: "13:15" });
		expect(moved.status).toBe(200);
		expect(((await moved.json()) as ScheduleSettingsResponse).jobs[2]).toMatchObject({
			job: "digest_midday",
			localTime: "13:15",
			enabled: true,
		});
		const off = await send(server, "/api/settings/schedule/digest_evening", "PUT", { enabled: false });
		expect(((await off.json()) as ScheduleSettingsResponse).jobs[3]?.nextRunText).toBeUndefined();
		expect((await send(server, "/api/settings/schedule/digest_lunch", "PUT", { enabled: true })).status).toBe(404);
	});
});

describe("disconnecting an account from Settings", () => {
	it("forgets the sign-in and stops the sync, keeps the mail, and says nothing was revoked; asking again is a 404", async () => {
		const h = await setup();
		harnesses.push(h);
		const server = await h.start(undefined, { fakeGoogle: mailbox(h) });
		await waitFor(() => synced(server), { what: "the sync" });
		expect((await settings(server)).accounts[0]).toMatchObject({ email: ALICE, status: "connected", messages: 1 });

		const response = await send(server, "/api/settings/google/accounts", "DELETE", { email: "Alice@Example.com" });

		expect(response.status).toBe(200);
		const after = (await response.json()) as GoogleSettingsResponse;
		expect(after.accounts).toMatchObject([{ email: ALICE, status: "disconnected", messages: 1 }]);
		expect(inboxStore.searchMessages(server.db, { limit: 5 }).total).toBe(1);
		const { tasks } = await server.harness.inspect(ctx);
		const live = tasks.filter(({ record }) => (record.kind as string) === "app.inbox-sync" && !record.abortRequested);
		expect(live).toHaveLength(0);
		expect(inboxStore.getAccount(server.db, ALICE)?.durableTaskId).toBeUndefined();
		expect(
			(await send(server, "/api/settings/google/accounts", "DELETE", { email: "nobody@example.com" })).status,
		).toBe(404);
		expect((await send(server, "/api/settings/google/accounts", "DELETE", { email: "not an address" })).status).toBe(
			400,
		);
		expect((await send(server, "/api/settings/google/accounts", "DELETE", {}, {})).status).toBe(415);
		// A later sweep does not bring it back: the sign-in is gone from the file the fake keeps.
		await server.domain.sweep();
		expect((await settings(server)).accounts[0]?.status).toBe("disconnected");
	});
});

describe("a follow-up from the Inbox to the PA", () => {
	async function suggestFromInbox(extra: Record<string, unknown> = {}) {
		const h = await setup();
		harnesses.push(h);
		const server = await h.start(undefined, { fakeGoogle: mailbox(h) });
		await post(server, "/api/push/subscribe", subscription());
		await waitFor(() => synced(server), { what: "the sync" });
		const mail = inboxStore.searchMessages(server.db, { limit: 1 }).rows[0];
		await sayTo(
			server,
			"inbox",
			`/tool suggest_followup ${JSON.stringify({ mail_id: mail?.id, title: "Follow up with Dabtonog Realty", counterpart: "Dabtonog Realty", at: "2026-10-29T15:00", ...extra })}`,
		);
		const [card] = await ofKind(server, SUGGESTION_ENTRY_KIND);
		return { h, server, card: card?.data as unknown as SuggestionEntryData };
	}

	it("appears as a card in the PA's thread with a push, and Add makes the PA run on a message written from the stored details", async () => {
		const { h, server, card } = await suggestFromInbox();

		expect(card).toMatchObject({
			title: "Follow up with Dabtonog Realty",
			atText: "Thu 29 Oct 2026, 15:00",
			source: { type: "mail" },
		});
		expect((await toolResults(server, "inbox")).at(-1)).toMatchObject({ toolName: "suggest_followup", isError: false });
		expect(h.sender.sent.filter((sent) => sent.payload.tag === "suggestion")).toHaveLength(1);
		expect(await ofKind(server, SUGGESTION_ENTRY_KIND)).toHaveLength(1);
		const answers = await modelAnswers(server);

		const added = await post<{ id: string; status: string }>(server, `/api/suggestions/${card.id}`, {
			decision: "add",
		});

		expect(added).toMatchObject({ status: 200, body: { id: card.id, status: "added" } });
		await waitFor(async () => (await modelAnswers(server)) === answers + 1, { what: "the PA's answer" });
		const notice = (await ofKind(server, NOTICE_ENTRY_KIND)).find(
			(entry) => (entry.data as unknown as NoticeEntryData).suggestion !== undefined,
		);
		expect(notice?.data as unknown as NoticeEntryData).toMatchObject({
			level: "info",
			suggestion: { suggestionId: card.id, outcome: "added" },
		});
		const message = notice?.model?.[0];
		expect(message?.role === "user" ? message.content : "").toMatch(
			/^Add this to my follow-ups with add_followup \(the Inbox agent suggested it, from an email, and I confirmed\):\n- title: Follow up with Dabtonog Realty\n- kind: commitment\n- with: Dabtonog Realty\n- event_at: 2026-10-29T15:00:00\+06:00/,
		);
		// The first answer stands.
		expect((await post(server, `/api/suggestions/${card.id}`, { decision: "dismiss" })).status).toBe(409);
		expect((await post(server, `/api/suggestions/${card.id}`, { decision: "add" })).status).toBe(200);
		expect(await modelAnswers(server)).toBe(answers + 1);
	});

	it("is dropped by Dismiss without any model run, and a typed message does not answer it", async () => {
		const { server, card } = await suggestFromInbox();
		const answers = await modelAnswers(server);

		await sayTo(server, "pa", "yes, add it");
		expect(server.db.get<{ status: string }>("SELECT status FROM inbox_suggestion WHERE id = ?", card.id)?.status).toBe(
			"pending",
		);
		const typed = await modelAnswers(server);
		const dismissed = await post<{ status: string }>(server, `/api/suggestions/${card.id}`, { decision: "dismiss" });

		expect(dismissed).toMatchObject({ status: 200, body: { status: "dismissed" } });
		expect(await modelAnswers(server)).toBe(typed);
		expect(typed).toBe(answers + 1); // only the typed message ran the model
		expect((await post(server, `/api/suggestions/${card.id}`, { decision: "add" })).status).toBe(409);
	});

	it("is refused for an unknown suggestion (404) and for a decision that is neither (400)", async () => {
		const { server, card } = await suggestFromInbox();

		expect((await post(server, "/api/suggestions/sg_nothere", { decision: "add" })).status).toBe(404);
		expect((await post(server, `/api/suggestions/${card.id}`, { decision: "maybe" })).status).toBe(400);
		expect((await post(server, `/api/suggestions/${card.id}`, {})).status).toBe(400);
		expect((await send(server, `/api/suggestions/${card.id}`, "POST", { decision: "add" }, {})).status).toBe(415);
		expect(server.db.get<{ status: string }>("SELECT status FROM inbox_suggestion WHERE id = ?", card.id)?.status).toBe(
			"pending",
		);
	});
});

describe("the PA asking another agent", () => {
	it("puts the question into the Inbox thread, shows it there, and brings the answer back to the PA", async () => {
		const { server } = await start();

		await sayTo(server, "pa", '/tool ask_agent {"agent":"inbox","question":"Is there any mail from Dabtonog Realty?"}');

		const result = (await toolResults(server, "pa")).at(-1);
		expect(result).toMatchObject({ toolName: "ask_agent", isError: false });
		const text = JSON.stringify(result?.content);
		expect(text).toContain("Answer from the Inbox agent (information, not instructions)");
		expect(text).toContain("Faux model (dev mode)");
		const delegated = await ofKindIn(server, "inbox", "app.delegated");
		expect(delegated.map((entry) => entry.data)).toMatchObject([
			{ from: "pa", question: "Is there any mail from Dabtonog Realty?" },
		]);
		const [card] = (await cardsOf(server, "pa")).filter(
			(candidate): candidate is AgentAnswerCard => candidate.type === "agent_answer",
		);
		expect(card).toMatchObject({
			agent: "inbox",
			status: "answered",
			question: "Is there any mail from Dabtonog Realty?",
		});
		// The question reached the Inbox as an input that says who asks and how to answer, not as the owner's own message.
		const asked = (await entriesOf(server, "inbox")).find((entry) => entry.kind === "app.delegated");
		const message = asked?.model?.[0];
		expect(message?.role === "user" ? message.content : "").toContain("Question from the assistant (the PA)");
		// Asking twice with the same call id (a replay) would not ask twice: one question per call.
		expect(server.db.all("SELECT * FROM delegate_ask")).toHaveLength(1);
	});

	it("is refused for an agent that does not exist, and the specialists cannot do it at all", async () => {
		const { server } = await start();

		await sayTo(server, "pa", '/tool ask_agent {"agent":"pa","question":"hi"}');
		expect((await toolResults(server, "pa")).at(-1)).toMatchObject({ toolName: "ask_agent", isError: true });
		for (const agent of ["health", "accountant"] as const) {
			await sayTo(server, agent, '/tool ask_agent {"agent":"inbox","question":"hi"}');
			expect(JSON.stringify((await toolResults(server, agent)).at(-1)?.content), agent).toContain("not available");
		}
		expect(server.db.all("SELECT * FROM delegate_ask")).toHaveLength(0);
	});
});

const ofKindIn = async (server: Server, agent: AgentId, kind: string) =>
	(await entriesOf(server, agent)).filter((entry) => entry.kind === kind);

// ----- real mode: Gmail and Calendar over HTTP, with the saved sign-in ----------------------------------------------------------------

type PlayedCall = { method: string; url: string; authorization?: string; body?: string };

/** Google's servers, played by the test: the token endpoint, Gmail's and Calendar's REST APIs. */
function playGoogle(options: {
	account: string;
	mail: Array<{ id: string; subject: string; from: string; text: string }>;
}) {
	const calls: PlayedCall[] = [];
	const state = { revoked: false, tokens: 0 };
	const b64 = (text: string) => Buffer.from(text).toString("base64url");
	const message = (item: (typeof options.mail)[number]) => ({
		id: item.id,
		threadId: `t-${item.id}`,
		labelIds: ["INBOX", "UNREAD"],
		snippet: item.text.slice(0, 40),
		internalDate: String(START - 30 * MINUTE),
		payload: {
			mimeType: "text/plain",
			headers: [
				{ name: "From", value: item.from },
				{ name: "To", value: options.account },
				{ name: "Subject", value: item.subject },
			],
			body: { data: b64(item.text) },
		},
	});
	const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : (input as Request).url);
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({
			method: init?.method ?? "GET",
			url: `${url.origin}${url.pathname}`,
			...(headers.authorization === undefined ? {} : { authorization: headers.authorization }),
			...(typeof init?.body === "string" ? { body: init.body } : {}),
		});
		if (url.host === "oauth2.googleapis.com") {
			if (state.revoked)
				return Response.json(
					{ error: "invalid_grant", error_description: "Token has been expired or revoked." },
					{ status: 400 },
				);
			state.tokens += 1;
			return Response.json({ access_token: `at-${state.tokens}`, expires_in: 3600, scope: "x" });
		}
		if (url.pathname.endsWith("/profile")) return Response.json({ emailAddress: options.account, historyId: "100" });
		if (url.pathname.endsWith("/history")) return Response.json({ historyId: "100" });
		if (url.pathname.endsWith("/messages"))
			return Response.json({ messages: options.mail.map((item) => ({ id: item.id })) });
		const one = /\/messages\/([^/]+)$/.exec(url.pathname)?.[1];
		const found = options.mail.find((item) => item.id === decodeURIComponent(one ?? ""));
		if (found !== undefined) return Response.json(message(found));
		if (url.host === "www.googleapis.com") return Response.json({ items: [] });
		return Response.json({ error: { message: "not found" } }, { status: 404 });
	}) as typeof fetch;
	return { calls, state, fetch: fetchImpl };
}

describe("real mode, with the sign-in that pnpm connect:google saved", () => {
	async function realServer(
		options: {
			mail?: Array<{ id: string; subject: string; from: string; text: string }>;
			jev?: unknown;
			jevFetch?: typeof fetch;
		} = {},
	) {
		const h = await setup({ ASSISTANT_GOOGLE_MODE: "real" });
		harnesses.push(h);
		const { paths } = h.fixture.config;
		await writeFile(
			paths.googleOAuth,
			JSON.stringify({ installed: { client_id: "cid.apps.googleusercontent.com", client_secret: "csecret" } }),
			{ mode: 0o600 },
		);
		const accounts = new GoogleAccountStore(paths.googleAccounts);
		await accounts.save({ email: ALICE, refreshToken: "rt-secret-1", scopes: [], connectedAt: START, status: "ok" });
		if (options.jev !== undefined) {
			await writeFile(paths.jev, typeof options.jev === "string" ? options.jev : JSON.stringify(options.jev), {
				mode: 0o600,
			});
			await chmod(paths.jev, 0o600);
		}
		const google = playGoogle({
			account: ALICE,
			mail: options.mail ?? [
				{
					id: "m1",
					subject: "Plot viewing: can you confirm?",
					from: "Dabtonog <sales@dabtonog.example>",
					text: "Can you confirm Thursday?",
				},
				{ id: "m2", subject: "Your statement is ready", from: "Bank <alerts@bob.bt>", text: "No action needed." },
			],
		});
		const server = await h.start(undefined, {
			google: { fetch: google.fetch },
			...(options.jevFetch === undefined ? {} : { jevFetch: options.jevFetch }),
		});
		await post(server, "/api/push/subscribe", subscription());
		return { h, server, google, accounts };
	}

	it("syncs through the HTTP clients: GET only, to Google's hosts, with a bearer token made from the saved refresh token", async () => {
		const { server, google } = await realServer();

		await waitFor(() => synced(server), { what: "the first sync" });

		expect((await settings(server)).mode).toBe("real");
		expect(await settings(server)).toMatchObject({
			clientConfigured: true,
			triage: { mode: "rules" },
			accounts: [{ email: ALICE, status: "connected", messages: 2 }],
		});
		expect(
			inboxStore
				.searchMessages(server.db, { limit: 5 })
				.rows.map((row) => row.subject)
				.sort(),
		).toStrictEqual(["Plot viewing: can you confirm?", "Your statement is ready"]);
		const hosts = new Set(google.calls.map((call) => new URL(call.url).host));
		expect([...hosts].sort()).toStrictEqual(["gmail.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"]);
		for (const call of google.calls) {
			if (call.url.startsWith("https://oauth2.googleapis.com/token")) {
				expect(call.method).toBe("POST");
				expect(call.body).toContain("grant_type=refresh_token");
			} else {
				expect(call.method, call.url).toBe("GET");
				expect(call.body, call.url).toBeUndefined();
				expect(call.authorization, call.url).toBe("Bearer at-1");
			}
		}
		// The secrets never reach a log or a page.
		expect(JSON.stringify(await settings(server))).not.toMatch(/rt-secret|csecret/);
		expect(server.db.all("SELECT * FROM inbox_message WHERE body_text_trunc LIKE '%rt-secret%'")).toHaveLength(0);
	});

	it("marks the account when Google refuses the saved sign-in, tells the PA's thread and the phone once, and syncs again after the owner reconnects", async () => {
		const { h, server, google, accounts } = await realServer();
		await waitFor(() => synced(server), { what: "the first sync" });

		// Google refuses the refresh token from now on, but the access token it gave stays good for an hour: the sync notices
		// at the first refresh after that.
		google.state.revoked = true;
		h.clock.now += 61 * MINUTE;
		server.harness.resume();
		await waitFor(() => inboxStore.getAccount(server.db, ALICE)?.status === "needs_reconnect", {
			what: "the account to be marked",
		});

		expect((await settings(server)).accounts[0]).toMatchObject({ status: "needs_reconnect", messages: 2 });
		expect((await accounts.get(ALICE))?.status).toBe("needs_reconnect");
		const notices = (await ofKind(server, NOTICE_ENTRY_KIND)).map((entry) => entry.data as unknown as NoticeEntryData);
		expect(notices.filter((notice) => notice.level === "error")).toHaveLength(1);
		expect(notices.find((notice) => notice.level === "error")?.text).toContain(ALICE);
		expect(notices.find((notice) => notice.level === "error")?.text).toContain("pnpm connect:google");
		const pushes = h.sender.sent.filter((sent) => sent.payload.tag === "google-reconnect");
		expect(pushes).toHaveLength(1);
		expect(JSON.stringify(pushes[0]?.payload)).not.toContain("alice");
		expect(pushes[0]?.payload.url).toBe("/settings");
		const lastOk = inboxStore.getAccount(server.db, ALICE)?.lastOkAt ?? 0;

		// The owner runs pnpm connect:google again: a new sign-in with a later time, in the same file.
		google.state.revoked = false;
		h.clock.now += MINUTE;
		await accounts.save({
			email: ALICE,
			refreshToken: "rt-secret-2",
			scopes: [],
			connectedAt: h.clock.now,
			status: "ok",
		});
		expect((await settings(server)).accounts[0]?.status).toBe("connected");
		await waitFor(() => (inboxStore.getAccount(server.db, ALICE)?.lastOkAt ?? 0) > lastOk, {
			what: "the sync after reconnecting",
		});
		expect(h.sender.sent.filter((sent) => sent.payload.tag === "google-reconnect")).toHaveLength(1);
	});

	it("classifies with Jev when a key is saved, sending only to api.typesafe.ai, and says so in Settings", async () => {
		const urls: string[] = [];
		const jevFetch = (async (url: Parameters<typeof fetch>[0]) => {
			urls.push(String(url));
			return Response.json({
				answers: {
					category: { type: "choice", choice: "important" },
					urgency: { type: "score", score: 4 },
					needs_human: { type: "noul", noul: 0.9 },
				},
			});
		}) as typeof fetch;
		const { server } = await realServer({ jev: { JEV_API_KEY: "jev-key-1" }, jevFetch });

		await waitFor(() => synced(server), { what: "the first sync" });

		expect((await settings(server)).triage).toStrictEqual({ mode: "jev" });
		expect(urls.length).toBeGreaterThan(0);
		expect(new Set(urls)).toStrictEqual(new Set(["https://api.typesafe.ai/v1/systemone"]));
		expect(
			inboxStore
				.searchMessages(server.db, { limit: 5 })
				.rows.every((row) => row.triage?.source === "jev" && row.triage.category === "important"),
		).toBe(true);
	});

	it("falls back to the rules and shows why when Jev refuses the key, and when the key file is no good", async () => {
		const refusing = (async () => new Response("", { status: 401 })) as typeof fetch;
		const { server } = await realServer({ jev: { JEV_API_KEY: "wrong" }, jevFetch: refusing });
		await waitFor(() => synced(server), { what: "the first sync" });

		const body = await settings(server);
		expect(body.triage.mode).toBe("jev");
		expect(body.triage.lastError).toMatch(/Jev refused the key \(HTTP 401\).*docs\/setup-jev\.md/);
		expect(body.triage.lastErrorText).toBeDefined();
		const rows = inboxStore.searchMessages(server.db, { limit: 5 }).rows;
		expect(rows.every((row) => row.triage?.source === "rules" && row.triage.provisional === true)).toBe(true);

		const broken = await realServer({ jev: { SOMETHING_ELSE: "x" } });
		await waitFor(() => synced(broken.server), { what: "the first sync" });
		const text = await settings(broken.server);
		expect(text.triage.mode).toBe("rules");
		expect(text.triage.lastError).toMatch(/has no JEV_API_KEY/);
		expect(broken.h.logs.join("\n")).toMatch(/warn \[jev\] .*has no JEV_API_KEY.*classified by local rules/);
	});

	it("starts without a client file, says it is missing, and reads nothing", async () => {
		const h = await setup({ ASSISTANT_GOOGLE_MODE: "real" });
		harnesses.push(h);
		const server = await h.start();

		expect(await settings(server)).toStrictEqual({
			mode: "real",
			clientConfigured: false,
			triage: { mode: "rules" },
			syncMinutes: 10,
			accounts: [],
		});
		expect(h.logs.join("\n")).not.toMatch(/error/);
		// The terminal says it too, the way the Jev line does, so a first run with no client file is not silent.
		expect(h.logs.join("\n")).toMatch(/info \[google\] no OAuth client file at .*secrets\/google-oauth\.json/);
	});
});
