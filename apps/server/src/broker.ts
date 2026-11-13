import { readFile } from "node:fs/promises";
import {
	type BrokerDeps,
	createFileSecretStore,
	createInProcessBroker,
	createJsonlAudit,
	parsePolicy,
} from "@assistant/extensions";
import type { CredBrokerConfig } from "./config.ts";

/**
 * The credential broker for `ZIMPOEN_CRED_BROKER=on`, in-process (phase 1; a separate `zbroker` process later). Reads and
 * validates the policy at start: a missing or invalid policy stops the server with every problem listed. Off: undefined.
 */
export async function loadCredBroker(config: CredBrokerConfig, now: () => number): Promise<BrokerDeps | undefined> {
	if (config.mode === "off") return undefined;
	let text: string;
	try {
		text = await readFile(config.policyPath, "utf8");
	} catch (error) {
		throw new Error(
			`ZIMPOEN_CRED_BROKER=on but the broker policy ${config.policyPath} cannot be read ` +
				`(${error instanceof Error ? error.message : String(error)}). Write it (see docs/ARCHITECTURE.md §5.7), set ZIMPOEN_CRED_POLICY, or set ZIMPOEN_CRED_BROKER=off.`,
		);
	}
	const policy = parsePolicy(text, config.policyPath);
	const audit = createJsonlAudit(config.auditPath);
	const broker = createInProcessBroker({ policy, secrets: createFileSecretStore(config.secretsDir), audit, now });
	return { broker, policy, audit };
}
