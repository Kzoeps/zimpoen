import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AppDb, openAppDb } from "../src/index.ts";

const dirs: string[] = [];
const dbs: AppDb[] = [];

function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "assistant-db-"));
	dirs.push(dir);
	return join(dir, "nested", "app.sqlite");
}

function open(path = ":memory:"): AppDb {
	const db = openAppDb(path);
	dbs.push(db);
	return db;
}

afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("openAppDb", () => {
	it("creates missing parent directories and uses WAL with foreign keys enforced", () => {
		const db = open(tempFile());
		expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
		expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
	});

	it("returns plain row objects, and undefined when no row matches", () => {
		const db = open();
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
		db.run("INSERT INTO t (name) VALUES (?)", "a");
		expect(db.get("SELECT id, name FROM t WHERE id = ?", 1)).toStrictEqual({
			id: 1,
			name: "a",
		});
		expect(db.get("SELECT id FROM t WHERE id = ?", 99)).toBeUndefined();
		expect(db.all("SELECT name FROM t")).toStrictEqual([{ name: "a" }]);
	});
});

describe("AppDb.transaction", () => {
	function withTable(): AppDb {
		const db = open();
		db.exec("CREATE TABLE t (n INTEGER)");
		return db;
	}
	const count = (db: AppDb) => db.get<{ c: number }>("SELECT count(*) AS c FROM t")?.c;

	it("commits when the callback returns and rolls back when it throws", () => {
		const db = withTable();
		db.transaction(() => db.run("INSERT INTO t VALUES (1)"));
		expect(() =>
			db.transaction(() => {
				db.run("INSERT INTO t VALUES (2)");
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(count(db)).toBe(1);
	});

	it("rolls back only the inner transaction when a nested one throws and the caller handles it", () => {
		const db = withTable();
		db.transaction(() => {
			db.run("INSERT INTO t VALUES (1)");
			expect(() =>
				db.transaction(() => {
					db.run("INSERT INTO t VALUES (2)");
					throw new Error("inner");
				}),
			).toThrow("inner");
		});
		expect(count(db)).toBe(1);
	});

	it("reports the original error when SQLite had already rolled the transaction back", () => {
		const db = withTable();
		let thrown: unknown;
		try {
			db.transaction(() => {
				db.exec("ROLLBACK"); // what SQLITE_FULL or an interrupt does on its own
				throw new Error("disk full");
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors[0]).toMatchObject({ message: "disk full" });
	});

	it("rejects an async callback instead of committing before its work finishes", () => {
		const db = withTable();
		expect(() =>
			db.transaction((): unknown => {
				db.run("INSERT INTO t VALUES (1)");
				return Promise.resolve();
			}),
		).toThrow(/must be synchronous/);
		expect(count(db)).toBe(0);
	});
});
