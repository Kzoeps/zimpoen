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
