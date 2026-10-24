import { afterEach, describe, expect, it } from "vitest";
import {
	type AppDb,
	coreMigrations,
	deletePushSubscription,
	getAgentRow,
	getAgentRowByConversation,
	insertAgentRow,
	listAgentRows,
	listPushSubscriptions,
	migrate,
	openAppDb,
	upsertPushSubscription,
} from "../src/index.ts";

const dbs: AppDb[] = [];
function migrated(): AppDb {
	const db = openAppDb(":memory:");
	dbs.push(db);
	migrate(db, coreMigrations);
	return db;
}
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});

describe("agents table", () => {
	it("keeps the first row for an agent id, so repeating an insert changes nothing", () => {
		const db = migrated();

		expect(insertAgentRow(db, { id: "pa", conversationId: 7, createdAt: 100 })).toBe(true);
		expect(insertAgentRow(db, { id: "pa", conversationId: 8, createdAt: 200 })).toBe(false);

		expect(getAgentRow(db, "pa")).toStrictEqual({
			id: "pa",
			conversationId: 7,
			createdAt: 100,
		});
		expect(getAgentRow(db, "health")).toBeUndefined();
	});

	it("finds the agent that owns a conversation, and only that one", () => {
		const db = migrated();
		insertAgentRow(db, { id: "pa", conversationId: 7, createdAt: 100 });

		expect(getAgentRowByConversation(db, 7)?.id).toBe("pa");
		expect(getAgentRowByConversation(db, 8)).toBeUndefined();
	});

	it("never lets two agents share a conversation", () => {
		const db = migrated();
		insertAgentRow(db, { id: "pa", conversationId: 7, createdAt: 100 });

		expect(() => insertAgentRow(db, { id: "inbox", conversationId: 7, createdAt: 101 })).toThrow(/UNIQUE/);
	});

	it("lists rows in creation order", () => {
		const db = migrated();
		insertAgentRow(db, { id: "inbox", conversationId: 2, createdAt: 200 });
		insertAgentRow(db, { id: "pa", conversationId: 1, createdAt: 100 });

		expect(listAgentRows(db).map((row) => row.id)).toStrictEqual(["pa", "inbox"]);
	});
});

describe("push subscriptions", () => {
	const row = { endpoint: "https://push.example/abc", p256dh: "key-1", auth: "auth-1", createdAt: 10 };

	it("stores one row per endpoint and refreshes its keys when the browser registers again", () => {
		const db = migrated();

		upsertPushSubscription(db, { ...row, userAgent: "Chrome" });
		upsertPushSubscription(db, { ...row, p256dh: "key-2", auth: "auth-2", createdAt: 99 });

		expect(listPushSubscriptions(db)).toStrictEqual([{ ...row, p256dh: "key-2", auth: "auth-2" }]);
	});

	it("removes a subscription by endpoint and says whether there was one", () => {
		const db = migrated();
		upsertPushSubscription(db, row);

		expect(deletePushSubscription(db, "https://push.example/other")).toBe(false);
		expect(deletePushSubscription(db, row.endpoint)).toBe(true);
		expect(listPushSubscriptions(db)).toStrictEqual([]);
	});
});
