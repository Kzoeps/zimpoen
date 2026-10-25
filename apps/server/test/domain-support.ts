import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MessagesPage, PushPayload, SendMessageResponse } from "@assistant/shared";
import { toolCardOf } from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord, SubmissionId } from "@earendil-works/pi-durable";
import { expect } from "vitest";
import type { Config } from "../src/config.ts";
import { PushGoneError, type PushSender, type PushTarget } from "../src/push/sender.ts";
import { type RunningServer, type StartServerOptions, startServer } from "../src/server.ts";
import { createFixture, type Fixture, recordingLogger } from "./support.ts";

/**
 * The scaffolding the whole-server tests of a domain module share: a server on a temp data directory with a fake clock
 * and a push service that records what it was asked to send, and the helpers that talk to the PA through the API.
 */

export const ctx = BACKGROUND_CONTEXT;
export const MINUTE = 60_000;
/** 14:00 on Sunday 25 October 2026 in Thimphu. */
export const START = Date.UTC(2026, 9, 25, 8, 0, 0);

export class RecordingSender implements PushSender {
	readonly sent: Array<{ endpoint: string; payload: PushPayload }> = [];
	readonly gone = new Set<string>();

	async send(target: PushTarget, payload: PushPayload): Promise<void> {
		if (this.gone.has(target.endpoint)) throw new PushGoneError(target.endpoint, 410);
		this.sent.push({ endpoint: target.endpoint, payload });
	}
}

export type Harness = {
	fixture: Fixture;
	clock: { now: number };
	sender: RecordingSender;
	/** Every line the servers of this test logged, in order. */
	logs: string[];
	servers: RunningServer[];
	/** `more` overrides other options of the server, for a test of one of them (the code mode time limit). */
	start(intervals?: StartServerOptions["intervals"], more?: Partial<StartServerOptions>): Promise<RunningServer>;
};

export async function setup(env: Record<string, string> = {}): Promise<Harness> {
	const fixture = await createFixture(env);
	const clock = { now: START };
	const sender = new RecordingSender();
	const logger = recordingLogger();
	const servers: RunningServer[] = [];
	return {
		fixture,
		clock,
		sender,
		logs: logger.lines,
		servers,
		start: async (intervals, more) => {
			const server = await startServer(fixture.config, {
				logger,
				devModel: { tokensPerSecond: 1_000_000 },
				now: () => clock.now,
				pushSender: sender,
				...(intervals === undefined ? {} : { intervals }),
				...more,
			});
			servers.push(server);
			return server;
		},
	};
}

export const base = (server: RunningServer) => `http://127.0.0.1:${server.port}`;

export async function post<T>(
	server: RunningServer,
	path: string,
	body: unknown,
): Promise<{ status: number; body: T }> {
	const response = await fetch(`${base(server)}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as T };
}

export const paConversation = (server: RunningServer): number =>
	server.db.get<{ conversation_id: number }>("SELECT conversation_id FROM agents WHERE id = 'pa'")?.conversation_id ??
	-1;

let requestCounter = 0;
/** Say something to the PA and wait until the run it started has finished. */
export async function say(server: RunningServer, text: string): Promise<SendMessageResponse> {
	const { status, body } = await post<SendMessageResponse>(
		server,
		`/api/conversations/${paConversation(server)}/messages`,
		{ content: text, requestId: `m3-${++requestCounter}` },
	);
	expect(status).toBe(202);
	const submission = await server.harness.submission(body.submissionId as SubmissionId, ctx);
	await submission?.wait(ctx);
	return body;
}

export async function entries(server: RunningServer): Promise<EntryRecord[]> {
	const response = await fetch(`${base(server)}/api/conversations/${paConversation(server)}/messages?limit=200`);
	return ((await response.json()) as MessagesPage).entries as EntryRecord[];
}

export const ofKind = async (server: RunningServer, kind: string) =>
	(await entries(server)).filter((entry) => entry.kind === kind);

/** Cards that tool results carried, oldest first. */
export async function cards(server: RunningServer) {
	return (await entries(server)).flatMap((entry) => {
		const message = entry.model?.[0];
		return message?.role === "toolResult" ? [toolCardOf(message.details)].filter((card) => card !== undefined) : [];
	});
}

export function subscription(host = "push.example") {
	return {
		endpoint: `https://${host}/send/${Math.random().toString(16).slice(2)}`,
		keys: { p256dh: Buffer.alloc(65, 7).toString("base64url"), auth: Buffer.alloc(16, 9).toString("base64url") },
	};
}

/** How many times the model answered: cards that timers post must not change it. */
export async function modelAnswers(server: RunningServer): Promise<number> {
	return (await entries(server)).filter((entry) => entry.kind === "pi.assistant").length;
}

/**
 * What a power cut does to Durable's database (synchronous=NORMAL) but not to app.sqlite (FULL): `durable.sqlite` comes
 * back from an older sync point. Copy it while the server is closed ({@link snapshotDurable}), put it back after a later
 * run ({@link restoreDurable}), and leave app.sqlite as it is.
 */
export async function snapshotDurable(config: Config, to: string): Promise<void> {
	const dir = dirname(config.paths.durableDb);
	await mkdir(to, { recursive: true });
	for (const name of (await readdir(dir)).filter((entry) => entry.startsWith("durable.sqlite"))) {
		await cp(join(dir, name), join(to, name));
	}
}

export async function restoreDurable(config: Config, from: string): Promise<void> {
	const dir = dirname(config.paths.durableDb);
	for (const name of (await readdir(dir)).filter((entry) => entry.startsWith("durable.sqlite"))) {
		await rm(join(dir, name), { force: true });
	}
	for (const name of await readdir(from)) await cp(join(from, name), join(dir, name));
}
