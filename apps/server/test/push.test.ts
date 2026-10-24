import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AppDb,
	coreMigrations,
	listPushSubscriptions,
	migrate,
	openAppDb,
	upsertPushSubscription,
} from "@assistant/db";
import type { PushPayload } from "@assistant/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import { createFakePushSender } from "../src/push/dev-sender.ts";
import { createNotifier } from "../src/push/notifier.ts";
import { createWebPushSender, PushGoneError, type PushSender, type PushTarget } from "../src/push/sender.ts";
import { loadOrCreateVapidKeys } from "../src/push/vapid.ts";
import { recordingLogger } from "./support.ts";

const dirs: string[] = [];
const dbs: AppDb[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const db of dbs.splice(0)) db.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "assistant-push-"));
	dirs.push(dir);
	return dir;
}

function database(): AppDb {
	const db = openAppDb(":memory:");
	migrate(db, coreMigrations);
	dbs.push(db);
	return db;
}

const subscribe = (db: AppDb, endpoint: string) =>
	upsertPushSubscription(db, { endpoint, p256dh: "p", auth: "a", createdAt: 1 });

const REMINDER: PushPayload = { title: "Reminder", body: "1 reminder", url: "/chat/pa", tag: "reminder" };

describe("notifier", () => {
	it("sends the payload to every subscribed device, and only the payload it was given", async () => {
		const db = database();
		subscribe(db, "https://a.example/1");
		subscribe(db, "https://b.example/2");
		const sent: Array<{ target: PushTarget; payload: PushPayload }> = [];
		const sender: PushSender = { send: async (target, payload) => void sent.push({ target, payload }) };

		const report = await createNotifier(db, sender, recordingLogger()).notify(REMINDER);

		expect(report).toStrictEqual({ sent: 2, removed: 0, failed: 0 });
		expect(sent.map(({ target }) => target.endpoint).sort()).toStrictEqual([
			"https://a.example/1",
			"https://b.example/2",
		]);
		expect(sent.every(({ payload }) => payload === REMINDER)).toBe(true);
		expect(JSON.stringify(REMINDER)).toBe('{"title":"Reminder","body":"1 reminder","url":"/chat/pa","tag":"reminder"}');
	});

	it("deletes a subscription the push service says is gone (404/410) and keeps the others", async () => {
		const db = database();
		subscribe(db, "https://gone.example/1");
		subscribe(db, "https://alive.example/2");
		const logger = recordingLogger();
		const sender: PushSender = {
			send: async (target) => {
				if (target.endpoint.includes("gone")) throw new PushGoneError(target.endpoint, 410);
			},
		};

		const report = await createNotifier(db, sender, logger).notify(REMINDER);

		expect(report).toStrictEqual({ sent: 1, removed: 1, failed: 0 });
		expect(listPushSubscriptions(db).map((row) => row.endpoint)).toStrictEqual(["https://alive.example/2"]);
		expect(logger.lines.join("\n")).toContain("removed a subscription that no longer exists (gone.example)");
	});

	it("keeps a subscription whose push failed for another reason, never throws, and does not log the payload", async () => {
		const db = database();
		subscribe(db, "https://flaky.example/1");
		const logger = recordingLogger();
		const sender: PushSender = {
			send: async () => {
				throw new Error("push service unavailable (503)");
			},
		};

		const report = await createNotifier(db, sender, logger).notify({ ...REMINDER, body: "secret body" });

		expect(report).toStrictEqual({ sent: 0, removed: 0, failed: 1 });
		expect(listPushSubscriptions(db)).toHaveLength(1);
		expect(logger.lines.join("\n")).toContain("could not reach flaky.example: push service unavailable (503)");
		expect(logger.lines.join("\n")).not.toContain("secret body");
	});

	it("does nothing, quietly, when nobody has subscribed", async () => {
		const report = await createNotifier(database(), { send: async () => Promise.reject(new Error("never")) }).notify(
			REMINDER,
		);

		expect(report).toStrictEqual({ sent: 0, removed: 0, failed: 0 });
	});
});

describe("web push sender", () => {
	const keys = webPush.generateVAPIDKeys();
	const target: PushTarget = { endpoint: "https://fcm.example/send/abc", p256dh: "p256", auth: "auth" };

	it("hands web-push the subscription, the JSON payload and our VAPID identity, with a time-to-live", async () => {
		const spy = vi.spyOn(webPush, "sendNotification").mockResolvedValue({ statusCode: 201, body: "", headers: {} });

		await createWebPushSender(keys, "mailto:me@example.com").send(target, REMINDER);

		expect(spy).toHaveBeenCalledWith(
			{ endpoint: target.endpoint, keys: { p256dh: "p256", auth: "auth" } },
			JSON.stringify(REMINDER),
			expect.objectContaining({
				vapidDetails: { subject: "mailto:me@example.com", publicKey: keys.publicKey, privateKey: keys.privateKey },
				TTL: expect.any(Number),
				urgency: "high",
			}),
		);
	});

	it.each([404, 410])("reports HTTP %i as a subscription that is gone", async (statusCode) => {
		vi.spyOn(webPush, "sendNotification").mockRejectedValue(Object.assign(new Error("gone"), { statusCode }));

		await expect(createWebPushSender(keys, "mailto:me@example.com").send(target, REMINDER)).rejects.toBeInstanceOf(
			PushGoneError,
		);
	});

	it("lets any other failure through as it is", async () => {
		vi.spyOn(webPush, "sendNotification").mockRejectedValue(
			Object.assign(new Error("server error"), { statusCode: 500 }),
		);

		await expect(createWebPushSender(keys, "mailto:me@example.com").send(target, REMINDER)).rejects.toThrow(
			"server error",
		);
	});
});

describe("fake sender", () => {
	it("sends nothing anywhere: it appends what it would have sent to a file and logs it", async () => {
		const dir = await tempDir();
		const outbox = join(dir, "outbox.jsonl");
		const logger = recordingLogger();

		await createFakePushSender(outbox, logger).send(
			{ endpoint: "https://phone.example/x", p256dh: "p", auth: "a" },
			REMINDER,
		);

		const [line] = (await readFile(outbox, "utf8")).trim().split("\n");
		expect(JSON.parse(line ?? "")).toMatchObject({ endpoint: "https://phone.example/x", payload: REMINDER });
		expect(logger.lines[0]).toContain("[push:fake] would send");
	});
});

describe("VAPID keys", () => {
	it("are created on first start with mode 0600, and read back unchanged afterwards", async () => {
		const dir = await tempDir();
		const path = join(dir, "secrets", "vapid.json");

		const first = await loadOrCreateVapidKeys(path, recordingLogger());
		const second = await loadOrCreateVapidKeys(path, recordingLogger());

		expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
		expect(second).toStrictEqual(first);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject(first);
	});

	it("are made private again when the file was copied in loosely", async () => {
		const dir = await tempDir();
		const path = join(dir, "vapid.json");
		const keys = await loadOrCreateVapidKeys(path, recordingLogger());
		await chmod(path, 0o644);
		const logger = recordingLogger();

		expect(await loadOrCreateVapidKeys(path, logger)).toStrictEqual(keys);

		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(logger.lines.join("\n")).toContain("readable by other users");
	});

	it("are never silently replaced: a damaged file is an error that says what is lost", async () => {
		const dir = await tempDir();
		const path = join(dir, "vapid.json");
		await writeFile(path, '{"publicKey": "only half"}');

		await expect(loadOrCreateVapidKeys(path, recordingLogger())).rejects.toThrow(
			/not a Web Push key file.*every device that enabled notifications must then enable them again/s,
		);
		expect(await readFile(path, "utf8")).toBe('{"publicKey": "only half"}');
	});
});
