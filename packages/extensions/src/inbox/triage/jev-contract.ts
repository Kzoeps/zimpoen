import { TRIAGE_CATEGORIES, type TriageCategory, URGENCY_RANGE } from "@assistant/shared";
import { clip, safeLine } from "../text.ts";
import type { TriageInput } from "../types.ts";

/**
 * Everything this program assumes about Jev's API, in one file: where the request goes, how it is written and how the answer
 * is read. Nothing else in the code knows the shape.
 *
 * TODO(verify): this was written from the plan (TypeSafe's `systemone` endpoint takes a state and typed questions: a choice, a
 * score and a yes/no) and NOT from https://docs.typesafe.ai, which could not be read offline. Before the first real key is
 * used, check against the documentation: the endpoint path and model name, the authorization header, the field names of a
 * question (`id`, `type`, `prompt`, `choices`, `min`, `max`) and of the answer (`answers`). A shape that does not match is
 * reported as a {@link JevContractError} (what Settings shows as "Jev answered in a shape this program does not know"), and
 * mail is classified by the local rules meanwhile, so a wrong guess costs triage quality, not mail. The fake server of
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

/** TODO(verify): the header that carries the key. */
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

/** TODO(verify): the request body. */
export function jevRequest(input: TriageInput): unknown {
	return {
		model: JEV_MODEL,
		state: jevState(input),
		questions: [
			{
				id: "category",
				type: "choice",
				prompt: "What kind of email is this for its owner?",
				choices: TRIAGE_CATEGORIES.map((category) => ({ value: category, description: CATEGORY_HELP[category] })),
			},
			{
				id: "urgency",
				type: "score",
				prompt: "How urgent is it for the owner to deal with this email? 1 can wait, 5 needs attention now.",
				min: URGENCY_RANGE.min,
				max: URGENCY_RANGE.max,
			},
			{
				id: "needs_human",
				type: "bool",
				prompt: "Does the owner personally have to read or answer this email (not just an automatic notice)?",
			},
		],
	};
}

export type JevAnswer = { category: TriageCategory; urgency: number; needsHuman: boolean };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The answers as `{ question id: value }`, from an object (`answers: { category: "..." }`) or a list (`answers: [{ id, value }]`). */
function answersOf(body: unknown): Record<string, unknown> | undefined {
	const root = asRecord(body);
	if (root === undefined) return undefined;
	const inner = root.answers ?? root.result ?? root.output ?? root;
	const direct = asRecord(inner);
	if (direct !== undefined) {
		return Object.fromEntries(Object.entries(direct).map(([key, value]) => [key, asRecord(value)?.value ?? value]));
	}
	if (Array.isArray(inner)) {
		const entries: Array<[string, unknown]> = [];
		for (const item of inner) {
			const answer = asRecord(item);
			const id = answer?.id ?? answer?.question ?? answer?.key;
			if (typeof id === "string") entries.push([id, answer?.value ?? answer?.answer]);
		}
		return Object.fromEntries(entries);
	}
	return undefined;
}

/** TODO(verify): the answer. Throws {@link JevContractError} naming what was missing; never echoes what the answer said. */
export function parseJevResponse(body: unknown): JevAnswer {
	const answers = answersOf(body);
	if (answers === undefined) {
		throw new JevContractError(
			"Jev answered, but not in the shape this program expects (no `answers`). Check docs.typesafe.ai against jev-contract.ts.",
		);
	}
	const category =
		typeof answers.category === "string" ? answers.category.trim().toLowerCase().replaceAll(" ", "_") : "";
	if (!(TRIAGE_CATEGORIES as readonly string[]).includes(category)) {
		throw new JevContractError(
			"Jev's answer has no category this program knows. Check the choices of the `category` question in jev-contract.ts.",
		);
	}
	const urgency = typeof answers.urgency === "string" ? Number(answers.urgency) : answers.urgency;
	if (typeof urgency !== "number" || !Number.isFinite(urgency)) {
		throw new JevContractError("Jev's answer has no urgency score. Check the `urgency` question in jev-contract.ts.");
	}
	const human = answers.needs_human ?? answers.needsHuman;
	const needsHuman =
		typeof human === "boolean" ? human : typeof human === "string" ? /^(true|yes)$/i.test(human.trim()) : undefined;
	if (needsHuman === undefined) {
		throw new JevContractError(
			"Jev's answer has no needs_human yes/no. Check the `needs_human` question in jev-contract.ts.",
		);
	}
	return {
		category: category as TriageCategory,
		urgency: Math.min(URGENCY_RANGE.max, Math.max(URGENCY_RANGE.min, Math.round(urgency))),
		needsHuman,
	};
}
