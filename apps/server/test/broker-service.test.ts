import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACTED } from "@assistant/extensions";
import { afterEach, describe, expect, it } from "vitest";
import { loadCredBroker } from "../src/broker.ts";
import { parseBrokerEnv, startBrokerService } from "../src/broker-service.ts";

const SECRET = "tok_0123456789abcdefghijklmnop";
const POLICY = {
	projects: [{ id: "demo", trust: "open" }],
	credentials: [{ id: "c", project: "demo", secretRef: "demo-token" }],
	actions: [
		{
			id: "show-env",
			argv: ["/usr/bin/env"],
			params: {},
			inject: { type: "env", name: "DEMO_TOKEN" },
			sensitivity: "routine",
			maxOutputBytes: 4000,
			timeoutMs: 5000,
		},
	],
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(): Promise<{ root: string; socketPath: string; env: Record<string, string> }> {
	const root = await mkdtemp(join(tmpdir(), "zbs-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "run"), { mode: 0o750 });
	await mkdir(join(root, "creds"), { mode: 0o700 });
	await writeFile(join(root, "creds", "demo-token"), `${SECRET}\n`, { mode: 0o600 });
	await writeFile(join(root, "policy.json"), JSON.stringify(POLICY));
	await chmod(join(root, "run"), 0o750);
	const socketPath = join(root, "run", "broker.sock");
	return {
		root,
		socketPath,
		env: {
			ZIMPOEN_BROKER_SOCKET: socketPath,
			ZIMPOEN_CRED_POLICY: join(root, "policy.json"),
			ZIMPOEN_BROKER_AUDIT: join(root, "audit.jsonl"),
			ZIMPOEN_BROKER_SECRETS: `file:${join(root, "creds")}`,
		},
	};
}

function closing(server: Server): void {
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
}

describe("zimpoen-broker service", () => {
	it("serves the server's socket client end to end: policy, a real program, scrubbed output, its own audit", async () => {
		const { root, socketPath, env } = await setup();
		closing(await startBrokerService(parseBrokerEnv(env), { log: () => {} }));

		const deps = await loadCredBroker(
			{ mode: "socket", socketPath, auditPath: join(root, "server-audit.jsonl") },
			() => 1,
		);
		expect(deps?.policy.actions.has("show-env")).toBe(true);
		const result = await deps?.broker.run({ project: "demo", credId: "c", action: "show-env", params: {} });
		expect(result?.exitCode).toBe(0);
		expect(result?.output).toContain(`DEMO_TOKEN=${REDACTED}`);
		expect(result?.output).not.toContain(SECRET);
		const audit = await readFile(join(root, "audit.jsonl"), "utf8");
		expect(audit).toContain('"event":"run"');
		expect(audit).not.toContain(SECRET);
	});

	it("stops the server's start with what to do when the broker is not running", async () => {
		const { root, socketPath } = await setup();
		await expect(
			loadCredBroker({ mode: "socket", socketPath, auditPath: join(root, "a.jsonl") }, () => 1),
		).rejects.toThrow(/ZIMPOEN_CRED_BROKER=socket.*Start zimpoen-broker/s);
	});

	it("reads its settings, defaulting to the systemd unit's paths and store", () => {
		expect(parseBrokerEnv({ CREDENTIALS_DIRECTORY: "/run/credentials/zimpoen-broker.service" })).toEqual({
			socketPath: "/run/zimpoen-broker/broker.sock",
			policyPath: "/etc/zimpoen-broker/policy.json",
			auditPath: "/var/lib/zimpoen-broker/audit.jsonl",
			secrets: { type: "systemd-creds", dir: "/run/credentials/zimpoen-broker.service" },
		});
		expect(() => parseBrokerEnv({ ZIMPOEN_BROKER_SECRETS: "vault", ZIMPOEN_BROKER_SOCKET: "rel.sock" })).toThrow(
			/ZIMPOEN_BROKER_SOCKET.*\n.*ZIMPOEN_BROKER_SECRETS/,
		);
	});

	it("refuses to start with the systemd-creds store outside systemd", async () => {
		const { env } = await setup();
		const { ZIMPOEN_BROKER_SECRETS: _, ...rest } = env;
		await expect(startBrokerService(parseBrokerEnv(rest), { log: () => {} })).rejects.toThrow(
			/CREDENTIALS_DIRECTORY is not set/,
		);
	});
});
