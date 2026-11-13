/**
 * Trust levels (PLAN upgrade §3): one place decides whether a sensitive action runs, asks the owner, or is refused. Tools
 * never decide for themselves; they name the sensitivity of what they do and call {@link decide}. Only the owner sets a
 * level (configuration or settings), never a tool.
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

export const DEFAULT_TRUST_LEVEL: TrustLevel = "normal";

export function isTrustLevel(value: unknown): value is TrustLevel {
	return value === "open" || value === "normal" || value === "strict";
}

export const SENSITIVITIES: readonly Sensitivity[] = [
	"routine",
	"bot_lifecycle",
	"merge_main",
	"deploy_prod",
	"prod_data_write",
	"destructive",
];

/**
 * Open allows everything (the caller logs it). Normal and Strict allow routine work and ask for anything else; Strict
 * also refuses an action whose policy entry is marked `strictDeny`, routine or not.
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
