import { SENSITIVITIES, type Sensitivity, TRUST_LEVELS, type TrustLevel } from "../trust.ts";

/**
 * The broker policy: an owner-written JSON file, read-only to agents. It names projects (each with a trust level), the
 * credentials a project may use (by reference into the secret store, never the value) and the actions that may run with
 * them: a fixed argv whose `{placeholders}` are filled from parameters that must match the policy's regular expressions.
 */
export type Policy = {
	projects: ReadonlyMap<string, ProjectPolicy>;
	credentials: ReadonlyMap<string, CredentialPolicy>;
	actions: ReadonlyMap<string, ActionPolicy>;
};

export type ProjectPolicy = { id: string; trust: TrustLevel };

export type CredentialPolicy = { id: string; project: string; secretRef: string };

/** How the secret reaches the program: one environment variable, or its standard input. */
export type Inject = { type: "env"; name: string } | { type: "stdin" };

export type ActionPolicy = {
	id: string;
	/** argv[0] is an absolute path; any element may contain `{name}` placeholders declared in `params`. */
	argv: readonly string[];
	/** Parameter name to an anchored regular expression its value must match in full. */
	params: ReadonlyMap<string, RegExp>;
	inject: Inject;
	sensitivity: Exclude<Sensitivity, "bot_lifecycle">;
	maxOutputBytes: number;
	timeoutMs: number;
	/** Refused outright when the project's trust level is `strict`. */
	strictDeny: boolean;
};

export const MAX_OUTPUT_BYTES_LIMIT = 1024 * 1024;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;

const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const ACTION_SENSITIVITIES: readonly Sensitivity[] = SENSITIVITIES.filter((s) => s !== "bot_lifecycle");

/** Every problem with a policy file, listed together so one edit fixes all of them. */
export class PolicyError extends Error {
	readonly problems: readonly string[];

	constructor(source: string, problems: readonly string[]) {
		super(
			`Invalid broker policy ${source} (${problems.length} problem(s)):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
		);
		this.name = "PolicyError";
		this.problems = problems;
	}
}

/** Parse and validate policy JSON text. Throws {@link PolicyError} naming every bad entry. */
export function parsePolicy(text: string, source = "(inline)"): Policy {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new PolicyError(source, [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
	}
	const problems: string[] = [];
	const policy = validate(raw, problems);
	if (problems.length > 0) throw new PolicyError(source, problems);
	return policy;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function validate(raw: unknown, problems: string[]): Policy {
	const projects = new Map<string, ProjectPolicy>();
	const credentials = new Map<string, CredentialPolicy>();
	const actions = new Map<string, ActionPolicy>();
	if (!isObj(raw)) {
		problems.push("the top level must be an object with projects, credentials and actions");
		return { projects, credentials, actions };
	}
	for (const [index, entry] of listOf(raw, "projects", problems).entries()) {
		const at = `projects[${index}]`;
		if (!isObj(entry)) {
			problems.push(`${at} must be an object`);
			continue;
		}
		const id = idOf(entry, at, problems, projects);
		const trust = entry.trust;
		if (!TRUST_LEVELS.includes(trust as TrustLevel)) {
			problems.push(`${at}.trust must be one of ${TRUST_LEVELS.join(", ")}`);
			continue;
		}
		if (id !== undefined) projects.set(id, { id, trust: trust as TrustLevel });
	}
	for (const [index, entry] of listOf(raw, "credentials", problems).entries()) {
		const at = `credentials[${index}]`;
		if (!isObj(entry)) {
			problems.push(`${at} must be an object`);
			continue;
		}
		const id = idOf(entry, at, problems, credentials);
		const project = entry.project;
		if (typeof project !== "string" || !projects.has(project)) {
			problems.push(`${at}.project must name a project declared in projects`);
			continue;
		}
		if (typeof entry.secretRef !== "string" || !ID.test(entry.secretRef)) {
			problems.push(`${at}.secretRef must be a secret name (lowercase letters, digits, '_', '.', '-')`);
			continue;
		}
		if (id !== undefined) credentials.set(id, { id, project, secretRef: entry.secretRef });
	}
	for (const [index, entry] of listOf(raw, "actions", problems).entries()) {
		const at = `actions[${index}]`;
		if (!isObj(entry)) {
			problems.push(`${at} must be an object`);
			continue;
		}
		const action = actionOf(entry, at, problems, actions);
		if (action !== undefined) actions.set(action.id, action);
	}
	return { projects, credentials, actions };
}

function listOf(raw: Obj, key: string, problems: string[]): unknown[] {
	const value = raw[key];
	if (!Array.isArray(value)) {
		problems.push(`${key} must be an array`);
		return [];
	}
	return value;
}

function idOf(entry: Obj, at: string, problems: string[], seen: ReadonlyMap<string, unknown>): string | undefined {
	const id = entry.id;
	if (typeof id !== "string" || !ID.test(id)) {
		problems.push(`${at}.id must be lowercase letters, digits, '_', '.' or '-' (at most 64)`);
		return undefined;
	}
	if (seen.has(id)) {
		problems.push(`${at}.id '${id}' is declared twice`);
		return undefined;
	}
	return id;
}

function actionOf(
	entry: Obj,
	at: string,
	problems: string[],
	seen: ReadonlyMap<string, unknown>,
): ActionPolicy | undefined {
	const before = problems.length;
	const id = idOf(entry, at, problems, seen);

	const params = new Map<string, RegExp>();
	if (entry.params !== undefined && !isObj(entry.params))
		problems.push(`${at}.params must be an object of name: regex`);
	for (const [name, source] of Object.entries(isObj(entry.params) ? entry.params : {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof source !== "string") {
			problems.push(`${at}.params.${name} must be a regex string under a plain name`);
			continue;
		}
		try {
			params.set(name, new RegExp(`^(?:${source})$`));
		} catch (error) {
			problems.push(`${at}.params.${name} is not a valid regex: ${error instanceof Error ? error.message : error}`);
		}
	}

	const argv = entry.argv;
	if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) {
		problems.push(`${at}.argv must be a non-empty array of strings`);
	} else {
		if (!(argv[0] as string).startsWith("/") || (argv[0] as string).includes("{")) {
			problems.push(`${at}.argv[0] must be an absolute path with no placeholder`);
		}
		const used = new Set<string>();
		for (const arg of argv as string[]) for (const match of arg.matchAll(PLACEHOLDER)) used.add(match[1] as string);
		for (const name of used)
			if (!params.has(name)) problems.push(`${at}.argv uses {${name}} but params does not declare it`);
		for (const name of params.keys()) if (!used.has(name)) problems.push(`${at}.params.${name} is never used in argv`);
	}

	let inject: Inject | undefined;
	const rawInject = entry.inject;
	if (isObj(rawInject) && rawInject.type === "stdin") inject = { type: "stdin" };
	else if (
		isObj(rawInject) &&
		rawInject.type === "env" &&
		typeof rawInject.name === "string" &&
		ENV_NAME.test(rawInject.name)
	) {
		inject = { type: "env", name: rawInject.name };
	} else problems.push(`${at}.inject must be {"type":"stdin"} or {"type":"env","name":"UPPER_CASE"}`);

	const sensitivity = entry.sensitivity;
	if (!ACTION_SENSITIVITIES.includes(sensitivity as Sensitivity)) {
		problems.push(`${at}.sensitivity must be one of ${ACTION_SENSITIVITIES.join(", ")}`);
	}
	const maxOutputBytes = intIn(entry.maxOutputBytes, 1, MAX_OUTPUT_BYTES_LIMIT, `${at}.maxOutputBytes`, problems);
	const timeoutMs = intIn(entry.timeoutMs, 100, MAX_TIMEOUT_MS, `${at}.timeoutMs`, problems);
	if (entry.strictDeny !== undefined && typeof entry.strictDeny !== "boolean") {
		problems.push(`${at}.strictDeny must be true or false`);
	}
	if (problems.length > before || id === undefined || inject === undefined) return undefined;
	return {
		id,
		argv: argv as string[],
		params,
		inject,
		sensitivity: sensitivity as ActionPolicy["sensitivity"],
		maxOutputBytes,
		timeoutMs,
		strictDeny: entry.strictDeny === true,
	};
}

function intIn(value: unknown, min: number, max: number, at: string, problems: string[]): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		problems.push(`${at} must be a whole number from ${min} to ${max}`);
		return min;
	}
	return value;
}

/**
 * The argv an action runs with these parameters. Throws a message for the model when a parameter is missing, unknown
 * or does not match its pattern. Values are substituted as text inside one argv element: no shell ever sees them.
 */
export function buildArgv(action: ActionPolicy, params: Readonly<Record<string, string>>): string[] {
	for (const name of Object.keys(params)) {
		if (!action.params.has(name)) {
			throw new Error(
				`Action '${action.id}' takes no parameter '${name}'. It takes: ${[...action.params.keys()].join(", ") || "none"}.`,
			);
		}
	}
	for (const [name, pattern] of action.params) {
		const value = params[name];
		if (value === undefined) throw new Error(`Action '${action.id}' needs parameter '${name}'.`);
		if (!pattern.test(value))
			throw new Error(`Parameter '${name}' does not match the pattern the policy allows for '${action.id}'.`);
	}
	return action.argv.map((arg) => arg.replace(PLACEHOLDER, (_, name: string) => params[name] as string));
}
