import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";

/** A value that can be bound to a `?` placeholder. */
export type SqlParam = SQLInputValue;

/** Result of an INSERT, UPDATE or DELETE. */
export type RunResult = { changes: number; lastInsertRowid: number | bigint };

export type OpenAppDbOptions = {
	/** Wait this long for another connection's lock before failing with SQLITE_BUSY. Default 5000 ms. */
	busyTimeoutMs?: number;
};

/**
 * Thin typed wrapper over `node:sqlite` for `app.sqlite`.
 *
 * Rows come back as plain objects. The `Row` type parameter of `get()` and `all()` is the caller's description of the
 * SELECT's columns: it is a cast, not a runtime check, so keep each query next to the type that describes it.
 */
export class AppDb {
	readonly path: string;
	readonly #db: DatabaseSync;
	readonly #statements = new Map<string, StatementSync>();
	#savepointDepth = 0;

	constructor(path: string, db: DatabaseSync) {
		this.path = path;
		this.#db = db;
	}

	get isOpen(): boolean {
		return this.#db.isOpen;
	}

	/** Run one or more statements without parameters or results (DDL, PRAGMA, multi-statement scripts). */
	exec(sql: string): void {
		this.#db.exec(sql);
	}

	run(sql: string, ...params: SqlParam[]): RunResult {
		const { changes, lastInsertRowid } = this.#statement(sql).run(...params);
		return { changes: Number(changes), lastInsertRowid };
	}

	/** The first row, or `undefined` when the query returns none. */
	get<Row extends object>(sql: string, ...params: SqlParam[]): Row | undefined {
		const row = this.#statement(sql).get(...params);
		return row === undefined ? undefined : (plain(row) as Row);
	}

	all<Row extends object>(sql: string, ...params: SqlParam[]): Row[] {
		return this.#statement(sql)
			.all(...params)
			.map((row) => plain(row) as Row);
	}

	/**
	 * Run `fn` in a transaction: commit when it returns, roll back when it throws. Calls made inside `fn` become
	 * savepoints, so helpers can use `transaction()` without knowing whether their caller already opened one.
	 *
	 * `fn` must be synchronous. A transaction cannot span an `await`: the connection is shared, so other code would run
	 * inside it.
	 */
	transaction<T>(fn: () => T): T {
		const nested = this.#db.isTransaction;
		// The counter moves only after BEGIN/SAVEPOINT succeeded: a BEGIN that times out must not leak a level.
		const savepoint = `sp_${this.#savepointDepth + 1}`;
		this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
		this.#savepointDepth++;
		try {
			const result = fn();
			if (isPromiseLike(result)) {
				throw new TypeError(
					"AppDb.transaction() callback returned a Promise. Transactions must be synchronous: do async work " +
						"before or after the transaction, never inside it.",
				);
			}
			this.#db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
			return result;
		} catch (error) {
			this.#rollback(nested, savepoint, error);
			throw error;
		} finally {
			this.#savepointDepth--;
		}
	}

	/** SQLite may already have rolled back (disk full, for example); that must not hide the error that caused it. */
	#rollback(nested: boolean, savepoint: string, cause: unknown): void {
		try {
			this.#db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
		} catch (rollbackError) {
			throw new AggregateError(
				[cause, rollbackError],
				"A transaction failed and could not be rolled back; the first error is the one that caused it.",
			);
		}
	}

	close(): void {
		if (!this.#db.isOpen) return;
		this.#statements.clear();
		this.#db.close();
	}

	#statement(sql: string): StatementSync {
		let statement = this.#statements.get(sql);
		if (statement === undefined) {
			statement = this.#db.prepare(sql);
			this.#statements.set(sql, statement);
		}
		return statement;
	}
}

/**
 * Open (creating if needed) the application database in WAL mode with foreign keys enforced.
 * Pass `":memory:"` for a throwaway database in tests.
 */
export function openAppDb(path: string, options: OpenAppDbOptions = {}): AppDb {
	const inMemory = path === ":memory:";
	if (!inMemory) mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path, {
		enableForeignKeyConstraints: true,
		timeout: options.busyTimeoutMs ?? 5000,
	});
	try {
		if (!inMemory) db.exec("PRAGMA journal_mode = WAL");
		// The default, written down: tasks and expenses are worth an fsync per commit.
		db.exec("PRAGMA synchronous = FULL");
	} catch (error) {
		db.close();
		throw error;
	}
	return new AppDb(path, db);
}

function plain(row: Record<string, SQLOutputValue>): Record<string, SQLOutputValue> {
	return { ...row };
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}
