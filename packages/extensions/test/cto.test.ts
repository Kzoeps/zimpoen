import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppDb, coreMigrations, migrate, openAppDb } from "@assistant/db";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	createFakeCodingLead,
	ctoModule,
	ctoStore,
	type DomainDeps,
	delegateModule,
	type FakeCodingLead,
	leadMessage,
	parseCardShow,
	validateCodingArgs,
} from "../src/index.ts";
import { isScheduledRunIds } from "../src/scheduled-run.ts";
import type { TrustLevel } from "../src/trust.ts";

const REPOS = ["hypercerts-org/api", "zimpoen"];
const ARGS = {
	repo: "zimpoen",
	goal: "Add a health check endpoint.",
	doneWhen: "pnpm test passes.",
	outOfScope: "UI.",
};

const outputOf = (result: ToolExecutionResult): string =>
	(result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

describe("validateCodingArgs", () => {
	it("accepts allowlisted repos and trims", () => {
		expect(validateCodingArgs({ ...ARGS, goal: "  Do it.  " }, REPOS).goal).toBe("Do it.");
	});

	it("refuses a repo outside the allowlist, values starting with '-', over-long text and control characters", () => {
		expect(() => validateCodingArgs({ ...ARGS, repo: "evil/repo" }, REPOS)).toThrow(/not one the owner allowed/);
		expect(() => validateCodingArgs({ ...ARGS, goal: "--exec=rm" }, REPOS)).toThrow(/must not start with '-'/);
		expect(() => validateCodingArgs({ ...ARGS, repo: "-zimpoen" }, REPOS)).toThrow(/must not start with '-'/);
		expect(() => validateCodingArgs({ ...ARGS, doneWhen: "x".repeat(1001) }, REPOS)).toThrow(/at most 1000/);
		expect(() => validateCodingArgs({ ...ARGS, outOfScope: "a\u0000b" }, REPOS)).toThrow(/control characters/);
		expect(() => validateCodingArgs({ ...ARGS, goal: "   " }, REPOS)).toThrow(/must not be empty/);
	});
});

describe("board output", () => {
	it("parses hc-board show", () => {
		const card = parseCardShow(
			[
				"t7 [review] Add health check",
				"  goal: Add a health check endpoint.",
				"  pr: https://github.com/o/r/pull/3",
				"  report: /home/x/report.md",
				"  note: ready",
				"  - 2026-01-01T00:00 w: claimed",
			].join("\n"),
		);
		expect(card).toEqual({
			id: "t7",
			status: "review",
			title: "Add health check",
			pr: "https://github.com/o/r/pull/3",
			report: "/home/x/report.md",
			note: "ready",
		});
		expect(parseCardShow("No card 'x'.")).toBeUndefined();
	});

	it("tells the lead fixed text naming the card", () => {
		expect(leadMessage("t7")).toBe("New coding card t7 from zimpoen's CTO. Read it with: hc-board show t7");
	});
});

describe("CTO tools", () => {
	const dbs: Array<{ db: AppDb; dir: string }> = [];
	afterEach(async () => {
		for (const { db, dir } of dbs.splice(0)) {
			db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	async function setup(options: { trust?: TrustLevel; requestIds?: string[]; lead?: FakeCodingLead } = {}) {
		const dir = await mkdtemp(join(tmpdir(), "cto-db-"));
		const db = openAppDb(join(dir, "app.sqlite"));
		dbs.push({ db, dir });
		migrate(db, [...coreMigrations, ...delegateModule.migrations, ...ctoModule.migrations]);
		const lead = options.lead ?? createFakeCodingLead();
		const deps = {
			db,
			now: () => 1000,
			harness: () => {
				throw new Error("not used");
			},
			runRequestIds: async () => options.requestIds ?? ["msg-1"],
			cto: { lead, repos: REPOS, trust: options.trust ?? "normal" },
		} as unknown as DomainDeps;
		const tools = ctoModule.extension(deps).tools ?? [];
		const call = (name: string, args: Record<string, unknown>, callId: string): Promise<ToolExecutionResult> => {
			const tool = tools.find((candidate) => candidate.name === name);
			if (tool === undefined) throw new Error(`${name} not registered`);
			return tool.execute(
				args as never,
				{ callId, conversationId: 9, now: () => 1000 } as unknown as ToolExecutionApi,
				BACKGROUND_CONTEXT,
			);
		};
		return { db, lead, call };
	}

	it("registers nothing when the CTO is off", () => {
		expect(ctoModule.extension({} as DomainDeps).tools ?? []).toEqual([]);
	});

	it("opens one card keyed by the call id and tells the lead once, even when replayed", async () => {
		const f = await setup();
		const first = await f.call("delegate_coding", ARGS, "call-1");
		expect(outputOf(first)).toMatch(/Card card-1 opened/);
		expect([...f.lead.cards.values()].map((card) => card.key)).toEqual(["call-1"]);
		expect(f.lead.notified).toEqual(["card-1"]);

		const replay = await f.call("delegate_coding", ARGS, "call-1");
		expect(outputOf(replay)).toBe(outputOf(first));
		expect(f.lead.cards.size).toBe(1);
		expect(f.lead.notified).toEqual(["card-1"]);
	});

	it("after a crash before the card id was saved, a replay gets the same card back from the board", async () => {
		const f = await setup();
		await f.lead.createCard({ key: "call-2", ...ARGS });
		ctoStore.insert(f.db, { callId: "call-2", conversationId: 9, ...ARGS, status: "creating", createdAt: 1 });
		await f.call("delegate_coding", ARGS, "call-2");
		expect(f.lead.cards.size).toBe(1);
		expect(ctoStore.getByCall(f.db, "call-2")).toMatchObject({ status: "notified", cardId: "card-1" });
	});

	it("says when telling the lead failed, and a replay tries again", async () => {
		const f = await setup();
		f.lead.failNext.add("notifyLead");
		const first = await f.call("delegate_coding", ARGS, "call-3");
		expect(outputOf(first)).toMatch(/telling the lead failed/);
		expect(ctoStore.getByCall(f.db, "call-3")?.status).toBe("created");
		await f.call("delegate_coding", ARGS, "call-3");
		expect(f.lead.notified).toEqual(["card-1"]);
		expect(f.lead.cards.size).toBe(1);
	});

	it("rejects bad arguments before touching the board", async () => {
		const f = await setup();
		await expect(f.call("delegate_coding", { ...ARGS, repo: "other" }, "bad")).rejects.toThrow(/not one the owner/);
		expect(f.lead.cards.size).toBe(0);
		expect(ctoStore.getByCall(f.db, "bad")).toBeUndefined();
	});

	it("refuses during a scheduled run unless trust is open (rule 13)", async () => {
		for (const requestIds of [["routine:r_1:2026-01-01T07:00:00.000Z"], ["briefing:2026-10-25"], []]) {
			const f = await setup({ requestIds });
			const result = await f.call("delegate_coding", ARGS, "s1");
			expect(outputOf(result)).toMatch(/rule 13/);
			expect(f.lead.cards.size).toBe(0);
			// The refusal is the call's answer for good: a replay does not open a card either.
			await f.call("delegate_coding", ARGS, "s1");
			expect(f.lead.cards.size).toBe(0);
		}
		const open = await setup({ trust: "open", requestIds: ["routine:r_1:2026-01-01T07:00:00.000Z"] });
		await open.call("delegate_coding", ARGS, "o1");
		expect(open.lead.cards.size).toBe(1);
	});

	it("treats a question the PA asked from a scheduled run as scheduled", async () => {
		const f = await setup({ requestIds: ["ask:pa-call"] });
		const insertAsk = (scheduled: number) =>
			f.db.run(
				`INSERT INTO delegate_ask (id, source_call_id, conversation_id, agent, question, request_id, status, scheduled, created_at)
				 VALUES ('q_1', 'pa-call', 1, 'cto', 'build it', 'ask:pa-call', 'waiting', ?, 1)`,
				scheduled,
			);
		// No row: cannot tell, so refused.
		expect(isScheduledRunIds(f.db, ["ask:pa-call"])).toBe(true);
		insertAsk(1);
		expect(outputOf(await f.call("delegate_coding", ARGS, "a1"))).toMatch(/rule 13/);
		f.db.run("UPDATE delegate_ask SET scheduled = 0");
		expect(outputOf(await f.call("delegate_coding", ARGS, "a2"))).toMatch(/opened/);
	});

	it("board_status reads cards it opened and refuses other ids", async () => {
		const f = await setup();
		expect(outputOf(await f.call("board_status", {}, "b0"))).toBe("No cards opened yet.");
		await f.call("delegate_coding", ARGS, "call-1");
		const card = f.lead.cards.get("card-1");
		if (card === undefined) throw new Error("no card");
		Object.assign(card, { status: "review", pr: "https://github.com/o/r/pull/3", note: "ready\nfor review" });

		const one = outputOf(await f.call("board_status", { card_id: "card-1" }, "b1"));
		expect(one).toContain("card-1 [review] repo zimpoen");
		expect(one).toContain("note: ready for review");
		expect(one).toContain("information only");
		expect(outputOf(await f.call("board_status", {}, "b2"))).toContain("card-1 [review]");
		await expect(f.call("board_status", { card_id: "card-9" }, "b3")).rejects.toThrow(/not opened by delegate_coding/);

		f.lead.failNext.add("readCard");
		expect(outputOf(await f.call("board_status", {}, "b4"))).toMatch(/could not be read/);
	});

	it("ask_agent reaches the CTO only while it is on", async () => {
		const f = await setup();
		f.db.run("INSERT INTO agents (id, conversation_id, created_at) VALUES ('cto', 42, 1)");
		const askTool = (cto: unknown) =>
			delegateModule
				.extension({ db: f.db, now: () => 1000, ...(cto === undefined ? {} : { cto }) } as unknown as DomainDeps)
				.tools?.find((tool) => tool.name === "ask_agent");
		const ask = askTool(undefined);
		await expect(
			ask?.execute(
				{ agent: "cto", question: "status?" } as never,
				{ callId: "q1", conversationId: 1, now: () => 1000 } as unknown as ToolExecutionApi,
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow(/no agent 'cto'/);
	});
});
