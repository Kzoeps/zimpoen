import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ActionArgs, ApprovalAction } from "../approvals/service.ts";
import type { DomainDeps } from "../module.ts";
import { currentRunRequestIds, isScheduledRunIds } from "../scheduled-run.ts";
import { asDetails, text } from "../tool-support.ts";
import { decide, type TrustLevel } from "../trust.ts";
import type { AuditEvent, AuditLog } from "./audit.ts";
import { type CredBroker, type CredRunResult, resolveRequest } from "./broker.ts";
import type { Policy, ProjectPolicy } from "./policy.ts";
import * as store from "./store.ts";

/** What the broker module needs from the server. Absent (`ZIMPOEN_CRED_BROKER=off`): no tool, no action. */
export type BrokerDeps = {
	broker: CredBroker;
	policy: Policy;
	audit: AuditLog;
	/**
	 * The trust level that applies to a project now: the owner's choice in Settings when there is one. Default: the level
	 * in the policy. Read at every call, so a change applies to the next one. Only the owner sets it; no tool can.
	 */
	trustOf?: (project: ProjectPolicy) => TrustLevel;
	/**
	 * The request ids of the inputs the calling conversation's current run answers. Default: read from the Harness's live
	 * submissions. Tests replace it.
	 */
	runRequestIds?: (api: ToolExecutionApi, context: Context) => Promise<readonly string[]>;
};

/** The approval action the server carries out when the owner approves a `cred_run` that asked. No tool has this name. */
export const CRED_EXEC_ACTION = "cred_exec";

type Deps = Pick<DomainDeps, "db" | "now" | "approvals" | "harness" | "warn" | "runRequestIds"> & {
	broker: BrokerDeps;
};

type CredArgs = { project: string; credId: string; action: string; params: Record<string, string> };

const argsOf = (args: ActionArgs): CredArgs => ({
	project: String(args.project),
	credId: String(args.credId),
	action: String(args.action),
	params: (args.params ?? {}) as Record<string, string>,
});

/** Same request, same target, whatever order the parameters came in. */
const targetOf = (args: CredArgs): string => {
	const params = Object.fromEntries(Object.entries(args.params).sort(([a], [b]) => a.localeCompare(b)));
	return `cred:${args.project}/${args.credId}/${args.action}?${JSON.stringify(params)}`;
};

const describeRun = (result: CredRunResult): string =>
	`Exit code ${result.exitCode}${result.redacted ? " (secrets redacted from output)" : ""}.\n${result.output}`;

/**
 * Approve → the server runs it. The request is checked against the policy again (it may have been edited since it was
 * asked, and a project now strict may refuse it), and a `broker_call` row keyed by the approval id is written before the
 * run: a crash during the run leaves it `running`, and startup recovery then reports "may have run" instead of running a
 * push or deploy twice.
 */
export function createCredExecAction(deps: Deps): ApprovalAction {
	const { db, now } = deps;
	return {
		tool: CRED_EXEC_ACTION,
		proposeTool: "cred_run",
		target: (args) => targetOf(argsOf(args)),
		run: async (args, approval) => {
			if (approval === undefined) throw new Error("cred_exec runs only from an approval request.");
			const { actionId, conversationId } = approval;
			const request = argsOf(args);
			const key = `approval:${actionId}`;
			const earlier = store.getCall(db, key);
			if (earlier?.status === "done") return describeRun(storedResult(earlier));
			if (earlier !== undefined) {
				throw new Error(
					earlier.status === "running"
						? "The server stopped while this action ran: it may or may not have run, so it was not run again. Check its effect."
						: `Refused: ${earlier.reason ?? "not allowed"}`,
				);
			}
			const resolved = resolveRequest(deps.broker.policy, request);
			const decision = decide(trustOf(deps.broker, resolved.project), resolved.action.sensitivity, {
				strictDeny: resolved.action.strictDeny,
			});
			const base = { callId: key, conversationId, ...request, approvalId: actionId, createdAt: now() };
			if (decision === "deny") {
				const reason = `project '${resolved.project.id}' is now strict and its policy refuses '${resolved.action.id}'.`;
				store.insertCall(db, { ...base, decision, status: "refused", reason });
				throw new Error(`Refused: ${reason}`);
			}
			store.insertCall(db, { ...base, decision, status: "running" });
			let result: CredRunResult;
			try {
				result = await deps.broker.broker.run({ ...request, approvalId: actionId });
			} catch (error) {
				store.failCall(db, key, error instanceof Error ? error.message : String(error), now());
				throw error;
			}
			store.finishCall(db, key, result, now());
			return describeRun(result);
		},
	};
}

const trustOf = (broker: BrokerDeps, project: ProjectPolicy): TrustLevel => broker.trustOf?.(project) ?? project.trust;

const storedResult = (row: store.CallRow): CredRunResult => ({
	exitCode: row.exitCode ?? -1,
	output: row.output ?? "",
	redacted: row.redacted ?? false,
});

export function createBrokerTools(deps: Deps): ToolRegistration[] {
	const { db, now, approvals } = deps;
	const { policy, audit } = deps.broker;
	// Fail closed: no placed input found means "cannot tell", which the tool refuses (rule 13).
	const runRequestIds =
		deps.broker.runRequestIds ??
		((api) => (deps.runRequestIds ?? ((id) => currentRunRequestIds(deps.harness(), id)))(Number(api.conversationId)));
	// Without levels: the owner may change a project's level while the server runs, and this text is fixed at start.
	const projects = [...policy.projects.keys()].join(", ") || "none";
	const actions = [...policy.actions.values()]
		.map((a) => `${a.id}${a.params.size > 0 ? ` {${[...a.params.keys()].join(", ")}}` : ""} [${a.sensitivity}]`)
		.join("; ");

	/** What a replayed call returns: exactly what the first execution said. */
	const replay = (row: store.CallRow) => {
		if (row.status === "done") return { output: text(describeRun(storedResult(row))) };
		if (row.status === "refused") return { output: text(`Refused: ${row.reason ?? "not allowed"}`) };
		if (row.status === "asked" && row.approvalId !== undefined) {
			const state = approvals.state(row.approvalId);
			return { output: text(`Approval requested (${row.approvalId}): status ${state?.status ?? "unknown"}.`) };
		}
		return {
			output: text(
				"This call was interrupted while the action ran: it may or may not have run. Check its effect before trying again with a new call.",
			),
		};
	};

	const credRun = defineTool({
		name: "cred_run",
		deferred: true,
		description:
			"Run a fixed action the owner's broker policy allows, with a credential you never see (there is no way to read a secret). " +
			"The project's trust level decides: it runs now, it asks the owner first (an approval card; the server runs it when they approve), or it is refused. " +
			`Projects: ${projects}. Actions: ${actions || "none"}. Never available during a scheduled run.`,
		parameters: Type.Object({
			project: Type.String({ minLength: 1, maxLength: 64 }),
			credId: Type.String({ minLength: 1, maxLength: 64, description: "A credential of that project." }),
			action: Type.String({ minLength: 1, maxLength: 64 }),
			params: Type.Optional(
				Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 500 }), {
					description: "The action's parameters, each matching the pattern the policy sets.",
				}),
			),
		}),
		replay: "safe",
		async execute(args, api, context) {
			const existing = store.getCall(db, api.callId);
			if (existing !== undefined) return replay(existing);
			const request: CredArgs = {
				project: args.project,
				credId: args.credId,
				action: args.action,
				params: args.params ?? {},
			};
			const base = {
				callId: api.callId,
				conversationId: Number(api.conversationId),
				...request,
				createdAt: now(),
			};
			/** Audit lines are written only after this call's row: a replay then finds the row and writes nothing twice. */
			const record = async (event: Omit<AuditEvent, "at" | "project" | "credId" | "action" | "params" | "callId">) => {
				try {
					await audit.append({ at: now(), ...request, callId: api.callId, ...event });
				} catch (error) {
					deps.warn?.(`[broker] audit write failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			};
			const refuse = async (reason: string) => {
				if (store.insertCall(db, { ...base, decision: "deny", status: "refused", reason })) {
					await record({ event: "refused", decision: "deny", reason });
				}
				return { output: text(`Refused: ${reason}`) };
			};

			const requestIds = await runRequestIds(api, context);
			if (isScheduledRunIds(db, requestIds)) {
				return refuse(
					"broker actions never run during a scheduled run (routine or daily job), or when the run's origin is unknown. Ask the owner in a normal conversation.",
				);
			}
			// A bad request throws for the model to fix; nothing is recorded, so the corrected call is a new call.
			const resolved = resolveRequest(policy, request);
			const decision = decide(trustOf(deps.broker, resolved.project), resolved.action.sensitivity, {
				strictDeny: resolved.action.strictDeny,
			});

			if (decision === "deny") {
				return refuse(`project '${resolved.project.id}' is strict and its policy refuses '${resolved.action.id}'.`);
			}
			if (decision === "ask") {
				const state = approvals.propose({
					conversationId: Number(api.conversationId),
					tool: CRED_EXEC_ACTION,
					args: { ...request },
					summary: `Run ${resolved.action.id} on ${resolved.project.id} with ${resolved.credential.id} (${resolved.action.sensitivity})`,
					callId: api.callId,
				});
				if (store.insertCall(db, { ...base, decision, status: "asked", approvalId: state.id })) {
					await record({ event: "decision", decision, approvalId: state.id });
				}
				return {
					output: text(
						`Approval requested (${state.id}): ${state.summary}. Nothing has run yet. Tell the owner to tap Approve; the server runs it and posts the result.`,
					),
					details: asDetails({
						type: "approval",
						actionId: state.id,
						summary: state.summary,
						expiresAt: state.expiresAt,
					}),
				};
			}
			// Row first: a crash during the run must not run it again on replay (it may push or deploy).
			if (!store.insertCall(db, { ...base, decision, status: "running" })) {
				return replay(store.getCall(db, api.callId) as store.CallRow);
			}
			await record({ event: "decision", decision });
			let result: CredRunResult;
			try {
				result = await deps.broker.broker.run({ ...request, callId: api.callId });
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				store.failCall(db, api.callId, reason, now());
				return { output: text(`Refused: ${reason}`) };
			}
			store.finishCall(db, api.callId, result, now());
			return { output: text(describeRun(result)) };
		},
	});
	return [credRun];
}
