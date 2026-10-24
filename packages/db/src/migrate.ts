import { type AppDb, isPromiseLike } from "./app-db.ts";

/**
 * One schema change, applied at most once per database and recorded in `_migrations`.
 *
 * `up` runs inside a transaction together with the bookkeeping insert, so a migration is all-or-nothing. It must be
 * synchronous and must not use statements SQLite forbids in a transaction (`VACUUM`, changing `PRAGMA foreign_keys`).
 *
 * Ids are global across every domain. Prefix them with the domain so they stay unique and sort sensibly, for example
 * `core/001_agents` or `tasks/001_items`. Never edit or reorder a migration that has shipped: add a new one.
 */
export type Migration = {
	id: string;
	up: (db: AppDb) => SyncResult;
};

/**
 * What a synchronous function may return: nothing. A Promise is not assignable, so `async` migrations fail to compile.
 * `void` (not `undefined`) so that `up: (db) => db.exec(...)` and block bodies without a return still fit.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: see above; `undefined` would reject `(db) => db.exec(sql)`
type SyncResult = void | { readonly then?: never };

export type MigrationReport = {
	/** Ids applied by this call, in order. */
	applied: string[];
	/** Ids that were already recorded and therefore skipped. */
	skipped: string[];
};

export class MigrationError extends Error {
	readonly migrationId: string | undefined;

	constructor(message: string, options: { migrationId?: string; cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "MigrationError";
		this.migrationId = options.migrationId;
	}
}

export type MigrateOptions = {
	/** Clock for `applied_at`, epoch milliseconds. Default `Date.now`. */
	now?: () => number;
};

/**
 * Bring `db` up to date with `migrations`, in array order.
 *
 * Idempotent: ids already recorded are skipped, so calling it on every start is the normal way to use it. It refuses to
 * run when the database records a migration this build does not know, because that means older code is looking at a
 * newer schema.
 */
export function migrate(db: AppDb, migrations: readonly Migration[], options: MigrateOptions = {}): MigrationReport {
	const now = options.now ?? Date.now;
	assertValid(migrations);

	db.exec("CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT");

	const known = new Set(migrations.map((migration) => migration.id));
	const recorded = db.all<{ id: string }>("SELECT id FROM _migrations ORDER BY applied_at, id").map((row) => row.id);
	const unknown = recorded.filter((id) => !known.has(id));
	if (unknown.length > 0) {
		throw new MigrationError(
			`The database has migrations applied that this build does not define: ${unknown.join(", ")}. ` +
				"An older version of the app is probably running against a newer database. " +
				"Start the newer version, or restore the database from a backup made before the upgrade.",
			{ migrationId: unknown[0] },
		);
	}

	const report: MigrationReport = { applied: [], skipped: [] };
	for (const migration of migrations) {
		if (applyOne(db, migration, now)) report.applied.push(migration.id);
		else report.skipped.push(migration.id);
	}
	return report;
}

/** Returns false when the migration was already applied. */
function applyOne(db: AppDb, migration: Migration, now: () => number): boolean {
	try {
		return db.transaction(() => {
			// Checked inside the transaction (which holds the write lock) so two starting processes cannot both apply it.
			const done = db.get<{ one: number }>("SELECT 1 AS one FROM _migrations WHERE id = ?", migration.id);
			if (done !== undefined) return false;
			const returned: unknown = migration.up(db);
			if (isPromiseLike(returned)) {
				// Whatever the async body does after its first await would run outside this transaction and after COMMIT.
				Promise.resolve(returned).catch(() => {});
				throw new TypeError(
					"its `up` returned a Promise. Migrations must be synchronous (node:sqlite is synchronous): " +
						"remove `async`/`await`, and do any async preparation before calling migrate().",
				);
			}
			db.run("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", migration.id, now());
			return true;
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new MigrationError(
			`Migration '${migration.id}' failed and was rolled back: ${reason}. ` +
				"Fix the migration (or the data it trips over) and start again; nothing was recorded for it.",
			{ migrationId: migration.id, cause: error },
		);
	}
}

function assertValid(migrations: readonly Migration[]): void {
	const seen = new Set<string>();
	for (const migration of migrations) {
		if (typeof migration.id !== "string" || migration.id.trim() === "") {
			throw new MigrationError(
				"A migration has an empty id. Give every migration a unique id such as 'core/001_agents'.",
			);
		}
		if (seen.has(migration.id)) {
			throw new MigrationError(
				`Migration id '${migration.id}' is declared more than once. Ids must be unique across all domains; ` +
					"prefix them with the domain, for example 'tasks/001_items'.",
				{ migrationId: migration.id },
			);
		}
		seen.add(migration.id);
	}
}
