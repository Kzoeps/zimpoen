import type { Migration } from "@assistant/db";

/**
 * Tables of the inbox module (PLAN §7). Never edit one that has shipped: add `inbox/00N_...` after it.
 *
 * Mail and events are a local copy of what Google has (read-only); the only things the owner changes here are the triage
 * of a mail (`mark_triage`, which also teaches `inbox_rule`) and what happens to a suggestion.
 */
export const inboxMigrations: readonly Migration[] = [
	{
		id: "inbox/001_accounts_mail",
		up: (db) => {
			db.exec(`
				-- One row per Google account. The row is the truth about the sync (PLAN §5.4): when the next one is due, which timer
				-- serves that run (gen), how many failed in a row. The sign-in itself is in <data>/secrets/google-accounts.json.
				CREATE TABLE inbox_account (
					email TEXT PRIMARY KEY,
					status TEXT NOT NULL CHECK (status IN ('connected', 'needs_reconnect', 'disconnected')),
					-- Gmail's history id: where the next incremental sync starts. NULL until the first sync has read the mailbox.
					history_id TEXT,
					-- The token's connectedAt this row last saw: a later one means the owner connected the account again.
					connected_at INTEGER NOT NULL,
					next_sync_at INTEGER NOT NULL,
					-- The last attempt that ended (well or not) and the last that ended well.
					last_sync_at INTEGER,
					last_ok_at INTEGER,
					last_error TEXT,
					failures INTEGER NOT NULL DEFAULT 0,
					needs_reconnect_at INTEGER,
					calendar_synced_at INTEGER,
					gen INTEGER NOT NULL DEFAULT 0,
					durable_task_id INTEGER,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				) STRICT;

				CREATE TABLE inbox_message (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					account TEXT NOT NULL REFERENCES inbox_account (email),
					gmail_id TEXT NOT NULL,
					thread_id TEXT NOT NULL,
					from_name TEXT NOT NULL DEFAULT '',
					from_addr TEXT NOT NULL DEFAULT '',
					to_addrs TEXT NOT NULL DEFAULT '',
					subject TEXT NOT NULL DEFAULT '',
					-- When it arrived (Gmail's internalDate), epoch ms.
					date INTEGER NOT NULL,
					-- JSON array of Gmail label ids.
					labels TEXT NOT NULL DEFAULT '[]',
					bulk INTEGER NOT NULL DEFAULT 0,
					snippet TEXT NOT NULL DEFAULT '',
					-- The readable text, cut to a few thousand characters. Untrusted.
					body_text_trunc TEXT NOT NULL DEFAULT '',
					-- 1: in the trash or spam, or deleted in Gmail. Kept as a row (so that a restored mail comes back), left out of everything the owner sees.
					hidden INTEGER NOT NULL DEFAULT 0,
					deleted_at INTEGER,
					-- The whole triage as JSON, and the parts a digest selects by.
					triage_json TEXT,
					category TEXT,
					urgency INTEGER,
					needs_human INTEGER,
					triage_source TEXT CHECK (triage_source IN ('jev', 'rules', 'owner')),
					-- Rules were used because Jev could not be reached: Jev looks at it again at a later sync.
					provisional INTEGER NOT NULL DEFAULT 0,
					triaged_at INTEGER,
					created_at INTEGER NOT NULL,
					UNIQUE (account, gmail_id)
				) STRICT;
				CREATE INDEX inbox_message_date ON inbox_message (date DESC);
				CREATE INDEX inbox_message_triaged ON inbox_message (triaged_at);
				CREATE INDEX inbox_message_untriaged ON inbox_message (id) WHERE triaged_at IS NULL;
				CREATE INDEX inbox_message_thread ON inbox_message (account, thread_id);

				-- Full-text search over what the Inbox agent may look through (search_mail).
				CREATE VIRTUAL TABLE inbox_message_fts USING fts5(
					subject, sender, snippet, body,
					content = 'inbox_message', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
				);
				CREATE TRIGGER inbox_message_fts_insert AFTER INSERT ON inbox_message BEGIN
					INSERT INTO inbox_message_fts (rowid, subject, sender, snippet, body)
					VALUES (new.id, new.subject, new.from_name || ' ' || new.from_addr, new.snippet, new.body_text_trunc);
				END;
				CREATE TRIGGER inbox_message_fts_delete AFTER DELETE ON inbox_message BEGIN
					INSERT INTO inbox_message_fts (inbox_message_fts, rowid, subject, sender, snippet, body)
					VALUES ('delete', old.id, old.subject, old.from_name || ' ' || old.from_addr, old.snippet, old.body_text_trunc);
				END;
				CREATE TRIGGER inbox_message_fts_update AFTER UPDATE OF subject, from_name, from_addr, snippet, body_text_trunc ON inbox_message BEGIN
					INSERT INTO inbox_message_fts (inbox_message_fts, rowid, subject, sender, snippet, body)
					VALUES ('delete', old.id, old.subject, old.from_name || ' ' || old.from_addr, old.snippet, old.body_text_trunc);
					INSERT INTO inbox_message_fts (rowid, subject, sender, snippet, body)
					VALUES (new.id, new.subject, new.from_name || ' ' || new.from_addr, new.snippet, new.body_text_trunc);
				END;

				CREATE TABLE inbox_event (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					account TEXT NOT NULL REFERENCES inbox_account (email),
					event_id TEXT NOT NULL,
					title TEXT NOT NULL DEFAULT '',
					start_at INTEGER NOT NULL,
					end_at INTEGER NOT NULL,
					all_day INTEGER NOT NULL DEFAULT 0,
					-- JSON array of the other people's addresses.
					attendees TEXT NOT NULL DEFAULT '[]',
					location TEXT NOT NULL DEFAULT '',
					updated INTEGER NOT NULL,
					UNIQUE (account, event_id)
				) STRICT;
				CREATE INDEX inbox_event_start ON inbox_event (start_at);
			`);
		},
	},
	{
		id: "inbox/002_rules_suggestions",
		up: (db) => {
			db.exec(`
				-- What the owner taught by marking a mail: every later mail from that sender (or domain) is triaged the same way.
				CREATE TABLE inbox_rule (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					kind TEXT NOT NULL CHECK (kind IN ('sender', 'domain')),
					value TEXT NOT NULL,
					category TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					UNIQUE (kind, value)
				) STRICT;

				-- The queue from the Inbox agent to the PA (PLAN rule 6: the only way across). A row is written by the suggest_followup
				-- tool, the server posts its card into the PA's thread, and the owner's answer ends it.
				CREATE TABLE inbox_suggestion (
					id TEXT PRIMARY KEY,
					kind TEXT NOT NULL CHECK (kind IN ('meeting', 'commitment')),
					title TEXT NOT NULL,
					counterpart TEXT NOT NULL DEFAULT '',
					context TEXT NOT NULL DEFAULT '',
					at INTEGER NOT NULL,
					ends_at INTEGER,
					source_type TEXT NOT NULL CHECK (source_type IN ('mail', 'event')),
					source_id INTEGER NOT NULL,
					source_label TEXT NOT NULL DEFAULT '',
					source_url TEXT,
					status TEXT NOT NULL CHECK (status IN ('pending', 'added', 'dismissed')),
					-- Rule 8: one suggest_followup call is one row.
					source_call_id TEXT UNIQUE,
					-- The card is in the PA's thread. NULL: not yet (a crash between the row and the post); the server posts it again.
					posted_at INTEGER,
					decided_at INTEGER,
					created_at INTEGER NOT NULL
				) STRICT;
				CREATE INDEX inbox_suggestion_unposted ON inbox_suggestion (created_at) WHERE posted_at IS NULL;

				-- Rule 8 for the tools that change a row that exists (mark_triage).
				CREATE TABLE inbox_call (
					source_call_id TEXT PRIMARY KEY,
					tool TEXT NOT NULL,
					subject TEXT,
					applied_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
	{
		id: "inbox/003_digest_state",
		up: (db) => {
			db.exec(`
				-- The window each digest looked at: (since_at, cutoff_at]. It is written when the digest first gathers its facts, so a
				-- rerun after a crash, or the repair after a power cut, shows the same mails, and the next digest begins where this one ended.
				CREATE TABLE inbox_digest (
					job TEXT NOT NULL,
					date TEXT NOT NULL,
					since_at INTEGER NOT NULL,
					cutoff_at INTEGER NOT NULL,
					PRIMARY KEY (job, date)
				) STRICT;

				-- Small facts the settings page shows: why the triage fell back to the rules the last time.
				CREATE TABLE inbox_state (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
	{
		id: "inbox/004_read_failures",
		up: (db) => {
			db.exec(`
				-- A message Gmail would not hand over, and how many syncs failed on it. One that fails every time must not stop the mail
				-- behind it: the sync goes on, asks for it again at each run until max_read_attempts tries have failed, and then leaves it
				-- out (skipped_at) and says so in Settings. Rows are forgotten when the message is read, or after the first sync's window.
				CREATE TABLE inbox_read_failure (
					account TEXT NOT NULL REFERENCES inbox_account (email),
					gmail_id TEXT NOT NULL,
					attempts INTEGER NOT NULL,
					last_error TEXT NOT NULL,
					last_failed_at INTEGER NOT NULL,
					-- NULL while it is still tried; the moment it was given up.
					skipped_at INTEGER,
					PRIMARY KEY (account, gmail_id)
				) STRICT;
			`);
		},
	},
	{
		// A suggestion that waited a week for an answer is `expired`. SQLite cannot change a CHECK, so the table is rebuilt with the
		// same columns; nothing references inbox_suggestion by a foreign key.
		id: "inbox/005_suggestion_expiry",
		up: (db) => {
			db.exec(`
				CREATE TABLE inbox_suggestion_new (
					id TEXT PRIMARY KEY,
					kind TEXT NOT NULL CHECK (kind IN ('meeting', 'commitment')),
					title TEXT NOT NULL,
					counterpart TEXT NOT NULL DEFAULT '',
					context TEXT NOT NULL DEFAULT '',
					at INTEGER NOT NULL,
					ends_at INTEGER,
					source_type TEXT NOT NULL CHECK (source_type IN ('mail', 'event')),
					source_id INTEGER NOT NULL,
					source_label TEXT NOT NULL DEFAULT '',
					source_url TEXT,
					status TEXT NOT NULL CHECK (status IN ('pending', 'added', 'dismissed', 'expired')),
					source_call_id TEXT UNIQUE,
					posted_at INTEGER,
					decided_at INTEGER,
					created_at INTEGER NOT NULL
				) STRICT;
				INSERT INTO inbox_suggestion_new (id, kind, title, counterpart, context, at, ends_at, source_type, source_id, source_label,
				                                  source_url, status, source_call_id, posted_at, decided_at, created_at)
					SELECT id, kind, title, counterpart, context, at, ends_at, source_type, source_id, source_label,
					       source_url, status, source_call_id, posted_at, decided_at, created_at FROM inbox_suggestion;
				DROP TABLE inbox_suggestion;
				ALTER TABLE inbox_suggestion_new RENAME TO inbox_suggestion;
				CREATE INDEX inbox_suggestion_unposted ON inbox_suggestion (created_at) WHERE posted_at IS NULL;
			`);
		},
	},
];
