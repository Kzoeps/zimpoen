import { Type } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { CodemodeSourceError } from "@earendil-works/pi-codemode/source";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	boundCodemodeSource,
	createBoundedCodemodeExtension,
	DEFAULT_CODEMODE_LIMITS,
	ledgerStore,
} from "../src/index.ts";
import { type Fixture, openFixture, say, toolCall, waitFor } from "./support.ts";

const LIMITS = { defaultTimeoutMs: 700, maxTimeoutMs: 1500 };

describe("the time limit written into a script", () => {
	it("gives a script that asks for nothing the default, and keeps the script after it as it was", () => {
		const bounded = boundCodemodeSource("text('hi');\nreturn 1;");
		expect(bounded).toBe("// @options: {\"timeout_ms\":30000}\ntext('hi');\nreturn 1;");
		expect(DEFAULT_CODEMODE_LIMITS).toStrictEqual({ defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000 });
	});

	it("keeps the other option of an options line, and adds the limit to it", () => {
		expect(boundCodemodeSource('// @options: {"max_output_tokens": 500}\ntext(1);')).toBe(
			'// @options: {"max_output_tokens":500,"timeout_ms":30000}\ntext(1);',
		);
	});

	it("cuts a request for a day (or for an hour, or for a minute and a bit too many) to the most allowed", () => {
		const day = boundCodemodeSource('// @options: {"timeout_ms": 86400000}\nwhile (true) {}');
		expect(day).toBe('// @options: {"timeout_ms":120000}\nwhile (true) {}');
		expect(boundCodemodeSource('// @options: {"timeout_ms": 2000}\nx();', LIMITS)).toBe(
			'// @options: {"timeout_ms":1500}\nx();',
		);
	});

	it("leaves a request within the limit exactly as the model wrote it", () => {
		const source = '// @options: {"max_output_tokens": 100, "timeout_ms": 45000}\ntext(1);';
		expect(boundCodemodeSource(source)).toBe(source);
	});

	it("reads an options line that ends with a Windows line break, and keeps the rest of the script", () => {
		expect(boundCodemodeSource('// @options: {"timeout_ms": 999999999}\r\ntext(1);\r\n')).toBe(
			'// @options: {"timeout_ms":120000}\ntext(1);\r\n',
		);
	});

	it("says what Durable would about a malformed options line, instead of running without a limit", () => {
		expect(() => boundCodemodeSource('// @options: {"timeout_ms": "soon"}\ntext(1);')).toThrow(CodemodeSourceError);
		expect(() => boundCodemodeSource("text(1);\n// @options: {}\n")).toThrow(/first line/);
	});

	it("refuses limits that make no sense when the extension is made", () => {
		const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
		const make = (limits: { defaultTimeoutMs?: number; maxTimeoutMs?: number }) => () =>
			createBoundedCodemodeExtension({ sandbox, models: false, limits });
		expect(make({ defaultTimeoutMs: 5000, maxTimeoutMs: 1000 })).toThrow(/default code mode time limit/);
		expect(make({ maxTimeoutMs: 0 })).toThrow(/whole number of milliseconds/);
		expect(make({ defaultTimeoutMs: 1.5 })).toThrow(/whole number of milliseconds/);
		void sandbox.close();
	});
});

const fixtures: Fixture[] = [];
const sandboxes: CodemodeSandbox[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.close().catch(() => {});
		await fixture.dispose();
	}
	for (const sandbox of sandboxes.splice(0)) await sandbox.close();
});

function boundedCodeMode(extra: Extension[] = []): Extension[] {
	// The sandbox's own timeout is generous on purpose: only the limit written into the script may end these scripts.
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024, timeoutMs: 60_000 });
	sandboxes.push(sandbox);
	return [createBoundedCodemodeExtension({ sandbox, models: false, limits: LIMITS }), ...extra];
}

async function open(extraExtensions: Extension[], options: Parameters<typeof openFixture>[0] = {}): Promise<Fixture> {
	const fixture = await openFixture({ accountant: { currency: "BTN" }, ...options, extraExtensions });
	fixtures.push(fixture);
	return fixture;
}

const lastResult = async (f: Fixture) =>
	(await f.entries())
		.flatMap((entry) => entry.model ?? [])
		.filter((message) => message.role === "toolResult")
		.at(-1);

const outputOf = async (f: Fixture): Promise<string> => JSON.stringify((await lastResult(f))?.content);

describe("a script through a real Harness", () => {
	it("is ended when it runs without end, with no limit of its own", async () => {
		const f = await open(boundedCodeMode());
		f.faux.setResponses([toolCall("codemode", { code: "while (true) {}" }, "loop-default"), say("It timed out.")]);

		const started = Date.now();
		await f.say("run it");

		expect((await lastResult(f))?.isError).toBe(true);
		expect(await outputOf(f)).toContain("Execution timed out after 700 ms");
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("cuts a request for a day to the most allowed, and does not touch a script that finishes", async () => {
		const f = await open(boundedCodeMode());
		f.faux.setResponses([
			toolCall("codemode", { code: '// @options: {"timeout_ms": 86400000}\nwhile (true) {}' }, "loop-day"),
			say("It timed out."),
			toolCall("codemode", { code: 'text("fast")' }, "fast"),
			say("Done."),
		]);

		await f.say("run the long one");
		expect(await outputOf(f)).toContain("Execution timed out after 1500 ms");

		await f.say("run the quick one");
		expect((await lastResult(f))?.isError).toBe(false);
		expect(await outputOf(f)).toContain("fast");
	});

	it("ends a script that a restart interrupted when its deadline has passed, and does not start it again", async () => {
		let phase: "first" | "second" = "first";
		let stalls = 0;
		let reached!: () => void;
		const stalled = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const stall = defineTool({
			name: "stall",
			description: "Waits until the process ends.",
			parameters: Type.Object({}),
			callers: ["tools"],
			replay: "safe",
			async execute(_args, _api, context) {
				stalls++;
				if (phase === "first") {
					reached();
					await new Promise<never>((_resolve, reject) =>
						context.abortSignal?.addEventListener("abort", () => reject(new Error("The process ended")), {
							once: true,
						}),
					);
				}
				return { output: [{ type: "text", text: "released" }] };
			},
		});
		const stallExtension = defineExtension({ name: "stall", tools: [stall] });
		const code = `await tools.stall({});\ntext("after the stall");`;

		const f1 = await open(boundedCodeMode([stallExtension]));
		f1.faux.setResponses([toolCall("codemode", { code }, "script-R"), say("finished")]);
		const running = f1.say("go");
		running.catch(() => {});
		await stalled;
		expect(stalls).toBe(1);
		await f1.close(); // the restart: the process ends, the script is left half done
		phase = "second";

		f1.clock.now += 5_000; // longer than the 700 ms the script was given
		const f2 = await openFixture({
			accountant: { currency: "BTN" },
			extraExtensions: boundedCodeMode([stallExtension]),
			dir: f1.dir,
			clock: f1.clock,
		});
		fixtures.push(f2);
		f2.faux.setResponses([say("finished")]);

		await waitFor(async () => (await lastResult(f2))?.toolName === "codemode", "the script's outcome");
		expect((await lastResult(f2))?.isError).toBe(true);
		expect(await outputOf(f2)).toContain("its deadline passed while it was interrupted");
		// The script did not start again (the VM would have printed this); the stalled nested call may resume by itself, which is Durable's.
		expect(await outputOf(f2)).not.toContain("after the stall");
	});

	it("writes a script's ledger entries once even though the limit changed the source it was given", async () => {
		const f = await open(boundedCodeMode());
		await f.callTool("add_account", { name: "Cash", kind: "cash" }, "acc");
		const code = 'await tools.add_expense({ amount: 25, merchant: "Tea", category: "food" }); text("ok");';
		f.faux.setResponses([toolCall("codemode", { code }, "script-w"), say("Added.")]);

		await f.say("add a tea");

		expect(ledgerStore.queryTxns(f.db, { merchant: "tea" }).total).toBe(1);
		expect(await outputOf(f)).toContain("ok");
	});
});
