import type {
	AgentAnswerCard,
	DelegatedEntryData,
	EventItem,
	EventListCard,
	InboxNoteCard,
	LateAnswerEntryData,
	MailCard,
	MailItem,
	MailListCard,
	SuggestionSummary,
	SuggestionToolCard,
	TriageCategory,
} from "@assistant/shared";
import type { ReactNode } from "react";
import { ASKED_AGENT_LABEL, TRIAGE_LABEL } from "../lib/card-text.ts";
import type { SuggestionCardState } from "../lib/ui-messages.ts";

/**
 * The Inbox agent's cards (mail, events, a note, a suggestion for the PA) and what one agent shows of a question put to
 * another. Plain functions of their data, like the Health and Accountant cards, so that a card renders the same on the
 * server, in the browser and in a test (`renderToStaticMarkup`).
 *
 * Everything that came out of an email (a subject, a sender, a snippet, the text) is shown as text: React escapes it, and
 * nothing here sets HTML. A mail's link is followed only when it is Gmail's own address ({@link gmailLink}), whatever the
 * stored card says. The two buttons of a suggestion come in as `action`, because they need the browser.
 */

/**
 * The address of a mail in Gmail, or nothing: a card links to `https://mail.google.com/...` and nowhere else. The server
 * builds these addresses, so this is a second lock, not the first: a stored card is data, and data does not get to choose
 * where a tap goes.
 */
export function gmailLink(url: string | undefined): string | undefined {
	if (url === undefined) return undefined;
	try {
		const parsed = new URL(url);
		const own = parsed.protocol === "https:" && parsed.hostname === "mail.google.com" && parsed.username === "";
		return own && parsed.password === "" && parsed.port === "" ? url : undefined;
	} catch {
		return undefined;
	}
}

function Category({ category }: { category: TriageCategory | undefined }) {
	if (category === undefined) return null;
	return <span className={`badge badge--mail badge--mail-${category}`}>{TRIAGE_LABEL[category] ?? category}</span>;
}

/** A link that opens the thread in Gmail in a new tab, or the plain text when the address is not Gmail's. */
function GmailLink({ url, children }: { url: string | undefined; children: ReactNode }) {
	const href = gmailLink(url);
	if (href === undefined) return <span>{children}</span>;
	return (
		<a href={href} target="_blank" rel="noopener noreferrer" title="Open in Gmail">
			{children}
		</a>
	);
}

// ----- mail ----------------------------------------------------------------------------------------------------------------------

/** One mail: its subject (a link to the conversation in Gmail), the category, who and when and which account. */
export function MailRow({ item, snippet = true }: { item: MailItem; snippet?: boolean }) {
	return (
		<li className="mail">
			<div className="mail__main">
				<span className="mail__subject">
					<GmailLink url={item.url}>{item.subject}</GmailLink>
				</span>
				<Category category={item.category} />
			</div>
			<p className="card__muted mail__meta">
				{item.from} · {item.dateText} · {item.account}
			</p>
			{snippet && item.snippet !== undefined ? <p className="mail__snippet">{item.snippet}</p> : null}
		</li>
	);
}

/** The mail of an inbox digest, as the daily card lists it. */
export function MailRows({ mail }: { mail: MailItem[] }) {
	return (
		<ul className="mails">
			{mail.map((item) => (
				<MailRow key={item.id} item={item} />
			))}
		</ul>
	);
}

export function MailListView({ card }: { card: MailListCard }) {
	return (
		<section className="card card--mail" aria-label={card.heading}>
			<header className="card__head">
				<span aria-hidden="true">📥</span> {card.heading} <span className="card__muted">({card.total})</span>
			</header>
			{card.mails.length === 0 ? <p className="card__muted">No mail found.</p> : <MailRows mail={card.mails} />}
			{card.total > card.mails.length ? (
				<p className="card__muted">…and {card.total - card.mails.length} more</p>
			) : null}
		</section>
	);
}

export function MailView({ card }: { card: MailCard }) {
	return (
		<section className="card card--mail" aria-label="Mail">
			<header className="card__head">
				<span aria-hidden="true">✉️</span> Mail
			</header>
			<ul className="mails">
				<MailRow item={card.mail} snippet={false} />
			</ul>
			{card.to === undefined ? null : <p className="card__muted">To: {card.to}</p>}
			<details className="card__facts">
				<summary>Text of the mail{card.more ? " (the first part)" : ""}</summary>
				<pre className="mail__text">{card.text}</pre>
			</details>
		</section>
	);
}

// ----- calendar ------------------------------------------------------------------------------------------------------------------

const SHOWN_ATTENDEES = 4;

function attendeesText(attendees: readonly string[]): string {
	if (attendees.length <= SHOWN_ATTENDEES) return attendees.join(", ");
	return `${attendees.slice(0, SHOWN_ATTENDEES).join(", ")} and ${attendees.length - SHOWN_ATTENDEES} more`;
}

function EventRow({ event }: { event: EventItem }) {
	const when = event.allDay
		? `${event.startText} · all day`
		: event.endText === undefined
			? event.startText
			: `${event.startText} to ${event.endText}`;
	return (
		<li className="event">
			<p className="event__title">{event.title}</p>
			<p className="card__muted">{when}</p>
			{event.attendees.length === 0 ? null : <p className="card__muted">With {attendeesText(event.attendees)}</p>}
			{event.location === undefined ? null : <p className="card__muted">At {event.location}</p>}
			<p className="card__muted">{event.account}</p>
		</li>
	);
}

export function EventListView({ card }: { card: EventListCard }) {
	return (
		<section className="card card--mail" aria-label={card.heading}>
			<header className="card__head">
				<span aria-hidden="true">📅</span> {card.heading} <span className="card__muted">({card.total})</span>
			</header>
			{card.events.length === 0 ? (
				<p className="card__muted">Nothing in the calendar for this.</p>
			) : (
				<ul className="events">
					{card.events.map((event) => (
						<EventRow key={event.id} event={event} />
					))}
				</ul>
			)}
			{card.total > card.events.length ? (
				<p className="card__muted">…and {card.total - card.events.length} more</p>
			) : null}
		</section>
	);
}

export function InboxNoteView({ card }: { card: InboxNoteCard }) {
	return (
		<p className="card card--notice card--mail" role="status">
			{card.text}
		</p>
	);
}

// ----- suggestions: the Inbox hands a follow-up to the PA --------------------------------------------------------------------------

function SuggestionDetails({ suggestion }: { suggestion: SuggestionSummary }) {
	return (
		<>
			<p className="card__title">{suggestion.title}</p>
			<p className="card__muted">
				{suggestion.kind === "meeting" ? "Meeting" : "Follow-up"}
				{suggestion.counterpart === undefined ? "" : ` with ${suggestion.counterpart}`} · {suggestion.atText}
				{suggestion.endsAtText === undefined ? "" : ` to ${suggestion.endsAtText}`}
			</p>
			{suggestion.context === undefined ? null : <p className="card__muted">{suggestion.context}</p>}
			<p className="card__muted">
				From {suggestion.source.type === "mail" ? "an email" : "a calendar event"}:{" "}
				<GmailLink url={suggestion.source.url}>{suggestion.source.label}</GmailLink>
			</p>
		</>
	);
}

/**
 * In the Inbox's own thread: what its `suggest_followup` made. The suggestion itself is in the PA's thread, and so is the
 * owner's answer, which this thread never sees: the wording must stay true after Add or Dismiss (no "is waiting").
 */
export function SuggestionSentView({ card }: { card: SuggestionToolCard }) {
	return (
		<section className="card card--suggestion" aria-label="Suggestion for the assistant">
			<header className="card__head">
				<span aria-hidden="true">📨</span> Suggested to the assistant
			</header>
			<SuggestionDetails suggestion={card.suggestion} />
			<p className="card__muted">
				Sent to the assistant's chat. It is added to your follow-ups only if you press Add there.
			</p>
		</section>
	);
}

/**
 * In the PA's thread: the Inbox suggests a follow-up. The owner decides with the two buttons (`action`); until then nothing
 * is added, and what Add asks of the PA is written by the server from these very details.
 */
export function SuggestionView({
	suggestion,
	state,
	action,
}: {
	suggestion: SuggestionSummary;
	state: SuggestionCardState;
	action: ReactNode;
}) {
	return (
		<section className={`card card--suggestion card--${state.status}`} aria-label="Suggestion from the Inbox">
			<header className="card__head">
				<span aria-hidden="true">📥</span> The Inbox suggests
			</header>
			<SuggestionDetails suggestion={suggestion} />
			{state.status === "pending" ? (
				<>
					<p className="card__muted">
						Nothing is added until you press Add. The assistant then saves it as a follow-up with exactly these details.
					</p>
					{action}
				</>
			) : (
				<p className="card__outcome" role="status">
					{state.status === "added"
						? "You pressed Add: the assistant was asked to save it."
						: state.status === "expired"
							? "Expired: nobody answered within 7 days, so nothing was added. Ask the Inbox again if you still want it."
							: "Dismissed."}
				</p>
			)}
		</section>
	);
}

// ----- one agent asks another ------------------------------------------------------------------------------------------------------

/** In a specialist's thread: the question the PA put to it. */
export function DelegatedView({ data }: { data: DelegatedEntryData }) {
	return (
		<section className="card card--delegated" aria-label="Question from the assistant">
			<header className="card__head">
				<span aria-hidden="true">🧭</span> Asked by the assistant
			</header>
			<p className="delegated__text">{data.question}</p>
		</section>
	);
}

/** What `ask_agent` returned to the PA: the answer, or that the agent is still working. */
export function AgentAnswerView({ card }: { card: AgentAnswerCard }) {
	const who = ASKED_AGENT_LABEL[card.agent];
	return (
		<section className="card card--delegated" aria-label={`Question to ${who}`}>
			<header className="card__head">
				<span aria-hidden="true">🧭</span> Asked {who}
			</header>
			<p className="card__muted">{card.question}</p>
			{card.status === "answered" ? <p className="delegated__text">{card.answer}</p> : null}
			{card.status === "pending" ? (
				<p className="card__muted">Still working. The answer will appear here as a card when it is ready.</p>
			) : null}
			{card.status === "failed" ? <p className="card__error">It could not be answered.</p> : null}
		</section>
	);
}

/** In the PA's thread: the answer of an agent the PA had stopped waiting for. */
export function LateAnswerView({ data }: { data: LateAnswerEntryData }) {
	const who = ASKED_AGENT_LABEL[data.agent];
	return (
		<section className="card card--delegated" aria-label={`Answer from ${who}`}>
			<header className="card__head">
				<span aria-hidden="true">🧭</span> Answer from {who}
			</header>
			<p className="card__muted">You asked: {data.question}</p>
			<p className="delegated__text">{data.answer}</p>
		</section>
	);
}
