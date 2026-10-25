"use client";

import {
	type AgendaEntryData,
	type BirthdayEntryData,
	type DailyEntryData,
	type FileSummary,
	type FollowupCardItem,
	type FollowupEntryData,
	formatSize,
	type JournalCardItem,
	type PersonCardItem,
	type SuggestionDecision,
	type TaskCardItem,
} from "@assistant/shared";
import { useAui } from "@assistant-ui/react";
import { useState } from "react";
import { ApiRequestError, decideApproval, decideSuggestion } from "../lib/api.ts";
import {
	DAILY_LABEL,
	FILE_EVENT_LABEL,
	FOLLOWUP_EVENT_LABEL,
	isDigest,
	JOURNAL_EVENT_LABEL,
	PERSON_EVENT_LABEL,
	TASK_EVENT_LABEL,
} from "../lib/card-text.ts";
import { answeredTheOtherWay } from "../lib/suggestion-form.ts";
import type { ApprovalCardState, UiCard } from "../lib/ui-messages.ts";
import {
	AccountantNoteView,
	BalancesView,
	ImportPreviewView,
	ImportResultView,
	InvoiceListView,
	InvoiceView,
	SpendingView,
	SplitView,
	TxnListView,
	TxnView,
	WhoOwesView,
} from "./accountant-cards.tsx";
import { useChat } from "./chat-context.tsx";
import { FileChip } from "./file-chip.tsx";
import {
	ExerciseChartView,
	WeightChartView,
	WeightLoggedView,
	WorkoutListView,
	WorkoutLoggedView,
} from "./health-charts.tsx";
import {
	AgentAnswerView,
	DelegatedView,
	EventListView,
	InboxNoteView,
	LateAnswerView,
	MailListView,
	MailRows,
	MailView,
	SuggestionSentView,
	SuggestionView,
} from "./inbox-cards.tsx";

export { FileChip };

/** One non-chat item of the thread: a reminder, an agenda, a question, a birthday, a notice, a task, a follow-up, a person, a list, or a request for approval. */
export function CardView({ card }: { card: UiCard }) {
	switch (card.type) {
		case "reminder":
			return <ReminderCard data={card.data} />;
		case "notice":
			return <NoticeCard text={card.data.text} level={card.data.level} />;
		case "agenda":
			return <AgendaCard data={card.data} />;
		case "followup_question":
			return <FollowupQuestionCard data={card.data} answered={card.answered === true} />;
		case "birthday":
			return <BirthdayCard data={card.data} answered={card.answered === true} />;
		case "followup":
			return <FollowupToolCard event={card.event} followup={card.followup} next={card.next} />;
		case "followup_list":
			return <FollowupListCardView heading={card.heading} followups={card.followups} total={card.total} />;
		case "person":
			return <PersonToolCard event={card.event} person={card.person} wished={card.wished} year={card.year} />;
		case "people_list":
			return <PeopleListCardView heading={card.heading} people={card.people} total={card.total} />;
		case "task":
			return <TaskCardView event={card.event} task={card.task} />;
		case "task_list":
			return <TaskListCardView heading={card.heading} tasks={card.tasks} total={card.total} />;
		case "approval":
			return (
				<ApprovalCardView
					actionId={card.actionId}
					summary={card.summary}
					state={card.state}
					buttonOnly={card.buttonOnly === true}
				/>
			);
		case "daily":
			return <DailyCard data={card.data} />;
		case "journal":
			return <JournalCardView event={card.event} entries={card.entries} />;
		case "file":
			return <FileToolCard event={card.event} file={card.file} />;
		case "file_list":
			return <FileListCardView heading={card.heading} files={card.files} total={card.total} />;
		case "weight":
			return <WeightLoggedView card={card} />;
		case "weight_chart":
			return <WeightChartView card={card} />;
		case "exercise_chart":
			return <ExerciseChartView card={card} />;
		case "workout":
			return <WorkoutLoggedView card={card} />;
		case "workout_list":
			return <WorkoutListView card={card} />;
		case "txn":
			return <TxnView card={card} />;
		case "txn_list":
			return <TxnListView card={card} />;
		case "balances":
			return <BalancesView card={card} />;
		case "spending":
			return <SpendingView card={card} />;
		case "import_preview":
			return (
				<ImportPreviewView
					card={card}
					answered={card.answered === true}
					action={<ImportConfirmButton importId={card.importId} />}
				/>
			);
		case "import_result":
			return <ImportResultView card={card} />;
		case "split":
			return <SplitView card={card} />;
		case "who_owes":
			return <WhoOwesView card={card} />;
		case "invoice":
			return <InvoiceView card={card} />;
		case "invoice_list":
			return <InvoiceListView card={card} />;
		case "accountant_note":
			return <AccountantNoteView card={card} />;
		case "mail_list":
			return <MailListView card={card} />;
		case "mail":
			return <MailView card={card} />;
		case "event_list":
			return <EventListView card={card} />;
		case "inbox_note":
			return <InboxNoteView card={card} />;
		case "suggestion_sent":
			return <SuggestionSentView card={card} />;
		case "suggestion":
			return (
				<SuggestionView
					suggestion={card.data}
					state={card.state}
					action={<SuggestionButtons suggestionId={card.data.id} />}
				/>
			);
		case "agent_answer":
			return <AgentAnswerView card={card} />;
		case "delegated":
			return <DelegatedView data={card.data} />;
		case "late_answer":
			return <LateAnswerView data={card.data} />;
	}
}

/**
 * Add and Dismiss under a suggestion of the Inbox. Add asks the PA to save the follow-up (the PA answers in this chat);
 * Dismiss drops it. The server writes the notice that settles the card, and it arrives on the stream, so the buttons stay off
 * from the moment one is pressed (a second tap must not be a second answer) until the card is replaced by its outcome.
 */
function SuggestionButtons({ suggestionId }: { suggestionId: string }) {
	const [pressed, setPressed] = useState<SuggestionDecision>();
	const [error, setError] = useState<string>();

	const decide = async (decision: SuggestionDecision): Promise<void> => {
		setPressed(decision);
		setError(undefined);
		try {
			await decideSuggestion(suggestionId, decision);
		} catch (failure) {
			setError(failure instanceof ApiRequestError ? failure.message : "Could not send your answer.");
			if (!answeredTheOtherWay(failure)) setPressed(undefined);
		}
	};

	return (
		<>
			<div className="card__actions">
				<button
					type="button"
					className="card__button card__button--primary"
					disabled={pressed !== undefined}
					onClick={() => void decide("add")}
				>
					{pressed === "add" ? "Adding…" : "Add"}
				</button>
				<button
					type="button"
					className="card__button"
					disabled={pressed !== undefined}
					onClick={() => void decide("dismiss")}
				>
					{pressed === "dismiss" ? "Dismissing…" : "Dismiss"}
				</button>
			</div>
			{error !== undefined ? (
				<p className="card__error" role="alert">
					{error}
				</p>
			) : null}
		</>
	);
}

/**
 * The button of an import preview: it says "Confirm import im_..." in the chat, as the owner would, and the model then calls
 * `confirm_import`. No other route is involved. Nothing but the model's rules ties a confirmation to this message, so the
 * owner's own words ("yes, import it") work as well, and the button only saves typing them.
 *
 * The message goes to the thread directly and not through the composer: sending from the composer takes whatever the owner
 * was typing, and the files they picked for it, along with the message.
 */
function ImportConfirmButton({ importId }: { importId: string }) {
	const { store } = useChat();
	const [busy, setBusy] = useState(false);
	const confirm = async (): Promise<void> => {
		setBusy(true);
		try {
			await store.getState().send(`Confirm import ${importId}`);
		} catch {
			// `send` has already put the reason in `sendError`, which the notice under the composer shows; the button stays.
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<p className="card__muted">Nothing is added to your accounts until you confirm.</p>
			<div className="card__actions">
				<button
					type="button"
					className="card__button card__button--primary"
					disabled={busy}
					onClick={() => void confirm()}
				>
					Confirm import
				</button>
			</div>
		</>
	);
}

/**
 * The request of the morning briefing, the evening wrap-up or an inbox digest, as the thread shows it: what the assistant
 * looked at. The briefing's and the wrap-up's facts stay folded, because the answer under them says the same in words. A
 * digest's mail is open: its rows are links to the conversations in Gmail, which the answer in words cannot be. A day with
 * nothing to say is only this card.
 */
function DailyCard({ data }: { data: DailyEntryData }) {
	const { icon, name } = DAILY_LABEL[data.job];
	const digest = isDigest(data.job);
	const items = data.sections.reduce((total, section) => total + (section.mail?.length ?? section.lines.length), 0);
	return (
		<section className="card card--daily" aria-label={name}>
			<header className="card__head">
				<span aria-hidden="true">{icon}</span> {name} <span className="card__muted">· {data.dateText}</span>
				{data.late === true ? <span className="chip chip--late">sent late</span> : null}
			</header>
			{data.empty === true ? (
				<p className="card__title">
					{digest
						? "No mail needs your attention since the last digest."
						: "Nothing on your list today: no tasks, meetings or birthdays. Enjoy the day."}
				</p>
			) : (
				<details className="card__facts" open={digest}>
					<summary>
						{digest ? "Mail the assistant picked out" : "What the assistant looked at"}{" "}
						<span className="card__muted">
							({items === 0 ? "nothing recorded" : `${items} item${items === 1 ? "" : "s"}`})
						</span>
					</summary>
					{data.sections.map((section) => (
						<div key={section.title}>
							<p className="card__muted card__section">{section.title}</p>
							{section.mail === undefined ? (
								<ul className="facts">
									{section.lines.map((line, index) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed once posted
										<li key={index}>{line}</li>
									))}
								</ul>
							) : (
								<>
									<MailRows mail={section.mail} />
									{/* The last line of a long digest says how many more there are; the rows above are the ones listed. */}
									{section.lines.length > section.mail.length ? (
										<p className="card__muted">{section.lines.at(-1)}</p>
									) : null}
								</>
							)}
						</div>
					))}
				</details>
			)}
		</section>
	);
}

function JournalCardView({ event, entries }: { event: keyof typeof JOURNAL_EVENT_LABEL; entries: JournalCardItem[] }) {
	return (
		<section className="card card--daily" aria-label={JOURNAL_EVENT_LABEL[event]}>
			<header className="card__head">
				<span aria-hidden="true">📓</span> {JOURNAL_EVENT_LABEL[event]}
			</header>
			{entries.length === 0 ? <p className="card__muted">Nothing written for those days.</p> : null}
			{entries.map((entry) => (
				<div key={entry.date} className="journal-day">
					<p className="card__title">{entry.dateText}</p>
					{entry.userLog !== undefined ? (
						<p>{entry.userLog}</p>
					) : (
						<p className="card__muted">Waiting for your answer to the wrap-up.</p>
					)}
					{entry.carriedOver.length > 0 ? (
						<>
							<p className="card__muted card__section">Carried over</p>
							<ul className="facts">
								{entry.carriedOver.map((item, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed once posted
									<li key={index}>{item}</li>
								))}
							</ul>
						</>
					) : null}
				</div>
			))}
		</section>
	);
}

function FileToolCard({ event, file }: { event: keyof typeof FILE_EVENT_LABEL; file: FileSummary }) {
	return (
		<section className="card card--file" aria-label={FILE_EVENT_LABEL[event]}>
			<header className="card__head">
				<span aria-hidden="true">🗂️</span> {FILE_EVENT_LABEL[event]}
			</header>
			<FileDetail file={file} />
		</section>
	);
}

function FileDetail({ file }: { file: FileSummary }) {
	return (
		<div className="file-detail">
			{file.source === "upload" || file.source === "generated" ? (
				<FileChip file={file} />
			) : (
				<p className="card__title">{file.name}</p>
			)}
			{file.description !== undefined ? <p>{file.description}</p> : null}
			<p className="card__muted">
				{file.mime} · {formatSize(file.size)}
				{file.source === "path" ? " · from your folders" : ""}
				{file.source === "generated" ? " · made by the assistant" : ""}
				{file.tags !== undefined ? ` · ${file.tags.join(", ")}` : ""}
			</p>
		</div>
	);
}

function FileListCardView({ heading, files, total }: { heading: string; files: FileSummary[]; total: number }) {
	return (
		<section className="card card--file" aria-label={heading}>
			<header className="card__head">
				{heading} <span className="card__muted">({total})</span>
			</header>
			{files.length === 0 ? (
				<p className="card__muted">No files.</p>
			) : (
				files.map((file) => <FileDetail key={file.id} file={file} />)
			)}
			{total > files.length ? <p className="card__muted">…and {total - files.length} more</p> : null}
		</section>
	);
}

function ReminderCard({ data }: { data: Extract<UiCard, { type: "reminder" }>["data"] }) {
	return (
		<section className="card card--reminder" aria-label="Reminder">
			<header className="card__head">
				<span aria-hidden="true">⏰</span> Reminder
			</header>
			<p className="card__title">{data.title}</p>
			{data.notes !== undefined ? <p className="card__muted">{data.notes}</p> : null}
			<p className="card__muted">Due {data.remindAtText}</p>
		</section>
	);
}

function NoticeCard({ text, level }: { text: string; level: "info" | "error" }) {
	return (
		<p
			className={`card card--notice${level === "error" ? " card--error" : ""}`}
			role={level === "error" ? "alert" : "status"}
		>
			{text}
		</p>
	);
}

function TaskLine({ task }: { task: TaskCardItem }) {
	const mark = task.status === "done" ? "✓" : "○";
	return (
		<li className={`task${task.status === "done" ? " task--done" : ""}`}>
			<span className="task__mark" aria-hidden="true">
				{mark}
			</span>
			<span className="task__body">
				<span className="task__title">{task.title}</span>
				{task.dueText !== undefined ? <span className="card__muted"> · due {task.dueText}</span> : null}
				{task.remindText !== undefined ? (
					<span className="card__muted">
						{" "}
						· {task.remindedAt === undefined ? "reminder" : "reminded"} {task.remindText}
					</span>
				) : null}
			</span>
		</li>
	);
}

function TaskCardView({ event, task }: { event: keyof typeof TASK_EVENT_LABEL; task: TaskCardItem }) {
	return (
		<section className="card card--task" aria-label={TASK_EVENT_LABEL[event]}>
			<header className="card__head">{TASK_EVENT_LABEL[event]}</header>
			<ul className="tasks">
				<TaskLine task={task} />
			</ul>
		</section>
	);
}

function TaskListCardView({ heading, tasks, total }: { heading: string; tasks: TaskCardItem[]; total: number }) {
	return (
		<section className="card card--task" aria-label={heading}>
			<header className="card__head">
				{heading} <span className="card__muted">({total})</span>
			</header>
			{tasks.length === 0 ? (
				<p className="card__muted">Nothing here.</p>
			) : (
				<ul className="tasks">
					{tasks.map((task) => (
						<TaskLine key={task.id} task={task} />
					))}
				</ul>
			)}
			{total > tasks.length ? <p className="card__muted">…and {total - tasks.length} more</p> : null}
		</section>
	);
}

const OUTCOME_LABEL: Record<Exclude<ApprovalCardState["status"], "pending">, string> = {
	executed: "Approved",
	failed: "Approved, but it failed",
	denied: "Denied",
	expired: "Expired: nothing was changed",
};

function ApprovalCardView({
	actionId,
	summary,
	state,
	buttonOnly,
}: {
	actionId: string;
	summary: string;
	state: ApprovalCardState;
	/** A typed YES does not answer this one: only the buttons do. */
	buttonOnly: boolean;
}) {
	const [busy, setBusy] = useState<"approve" | "deny">();
	const [error, setError] = useState<string>();

	const answer = async (decision: "approve" | "deny"): Promise<void> => {
		setBusy(decision);
		setError(undefined);
		try {
			// The outcome arrives on the stream as a notice, which settles this card; nothing to update here.
			await decideApproval(actionId, decision);
		} catch (failure) {
			setError(failure instanceof ApiRequestError ? failure.message : "Could not send your answer.");
			setBusy(undefined);
		}
	};

	return (
		<section className={`card card--approval card--${state.status}`} aria-label="Approval needed">
			<header className="card__head">
				<span aria-hidden="true">🔐</span> {state.status === "pending" ? "Needs your approval" : "Approval"}
			</header>
			<p className="card__title">{summary}</p>
			{state.status === "pending" ? (
				<>
					<p className="card__muted">
						{buttonOnly
							? "Nothing happens until you tap Approve. A reply of YES does not count for this one."
							: "Nothing happens until you answer. A reply of YES also works, if this is the only request waiting and you have not written anything since."}
					</p>
					<div className="card__actions">
						<button
							type="button"
							className="card__button card__button--primary"
							disabled={busy !== undefined}
							onClick={() => void answer("approve")}
						>
							{busy === "approve" ? "Approving…" : "Approve"}
						</button>
						<button
							type="button"
							className="card__button"
							disabled={busy !== undefined}
							onClick={() => void answer("deny")}
						>
							{busy === "deny" ? "Denying…" : "Deny"}
						</button>
					</div>
					{error !== undefined ? (
						<p className="card__error" role="alert">
							{error}
						</p>
					) : null}
				</>
			) : (
				<p className="card__outcome" role="status">
					{OUTCOME_LABEL[state.status]}
				</p>
			)}
		</section>
	);
}

/** The agenda of a meeting, posted shortly before it starts. */
function AgendaCard({ data }: { data: AgendaEntryData }) {
	return (
		<section className="card card--agenda" aria-label="Agenda">
			<header className="card__head">
				<span aria-hidden="true">📋</span> {data.today ? "Today's agenda" : "Agenda"}
			</header>
			<p className="card__title">{data.title}</p>
			<p className="card__muted">
				{data.counterpart !== undefined ? `${data.counterpart} · ` : ""}
				{data.eventAtText}
			</p>
			<ol className="points">
				{data.points.map((point, index) => (
					// Points are plain text in the order they were added; the same wording twice is two points.
					// biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed once posted
					<li key={index}>{point}</li>
				))}
			</ol>
		</section>
	);
}

/**
 * What a follow-up says by itself: the nudge when a commitment is due, the question after a meeting or commitment, and
 * that question once more the next morning. The answer goes through the chat: the button only starts the sentence.
 */
function FollowupQuestionCard({ data, answered }: { data: FollowupEntryData; answered: boolean }) {
	const aui = useAui();
	const startAnswer = (): void => aui.thread().composer().setText(`Outcome of “${data.title}”: `);
	const about = (
		<p className="card__muted">
			{data.kind === "meeting" ? "Meeting" : "Commitment"}
			{data.counterpart !== undefined ? ` with ${data.counterpart}` : ""} · {data.eventAtText}
		</p>
	);
	if (data.stage === "nudge") {
		return (
			<section className="card card--followup" aria-label="Follow-up due">
				<header className="card__head">
					<span aria-hidden="true">⏰</span> Due now
				</header>
				<p className="card__title">{data.title}</p>
				{about}
				{data.context !== undefined ? <p className="card__muted">{data.context}</p> : null}
			</section>
		);
	}
	return (
		<section className="card card--followup" aria-label="Follow-up question">
			<header className="card__head">
				<span aria-hidden="true">💬</span>{" "}
				{data.stage === "reask" ? "Still open" : data.chained ? "Follow-up of a follow-up" : "Follow-up"}
			</header>
			<p className="card__title">How did it go? {data.title}</p>
			{about}
			{answered ? (
				<p className="card__muted">Answered.</p>
			) : (
				<>
					<p className="card__muted">
						{data.stage === "reask" ? "I asked yesterday and have not heard back. " : ""}
						Tell me what happened, and whether it needs a follow-up and when. I will remember it and ask again then.
					</p>
					<div className="card__actions">
						<button type="button" className="card__button card__button--primary" onClick={startAnswer}>
							Record outcome
						</button>
					</div>
				</>
			)}
		</section>
	);
}

/** The morning reminder to wish someone well, or the evening question whether the owner did. */
function BirthdayCard({ data, answered }: { data: BirthdayEntryData; answered: boolean }) {
	const aui = useAui();
	const answer = (wished: boolean): void =>
		aui
			.thread()
			.composer()
			.setText(wished ? `Yes, I wished ${data.name}.` : `No, not yet: I have not wished ${data.name}.`);
	return (
		<section className="card card--birthday" aria-label="Birthday">
			<header className="card__head">
				<span aria-hidden="true">🎂</span> Birthday
			</header>
			<p className="card__title">
				{data.stage === "remind" ? `Wish ${data.name} a happy birthday` : `Did you wish ${data.name} a happy birthday?`}
			</p>
			<p className="card__muted">
				{data.relation !== undefined ? `${data.relation} · ` : ""}
				{data.dateText}
				{data.turns !== undefined ? ` · turns ${data.turns}` : ""}
			</p>
			{data.stage === "check" && answered ? <p className="card__muted">Answered.</p> : null}
			{data.stage === "check" && !answered ? (
				<div className="card__actions">
					<button type="button" className="card__button card__button--primary" onClick={() => answer(true)}>
						Yes, I did
					</button>
					<button type="button" className="card__button" onClick={() => answer(false)}>
						Not yet
					</button>
				</div>
			) : null}
		</section>
	);
}

function FollowupLine({ item }: { item: FollowupCardItem }) {
	const mark = item.status === "resolved" ? "✓" : item.status === "asked" ? "?" : "○";
	return (
		<li className={`task${item.status === "resolved" ? " task--done" : ""}`}>
			<span className="task__mark" aria-hidden="true">
				{mark}
			</span>
			<span className="task__body">
				<span className="task__title">{item.title}</span>
				<span className="card__muted">
					{item.counterpart !== undefined ? ` · ${item.counterpart}` : ""} · {item.eventText}
					{item.status === "asked" ? " · waiting for the outcome" : ""}
				</span>
				{item.agenda.length > 0 ? (
					<ol className="points">
						{item.agenda.map((point, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed once posted
							<li key={index}>{point}</li>
						))}
					</ol>
				) : null}
				{item.outcome !== undefined ? <span className="card__muted">Outcome: {item.outcome}</span> : null}
			</span>
		</li>
	);
}

function FollowupToolCard({
	event,
	followup,
	next,
}: {
	event: keyof typeof FOLLOWUP_EVENT_LABEL;
	followup: FollowupCardItem;
	next: FollowupCardItem | undefined;
}) {
	return (
		<section className="card card--followup" aria-label={FOLLOWUP_EVENT_LABEL[event]}>
			<header className="card__head">{FOLLOWUP_EVENT_LABEL[event]}</header>
			<ul className="tasks">
				<FollowupLine item={followup} />
			</ul>
			{next !== undefined ? (
				<>
					<p className="card__muted">Next follow-up</p>
					<ul className="tasks">
						<FollowupLine item={next} />
					</ul>
				</>
			) : null}
		</section>
	);
}

function FollowupListCardView({
	heading,
	followups,
	total,
}: {
	heading: string;
	followups: FollowupCardItem[];
	total: number;
}) {
	return (
		<section className="card card--followup" aria-label={heading}>
			<header className="card__head">
				{heading} <span className="card__muted">({total})</span>
			</header>
			{followups.length === 0 ? (
				<p className="card__muted">Nothing here.</p>
			) : (
				<ul className="tasks">
					{followups.map((item) => (
						<FollowupLine key={item.id} item={item} />
					))}
				</ul>
			)}
			{total > followups.length ? <p className="card__muted">…and {total - followups.length} more</p> : null}
		</section>
	);
}

function PersonLine({ person }: { person: PersonCardItem }) {
	return (
		<li className="task">
			<span className="task__mark" aria-hidden="true">
				🎂
			</span>
			<span className="task__body">
				<span className="task__title">{person.name}</span>
				<span className="card__muted">
					{person.relation !== undefined ? ` · ${person.relation}` : ""} · {person.birthdayText} · next{" "}
					{person.nextText}
					{person.turns !== undefined ? ` (turns ${person.turns})` : ""}
				</span>
			</span>
		</li>
	);
}

function PersonToolCard({
	event,
	person,
	wished,
	year,
}: {
	event: keyof typeof PERSON_EVENT_LABEL;
	person: PersonCardItem;
	wished: boolean | undefined;
	year: number | undefined;
}) {
	return (
		<section className="card card--birthday" aria-label={PERSON_EVENT_LABEL[event]}>
			<header className="card__head">{PERSON_EVENT_LABEL[event]}</header>
			{event === "wish" ? (
				<p className="card__title">
					{wished === true ? "You wished" : "You have not yet wished"} {person.name}
					{year !== undefined ? ` (${year})` : ""}
				</p>
			) : (
				<ul className="tasks">
					<PersonLine person={person} />
				</ul>
			)}
		</section>
	);
}

function PeopleListCardView({ heading, people, total }: { heading: string; people: PersonCardItem[]; total: number }) {
	return (
		<section className="card card--birthday" aria-label={heading}>
			<header className="card__head">
				{heading} <span className="card__muted">({total})</span>
			</header>
			{people.length === 0 ? (
				<p className="card__muted">Nobody here.</p>
			) : (
				<ul className="tasks">
					{people.map((person) => (
						<PersonLine key={person.id} person={person} />
					))}
				</ul>
			)}
			{total > people.length ? <p className="card__muted">…and {total - people.length} more</p> : null}
		</section>
	);
}
