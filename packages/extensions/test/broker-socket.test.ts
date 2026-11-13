import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CredBroker,
	createInProcessBroker,
	createMemoryAudit,
	createMemorySecretStore,
	createSocketBroker,
	createSystemdCredsStore,
	fetchBrokerPolicy,
	listenBrokerSocket,
	MAX_REQUEST_BYTES,
	parsePolicy,
	REDACTED,
} from "../src/broker/index.ts";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const POLICY_TEXT = JSON.stringify({
	projects: [{ id: "zimpoen", trust: "normal" }],
	credentials: [{ id: "gh", project: "zimpoen", secretRef: "gh-token" }],
	actions: [
		{
			id: "pr-view",
			argv: ["/usr/bin/gh", "pr", "view", "{pr}"],
			params: { pr: "[0-9]{1,6}" },
			inject: { type: "env", name: "GH_TOKEN" },
			sensitivity: "routine",
			maxOutputBytes: 2000,
			timeoutMs: 5000,
		},
	],
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function socketDir(mode = 0o750): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "zb-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, "run");
	await mkdir(dir, { mode });
	return dir;
}

function closing(server: Server): Server {
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	cleanups.push(
		() =>
			new Promise((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(resolve);
			}),
	);
	return server;
}

/** A broker whose program echoes its secret, so scrubbing is visible across the socket. */
function echoBroker(): { broker: CredBroker; audit: ReturnType<typeof createMemoryAudit> } {
	const audit = createMemoryAudit();
	const broker = createInProcessBroker({
		policy: parsePolicy(POLICY_TEXT),
		secrets: createMemorySecretStore({ "gh-token": SECRET }),
		audit,
		now: () => 1,
		exec: async (req) => ({
			exitCode: 0,
			output: `PR ${req.args.at(-1)} token=${req.env.GH_TOKEN}`,
			timedOut: false,
			truncated: false,
		}),
	});
	return { broker, audit };
}

async function listen(): Promise<{ socketPath: string; audit: ReturnType<typeof createMemoryAudit> }> {
	const socketPath = join(await socketDir(), "broker.sock");
	const { broker, audit } = echoBroker();
	closing(await listenBrokerSocket(socketPath, { broker, policyText: POLICY_TEXT }));
	return { socketPath, audit };
}

/** Send raw bytes and collect the whole reply. */
function raw(socketPath: string, payload: string | Buffer): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let reply = "";
		socket.on("data", (chunk) => {
			reply += chunk.toString("utf8");
		});
		socket.on("close", () => resolve(reply));
		socket.on("error", reject);
		socket.write(payload);
	});
}

describe("broker socket", () => {
	it("runs a request through the broker process and returns only scrubbed output", async () => {
		const { socketPath, audit } = await listen();
		const client = createSocketBroker({ socketPath, timeoutMs: () => 5000 });
		const result = await client.run({
			project: "zimpoen",
			credId: "gh",
			action: "pr-view",
			params: { pr: "42" },
			callId: "call-1",
		});
		expect(result.output).toBe(`PR 42 token=${REDACTED}`);
		expect(result.redacted).toBe(true);
		expect(audit.events[0]).toMatchObject({ event: "run", action: "pr-view", callId: "call-1" });
	});

	it("serves the policy text the server decides with", async () => {
		const { socketPath } = await listen();
		expect(parsePolicy(await fetchBrokerPolicy(socketPath)).actions.has("pr-view")).toBe(true);
	});

	it("passes the broker's refusal back as an error for the model", async () => {
		const { socketPath } = await listen();
		const client = createSocketBroker({ socketPath, timeoutMs: () => 5000 });
		await expect(client.run({ project: "nope", credId: "gh", action: "pr-view", params: {} })).rejects.toThrow(
			/Unknown project 'nope'/,
		);
		await expect(
			client.run({ project: "zimpoen", credId: "gh", action: "pr-view", params: { pr: "1; rm -rf /" } }),
		).rejects.toThrow(/does not match/);
	});

	it("refuses malformed, wrong-version, ill-typed and oversized requests", async () => {
		const { socketPath } = await listen();
		expect(JSON.parse(await raw(socketPath, "not json\n"))).toEqual({ ok: false, error: "The request is not JSON." });
		expect(JSON.parse(await raw(socketPath, '{"v":2,"op":"policy"}\n')).error).toMatch(/v1/);
		expect(
			JSON.parse(await raw(socketPath, '{"v":1,"op":"run","req":{"project":"zimpoen","credId":"gh","action":1}}\n'))
				.error,
		).toMatch(/as text/);
		expect(
			JSON.parse(
				await raw(
					socketPath,
					'{"v":1,"op":"run","req":{"project":"zimpoen","credId":"gh","action":"pr-view","params":{"pr":4}}}\n',
				),
			).error,
		).toMatch(/params/);
		const big = await raw(socketPath, Buffer.alloc(MAX_REQUEST_BYTES + 10, "a"));
		expect(JSON.parse(big).error).toMatch(/larger than/);
	});

	it("makes the socket 0660 and refuses a directory others can enter", async () => {
		const { socketPath } = await listen();
		expect((await stat(socketPath)).mode & 0o777).toBe(0o660);
		const open = await socketDir(0o755);
		const { broker } = echoBroker();
		await expect(listenBrokerSocket(join(open, "b.sock"), { broker, policyText: POLICY_TEXT })).rejects.toThrow(
			/open to other users.*chmod 0750/,
		);
		await expect(
			listenBrokerSocket(join(open, "missing", "b.sock"), { broker, policyText: POLICY_TEXT }),
		).rejects.toThrow(/does not exist/);
	});

	it("gives up on a broker that never answers, and on one whose reply is too large", async () => {
		const dir = await socketDir();
		const silent = join(dir, "silent.sock");
		closing(createServer(() => {}).listen(silent));
		await expect(fetchBrokerPolicy(silent, 100)).rejects.toThrow(/did not answer within 100 ms/);

		const flood = join(dir, "flood.sock");
		closing(
			createServer((socket) => {
				socket.on("error", () => {});
				const chunk = Buffer.alloc(1024 * 1024, "x");
				const push = (): void => {
					while (!socket.destroyed && socket.write(chunk));
					if (!socket.destroyed) socket.once("drain", push);
				};
				push();
			}).listen(flood),
		);
		await expect(fetchBrokerPolicy(flood, 10_000)).rejects.toThrow(/larger than/);
	});

	it("says how to fix an unreachable broker", async () => {
		const dir = await socketDir();
		await expect(fetchBrokerPolicy(join(dir, "none.sock"))).rejects.toThrow(/Is zimpoen-broker running/);
	});
});

describe("systemd-creds secret store", () => {
	it("reads $CREDENTIALS_DIRECTORY/<ref> and names the unit setting when one is missing", async () => {
		const dir = await socketDir();
		await writeFile(join(dir, "gh-token"), `${SECRET}\n`);
		const store = createSystemdCredsStore(dir);
		expect(await store.get("gh-token")).toBe(SECRET);
		await expect(store.get("other")).rejects.toThrow(/LoadCredentialEncrypted=other:/);
		await expect(store.get("../etc")).rejects.toThrow(/not a valid secret name/);
	});

	it("refuses to start outside a unit that loads credentials", () => {
		expect(() => createSystemdCredsStore(undefined)).toThrow(/CREDENTIALS_DIRECTORY is not set/);
	});
});
