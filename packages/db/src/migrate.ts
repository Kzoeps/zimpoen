import { type AppDb, isPromiseLike } from "./app-db.ts";

/**
 * One schema change, applied at most once per database and recorded in `_migrations`.
 *
 * `up` runs inside a transaction together with the bookkeeping insert, so a migration is all-or-nothing. It must be
 * synchronous and must not use statements SQLite forbids in a transaction (`VACUUM`, changing `PRAGMA foreign_keys`).
 *
 * Ids are `<module>/<sequence>[_<name>]`, for example `core/001_agents` or `tasks/002_call_ledger`. The module is the
 * domain that owns the tables (`core`, `tasks`, `approvals`, ...); the sequence is three or more digits. Ordering is a
 * rule **within one module only**: a module's migrations must be declared in ascending sequence, and what a database
 * has recorded for a module must be a prefix of what the module declares. Different modules are independent, so adding a
 * module anywhere in the list never disturbs another. Never edit or reorder a migration that has shipped: add a new one
 * with the next sequence number.
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
 * Bring `db` up to date with `migrations`, in array order (modules do not reorder each other; see {@link Migration}).
 *
 * Idempotent: ids already recorded are skipped, so calling it on every start is the normal way to use it. It refuses to
 * run when the database records a migration this build does not know, because that means older code is looking at a
 * newer schema, and when a module's recorded migrations are not a prefix of the ones it declares, because that means a
 * migration was inserted before one that had already shipped.
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
	assertRecordedPrefix(migrations, new Set(recorded));

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

const ID_FORMAT = /^([a-z][a-z0-9-]*)\/(\d{3,})(?:_[a-z0-9_]+)?$/;

/** The module and sequence number an id names. Only call with ids that passed {@link assertValid}. */
function parts(id: string): { module: string; sequence: number } {
	const match = ID_FORMAT.exec(id);
	return { module: match?.[1] ?? "", sequence: Number(match?.[2] ?? 0) };
}

function assertValid(migrations: readonly Migration[]): void {
	const seen = new Set<string>();
	const lastSequence = new Map<string, { sequence: number; id: string }>();
	for (const migration of migrations) {
		if (typeof migration.id !== "string" || migration.id.trim() === "") {
			throw new MigrationError(
				"A migration has an empty id. Give every migration a unique id such as 'core/001_agents'.",
			);
		}
		if (!ID_FORMAT.test(migration.id)) {
			throw new MigrationError(
				`Migration id '${migration.id}' is not '<module>/<sequence>[_<name>]'. Use a lowercase module name, a slash and ` +
					"a sequence of three or more digits, for example 'tasks/001_items'.",
				{ migrationId: migration.id },
			);
		}
		if (seen.has(migration.id)) {
			throw new MigrationError(
				`Migration id '${migration.id}' is declared more than once. Ids must be unique across all modules; ` +
					"prefix them with the module, for example 'tasks/001_items'.",
				{ migrationId: migration.id },
			);
		}
		seen.add(migration.id);

		const { module, sequence } = parts(migration.id);
		const previous = lastSequence.get(module);
		if (previous !== undefined && sequence <= previous.sequence) {
			throw new MigrationError(
				`Module '${module}' declares '${migration.id}' after '${previous.id}'. Within a module, migrations must be ` +
					"declared in ascending sequence, each with a number higher than the one before it.",
				{ migrationId: migration.id },
			);
		}
		lastSequence.set(module, { sequence, id: migration.id });
	}
}

/**
 * What a database recorded for a module must be the first `k` migrations the module declares. A recorded migration that
 * follows an unrecorded one means a migration was inserted before one that had already been applied here, which would
 * leave this database with a schema no fresh database can reach.
 */
function assertRecordedPrefix(migrations: readonly Migration[], recorded: ReadonlySet<string>): void {
	const gaps = new Map<string, string>();
	for (const migration of migrations) {
		const { module } = parts(migration.id);
		if (!recorded.has(migration.id)) {
			if (!gaps.has(module)) gaps.set(module, migration.id);
		} else if (gaps.has(module)) {
			throw new MigrationError(
				`Module '${module}' declares '${gaps.get(module)}' before '${migration.id}', but this database applied ` +
					`'${migration.id}' without it. Migrations that have shipped are never reordered or preceded by new ones: ` +
					`give '${gaps.get(module)}' a sequence number after the last one in '${module}'.`,
				{ migrationId: gaps.get(module) },
			);
		}
	}
}
