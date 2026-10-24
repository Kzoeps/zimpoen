import { afterEach, describe, expect, it } from "vitest";
import { type AppDb, type Migration, MigrationError, migrate, openAppDb } from "../src/index.ts";

const dbs: AppDb[] = [];
function open(): AppDb {
	const db = openAppDb(":memory:");
	dbs.push(db);
	return db;
}
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});

const tables = (db: AppDb) =>
	db
		.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.map((row) => row.name);
const recorded = (db: AppDb) =>
	db.all<{ id: string }>("SELECT id FROM _migrations ORDER BY applied_at, rowid").map((r) => r.id);

const createA: Migration = {
	id: "demo/001_a",
	up: (db) => db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY)"),
};
const createB: Migration = {
	id: "demo/002_b",
	up: (db) => db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY)"),
};
const createC: Migration = {
	id: "other/001_c",
	up: (db) => db.exec("CREATE TABLE c (id INTEGER PRIMARY KEY)"),
};

describe("migrate", () => {
	it("applies migrations in array order and records each with the clock's time", () => {
		const db = open();
		let clock = 1000;
		const report = migrate(db, [createC, createA, createB], { now: () => clock++ });

		expect(report).toStrictEqual({
			applied: ["other/001_c", "demo/001_a", "demo/002_b"],
			skipped: [],
		});
		expect(tables(db)).toStrictEqual(["_migrations", "a", "b", "c"]);
		expect(db.all("SELECT id, applied_at FROM _migrations ORDER BY applied_at")).toStrictEqual([
			{ id: "other/001_c", applied_at: 1000 },
			{ id: "demo/001_a", applied_at: 1001 },
			{ id: "demo/002_b", applied_at: 1002 },
		]);
	});

	it("is idempotent: a second run applies nothing and a new migration is applied alone", () => {
		const db = open();
		migrate(db, [createA]);
		let reruns = 0;
		const counting: Migration = { ...createA, up: () => void reruns++ };

		expect(migrate(db, [counting])).toStrictEqual({
			applied: [],
			skipped: ["demo/001_a"],
		});
		expect(reruns).toBe(0);
		expect(migrate(db, [createA, createB])).toStrictEqual({
			applied: ["demo/002_b"],
			skipped: ["demo/001_a"],
		});
		expect(recorded(db)).toStrictEqual(["demo/001_a", "demo/002_b"]);
	});

	it("rolls a failing migration back completely and keeps earlier ones", () => {
		const db = open();
		const broken: Migration = {
			id: "demo/002_broken",
			up: (tx) => {
				tx.exec("CREATE TABLE half_done (id INTEGER)");
				throw new Error("disk says no");
			},
		};

		const after: Migration = { id: "demo/003_after", up: (tx) => tx.exec("CREATE TABLE after (id INTEGER)") };

		const failure = (() => {
			try {
				migrate(db, [createA, broken, after]);
			} catch (error) {
				return error;
			}
		})();

		expect(failure).toBeInstanceOf(MigrationError);
		expect((failure as MigrationError).migrationId).toBe("demo/002_broken");
		expect((failure as MigrationError).message).toMatch(/demo\/002_broken.*rolled back.*disk says no/);
		expect(tables(db)).toStrictEqual(["_migrations", "a"]);
		expect(recorded(db)).toStrictEqual(["demo/001_a"]);

		// After the fix, only the failed migration and the ones after it run.
		const fixed: Migration = {
			id: "demo/002_broken",
			up: (tx) => tx.exec("CREATE TABLE fixed (id INTEGER)"),
		};
		expect(migrate(db, [createA, fixed, after]).applied).toStrictEqual(["demo/002_broken", "demo/003_after"]);
	});

	it("refuses to run when the database knows a migration this build does not", () => {
		const db = open();
		migrate(db, [createA, createB]);

		expect(() => migrate(db, [createA])).toThrow(/does not define: demo\/002_b.*newer version/s);
		expect(recorded(db)).toStrictEqual(["demo/001_a", "demo/002_b"]);
	});

	it("refuses an async migration instead of recording it and letting the rest run outside the transaction", async () => {
		const db = open();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const asyncUp = async (tx: AppDb): Promise<void> => {
			tx.exec("CREATE TABLE a (id INTEGER)");
			await Promise.resolve();
			throw new Error("boom after the first await");
		};
		// @ts-expect-error the type refuses an async `up`, and the runner refuses one that slips through
		const asyncMigration: Migration = { id: "demo/001_async", up: asyncUp };

		try {
			expect(() => migrate(db, [asyncMigration])).toThrow(MigrationError);
			expect(() => migrate(db, [asyncMigration])).toThrow(/returned a Promise.*must be synchronous/s);
			await new Promise((resolve) => setTimeout(resolve, 10));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		// What ran before its first await was rolled back; nothing is recorded; the lost rejection is not left unhandled.
		expect(tables(db)).toStrictEqual(["_migrations"]);
		expect(recorded(db)).toStrictEqual([]);
		expect(unhandled).toStrictEqual([]);
	});

	describe("ordering is a rule within one module, not across modules", () => {
		it("lets a new module appear anywhere in the list, before modules that already ran", () => {
			const db = open();
			migrate(db, [createA, createB]);

			// `other` is declared first now; `demo` is untouched, so nothing is out of order.
			expect(migrate(db, [createC, createA, createB])).toStrictEqual({
				applied: ["other/001_c"],
				skipped: ["demo/001_a", "demo/002_b"],
			});
		});

		it("lets modules interleave in the list as long as each module's own order holds", () => {
			const db = open();

			expect(migrate(db, [createA, createC, createB]).applied).toStrictEqual([
				"demo/001_a",
				"other/001_c",
				"demo/002_b",
			]);
		});

		it("refuses a module that declares its migrations out of sequence", () => {
			const db = open();

			expect(() => migrate(db, [createB, createA])).toThrow(
				/Module 'demo' declares 'demo\/001_a' after 'demo\/002_b'.*ascending/s,
			);
			expect(tables(db)).toStrictEqual([]);
		});

		it("refuses a migration inserted before one this database already applied, and applies nothing", () => {
			const db = open();
			migrate(db, [createA, { id: "demo/003_later", up: (tx) => tx.exec("CREATE TABLE later (id INTEGER)") }]);

			expect(() => migrate(db, [createA, createB, { id: "demo/003_later", up: () => {} }])).toThrow(
				/Module 'demo' declares 'demo\/002_b' before 'demo\/003_later'.*after the last one in 'demo'/s,
			);
			expect(recorded(db)).toStrictEqual(["demo/001_a", "demo/003_later"]);
			expect(tables(db)).not.toContain("b");
		});

		it("does not let one module's gap block another module's new migrations", () => {
			const db = open();
			migrate(db, [createA]);

			expect(migrate(db, [createA, createB, createC]).applied).toStrictEqual(["demo/002_b", "other/001_c"]);
		});
	});

	it("rejects ids that are not '<module>/<sequence>[_<name>]'", () => {
		const db = open();

		for (const id of ["001_a", "Demo/001_a", "demo/1_a", "demo/001-a", "demo/001_A"]) {
			expect(() => migrate(db, [{ id, up: () => {} }])).toThrow(/is not '<module>\/<sequence>\[_<name>\]'/);
		}
		expect(tables(db)).toStrictEqual([]);
	});

	it("rejects duplicate or empty ids before touching the database", () => {
		const db = open();

		expect(() => migrate(db, [createA, { ...createA }])).toThrow(/'demo\/001_a' is declared more than once/);
		expect(() => migrate(db, [{ id: " ", up: () => {} }])).toThrow(/empty id/);
		expect(tables(db)).toStrictEqual([]);
	});
});
