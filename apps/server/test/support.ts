import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppDb, coreMigrations, migrate } from "@assistant/db";
import { approvalsModule, createApprovalService, createEntryPoster, filesModule } from "@assistant/extensions";
import type { StreamBatch, StreamEvent } from "@assistant/shared";
import { type Config, type Env, loadConfig } from "../src/config.ts";
import type { AppDeps } from "../src/http/app.ts";
import { createHostPolicy } from "../src/http/guard.ts";
import type { Runtime } from "../src/runtime.ts";
import type { ServerLogger } from "../src/server.ts";
import type { SseFrame } from "../src/stream.ts";

export type Fixture = {
	root: string;
	/** A real, validated config over a fresh temp data directory. Authentication off, faux model, port 0. */
	config: Config;
	cleanup(): Promise<void>;
};

const roots = new Set<string>();

export async function createFixture(overrides: Env = {}): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "assistant-test-"));
	roots.add(root);
	const docs = join(root, "docs");
	await mkdir(docs, { recursive: true });
	const config = await loadConfig({
		ASSISTANT_DATA_DIR: join(root, "data"),
		ASSISTANT_READ_PATHS: docs,
		ASSISTANT_AUTH: "off",
		ASSISTANT_MODEL_MODE: "faux",
		...overrides,
	});
	return {
		root,
		// Port 0: the operating system picks a free one, so parallel test files never collide.
		config: { ...config, http: { ...config.http, port: 0 } },
		cleanup: async () => {
			roots.delete(root);
			await rm(root, { recursive: true, force: true });
		},
	};
}

export async function removeAllFixtures(): Promise<void> {
	for (const root of roots) await rm(root, { recursive: true, force: true });
	roots.clear();
}

export function recordingLogger(): ServerLogger & { lines: string[] } {
	const lines: string[] = [];
	const record =
		(level: string) =>
		(...args: unknown[]) =>
			void lines.push(`${level} ${args.map(String).join(" ")}`);
	return { lines, info: record("info"), warn: record("warn"), error: record("error") };
}

export async function waitFor<T>(
	check: () => T | Promise<T>,
	options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<NonNullable<T>> {
	const { timeoutMs = 10_000, intervalMs = 15, what = "condition" } = options;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value as NonNullable<T>;
		if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** Every stream event carried by the data frames among `frames`, in order. */
export function eventsOf(frames: readonly SseFrame[]): StreamEvent[] {
	return frames.flatMap((frame) => ("data" in frame ? (JSON.parse(frame.data) as StreamBatch) : []));
}

export const isDone = (event: StreamEvent): boolean => event.type === "submission" && event.record.status === "done";

/** Text of the assistant's visible answer in a `message_end` event, if that is what the event is. */
export function answerText(event: StreamEvent): string | undefined {
	if (event.type !== "message_end") return undefined;
	const message = event.entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** Read an SSE response into its batches (one per data frame) until `stop` says enough or the body ends. */
export async function readSseBatches(
	response: Response,
	stop: (batches: StreamBatch[]) => boolean,
	timeoutMs = 10_000,
): Promise<StreamBatch[]> {
	if (response.body === null) throw new Error("SSE response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const batches: StreamBatch[] = [];
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			// A server that goes away mid-stream ends the stream; tests assert on what arrived before that.
			const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
				const block = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const data = block
					.split("\n")
					.filter((line) => line.startsWith("data: "))
					.map((line) => line.slice(6))
					.join("\n");
				if (data !== "") batches.push(JSON.parse(data) as StreamBatch);
			}
			if (stop(batches)) return batches;
		}
		return batches;
	} finally {
		await reader.cancel().catch(() => {});
	}
}

/** Like {@link readSseBatches}, with every event of every batch in one list. */
export async function readSse(
	response: Response,
	stop: (events: StreamEvent[]) => boolean,
	timeoutMs = 10_000,
): Promise<StreamEvent[]> {
	const batches = await readSseBatches(response, (seen) => stop(seen.flat()), timeoutMs);
	return batches.flat();
}

/** Everything `createApp` needs, from a runtime and its app database. Authentication off, listening on port 3001. */
export function appDepsFor(runtime: Runtime, db: AppDb, overrides: Partial<AppDeps> = {}): AppDeps {
	// The approval service looks at its table for every message the owner sends, so a test database needs it.
	migrate(db, [...coreMigrations, ...approvalsModule.migrations, ...filesModule.migrations]);
	return {
		harness: runtime.harness,
		db,
		models: runtime.models,
		unanswered: runtime.unanswered,
		approvals: createApprovalService({
			db,
			now: Date.now,
			post: createEntryPoster(() => runtime.harness),
		}),
		push: { publicKey: "test-vapid-public-key" },
		// The daily jobs and the uploads folder belong to tests of their own, which pass real ones.
		daily: {
			ensureRows: () => [],
			list: () => [],
			update: async (job) => {
				throw new Error(`No daily job '${job}' in this test.`);
			},
		},
		timezone: "Asia/Thimphu",
		filesDir: join(tmpdir(), "assistant-test-no-uploads"),
		auth: { mode: "off" },
		hosts: createHostPolicy(3001, []),
		...overrides,
	};
}
