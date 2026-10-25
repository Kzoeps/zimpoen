import type { TriageResult } from "@assistant/shared";
import type { RuleRow } from "../store.ts";
import type { RequestOptions, Triage, TriageInput } from "../types.ts";
import { classifyByRules, learnedCategory } from "./rules.ts";

export { createJevTriage, JevAuthError, type JevOptions, JevPausedError, JevUnavailableError } from "./jev.ts";
export { JEV_ENDPOINT, JEV_HOST, JEV_MODEL, JevContractError, jevRequest, parseJevResponse } from "./jev-contract.ts";
export { classifyByRules, createRulesTriage, DEFAULT_URGENCY, learnedCategory } from "./rules.ts";

/** A triage that fell back to the rules, and why: what Settings shows, and what the next sync tries Jev again for. */
export type TriageFallback = { error: unknown };

/**
 * One mail through the classifier the owner has: what they taught first (no call to Jev for a sender they already
 * marked), then `triage`, and when `triage` is Jev and cannot answer, the rules, flagged as provisional so that a later sync
 * asks Jev again. An aborted request is not a failure: it is thrown on (the server is closing). `rulesOnly`: do not ask Jev
 * at all (the sync has spent the time it gives Jev); the answer is the same provisional one.
 */
export async function classifyMail(
	triage: Triage,
	learned: readonly RuleRow[],
	input: TriageInput,
	options: RequestOptions & { onFallback?: (fallback: TriageFallback) => void; rulesOnly?: boolean } = {},
): Promise<TriageResult> {
	const taught = learnedCategory(input, learned);
	if (taught !== undefined) return taught;
	if (options.rulesOnly === true && triage.mode === "jev") return { ...classifyByRules(input), provisional: true };
	try {
		return await triage.classify(input, options);
	} catch (error) {
		if (options.signal?.aborted === true || triage.mode === "rules") throw error;
		options.onFallback?.({ error });
		return { ...classifyByRules(input), provisional: true };
	}
}
