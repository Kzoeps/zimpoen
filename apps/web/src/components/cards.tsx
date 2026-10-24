"use client";

import type { TaskCardItem } from "@assistant/shared";
import { useState } from "react";
import { ApiRequestError, decideApproval } from "../lib/api.ts";
import { TASK_EVENT_LABEL } from "../lib/card-text.ts";
import type { ApprovalCardState, UiCard } from "../lib/ui-messages.ts";

/** One non-chat item of the thread: a reminder, a notice, a task, a task list, or a request for approval. */
export function CardView({ card }: { card: UiCard }) {
	switch (card.type) {
		case "reminder":
			return <ReminderCard data={card.data} />;
		case "notice":
			return <NoticeCard text={card.data.text} level={card.data.level} />;
		case "task":
			return <TaskCardView event={card.event} task={card.task} />;
		case "task_list":
			return <TaskListCardView heading={card.heading} tasks={card.tasks} total={card.total} />;
		case "approval":
			return <ApprovalCardView actionId={card.actionId} summary={card.summary} state={card.state} />;
	}
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
}: {
	actionId: string;
	summary: string;
	state: ApprovalCardState;
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
						Nothing happens until you answer. A reply of YES also works, if this is the only request waiting and you
						have not written anything since.
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
