import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { approvalsMigrations } from "./migrations.ts";

export const APPROVALS_EXTENSION_NAME = "approvals";

/**
 * Rule 3 of the plan, in code: a tool that destroys data never runs without the owner's approval, whatever the model
 * decides. The hook refuses a call to any registered destructive tool unless an approved request for exactly that tool
 * and target exists; the model's way to get one is the module's `propose_*` tool, and the owner's way to give it is the
 * Approve button or a reply of YES.
 */
export function createApprovalsExtension(deps: Pick<DomainDeps, "approvals">) {
	const { approvals } = deps;
	return defineExtension({
		name: APPROVALS_EXTENSION_NAME,
		hooks: [
			hook(ToolTask, {
				beforeTool: (call, api) => {
					if (!approvals.isDestructive(call.name)) return undefined;
					const propose = approvals.proposeToolFor(call.name) ?? "the propose tool";
					const refusal = {
						block:
							`Blocked: ${call.name} permanently changes data, so it needs the owner's approval first. ` +
							`Call ${propose} with the same arguments, then tell the owner to tap Approve or reply YES. ` +
							"Do not call this tool again until they have answered.",
					};
					try {
						return approvals.isApproved(Number(api.conversationId), call.name, call.arguments) ? undefined : refusal;
					} catch {
						// Arguments the module cannot even name a target for are not an approved call.
						return refusal;
					}
				},
			}),
		],
	});
}

export const approvalsModule: DomainModule = {
	name: "approvals",
	migrations: approvalsMigrations,
	extension: createApprovalsExtension,
};

export {
	type ActionArgs,
	APPROVAL_TTL_MS,
	type ApprovalAction,
	ApprovalConflict,
	ApprovalNotFound,
	type ApprovalService,
	createApprovalService,
	isYes,
	type ProposeInput,
	type RecoveryFailure,
	type RecoveryReport,
} from "./service.ts";
export type { PendingAction } from "./store.ts";
