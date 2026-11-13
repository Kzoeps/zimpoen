import { defineExtension } from "@earendil-works/pi-durable";
import type { DomainDeps, DomainModule } from "../module.ts";
import { brokerMigrations } from "./migrations.ts";
import { createBrokerTools, createCredExecAction } from "./tools.ts";

export const BROKER_EXTENSION_NAME = "broker";

/**
 * The credential broker (plan §5 "Credential broker", phase 1d). With `deps.broker` absent (`ZIMPOEN_CRED_BROKER=off`,
 * the default) it registers no tool and no approval action; its table is still migrated so the flag can flip freely.
 */
export const brokerModule: DomainModule = {
	name: "broker",
	migrations: brokerMigrations,
	extension: (deps: DomainDeps) =>
		defineExtension({
			name: BROKER_EXTENSION_NAME,
			tools: deps.broker === undefined ? [] : createBrokerTools({ ...deps, broker: deps.broker }),
		}),
	actions: (deps) => (deps.broker === undefined ? [] : [createCredExecAction({ ...deps, broker: deps.broker })]),
};

export { type AuditEvent, type AuditLog, createJsonlAudit, createMemoryAudit } from "./audit.ts";
export {
	type CredBroker,
	type CredRunRequest,
	type CredRunResult,
	createInProcessBroker,
	type ExecFn,
	type ExecRequest,
	type ExecResult,
	execProgram,
	resolveRequest,
} from "./broker.ts";
export { type ActionPolicy, buildArgv, type Policy, PolicyError, parsePolicy } from "./policy.ts";
export { capBytes, REDACTED, scrub, secretVariants } from "./scrub.ts";
export { createFileSecretStore, createMemorySecretStore, type SecretStore } from "./secrets.ts";
export * as brokerStore from "./store.ts";
export { type BrokerDeps, CRED_EXEC_ACTION, isScheduledRequest } from "./tools.ts";
