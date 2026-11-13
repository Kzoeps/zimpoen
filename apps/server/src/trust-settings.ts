import { randomUUID } from "node:crypto";
import { type AppDb, getAgentRow, type Migration } from "@assistant/db";
import {
	createEntryPoster,
	DEFAULT_TRUST_LEVEL,
	isTrustLevel,
	type ProjectPolicy,
	type TrustLevel,
} from "@assistant/extensions";
import {
	NOTICE_ENTRY_KIND,
	type ProjectTrustView,
	type TrustSettingsResponse,
	type TrustSettingView,
} from "@assistant/shared";
import type { Harness } from "@earendil-works/pi-durable";

/**
 * The owner's trust levels (PLAN upgrade §3), as set in Settings: one for the PA (bot creation and deletion) and one per
 * broker project. Not a domain module: no agent has a tool that reaches this table, so only the owner's HTTP requests
 * write it. A stored level overrides the default (`ZIMPOEN_PA_TRUST`, or the project's level in the broker policy);
 * removing it goes back to the default. Read at every decision, so a change applies to the next tool call.
 */
export const trustMigrations: readonly Migration[] = [
	{
		id: "trust/001_settings",
		up: (db) => {
			db.exec(`
				-- subject: 'pa', or 'project:<id>' for a project of the broker policy.
				CREATE TABLE trust_setting (
					subject TEXT PRIMARY KEY,
					level TEXT NOT NULL CHECK (level IN ('open', 'normal', 'strict')),
					updated_at INTEGER NOT NULL
				) STRICT;
			`);
		},
	},
];

export class UnknownTrustProject extends Error {
	constructor(id: string, known: readonly string[]) {
		super(
			known.length === 0
				? `There is no project '${id.slice(0, 64)}': the credential broker is off or its policy names no project.`
				: `There is no project '${id.slice(0, 64)}' in the broker policy. Projects: ${known.join(", ")}.`,
		);
		this.name = "UnknownTrustProject";
	}
}

export type TrustSettings = {
	/** The PA's level now. */
	pa(): TrustLevel;
	/** A project's level now. */
	project(project: ProjectPolicy): TrustLevel;
	view(): TrustSettingsResponse;
	/** `null`: back to the default. */
	setPa(level: TrustLevel | null): TrustSettingsResponse;
	/** Throws {@link UnknownTrustProject} for a project the policy does not name. */
	setProject(id: string, level: TrustLevel | null): TrustSettingsResponse;
};

export function createTrustSettings(options: {
	db: AppDb;
	now: () => number;
	/** `ZIMPOEN_PA_TRUST`. Absent: normal. */
	paDefault?: TrustLevel;
	/** The broker policy's projects; absent when the broker is off. */
	projects?: ReadonlyMap<string, ProjectPolicy>;
}): TrustSettings {
	const { db } = options;
	const paDefault = options.paDefault ?? DEFAULT_TRUST_LEVEL;
	const projects = options.projects;

	function stored(subject: string): TrustLevel | undefined {
		const level = db.get<{ level: string }>("SELECT level FROM trust_setting WHERE subject = ?", subject)?.level;
		return isTrustLevel(level) ? level : undefined;
	}

	function store(subject: string, level: TrustLevel | null): void {
		if (level === null) db.run("DELETE FROM trust_setting WHERE subject = ?", subject);
		else
			db.run(
				`INSERT INTO trust_setting (subject, level, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT (subject) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
				subject,
				level,
				options.now(),
			);
	}

	const settingOf = (subject: string, defaultLevel: TrustLevel): TrustSettingView => {
		const level = stored(subject);
		return { level: level ?? defaultLevel, defaultLevel, overridden: level !== undefined };
	};

	function view(): TrustSettingsResponse {
		const list: ProjectTrustView[] = [...(projects?.values() ?? [])].map((project) => ({
			id: project.id,
			...settingOf(`project:${project.id}`, project.trust),
		}));
		return { pa: settingOf("pa", paDefault), broker: projects === undefined ? "off" : "on", projects: list };
	}

	return {
		pa: () => stored("pa") ?? paDefault,
		project: (project) => stored(`project:${project.id}`) ?? project.trust,
		view,
		setPa: (level) => {
			store("pa", level);
			return view();
		},
		setProject: (id, level) => {
			if (projects?.has(id) !== true) throw new UnknownTrustProject(id, [...(projects?.keys() ?? [])]);
			store(`project:${id}`, level);
			return view();
		},
	};
}

/** Write a display-only note into the PA's thread. Throws when the PA has no conversation yet. */
export async function postTrustNote(db: AppDb, harness: Harness, text: string): Promise<void> {
	const pa = getAgentRow(db, "pa");
	if (pa === undefined) throw new Error("the PA has no conversation yet");
	await createEntryPoster(() => harness)(pa.conversationId, {
		kind: NOTICE_ENTRY_KIND,
		data: { text, level: "info" },
		requestId: `trust:${randomUUID()}`,
	});
}
