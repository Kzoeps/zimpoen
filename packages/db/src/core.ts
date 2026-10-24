import type { AppDb } from "./app-db.ts";
import type { Migration } from "./migrate.ts";

/** Tables every deployment has, whatever domains are installed. Domain modules bring their own migrations. */
export const coreMigrations: readonly Migration[] = [
	{
		id: "core/001_agents",
		// conversation_id is a Durable ConversationId, which is a plain integer (PLAN §7 sketched TEXT).
		up: (db) =>
			db.exec(`
				CREATE TABLE agents (
					id TEXT PRIMARY KEY,
					conversation_id INTEGER NOT NULL UNIQUE,
					created_at INTEGER NOT NULL
				) STRICT
			`),
	},
	{
		// One row per browser/device that asked for notifications. PLAN §7 sketched `keys_json`; two columns let the
		// database refuse a row the sender could never use.
		id: "core/002_push_subscriptions",
		up: (db) =>
			db.exec(`
				CREATE TABLE push_subscriptions (
					endpoint TEXT PRIMARY KEY,
					p256dh TEXT NOT NULL,
					auth TEXT NOT NULL,
					user_agent TEXT,
					created_at INTEGER NOT NULL
				) STRICT
			`),
	},
];

export type AgentRow = {
	id: string;
	conversationId: number;
	createdAt: number;
};

type AgentRecord = { id: string; conversation_id: number; created_at: number };

const fromRecord = (record: AgentRecord): AgentRow => ({
	id: record.id,
	conversationId: record.conversation_id,
	createdAt: record.created_at,
});

export function listAgentRows(db: AppDb): AgentRow[] {
	return db
		.all<AgentRecord>("SELECT id, conversation_id, created_at FROM agents ORDER BY created_at, id")
		.map(fromRecord);
}

export function getAgentRow(db: AppDb, id: string): AgentRow | undefined {
	const record = db.get<AgentRecord>("SELECT id, conversation_id, created_at FROM agents WHERE id = ?", id);
	return record === undefined ? undefined : fromRecord(record);
}

export function getAgentRowByConversation(db: AppDb, conversationId: number): AgentRow | undefined {
	const record = db.get<AgentRecord>(
		"SELECT id, conversation_id, created_at FROM agents WHERE conversation_id = ?",
		conversationId,
	);
	return record === undefined ? undefined : fromRecord(record);
}

/**
 * Record which conversation belongs to an agent. Keeps the first row if one exists, so a repeated call is a no-op;
 * returns whether this call inserted it.
 */
export function insertAgentRow(db: AppDb, row: AgentRow): boolean {
	const result = db.run(
		"INSERT INTO agents (id, conversation_id, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
		row.id,
		row.conversationId,
		row.createdAt,
	);
	return result.changes > 0;
}

/** A browser's Web Push subscription: where to send and the keys that encrypt the payload for that browser. */
export type PushSubscriptionRow = {
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent?: string;
	createdAt: number;
};

type PushRecord = { endpoint: string; p256dh: string; auth: string; user_agent: string | null; created_at: number };

/** Insert, or refresh the keys of a subscription the browser re-registered: the endpoint identifies the device. */
export function upsertPushSubscription(db: AppDb, row: PushSubscriptionRow): void {
	db.run(
		`INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
		row.endpoint,
		row.p256dh,
		row.auth,
		row.userAgent ?? null,
		row.createdAt,
	);
}

/** Returns whether a subscription was removed. */
export function deletePushSubscription(db: AppDb, endpoint: string): boolean {
	return db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint).changes > 0;
}

export function listPushSubscriptions(db: AppDb): PushSubscriptionRow[] {
	return db
		.all<PushRecord>(
			"SELECT endpoint, p256dh, auth, user_agent, created_at FROM push_subscriptions ORDER BY created_at, endpoint",
		)
		.map((record) => ({
			endpoint: record.endpoint,
			p256dh: record.p256dh,
			auth: record.auth,
			createdAt: record.created_at,
			...(record.user_agent === null ? {} : { userAgent: record.user_agent }),
		}));
}
