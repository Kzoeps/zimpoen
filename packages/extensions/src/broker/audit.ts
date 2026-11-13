import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** One line of the broker audit log. Never carries a secret value: only names, parameters and outcomes. */
export type AuditEvent = {
	at: number;
	event: "decision" | "run" | "refused";
	project: string;
	credId: string;
	action: string;
	params: Readonly<Record<string, string>>;
	decision?: "allow" | "ask" | "deny";
	callId?: string;
	approvalId?: string;
	exitCode?: number;
	timedOut?: boolean;
	redacted?: boolean;
	reason?: string;
};

export interface AuditLog {
	append(event: AuditEvent): Promise<void>;
}

/** Append-only JSONL, one event per line; the file is created 0600 and only ever appended to. */
export function createJsonlAudit(path: string): AuditLog {
	let ready: Promise<unknown> | undefined;
	return {
		async append(event) {
			ready ??= mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await ready;
			await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: "a" });
		},
	};
}

/** For tests: events kept in memory. */
export function createMemoryAudit(): AuditLog & { events: AuditEvent[] } {
	const events: AuditEvent[] = [];
	return {
		events,
		async append(event) {
			events.push(event);
		},
	};
}
