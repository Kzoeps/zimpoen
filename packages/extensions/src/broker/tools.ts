import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ActionArgs, ApprovalAction } from "../approvals/service.ts";
import { DAILY_JOBS } from "../daily/jobs.ts";
import type { DomainDeps } from "../module.ts";
import { asDetails, text } from "../tool-support.ts";
import { decide } from "../trust.ts";
import type { AuditLog } from "./audit.ts";
import { type CredBroker, type CredRunResult, resolveRequest } from "./broker.ts";
import type { Policy } from "./policy.ts";
import * as store from "./store.ts";

/** What the broker module needs from the server. Absent (`ZIMPOEN_CRED_BROKER=off`): no tool, no action. */
export type BrokerDeps = {
	broker: CredBroker;
	policy: Policy;
	audit: AuditLog;
	/**
	 * The request ids of the inputs the calling conversation's current run answers. Default: read from the Harness's live
	 * submissions. Tests replace it.
	 */
	runRequestIds?: (api: ToolExecutionApi, context: Context) => Promise<readonly string[]>;
};

/** The approval action the server carries out when the owner approves a `cred_run` that asked. No tool has this name. */
export const CRED_EXEC_ACTION = "cred_exec";

/**
 * Plan rule 13: nothing self-propagating during scheduled runs. A run started by a routine (`routine:`) or a daily job
 * (`daily:`, and the daily jobs' own `<job>:<date>` request ids) may not start broker actions.
 */
export function isScheduledRequest(requestId: string): boolean {
	if (requestId.startsWith("routine:") || requestId.startsWith("daily:")) return true;
	return DAILY_JOBS.some((job) => requestId.startsWith(`${job.id}:`));
}

type Deps = Pick<DomainDeps, "db" | "now" | "approvals" | "harness"> & { broker: BrokerDeps };

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

/** Approve → the server runs it: the request is checked against the current policy again, then the broker runs it. */
export function createCredExecAction(deps: Deps): ApprovalAction {
	return {
		tool: CRED_EXEC_ACTION,
		proposeTool: "cred_run",
		target: (args) => targetOf(argsOf(args)),
		run: async (args) => {
			return describeRun(await deps.broker.broker.run(argsOf(args)));
		},
	};
}

async function defaultRunRequestIds(deps: Deps, api: ToolExecutionApi, context: Context): Promise<string[]> {
	const live = await deps.harness().inspect(context);
	return live.submissions
		.filter(
			(s) => Number(s.conversationId) === Number(api.conversationId) && s.type === "input" && s.status === "placed",
		)
		.flatMap((s) => (s.requestId === undefined ? [] : [s.requestId]));
}

export function createBrokerTools(deps: Deps): ToolRegistration[] {
	const { db, now, approvals } = deps;
	const { policy, audit } = deps.broker;
	const runRequestIds = deps.broker.runRequestIds ?? ((api, context) => defaultRunRequestIds(deps, api, context));
	const projects = [...policy.projects.values()].map((p) => `${p.id} (${p.trust})`).join(", ") || "none";
	const actions = [...policy.actions.values()]
		.map((a) => `${a.id}${a.params.size > 0 ? ` {${[...a.params.keys()].join(", ")}}` : ""} [${a.sensitivity}]`)
		.join("; ");

	/** What a replayed call returns: exactly what the first execution said. */
	const replay = (row: store.CallRow) => {
		if (row.status === "done")
			return {
				output: text(
					describeRun({ exitCode: row.exitCode ?? -1, output: row.output ?? "", redacted: row.redacted ?? false }),
				),
			};
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
			const refuse = async (reason: string) => {
				store.insertCall(db, { ...base, decision: "deny", status: "refused", reason });
				await audit.append({ at: now(), event: "refused", ...request, callId: api.callId, reason });
				return { output: text(`Refused: ${reason}`) };
			};

			const requestIds = await runRequestIds(api, context);
			if (requestIds.some(isScheduledRequest)) {
				return refuse(
					"broker actions never run during a scheduled run (routine or daily job). Ask the owner in a normal conversation.",
				);
			}
			// A bad request throws for the model to fix; nothing is recorded, so the corrected call is a new call.
			const resolved = resolveRequest(policy, request);
			const decision = decide(resolved.project.trust, resolved.action.sensitivity, {
				strictDeny: resolved.action.strictDeny,
			});
			await audit.append({ at: now(), event: "decision", ...request, decision, callId: api.callId });

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
				store.insertCall(db, { ...base, decision, status: "asked", approvalId: state.id });
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
			try {
				const result = await deps.broker.broker.run({ ...request, callId: api.callId });
				store.finishCall(db, api.callId, result, now());
				return { output: text(describeRun(result)) };
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				store.failCall(db, api.callId, reason, now());
				return { output: text(`Refused: ${reason}`) };
			}
		},
	});
	return [credRun];
}
