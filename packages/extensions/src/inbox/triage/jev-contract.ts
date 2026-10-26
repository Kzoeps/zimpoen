import { TRIAGE_CATEGORIES, type TriageCategory, URGENCY_RANGE } from "@assistant/shared";
import { clip, safeLine } from "../text.ts";
import type { TriageInput } from "../types.ts";

/**
 * Everything this program assumes about Jev's API, in one file: where the request goes, how it is written and how the answer
 * is read. Nothing else in the code knows the shape.
 *
 * Written against https://docs.typesafe.ai (quick start, Choice, Score, Noul and Models pages). A request names its questions
 * in an object keyed by question id; each question has a `type` (`choice`, `score` or `noul`), `instructions` and, for choice
 * and score, `criteria`. The answer comes back under the same ids in `answers`. A shape that does not match is reported as a
 * {@link JevContractError}, and mail is classified by the local rules meanwhile. The fake server of
 * `test/inbox-triage.test.ts` pins the shape written here: change both together.
 */

/** The only host a Jev request goes to. There is deliberately no setting that changes it. */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_HOST = "api.typesafe.ai";
export const JEV_MODEL = "jev-1.14.0";

/** How much of a mail Jev is shown: enough to judge it, little enough to keep what leaves the machine small. */
export const JEV_BODY_CHARS = 1500;

/** The answer did not have the shape this file expects. */
export class JevContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JevContractError";
	}
}

/** The key goes in a bearer authorization header. */
export function jevHeaders(apiKey: string): Record<string, string> {
	return { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` };
}

/** The mail as the text Jev reads: who, what, and the start of the message. */
export function jevState(input: TriageInput): string {
	return [
		`From: ${safeLine(input.fromName, 120)} <${safeLine(input.fromAddress, 200)}>`,
		`To: ${safeLine(input.to, 200)}`,
		`Subject: ${safeLine(input.subject, 300)}`,
		`Gmail labels: ${input.labels.join(", ") || "none"}`,
		`Mailing list: ${input.bulk ? "yes" : "no"}`,
		"",
		clip(input.text !== "" ? input.text : input.snippet, JEV_BODY_CHARS),
	].join("\n");
}

const CATEGORY_HELP: Record<TriageCategory, string> = {
	important: "matters to the owner and should be seen today",
	needs_reply: "a person is waiting for an answer",
	follow_up: "something the owner has to chase or be chased about",
	newsletter: "a newsletter or mailing list",
	notification: "an automatic message from an app or service",
	promo: "advertising",
	personal: "a personal message with nothing to answer",
	finance: "a bill, receipt, statement or bank message",
	other: "none of the above",
};

/**
 * The urgency levels, lowest first. Jev scores a mail as a position from 0 to 4 on these; the owner's urgency is that
 * position plus one, so the levels must stay in step with {@link URGENCY_RANGE}.
 */
const URGENCY_LEVELS = [
	"Can wait indefinitely or never needs attention",
	"Worth a look this week",
	"Should be dealt with in the next day or two",
	"Should be dealt with today",
	"Needs attention right now",
] as const;

/** The request body: the mail as `state` and three questions keyed by id. */
export function jevRequest(input: TriageInput): unknown {
	return {
		model: JEV_MODEL,
		state: jevState(input),
		questions: {
			category: {
				type: "choice",
				instructions: "What kind of email is this for its owner?",
				criteria: CATEGORY_HELP,
			},
			urgency: {
				type: "score",
				instructions: "How urgent is it for the owner to deal with this email?",
				criteria: URGENCY_LEVELS,
			},
			needs_human: {
				type: "noul",
				instructions: "The owner personally has to read or answer this email; it is not just an automatic notice.",
			},
		},
	};
}

export type JevAnswer = { category: TriageCategory; urgency: number; needsHuman: boolean };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Jev's yes/no answers are probabilities; at least this much counts as yes. */
const NEEDS_HUMAN_THRESHOLD = 0.5;

/**
 * Read `answers.category.choice`, `answers.urgency.score` (0 to 4) and `answers.needs_human.noul` (0 to 1). Throws
 * {@link JevContractError} naming what was missing; never echoes what the answer said.
 */
export function parseJevResponse(body: unknown): JevAnswer {
	const answers = asRecord(asRecord(body)?.answers);
	if (answers === undefined) {
		throw new JevContractError(
			"Jev answered, but not in the shape this program expects (no `answers`). Check docs.typesafe.ai against jev-contract.ts.",
		);
	}
	const choice = asRecord(answers.category)?.choice;
	const category = typeof choice === "string" ? choice : "";
	if (!(TRIAGE_CATEGORIES as readonly string[]).includes(category)) {
		throw new JevContractError(
			"Jev's answer has no category this program knows. Check the criteria of the `category` question in jev-contract.ts.",
		);
	}
	const score = asRecord(answers.urgency)?.score;
	if (typeof score !== "number" || !Number.isFinite(score)) {
		throw new JevContractError("Jev's answer has no urgency score. Check the `urgency` question in jev-contract.ts.");
	}
	const noul = asRecord(answers.needs_human)?.noul;
	if (typeof noul !== "number" || !Number.isFinite(noul)) {
		throw new JevContractError(
			"Jev's answer has no needs_human probability. Check the `needs_human` question in jev-contract.ts.",
		);
	}
	return {
		category: category as TriageCategory,
		urgency: Math.min(URGENCY_RANGE.max, Math.max(URGENCY_RANGE.min, Math.round(score) + URGENCY_RANGE.min)),
		needsHuman: noul >= NEEDS_HUMAN_THRESHOLD,
	};
}
