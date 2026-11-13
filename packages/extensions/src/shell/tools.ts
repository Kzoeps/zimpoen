import { getAgentRowByConversation } from "@assistant/db";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { getBot } from "../bots/store.ts";
import type { DomainDeps } from "../module.ts";
import { runIsScheduled } from "../scheduled-run.ts";
import { text } from "../tool-support.ts";
import { type ContainerRunner, SHELL_LIMITS, SHELL_WORKDIR } from "./sandbox.ts";

export const SHELL_EXTENSION_NAME = "shell";

/** What the shell needs from the server. Absent (`ZIMPOEN_SHELL=off`, the default): no tool. */
export type ShellDeps = { runner: ContainerRunner };

type Deps = Pick<DomainDeps, "db" | "harness" | "runRequestIds" | "shell">;

/** The built-in agents that may have the shell. Never the Inbox (rule 6: it reads untrusted mail). */
const SHELL_AGENTS: ReadonlySet<string> = new Set(["pa"]);

/**
 * Whether an agent may run the shell: the PA, and a bot whose row has the `shell` preset. Checked on every call, on top of
 * which agents select the extension at all, so a wiring mistake cannot hand the Inbox a shell.
 */
export function mayUseShell(db: DomainDeps["db"], agentId: string): boolean {
	if (agentId === "inbox") return false;
	if (SHELL_AGENTS.has(agentId)) return true;
	if (!agentId.startsWith("bot:")) return false;
	return getBot(db, agentId.slice("bot:".length))?.tools.includes("shell") ?? false;
}

const describe = (result: { exitCode: number; output: string; timedOut: boolean }, timeoutMs: number): string =>
	`Exit code ${result.exitCode}${result.timedOut ? ` (timed out after ${timeoutMs / 1000} s; the container was removed)` : ""}.\n${result.output}`;

/**
 * `shell_run` (PLAN upgrade §8): one command in the calling agent's own gVisor container. Not `replay: "safe"`: a crash
 * mid-run is reported to the model as interrupted instead of running the command again.
 */
export function createShellExtension(deps: Deps): Extension {
	const shell = deps.shell;
	if (shell === undefined) return defineExtension({ name: SHELL_EXTENSION_NAME, tools: [] });
	const shellRun = defineTool({
		name: "shell_run",
		deferred: true,
		description:
			`Run a shell command (/bin/sh -c) in your own disposable Linux sandbox, never on the owner's machine. ` +
			`Your files persist in ${SHELL_WORKDIR} between calls; everything else is read-only and reset each call (/tmp is ` +
			`scratch). No access to the owner's files, secrets or local network; the internet only if the owner enabled it. ` +
			`Output is capped at ${SHELL_LIMITS.maxOutputBytes / 1024} KB; default time limit ${SHELL_LIMITS.defaultTimeoutMs / 1000} s. ` +
			"Never available during a scheduled run.",
		parameters: Type.Object({
			command: Type.String({ minLength: 1, maxLength: SHELL_LIMITS.maxCommandChars }),
			timeoutSeconds: Type.Optional(
				Type.Integer({ minimum: 1, maximum: SHELL_LIMITS.maxTimeoutMs / 1000, description: "Default 60." }),
			),
		}),
		async execute(args, api) {
			const conversationId = Number(api.conversationId);
			const agentId = getAgentRowByConversation(deps.db, conversationId)?.id;
			if (agentId === undefined || !mayUseShell(deps.db, agentId)) {
				return { output: text("Refused: this agent has no shell.") };
			}
			if (await runIsScheduled(deps, conversationId)) {
				return {
					output: text(
						"Refused: the shell never runs during a scheduled run (routine or daily job), or when the run's origin is unknown (rule 13). Ask the owner in a normal conversation.",
					),
				};
			}
			const timeoutMs = Math.min(
				(args.timeoutSeconds ?? SHELL_LIMITS.defaultTimeoutMs / 1000) * 1000,
				SHELL_LIMITS.maxTimeoutMs,
			);
			const result = await shell.runner.run({ agentId, command: args.command, timeoutMs, callId: api.callId });
			return { output: text(describe(result, timeoutMs)) };
		},
	});
	return defineExtension({ name: SHELL_EXTENSION_NAME, tools: [shellRun] });
}
