import {
	type AgentAnswerCard,
	DAILY_ENTRY_KIND,
	type DailyEntryData,
	DELEGATED_ENTRY_KIND,
	type EntryRecord,
	type EventListCard,
	gmailThreadUrl,
	LATE_ANSWER_ENTRY_KIND,
	type MailCard,
	type MailItem,
	type MailListCard,
	NOTICE_ENTRY_KIND,
	SUGGESTION_ENTRY_KIND,
	type SuggestionEntryData,
	type SuggestionSummary,
} from "@assistant/shared";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardView } from "../src/components/cards.tsx";
import {
	AgentAnswerView,
	DelegatedView,
	EventListView,
	gmailLink,
	InboxNoteView,
	LateAnswerView,
	MailListView,
	MailView,
	SuggestionSentView,
	SuggestionView,
} from "../src/components/inbox-cards.tsx";
import { ApiRequestError } from "../src/lib/api.ts";
import { cardSummary } from "../src/lib/card-text.ts";
import { answeredTheOtherWay } from "../src/lib/suggestion-form.ts";
import { toUiMessages, type UiCard, type UiMessage } from "../src/lib/ui-messages.ts";

function render<Props extends object>(component: (props: Props) => ReactElement, props: Props): string {
	return renderToStaticMarkup(createElement(component as FunctionComponent<Props>, props));
}
const renderCard = (card: UiCard): string => renderToStaticMarkup(createElement(CardView, { card }));
const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

const url = gmailThreadUrl("work@x.example", "t_abc");
const mail = (over: Partial<MailItem> = {}): MailItem => ({
	id: 12,
	account: "work@x.example",
	from: "Dabtonog Realty <agent@dabtonog.example>",
	subject: "Plot viewing on Thursday",
	dateText: "Mon 26 Oct 2026, 09:14",
	category: "needs_reply",
	urgency: 4,
	snippet: "Can you confirm 15:00?",
	url,
	...over,
});

describe("where a mail's link goes", () => {
	it("follows Gmail's own address and nothing else, whatever the stored card says", () => {
		expect(gmailLink(url)).toBe(url);
		for (const hostile of [
			"javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"http://mail.google.com/mail/u/a@b.example/#all/t",
			"https://mail.google.com.evil.example/mail/u/a@b.example/#all/t",
			"https://evil.example/https://mail.google.com/",
			"https://user:pw@mail.google.com/mail/",
			"https://mail.google.com:8443/mail/",
			"//mail.google.com/mail/",
			"not a url",
			"",
		]) {
			expect(gmailLink(hostile), hostile).toBeUndefined();
		}
		expect(gmailLink(undefined)).toBeUndefined();
	});
});

describe("mail lists", () => {
	const card: MailListCard = { type: "mail_list", heading: "Mail, last 14 days", mails: [mail()], total: 3 };

	it("lists each mail with a link that opens Gmail in a new tab without handing the page over, its category, sender, date and account", () => {
		const markup = render(MailListView, { card });

		expect(markup).toContain(
			`<a href="${url}" target="_blank" rel="noopener noreferrer" title="Open in Gmail">Plot viewing on Thursday</a>`,
		);
		expect(markup).toContain('<span class="badge badge--mail badge--mail-needs_reply">needs a reply</span>');
		expect(markup).toContain(
			"Dabtonog Realty &lt;agent@dabtonog.example&gt; · Mon 26 Oct 2026, 09:14 · work@x.example",
		);
		expect(markup).toContain("Can you confirm 15:00?");
		expect(markup).toContain("…and 2 more");
	});

	it("shows what an email says as text, never as markup: a hostile subject, sender and snippet are escaped", () => {
		const hostile = mail({
			subject: '<img src=x onerror="alert(1)">',
			from: "<script>steal()</script>",
			snippet: "<b onmouseover=x>hi</b>",
		});

		const markup = render(MailListView, { card: { ...card, mails: [hostile], total: 1 } });

		expect(markup).not.toContain("<img");
		expect(markup).not.toContain("<script");
		expect(markup).not.toContain("<b ");
		expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
	});

	it("draws a mail whose address is not Gmail's as plain text, with no link at all", () => {
		const markup = render(MailListView, {
			card: { ...card, mails: [mail({ url: "https://evil.example/phish" })], total: 1 },
		});

		expect(markup).toContain("Plot viewing on Thursday");
		expect(markup).not.toContain("<a ");
		expect(markup).not.toContain("evil.example");
	});

	it("says so when nothing matched, and does not invent a category for a mail that has none yet", () => {
		expect(render(MailListView, { card: { ...card, mails: [], total: 0 } })).toContain("No mail found.");
		const unsorted = render(MailListView, { card: { ...card, mails: [mail({ category: undefined })], total: 1 } });
		expect(unsorted).not.toContain("badge--mail");
	});
});

describe("one mail read", () => {
	const card: MailCard = {
		type: "mail",
		mail: mail(),
		to: "me@x.example",
		text: "Hello,\n<script>x()</script>\nSee you.",
		more: true,
	};

	it("keeps the text folded, as text, and says when it is only the first part", () => {
		const markup = render(MailView, { card });

		expect(markup).toContain("<summary>Text of the mail (the first part)</summary>");
		expect(markup).not.toContain("<details open");
		expect(markup).toContain("Hello,\n&lt;script&gt;x()&lt;/script&gt;\nSee you.");
		expect(markup).not.toContain("<script");
		expect(markup).toContain("To: me@x.example");
		// The snippet repeats the text, so the header does not show it.
		expect(markup).not.toContain("Can you confirm 15:00?");
	});
});

describe("calendar events", () => {
	const card: EventListCard = {
		type: "event_list",
		heading: "Calendar, this week",
		total: 3,
		events: [
			{
				id: 5,
				account: "work@x.example",
				title: "Plot viewing",
				startText: "Thu 29 Oct 2026, 15:00",
				endText: "16:00",
				allDay: false,
				attendees: ["a@x.example", "b@x.example", "c@x.example", "d@x.example", "e@x.example", "f@x.example"],
				location: "Dabtonog",
			},
			{ id: 6, account: "work@x.example", title: "Losar", startText: "Fri 30 Oct 2026", allDay: true, attendees: [] },
		],
	};

	it("shows the time range, the first attendees and how many more, the place and the account; an all-day event has no clock", () => {
		const markup = render(EventListView, { card });

		expect(markup).toContain("Thu 29 Oct 2026, 15:00 to 16:00");
		expect(markup).toContain("With a@x.example, b@x.example, c@x.example, d@x.example and 2 more");
		expect(markup).toContain("At Dabtonog");
		expect(markup).toContain("Fri 30 Oct 2026 · all day");
		expect(markup).toContain("…and 1 more");
	});

	it("says what an empty calendar means", () => {
		expect(render(EventListView, { card: { ...card, events: [], total: 0 } })).toContain(
			"Nothing in the calendar for this.",
		);
	});

	it("shows a note as a note", () => {
		expect(render(InboxNoteView, { card: { type: "inbox_note", text: "Marked as important." } })).toContain(
			"Marked as important.",
		);
	});
});

describe("inbox digests", () => {
	const digest = (over: Partial<DailyEntryData> = {}): UiCard => ({
		type: "daily",
		data: {
			job: "digest_midday",
			date: "2026-10-26",
			dateText: "Mon 26 Oct 2026",
			firedAt: 1,
			sections: [
				{
					title: "Mail that needs your attention",
					lines: ["[12] one line", "[13] another", "… and 4 more (search_mail finds them)"],
					mail: [mail(), mail({ id: 13, subject: "Invoice due", category: "finance", account: "me@y.example" })],
				},
			],
			...over,
		},
	});

	it("lists the mail it picked out, open, each a link to its conversation in Gmail, so that nothing needs a tap to be seen", () => {
		const markup = renderCard(digest());

		expect(markup).toContain("Inbox digest");
		expect(markup).toContain('<details class="card__facts" open="">');
		expect(markup).toContain("Mail the assistant picked out");
		expect(count(markup, 'rel="noopener noreferrer"')).toBe(2);
		expect(markup).toContain(`href="${url}"`);
		expect(markup).toContain("Invoice due");
		expect(markup).toContain("me@y.example");
		// The model's text for the extra mails is the last line, and it is the card's too.
		expect(markup).toContain("… and 4 more (search_mail finds them)");
		expect(markup).not.toContain("[12] one line");
	});

	it("keeps the briefing's facts folded and as lines, as before", () => {
		const markup = renderCard({
			type: "daily",
			data: {
				job: "briefing",
				date: "2026-10-26",
				dateText: "Mon 26 Oct 2026",
				firedAt: 1,
				sections: [{ title: "Tasks due today", lines: ["Pay rent (t_1)"] }],
			},
		});

		expect(markup).toContain("Morning briefing");
		expect(markup).not.toContain("open=");
		expect(markup).toContain("<li>Pay rent (t_1)</li>");
	});

	it("says in its own words that no mail needs attention, not that there is nothing on a task list", () => {
		const markup = renderCard(digest({ sections: [], empty: true }));

		expect(markup).toContain("No mail needs your attention since the last digest.");
		expect(markup).not.toContain("Enjoy the day");
		expect(renderCard(digest({ job: "digest_evening", sections: [], empty: true }))).toContain("Inbox digest");
	});

	it("is an Inbox digest in a screen reader's list, and says nothing new when it is empty", () => {
		expect(cardSummary(digest())).toBe("Inbox digest, Mon 26 Oct 2026");
		expect(cardSummary(digest({ sections: [], empty: true }))).toBe("Inbox digest, Mon 26 Oct 2026: nothing new");
	});
});

describe("suggestions", () => {
	const suggestion: SuggestionSummary = {
		id: "sg_ab12cd34",
		kind: "meeting",
		title: "Follow up with Dabtonog Realty",
		counterpart: "Dabtonog Realty",
		context: "They asked to confirm the plot viewing",
		at: 1,
		atText: "Thu 29 Oct 2026, 15:00",
		endsAtText: "16:00",
		source: { type: "mail", label: "Plot viewing on Thursday", url },
	};
	const props = (state: Parameters<typeof SuggestionView>[0]["state"]) => ({
		suggestion,
		state,
		action: createElement("button", { type: "button", id: "the-buttons" }, "Add / Dismiss"),
	});

	it("asks the owner, shows exactly what would be added and where it came from, and puts the buttons under it", () => {
		const markup = render(SuggestionView, props({ status: "pending" }));

		expect(markup).toContain("The Inbox suggests");
		expect(markup).toContain("Follow up with Dabtonog Realty");
		expect(markup).toContain("Meeting with Dabtonog Realty · Thu 29 Oct 2026, 15:00 to 16:00");
		expect(markup).toContain("They asked to confirm the plot viewing");
		expect(markup).toContain(`From an email: <a href="${url}"`);
		expect(markup).toContain("Nothing is added until you press Add.");
		expect(markup).toContain('id="the-buttons"');
	});

	it("takes the buttons away from a suggestion that waited a week, and says nothing was added", () => {
		const expired = render(SuggestionView, props({ status: "expired" }));

		expect(expired).not.toContain("the-buttons");
		expect(expired).toContain("Expired: nobody answered within 7 days, so nothing was added.");
		expect(expired).toContain("card--expired");
	});

	it("takes the buttons away once the owner has answered, and says what they did", () => {
		const added = render(SuggestionView, props({ status: "added", text: "You asked the assistant to add it." }));
		const dismissed = render(SuggestionView, props({ status: "dismissed", text: "You dismissed it." }));

		expect(added).not.toContain("the-buttons");
		expect(added).toContain("You pressed Add: the assistant was asked to save it.");
		expect(dismissed).not.toContain("the-buttons");
		expect(dismissed).toContain("Dismissed.");
	});

	it("draws the real buttons in the PA's thread: both on, labelled Add and Dismiss", () => {
		const markup = renderCard({
			type: "suggestion",
			data: { ...suggestion, firedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER },
			state: { status: "pending" },
		});

		expect(markup).toContain(">Add</button>");
		expect(markup).toContain(">Dismiss</button>");
		expect(markup).not.toContain("disabled");
	});

	it("tells the Inbox's own thread where the suggestion went, without claiming it is still waiting", () => {
		const markup = render(SuggestionSentView, { card: { type: "suggestion_sent", suggestion } });

		expect(markup).toContain("Suggested to the assistant");
		expect(markup).toContain("It is added to your follow-ups only if you press Add there.");
		// The owner's answer is in the PA's thread: this card cannot know it, so it must not say "waiting" (browser check BC2).
		expect(markup).not.toMatch(/waiting/i);
	});

	it("keeps the buttons off after a 409 (the other answer won) and only then", () => {
		expect(answeredTheOtherWay(new ApiRequestError(409, "conflict", "Suggestion sg_1 was already dismissed."))).toBe(
			true,
		);
		expect(answeredTheOtherWay(new ApiRequestError(404, "not_found", "There is no suggestion."))).toBe(false);
		expect(answeredTheOtherWay(new ApiRequestError(0, "network", "Cannot reach the assistant server."))).toBe(false);
		expect(answeredTheOtherWay(new Error("boom"))).toBe(false);
	});
});

describe("one agent asking another", () => {
	it("shows the specialist the question it was asked, as text", () => {
		const markup = render(DelegatedView, { data: { from: "pa", question: "Any mail from <b>Pema</b>?", firedAt: 1 } });

		expect(markup).toContain("Asked by the assistant");
		expect(markup).toContain("Any mail from &lt;b&gt;Pema&lt;/b&gt;?");
	});

	it("shows the PA what ask_agent got: the answer, or that the agent is still working, or that it failed", () => {
		const card: AgentAnswerCard = {
			type: "agent_answer",
			agent: "inbox",
			question: "Anything from the bank?",
			status: "answered",
			answer: "Two mails: a statement and a notice.",
		};

		const answered = render(AgentAnswerView, { card });
		expect(answered).toContain("Asked the Inbox");
		expect(answered).toContain("Two mails: a statement and a notice.");
		const pending = render(AgentAnswerView, { card: { ...card, status: "pending" } });
		expect(pending).toContain("Still working.");
		expect(pending).not.toContain("Two mails");
		expect(render(AgentAnswerView, { card: { ...card, status: "failed" } })).toContain("It could not be answered.");
	});

	it("shows an answer that came after the PA stopped waiting, with the question it answers", () => {
		const markup = render(LateAnswerView, {
			data: { agent: "accountant", question: "What did I spend?", answer: "Nu. 4,500.00 on food.", firedAt: 1 },
		});

		expect(markup).toContain("Answer from the Accountant");
		expect(markup).toContain("You asked: What did I spend?");
		expect(markup).toContain("Nu. 4,500.00 on food.");
	});

	it("is a sentence in a screen reader's list for every card of the Inbox", () => {
		const base = { id: 1, account: "a@x.example", startText: "Mon", allDay: true, attendees: [] };
		const cards: UiCard[] = [
			{ type: "mail_list", heading: "Mail, last 14 days", mails: [], total: 0 },
			{ type: "mail", mail: mail(), text: "t", more: false },
			{ type: "event_list", heading: "Calendar, today", events: [{ ...base, title: "x" }], total: 1 },
			{ type: "inbox_note", text: "Marked as important." },
			{ type: "agent_answer", agent: "health", question: "Weight?", status: "pending" },
			{ type: "delegated", data: { from: "pa", question: "Weight?", firedAt: 1 } },
		];
		expect(cards.map(cardSummary)).toStrictEqual([
			"Mail, last 14 days: 0",
			"Mail from Dabtonog Realty <agent@dabtonog.example>: Plot viewing on Thursday",
			"Calendar, today: 1",
			"Marked as important.",
			"Asked the Health agent: Weight?",
			"Asked by the assistant: Weight?",
		]);
	});
});

// ----- what the thread makes of the entries -------------------------------------------------------------------------------------------

const entry = (id: number, kind: string, rest: object): EntryRecord =>
	({ id, conversationId: 2, kind, ...rest }) as unknown as EntryRecord;
const suggestionEntry = (id: number, sg: string, expiresAt: number = Number.MAX_SAFE_INTEGER): EntryRecord =>
	entry(id, SUGGESTION_ENTRY_KIND, {
		data: {
			id: sg,
			kind: "commitment",
			title: `Follow up ${sg}`,
			at: 1,
			atText: "Thu 29 Oct 2026, 15:00",
			source: { type: "event", label: "Plot viewing" },
			firedAt: 10_000 + id,
			expiresAt,
		} satisfies SuggestionEntryData,
	});
const notice = (id: number, text: string, suggestion?: { suggestionId: string; outcome: string }): EntryRecord =>
	entry(id, NOTICE_ENTRY_KIND, { data: { text, level: "info", ...(suggestion === undefined ? {} : { suggestion }) } });
const answer = (id: number, text: string): EntryRecord =>
	entry(id, "pi.assistant", {
		model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: id * 1_000 }],
	});
const owner = (id: number, content: string): EntryRecord =>
	entry(id, "pi.user", { model: [{ role: "user", content, timestamp: id * 1_000 }] });
const messagesOf = (entries: EntryRecord[]): UiMessage[] => toUiMessages({ entries, draft: undefined, unanswered: [] });
const cardsOf = (messages: UiMessage[]): UiCard[] =>
	messages.flatMap((message) => (message.role === "system" ? [message.card] : []));
const stateOf = (card: UiCard | undefined) => (card?.type === "suggestion" ? card.state : undefined);

describe("the approval card of a sender rule", () => {
	const approval = (over: { buttonOnly?: true } = {}): UiCard => ({
		type: "approval",
		actionId: "ap_1",
		summary: "From now on classify every mail from deals@shop.example as promo",
		expiresAt: Number.MAX_SAFE_INTEGER,
		state: { status: "pending" },
		...over,
	});

	it("says that only the buttons answer it, because a typed YES does not count for a rule that mail could ask for", () => {
		const markup = renderCard(approval({ buttonOnly: true }));

		expect(markup).toContain("Nothing happens until you tap Approve. A reply of YES does not count for this one.");
		expect(markup).not.toContain("A reply of YES also works");
		expect(markup).toContain(">Approve</button>");
		expect(markup).toContain(">Deny</button>");
	});

	it("keeps the sentence about YES for every other approval", () => {
		expect(renderCard(approval())).toContain("A reply of YES also works");
	});
});

describe("a suggestion's state in the PA's thread", () => {
	it("is waiting until a notice says what the owner did with that suggestion", () => {
		const waiting = cardsOf(messagesOf([suggestionEntry(1, "sg_1")]));
		expect(stateOf(waiting[0])).toStrictEqual({ status: "pending" });

		const added = cardsOf(
			messagesOf([
				suggestionEntry(1, "sg_1"),
				notice(2, "You asked the assistant to add “Follow up sg_1”.", { suggestionId: "sg_1", outcome: "added" }),
			]),
		);
		expect(stateOf(added[0])).toStrictEqual({
			status: "added",
			text: "You asked the assistant to add “Follow up sg_1”.",
		});
		// The notice itself is a card of the thread, too.
		expect(added.map((card) => card.type)).toStrictEqual(["suggestion", "notice"]);

		const dismissed = cardsOf(
			messagesOf([
				suggestionEntry(1, "sg_1"),
				notice(2, "You dismissed it.", { suggestionId: "sg_1", outcome: "dismissed" }),
			]),
		);
		expect(stateOf(dismissed[0])).toMatchObject({ status: "dismissed" });
	});

	it("settles each suggestion by its own id: another one's notice, or an ordinary notice, changes nothing", () => {
		const cards = cardsOf(
			messagesOf([
				suggestionEntry(1, "sg_1"),
				suggestionEntry(2, "sg_2"),
				notice(3, "You dismissed sg_2.", { suggestionId: "sg_2", outcome: "dismissed" }),
				notice(4, "Something else happened."),
			]),
		);

		expect(cards.filter((card) => card.type === "suggestion").map(stateOf)).toStrictEqual([
			{ status: "pending" },
			{ status: "dismissed", text: "You dismissed sg_2." },
		]);
	});

	it("is expired once its week has passed unanswered, by the clock the thread is drawn with, and an answer is not undone by it", () => {
		const expiresAt = 1_000_000;
		const entries = [
			suggestionEntry(1, "sg_old", expiresAt),
			suggestionEntry(2, "sg_answered", expiresAt),
			notice(3, "You dismissed it.", { suggestionId: "sg_answered", outcome: "dismissed" }),
		];
		const states = (now: number) =>
			cardsOf(toUiMessages({ entries, draft: undefined, unanswered: [] }, now))
				.filter((card) => card.type === "suggestion")
				.map(stateOf);

		expect(states(expiresAt - 1)).toStrictEqual([
			{ status: "pending" },
			{ status: "dismissed", text: "You dismissed it." },
		]);
		expect(states(expiresAt)).toStrictEqual([
			{ status: "expired" },
			{ status: "dismissed", text: "You dismissed it." },
		]);
	});

	it("goes by the first answer, as the server does", () => {
		const cards = cardsOf(
			messagesOf([
				suggestionEntry(1, "sg_1"),
				notice(2, "Added.", { suggestionId: "sg_1", outcome: "added" }),
				notice(3, "Dismissed.", { suggestionId: "sg_1", outcome: "dismissed" }),
			]),
		);

		expect(stateOf(cards[0])).toMatchObject({ status: "added", text: "Added." });
	});

	it("ignores a notice that names an outcome it does not know", () => {
		const cards = cardsOf(
			messagesOf([suggestionEntry(1, "sg_1"), notice(2, "?", { suggestionId: "sg_1", outcome: "snoozed" })]),
		);

		expect(stateOf(cards[0])).toStrictEqual({ status: "pending" });
	});

	it("leaves out an entry that is not a suggestion, instead of drawing an empty card", () => {
		expect(
			messagesOf([
				entry(1, SUGGESTION_ENTRY_KIND, { data: { title: "x" } }),
				entry(2, SUGGESTION_ENTRY_KIND, {}),
				entry(3, DELEGATED_ENTRY_KIND, { data: {} }),
				entry(4, LATE_ANSWER_ENTRY_KIND, { data: { question: "q" } }),
			]),
		).toStrictEqual([]);
	});

	it("stamps a suggestion, a question and a late answer with the time they were posted", () => {
		const messages = messagesOf([
			suggestionEntry(1, "sg_1"),
			entry(2, DELEGATED_ENTRY_KIND, { data: { from: "pa", question: "Q?", firedAt: 22_000 } }),
			entry(3, LATE_ANSWER_ENTRY_KIND, { data: { agent: "inbox", question: "Q?", answer: "A", firedAt: 33_000 } }),
		]);

		expect(messages.map((message) => message.createdAt)).toStrictEqual([10_001, 22_000, 33_000]);
		expect(cardsOf(messages).map((card) => card.type)).toStrictEqual(["suggestion", "delegated", "late_answer"]);
	});
});

describe("the Inbox's digest in its own thread", () => {
	const digestEntry = (id: number, job: DailyEntryData["job"], empty = false): EntryRecord =>
		entry(id, DAILY_ENTRY_KIND, {
			data: {
				job,
				date: "2026-10-26",
				dateText: "Mon 26 Oct 2026",
				sections: [],
				firedAt: id * 1_000,
				...(empty ? { empty: true } : {}),
			},
			...(empty ? {} : { model: [{ role: "user", content: "Inbox digest request", timestamp: id * 1_000 }] }),
		});
	const chips = (messages: UiMessage[]) =>
		messages.flatMap((message) => (message.role === "assistant" ? [message.chip] : []));

	it("labels the Inbox agent's first answer after a digest with the digest's name, and no later one", () => {
		const messages = messagesOf([
			digestEntry(1, "digest_midday"),
			answer(2, "Two mails need you."),
			answer(3, "Anything else?"),
		]);

		expect(chips(messages)).toStrictEqual(["📥 Inbox digest", undefined]);
	});

	it("labels nothing after a digest that stood alone, nor a reply once the owner has spoken", () => {
		expect(chips(messagesOf([digestEntry(1, "digest_evening", true), answer(2, "Hello!")]))).toStrictEqual([undefined]);
		expect(
			chips(
				messagesOf([
					digestEntry(1, "digest_evening"),
					owner(2, "Which one is from the bank?"),
					answer(3, "The second."),
				]),
			),
		).toStrictEqual([undefined]);
	});
});
