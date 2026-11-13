import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppDb, coreMigrations, migrate, openAppDb } from "@assistant/db";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BrokerDeps,
	brokerModule,
	CRED_EXEC_ACTION,
	capBytes,
	createFileSecretStore,
	createInProcessBroker,
	createJsonlAudit,
	createMemoryAudit,
	createMemorySecretStore,
	type ExecFn,
	type ExecRequest,
	execProgram,
	isScheduledRequest,
	PolicyError,
	parsePolicy,
	REDACTED,
	scrub,
} from "../src/broker/index.ts";
import { approvalsModule, createApprovalService, type DomainDeps, type PostedEntry } from "../src/index.ts";
import { decide } from "../src/trust.ts";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

const POLICY = {
	projects: [
		{ id: "zimpoen", trust: "normal" },
		{ id: "sandbox", trust: "open" },
		{ id: "bank", trust: "strict" },
	],
	credentials: [
		{ id: "gh", project: "zimpoen", secretRef: "gh-token" },
		{ id: "gh-sandbox", project: "sandbox", secretRef: "gh-token" },
		{ id: "db", project: "bank", secretRef: "gh-token" },
	],
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
		{
			id: "merge",
			argv: ["/usr/bin/gh", "pr", "merge", "{pr}"],
			params: { pr: "[0-9]{1,6}" },
			inject: { type: "env", name: "GH_TOKEN" },
			sensitivity: "merge_main",
			maxOutputBytes: 2000,
			timeoutMs: 5000,
			strictDeny: true,
		},
	],
};

describe("trust decide", () => {
	it("open allows, normal and strict ask for anything but routine, strict honours strictDeny", () => {
		expect(decide("open", "destructive")).toBe("allow");
		expect(decide("normal", "routine")).toBe("allow");
		expect(decide("normal", "merge_main")).toBe("ask");
		expect(decide("normal", "merge_main", { strictDeny: true })).toBe("ask");
		expect(decide("strict", "deploy_prod")).toBe("ask");
		expect(decide("strict", "deploy_prod", { strictDeny: true })).toBe("deny");
		expect(decide("strict", "routine", { strictDeny: true })).toBe("deny");
	});
});

describe("policy validation", () => {
	it("accepts a valid policy", () => {
		const policy = parsePolicy(JSON.stringify(POLICY));
		expect(policy.actions.get("merge")?.strictDeny).toBe(true);
		expect(policy.projects.get("bank")?.trust).toBe("strict");
	});

	it("lists every problem at once", () => {
		const bad = {
			projects: [{ id: "p", trust: "yolo" }],
			credentials: [{ id: "c", project: "nope", secretRef: "x" }],
			actions: [
				{
					id: "a",
					argv: ["gh", "{who}"],
					params: { extra: "x" },
					inject: { type: "env", name: "lower" },
					sensitivity: "bot_lifecycle",
					maxOutputBytes: 0,
					timeoutMs: 10,
				},
			],
		};
		let error: unknown;
		try {
			parsePolicy(JSON.stringify(bad), "policy.json");
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(PolicyError);
		const text = (error as PolicyError).problems.join("\n");
		for (const expected of [
			"projects[0].trust",
			"credentials[0].project",
			"argv[0] must be an absolute path",
			"uses {who}",
			"params.extra is never used",
			"inject",
			"sensitivity",
			"maxOutputBytes",
			"timeoutMs",
		]) {
			expect(text).toContain(expected);
		}
		expect((error as Error).message).toContain("policy.json");
	});

	it("rejects non-JSON with a clear message", () => {
		expect(() => parsePolicy("{", "p.json")).toThrow(/not valid JSON/);
	});
});

describe("scrubbing", () => {
	it("removes the secret as is, base64 and URL-encoded, and known token shapes", () => {
		const secret = "s3cr3t/value+x";
		const input = [
			`raw ${secret}`,
			`b64 ${Buffer.from(secret).toString("base64")}`,
			`url ${encodeURIComponent(secret)}`,
			"other github_pat_ABCDEFGHIJKLMNOPQRSTUVWX123",
			"openai sk-proj-ABCDEFGHIJKLMNOP1234",
			"gh gho_ABCDEFGHIJKLMNOPQRSTUVWX",
			"db postgres://app:hunter2@db.local:5432/x",
		].join("\n");
		const out = scrub(input, [secret]);
		expect(out.redacted).toBe(true);
		expect(out.text).not.toContain(secret);
		expect(out.text).not.toContain(Buffer.from(secret).toString("base64"));
		expect(out.text).not.toContain(encodeURIComponent(secret));
		expect(out.text).not.toMatch(/github_pat_|sk-proj|gho_|hunter2/);
		expect(out.text).toContain(`postgres://app:${REDACTED}@db.local`);
	});

	it("reports nothing redacted for clean output, and caps by bytes", () => {
		expect(scrub("all fine", ["zzzzzz"])).toEqual({ text: "all fine", redacted: false });
		const capped = capBytes("é".repeat(100), 51);
		expect(capped.truncated).toBe(true);
		expect(capped.text.startsWith("é".repeat(25))).toBe(true);
		expect(capped.text).not.toContain("\uFFFD");
	});
});

describe("in-process broker", () => {
	it("runs a fixed argv with a clean env holding only the secret, scrubs, caps and audits without the value", async () => {
		const calls: ExecRequest[] = [];
		const exec: ExecFn = async (req) => {
			calls.push(req);
			return { exitCode: 0, output: `token=${SECRET}\n${"x".repeat(5000)}`, timedOut: false, truncated: false };
		};
		const audit = createMemoryAudit();
		const broker = createInProcessBroker({
			policy: parsePolicy(JSON.stringify(POLICY)),
			secrets: createMemorySecretStore({ "gh-token": SECRET }),
			audit,
			now: () => 1,
			exec,
		});
		const result = await broker.run({ project: "zimpoen", credId: "gh", action: "pr-view", params: { pr: "42" } });
		expect(calls[0]?.file).toBe("/usr/bin/gh");
		expect(calls[0]?.args).toEqual(["pr", "view", "42"]);
		expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(["GH_TOKEN", "LANG", "PATH"]);
		expect(result.redacted).toBe(true);
		expect(result.output).not.toContain(SECRET);
		expect(Buffer.byteLength(result.output)).toBeLessThan(2100);
		expect(JSON.stringify(audit.events)).not.toContain(SECRET);
		expect(audit.events[0]).toMatchObject({ event: "run", exitCode: 0, redacted: true });
	});

	it("refuses parameters that do not match the policy, before anything runs", async () => {
		let ran = false;
		const broker = createInProcessBroker({
			policy: parsePolicy(JSON.stringify(POLICY)),
			secrets: createMemorySecretStore({ "gh-token": SECRET }),
			audit: createMemoryAudit(),
			now: () => 1,
			exec: async () => {
				ran = true;
				return { exitCode: 0, output: "", timedOut: false, truncated: false };
			},
		});
		const run = (params: Record<string, string>, credId = "gh") =>
			broker.run({ project: "zimpoen", credId, action: "pr-view", params });
		await expect(run({ pr: "1; rm -rf /" })).rejects.toThrow(/does not match/);
		await expect(run({ pr: "1", extra: "x" })).rejects.toThrow(/no parameter 'extra'/);
		await expect(run({ pr: "1" }, "gh-sandbox")).rejects.toThrow(/has no credential/);
		expect(ran).toBe(false);
	});

	it("really executes with the default runner: no inherited environment, output scrubbed", async () => {
		const policy = parsePolicy(
			JSON.stringify({
				projects: [{ id: "p", trust: "open" }],
				credentials: [{ id: "c", project: "p", secretRef: "tok" }],
				actions: [
					{
						id: "env",
						argv: ["/usr/bin/env"],
						inject: { type: "env", name: "TOKEN" },
						sensitivity: "routine",
						maxOutputBytes: 4000,
						timeoutMs: 5000,
					},
				],
			}),
		);
		process.env.ZIMPOEN_TEST_LEAK = "should-not-be-seen";
		try {
			const broker = createInProcessBroker({
				policy,
				secrets: createMemorySecretStore({ tok: "hello-secret-value" }),
				audit: createMemoryAudit(),
				now: () => 1,
				exec: execProgram,
			});
			const result = await broker.run({ project: "p", credId: "c", action: "env", params: {} });
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain(`TOKEN=${REDACTED}`);
			expect(result.output).not.toContain("hello-secret-value");
			expect(result.output).not.toContain("ZIMPOEN_TEST_LEAK");
		} finally {
			delete process.env.ZIMPOEN_TEST_LEAK;
		}
	});
});

describe("file secret store and audit log", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
	});

	it("reads 0600 files, refuses group-readable ones, and appends audit JSONL", async () => {
		const dir = await mkdtemp(join(tmpdir(), "broker-"));
		dirs.push(dir);
		const secrets = join(dir, "creds");
		const store = createFileSecretStore(secrets);
		await expect(store.get("missing")).rejects.toThrow(/not set/);
		await writeFile(join(secrets, "ok"), "value\n", { mode: 0o600 });
		await writeFile(join(secrets, "loose"), "value", { mode: 0o644 });
		expect(await store.get("ok")).toBe("value");
		await expect(store.get("loose")).rejects.toThrow(/chmod 600/);
		await expect(store.get("../etc")).rejects.toThrow(/not a valid secret name/);

		const audit = createJsonlAudit(join(dir, "audit.jsonl"));
		await audit.append({ at: 1, event: "decision", project: "p", credId: "c", action: "a", params: {} });
		await audit.append({ at: 2, event: "run", project: "p", credId: "c", action: "a", params: {}, exitCode: 0 });
		const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n");
		expect(lines.map((line) => JSON.parse(line).event)).toEqual(["decision", "run"]);
	});
});

describe("cred_run tool", () => {
	const dbs: Array<{ db: AppDb; dir: string }> = [];
	afterEach(async () => {
		for (const { db, dir } of dbs.splice(0)) {
			db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	async function setup(options: { requestIds?: string[] } = {}) {
		const dir = await mkdtemp(join(tmpdir(), "broker-db-"));
		const db = openAppDb(join(dir, "app.sqlite"));
		dbs.push({ db, dir });
		migrate(db, [...coreMigrations, ...approvalsModule.migrations, ...brokerModule.migrations]);
		const posted: PostedEntry[] = [];
		const approvals = createApprovalService({
			db,
			now: () => 1000,
			post: async (_conversationId, entry) => {
				posted.push(entry);
				return { submissionId: posted.length };
			},
		});
		const execs: ExecRequest[] = [];
		const audit = createMemoryAudit();
		const policy = parsePolicy(JSON.stringify(POLICY));
		const broker: BrokerDeps = {
			policy,
			audit,
			broker: createInProcessBroker({
				policy,
				secrets: createMemorySecretStore({ "gh-token": SECRET }),
				audit,
				now: () => 1000,
				exec: async (req) => {
					execs.push(req);
					return { exitCode: 0, output: `merged with ${SECRET}`, timedOut: false, truncated: false };
				},
			}),
			runRequestIds: async () => options.requestIds ?? ["msg-1"],
		};
		const deps = {
			db,
			now: () => 1000,
			approvals,
			harness: () => {
				throw new Error("not used");
			},
			broker,
		} as unknown as DomainDeps;
		for (const action of brokerModule.actions?.(deps) ?? []) approvals.register(action);
		const tool = brokerModule.extension(deps).tools?.find((candidate) => candidate.name === "cred_run");
		if (tool === undefined) throw new Error("cred_run not registered");
		const call = (args: Record<string, unknown>, callId: string): Promise<ToolExecutionResult> =>
			tool.execute(
				args as never,
				{ callId, conversationId: 7, now: () => 1000 } as unknown as ToolExecutionApi,
				BACKGROUND_CONTEXT,
			);
		return { db, approvals, posted, execs, audit, call };
	}

	const outputOf = (result: ToolExecutionResult): string =>
		(result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

	it("registers nothing when the broker is off", () => {
		const deps = { db: undefined, approvals: undefined } as unknown as DomainDeps;
		expect(brokerModule.extension(deps).tools ?? []).toEqual([]);
		expect(brokerModule.actions?.(deps)).toEqual([]);
	});

	it("runs a routine action at once and returns scrubbed output", async () => {
		const f = await setup();
		const result = await f.call({ project: "zimpoen", credId: "gh", action: "pr-view", params: { pr: "1" } }, "c1");
		expect(f.execs).toHaveLength(1);
		expect(outputOf(result)).toContain("Exit code 0");
		expect(outputOf(result)).not.toContain(SECRET);
	});

	it("is idempotent by call id: a replay returns the stored result and runs nothing", async () => {
		const f = await setup();
		const args = { project: "zimpoen", credId: "gh", action: "pr-view", params: { pr: "1" } };
		const first = await f.call(args, "same");
		const second = await f.call(args, "same");
		expect(f.execs).toHaveLength(1);
		expect(outputOf(second)).toBe(outputOf(first));
	});

	it("asks for a sensitive action under Normal, and the server runs it on approval", async () => {
		const f = await setup();
		const result = await f.call({ project: "zimpoen", credId: "gh", action: "merge", params: { pr: "9" } }, "m1");
		expect(f.execs).toHaveLength(0);
		const card = result.details as { type: string; actionId: string };
		expect(card.type).toBe("approval");
		// A replay of the proposing call neither asks twice nor runs.
		await f.call({ project: "zimpoen", credId: "gh", action: "merge", params: { pr: "9" } }, "m1");
		expect(f.db.all("SELECT id FROM pending_actions WHERE tool = ?", CRED_EXEC_ACTION)).toHaveLength(1);

		const state = await f.approvals.decide(card.actionId, "approve", "button");
		expect(state.status).toBe("executed");
		expect(f.execs).toHaveLength(1);
		expect(f.execs[0]?.args).toEqual(["pr", "merge", "9"]);
		expect(state.resultText).not.toContain(SECRET);
		expect(JSON.stringify(f.posted)).not.toContain(SECRET);
	});

	it("allows everything under Open and refuses a strictDeny action under Strict", async () => {
		const f = await setup();
		await f.call({ project: "sandbox", credId: "gh-sandbox", action: "merge", params: { pr: "2" } }, "o1");
		expect(f.execs).toHaveLength(1);
		const denied = await f.call({ project: "bank", credId: "db", action: "merge", params: { pr: "2" } }, "s1");
		expect(outputOf(denied)).toMatch(/^Refused: .*strict/);
		expect(f.execs).toHaveLength(1);
	});

	it("refuses during a scheduled run", async () => {
		for (const requestId of ["routine:r_1:2026-01-01", "daily:x", "briefing:2026-10-25"]) {
			expect(isScheduledRequest(requestId)).toBe(true);
			const f = await setup({ requestIds: [requestId] });
			const result = await f.call(
				{ project: "sandbox", credId: "gh-sandbox", action: "pr-view", params: { pr: "1" } },
				"r1",
			);
			expect(outputOf(result)).toMatch(/scheduled run/);
			expect(f.execs).toHaveLength(0);
		}
		expect(isScheduledRequest("msg-1")).toBe(false);
	});
});
