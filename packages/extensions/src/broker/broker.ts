import { spawn } from "node:child_process";
import type { AuditLog } from "./audit.ts";
import { type ActionPolicy, buildArgv, type CredentialPolicy, type Policy, type ProjectPolicy } from "./policy.ts";
import { capBytes, scrub } from "./scrub.ts";
import type { SecretStore } from "./secrets.ts";

export type CredRunRequest = {
	project: string;
	credId: string;
	action: string;
	params: Readonly<Record<string, string>>;
	/** The approval the run carries out, when it was asked for. Recorded in the audit log. */
	approvalId?: string;
	/** The tool call that started it. Recorded in the audit log. */
	callId?: string;
};

export type CredRunResult = { exitCode: number; output: string; redacted: boolean };

/**
 * Runs a policy action with a credential the caller never sees (plan §5 "Credential broker"). Phase 1 implements it
 * in-process; a separate `zbroker` process implements the same interface later. There is no way to read a secret.
 */
export interface CredBroker {
	run(req: CredRunRequest): Promise<CredRunResult>;
}

export type ExecRequest = {
	file: string;
	args: readonly string[];
	env: Readonly<Record<string, string>>;
	input?: string;
	timeoutMs: number;
	/** Stop collecting (and kill the program) past this many bytes of combined output. */
	maxBytes: number;
};

export type ExecResult = { exitCode: number; output: string; timedOut: boolean; truncated: boolean };

export type ExecFn = (req: ExecRequest) => Promise<ExecResult>;

/** What a request resolves to in the policy. Throws a message for the model when any part is unknown or mismatched. */
export type Resolved = { project: ProjectPolicy; credential: CredentialPolicy; action: ActionPolicy; argv: string[] };

export function resolveRequest(policy: Policy, req: Omit<CredRunRequest, "approvalId" | "callId">): Resolved {
	const project = policy.projects.get(req.project);
	if (project === undefined) {
		throw new Error(`Unknown project '${req.project}'. Known: ${[...policy.projects.keys()].join(", ") || "none"}.`);
	}
	const credential = policy.credentials.get(req.credId);
	if (credential === undefined || credential.project !== project.id) {
		throw new Error(`Project '${project.id}' has no credential '${req.credId}'.`);
	}
	const action = policy.actions.get(req.action);
	if (action === undefined) {
		throw new Error(`Unknown action '${req.action}'. Known: ${[...policy.actions.keys()].join(", ") || "none"}.`);
	}
	return { project, credential, action, argv: buildArgv(action, req.params) };
}

/** Programs see only this PATH and the injected secret: none of the server's environment. */
const CLEAN_PATH = "/usr/local/bin:/usr/bin:/bin";

export type InProcessBrokerDeps = {
	policy: Policy;
	secrets: SecretStore;
	audit: AuditLog;
	now: () => number;
	exec?: ExecFn;
};

export function createInProcessBroker(deps: InProcessBrokerDeps): CredBroker {
	const exec = deps.exec ?? execProgram;
	return {
		async run(req) {
			const { credential, action, argv } = resolveRequest(deps.policy, req);
			const secret = await deps.secrets.get(credential.secretRef);
			const env: Record<string, string> = { PATH: CLEAN_PATH, LANG: "C.UTF-8" };
			if (action.inject.type === "env") env[action.inject.name] = secret;
			const [file, ...args] = argv as [string, ...string[]];
			// Collect more than the cap so a secret straddling the cap is still whole when scrubbed.
			const result = await exec({
				file,
				args,
				env,
				...(action.inject.type === "stdin" ? { input: `${secret}\n` } : {}),
				timeoutMs: action.timeoutMs,
				maxBytes: action.maxOutputBytes * 2 + 4096,
			});
			// A collection cut mid-secret leaves a fragment no pattern matches: drop the tail where one could be.
			const raw = result.truncated
				? result.output.slice(0, Math.max(0, result.output.length - secret.length * 2))
				: result.output;
			const scrubbed = scrub(raw, [secret]);
			const capped = capBytes(scrubbed.text, action.maxOutputBytes);
			const output = result.timedOut ? `${capped.text}\n[timed out after ${action.timeoutMs} ms]` : capped.text;
			await deps.audit.append({
				at: deps.now(),
				event: "run",
				project: req.project,
				credId: req.credId,
				action: req.action,
				params: req.params,
				exitCode: result.exitCode,
				timedOut: result.timedOut,
				redacted: scrubbed.redacted,
				...(req.callId === undefined ? {} : { callId: req.callId }),
				...(req.approvalId === undefined ? {} : { approvalId: req.approvalId }),
			});
			return { exitCode: result.exitCode, output, redacted: scrubbed.redacted };
		},
	};
}

/** Run a program with a fixed argv (no shell), a clean environment, a time limit and an output limit. */
export const execProgram: ExecFn = (req) =>
	new Promise((resolve) => {
		const child = spawn(req.file, [...req.args], {
			env: { ...req.env },
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let timedOut = false;
		const collect = (chunk: Buffer): void => {
			if (truncated) return;
			chunks.push(chunk);
			size += chunk.length;
			if (size > req.maxBytes) {
				truncated = true;
				child.kill("SIGKILL");
			}
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, req.timeoutMs);
		const finish = (exitCode: number, extra = ""): void => {
			clearTimeout(timer);
			const output = Buffer.concat(chunks).subarray(0, req.maxBytes).toString("utf8") + extra;
			resolve({ exitCode, output, timedOut, truncated });
		};
		child.on("error", (error) => finish(127, `failed to start ${req.file}: ${error.message}`));
		child.on("close", (code) => finish(code ?? 137));
		child.stdin.on("error", () => {});
		child.stdin.end(req.input ?? "");
	});
