import { readFile } from "node:fs/promises";
import {
	type BrokerDeps,
	createFileSecretStore,
	createInProcessBroker,
	createJsonlAudit,
	createSocketBroker,
	fetchBrokerPolicy,
	parsePolicy,
} from "@assistant/extensions";
import type { CredBrokerConfig } from "./config.ts";

/** Time the socket client allows past an action's own timeout: the broker scrubs, audits and replies after it. */
const SOCKET_MARGIN_MS = 15_000;
/** For a request naming no known action: the broker refuses it at once. */
const UNKNOWN_ACTION_TIMEOUT_MS = 10_000;

/**
 * The credential broker for `ZIMPOEN_CRED_BROKER`: in process (development), or a client of the `zimpoen-broker`
 * process's socket. Reads and validates the policy at start, from the file or from the broker: a missing or invalid
 * policy, or a broker that can't be reached, stops the server with the reason. Off: undefined.
 */
export async function loadCredBroker(
	config: CredBrokerConfig,
	now: () => number,
	warn?: (message: string) => void,
): Promise<BrokerDeps | undefined> {
	if (config.mode === "off") return undefined;
	if (config.mode === "socket") return loadSocketBroker(config);
	let text: string;
	try {
		text = await readFile(config.policyPath, "utf8");
	} catch (error) {
		throw new Error(
			`ZIMPOEN_CRED_BROKER=inprocess but the broker policy ${config.policyPath} cannot be read ` +
				`(${error instanceof Error ? error.message : String(error)}). Write it (see docs/ARCHITECTURE.md §5.7), set ZIMPOEN_CRED_POLICY, or set ZIMPOEN_CRED_BROKER=off.`,
		);
	}
	const policy = parsePolicy(text, config.policyPath);
	const audit = createJsonlAudit(config.auditPath);
	const broker = createInProcessBroker({
		policy,
		secrets: createFileSecretStore(config.secretsDir),
		audit,
		now,
		...(warn === undefined ? {} : { warn }),
	});
	return { broker, policy, audit };
}

async function loadSocketBroker(config: Extract<CredBrokerConfig, { mode: "socket" }>): Promise<BrokerDeps> {
	let text: string;
	try {
		text = await fetchBrokerPolicy(config.socketPath);
	} catch (error) {
		throw new Error(
			`ZIMPOEN_CRED_BROKER=socket but the broker's policy could not be fetched: ${error instanceof Error ? error.message : String(error)} ` +
				"Start zimpoen-broker (docs/OPS.md), set ZIMPOEN_BROKER_SOCKET, or set ZIMPOEN_CRED_BROKER=off.",
		);
	}
	const policy = parsePolicy(text, `from the broker at ${config.socketPath}`);
	const broker = createSocketBroker({
		socketPath: config.socketPath,
		timeoutMs: (req) => {
			const action = policy.actions.get(req.action);
			return action === undefined ? UNKNOWN_ACTION_TIMEOUT_MS : action.timeoutMs + SOCKET_MARGIN_MS;
		},
	});
	return { broker, policy, audit: createJsonlAudit(config.auditPath) };
}
