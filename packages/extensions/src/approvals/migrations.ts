import type { Migration } from "@assistant/db";

export const approvalsMigrations: readonly Migration[] = [
	{
		id: "approvals/001_pending_actions",
		up: (db) => {
			db.exec(`
				CREATE TABLE pending_actions (
					id TEXT PRIMARY KEY,
					conversation_id INTEGER NOT NULL,
					-- The destructive tool the request is for, and a canonical name for what it would touch ('task:t_ab12').
					-- The beforeTool hook lets a call through only when both match an approved row.
					tool TEXT NOT NULL,
					target TEXT NOT NULL,
					args_json TEXT NOT NULL,
					summary TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'executed', 'failed')),
					result_text TEXT,
					source_call_id TEXT UNIQUE,
					created_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL,
					decided_at INTEGER,
					decided_via TEXT CHECK (decided_via IN ('button', 'yes')),
					-- The client's requestId of a "YES" message, so a retried POST finds its decision instead of re-asking the model.
					decided_request_id TEXT,
					executed_at INTEGER,
					-- The outcome notice (a zero-token write into the thread) has been posted.
					notified_at INTEGER,
					notice_submission_id INTEGER
				) STRICT;
				CREATE INDEX pending_actions_conversation ON pending_actions (conversation_id, status, created_at);
			`);
		},
	},
	{
		// A reply of YES approves only while it is plainly the answer: see `ApprovalService.tryYes`.
		id: "approvals/002_yes_window",
		up: (db) => {
			db.exec("ALTER TABLE pending_actions ADD COLUMN yes_ok INTEGER NOT NULL DEFAULT 1 CHECK (yes_ok IN (0, 1))");
		},
	},
];
