/**
 * Trust levels (docs/plans/upgrade.md §3): the one place that decides whether a sensitive action runs, asks the owner,
 * or is refused. Tools never decide for themselves. Only the owner sets a level (policy file or settings), never a tool.
 */

export type TrustLevel = "open" | "normal" | "strict";

export type Sensitivity =
	| "routine"
	| "bot_lifecycle"
	| "merge_main"
	| "deploy_prod"
	| "prod_data_write"
	| "destructive";

export type TrustDecision = "allow" | "ask" | "deny";

export const TRUST_LEVELS: readonly TrustLevel[] = ["open", "normal", "strict"];
export const SENSITIVITIES: readonly Sensitivity[] = [
	"routine",
	"bot_lifecycle",
	"merge_main",
	"deploy_prod",
	"prod_data_write",
	"destructive",
];

/**
 * Open allows everything (every use is still logged). Normal and Strict allow routine work and ask for anything else;
 * Strict additionally refuses an action whose policy entry is marked `strictDeny`.
 */
export function decide(
	level: TrustLevel,
	sensitivity: Sensitivity,
	options: { strictDeny?: boolean } = {},
): TrustDecision {
	if (level === "open") return "allow";
	if (level === "strict" && options.strictDeny === true) return "deny";
	if (sensitivity === "routine") return "allow";
	return "ask";
}
