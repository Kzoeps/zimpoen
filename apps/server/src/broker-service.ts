import { readFile } from "node:fs/promises";
import type { Server } from "node:net";
import { isAbsolute, resolve } from "node:path";
import {
	createFileSecretStore,
	createInProcessBroker,
	createJsonlAudit,
	createSystemdCredsStore,
	listenBrokerSocket,
	parsePolicy,
} from "@assistant/extensions";
import { DEFAULT_BROKER_SOCKET } from "./config.ts";

/**
 * Settings of the `zimpoen-broker` process (plan §9), all from its environment:
 *
 * - `ZIMPOEN_BROKER_SOCKET`: where it listens (default `/run/zimpoen-broker/broker.sock`).
 * - `ZIMPOEN_CRED_POLICY`: the policy file (default `/etc/zimpoen-broker/policy.json`).
 * - `ZIMPOEN_BROKER_AUDIT`: its run log (default `/var/lib/zimpoen-broker/audit.jsonl`).
 * - `ZIMPOEN_BROKER_SECRETS`: `systemd-creds` (default; `$CREDENTIALS_DIRECTORY`) or `file:<absolute dir>` (development).
 */
export type BrokerServiceConfig = {
	socketPath: string;
	policyPath: string;
	auditPath: string;
	secrets: { type: "systemd-creds"; dir: string | undefined } | { type: "file"; dir: string };
};

export function parseBrokerEnv(env: Readonly<Record<string, string | undefined>>): BrokerServiceConfig {
	const problems: string[] = [];
	const path = (name: string, fallback: string): string => {
		const raw = env[name]?.trim() || fallback;
		if (!isAbsolute(raw)) problems.push(`${name}: '${raw}' is not an absolute path.`);
		return resolve(raw);
	};
	const socketPath = path("ZIMPOEN_BROKER_SOCKET", DEFAULT_BROKER_SOCKET);
	const policyPath = path("ZIMPOEN_CRED_POLICY", "/etc/zimpoen-broker/policy.json");
	const auditPath = path("ZIMPOEN_BROKER_AUDIT", "/var/lib/zimpoen-broker/audit.jsonl");
	const rawSecrets = env.ZIMPOEN_BROKER_SECRETS?.trim() || "systemd-creds";
	let secrets: BrokerServiceConfig["secrets"] = { type: "systemd-creds", dir: env.CREDENTIALS_DIRECTORY };
	if (rawSecrets.startsWith("file:")) {
		const dir = rawSecrets.slice("file:".length);
		if (!isAbsolute(dir)) problems.push(`ZIMPOEN_BROKER_SECRETS: '${dir}' is not an absolute path.`);
		secrets = { type: "file", dir: resolve(dir) };
	} else if (rawSecrets !== "systemd-creds") {
		problems.push(
			`ZIMPOEN_BROKER_SECRETS: '${rawSecrets}' is not valid. Use 'systemd-creds' (default) or 'file:/absolute/dir'.`,
		);
	}
	if (problems.length > 0) {
		throw new Error(`zimpoen-broker is misconfigured:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	}
	return { socketPath, policyPath, auditPath, secrets };
}

export type BrokerServiceDeps = {
	now?: () => number;
	log?: (message: string) => void;
};

/** Read the policy, open the secret store and listen. Every failure is thrown with what to fix. */
export async function startBrokerService(config: BrokerServiceConfig, deps: BrokerServiceDeps = {}): Promise<Server> {
	const log = deps.log ?? ((message: string) => console.error(message));
	const policyText = await readFile(config.policyPath, "utf8").catch((error: unknown) => {
		throw new Error(
			`The broker policy ${config.policyPath} cannot be read (${error instanceof Error ? error.message : String(error)}). ` +
				"Write it (docs/ARCHITECTURE.md §5.7) or set ZIMPOEN_CRED_POLICY.",
		);
	});
	const policy = parsePolicy(policyText, config.policyPath);
	const secrets =
		config.secrets.type === "file"
			? createFileSecretStore(config.secrets.dir)
			: createSystemdCredsStore(config.secrets.dir);
	const broker = createInProcessBroker({
		policy,
		secrets,
		audit: createJsonlAudit(config.auditPath),
		now: deps.now ?? Date.now,
		warn: log,
	});
	const server = await listenBrokerSocket(config.socketPath, { broker, policyText, warn: log });
	log(`[broker] listening on ${config.socketPath} (secrets: ${config.secrets.type})`);
	return server;
}
