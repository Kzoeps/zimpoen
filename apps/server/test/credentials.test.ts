import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../src/credentials.ts";

let dir: string;
let path: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "assistant-creds-"));
	path = join(dir, "secrets", "credentials.json");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const oauth = (expires: number): Credential => ({ type: "oauth", access: "a", refresh: "r", expires });
const key: Credential = { type: "api_key", key: "sk-test" };

describe("FileCredentialStore", () => {
	it("reads nothing before anything is stored, and creates no file by reading", async () => {
		const store = new FileCredentialStore(path);

		expect(await store.read("openai")).toBeUndefined();
		expect(await store.list()).toStrictEqual([]);
		await expect(stat(path)).rejects.toThrow();
	});

	it("stores a credential in a private file that a new store instance (a restart) can read", async () => {
		await new FileCredentialStore(path).modify("openai", async () => oauth(100));

		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(dir, "secrets"))).mode & 0o777).toBe(0o700);
		expect(await new FileCredentialStore(path).read("openai")).toStrictEqual(oauth(100));
		expect(JSON.parse(await readFile(path, "utf8"))).toStrictEqual({ openai: oauth(100) });
	});

	it("hands the current credential to modify() and keeps it when modify() returns undefined", async () => {
		const store = new FileCredentialStore(path);
		await store.modify("openai", async () => oauth(1));

		const seen: Array<Credential | undefined> = [];
		const unchanged = await store.modify("openai", async (current) => {
			seen.push(current);
			return undefined;
		});

		expect(seen).toStrictEqual([oauth(1)]);
		expect(unchanged).toStrictEqual(oauth(1));
		expect(await store.read("openai")).toStrictEqual(oauth(1));
	});

	it("serializes concurrent modify() calls so a read-modify-write never loses an update", async () => {
		const store = new FileCredentialStore(path);
		await store.modify("openai", async () => oauth(0));

		await Promise.all(
			Array.from({ length: 25 }, () =>
				store.modify("openai", async (current) => {
					await new Promise((resolve) => setTimeout(resolve, 1));
					return oauth((current as { expires: number }).expires + 1);
				}),
			),
		);

		expect(((await store.read("openai")) as { expires: number }).expires).toBe(25);
		expect((await readdir(join(dir, "secrets"))).filter((name) => name.endsWith(".tmp"))).toStrictEqual([]);
	});

	it("keeps two writers that share no memory (the server and a login command) from losing each other's updates", async () => {
		const server = new FileCredentialStore(path);
		const loginCommand = new FileCredentialStore(path);
		await server.modify("openai", async () => oauth(0));
		const bump = (store: FileCredentialStore) =>
			store.modify("openai", async (current) => {
				await new Promise((resolve) => setTimeout(resolve, 2));
				return oauth((current as { expires: number }).expires + 1);
			});

		await Promise.all(Array.from({ length: 10 }, (_, index) => bump(index % 2 === 0 ? server : loginCommand)));

		expect(((await server.read("openai")) as { expires: number }).expires).toBe(10);
		expect(await readdir(join(dir, "secrets"))).toStrictEqual(["credentials.json"]);
	});

	it("recovers from a lock its writer died holding", async () => {
		const store = new FileCredentialStore(path);
		await store.modify("openai", async () => oauth(1));
		// pid 2^22 + 1 is above Linux's default pid limit, so no such process exists.
		await writeFile(`${path}.lock`, JSON.stringify({ pid: 4_194_305, token: "crashed", acquiredAt: 1 }));

		await store.modify("openai", async () => oauth(2));

		expect(await store.read("openai")).toStrictEqual(oauth(2));
		expect(await readdir(join(dir, "secrets"))).toStrictEqual(["credentials.json"]);
	});

	it("removes temp files a crashed write left behind, and nothing else", async () => {
		const store = new FileCredentialStore(path);
		await store.modify("openai", async () => oauth(1));
		const secrets = join(dir, "secrets");
		await writeFile(join(secrets, "credentials.json.4242.deadbeef.tmp"), '{"openai":{"type":"api_key"}}');
		await writeFile(join(secrets, "notes.txt"), "keep me");

		expect(await store.cleanupTempFiles()).toBe(1);

		expect((await readdir(secrets)).sort()).toStrictEqual(["credentials.json", "notes.txt"]);
		expect(await store.read("openai")).toStrictEqual(oauth(1));
	});

	it("keeps other providers when one is written or deleted, and lists types without secrets", async () => {
		const store = new FileCredentialStore(path);
		await Promise.all([store.modify("openai", async () => oauth(1)), store.modify("google", async () => key)]);
		await store.delete("google");

		expect(await store.list()).toStrictEqual([{ providerId: "openai", type: "oauth" }]);
		expect(await store.read("google")).toBeUndefined();
		expect(await store.read("openai")).toStrictEqual(oauth(1));
	});

	it("leaves the file untouched when modify() fails", async () => {
		const store = new FileCredentialStore(path);
		await store.modify("openai", async () => oauth(1));

		await expect(
			store.modify("openai", async () => {
				throw new Error("refresh failed");
			}),
		).rejects.toThrow("refresh failed");

		expect(await store.read("openai")).toStrictEqual(oauth(1));
		// and the provider's queue keeps working
		await store.modify("openai", async () => oauth(2));
		expect(await store.read("openai")).toStrictEqual(oauth(2));
	});

	it("refuses to treat a corrupt file as empty, so the next write cannot destroy the tokens in it", async () => {
		const store = new FileCredentialStore(path);
		await store.modify("openai", async () => oauth(1));
		await writeFile(path, '{"openai": {"type": "oauth", ');

		await expect(store.read("openai")).rejects.toThrow(/is not valid JSON.*sign in again/s);
		await expect(store.modify("openai", async () => oauth(2))).rejects.toThrow(/is not valid JSON/);
		expect(await readFile(path, "utf8")).toBe('{"openai": {"type": "oauth", ');
	});

	it("rejects entries that are not credentials, naming the provider", async () => {
		const store = new FileCredentialStore(path);
		await store.modify("openai", async () => oauth(1));
		await writeFile(path, JSON.stringify({ openai: { token: "x" } }));

		await expect(store.read("openai")).rejects.toThrow(/invalid entry for provider 'openai'/);
	});

	it("tightens a file that was copied in with loose permissions, and reports it", async () => {
		const store = new FileCredentialStore(path);
		await store.modify("openai", async () => oauth(1));
		await chmod(path, 0o644);

		expect(await store.ensurePrivate()).toBe(true);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await store.ensurePrivate()).toBe(false);
		expect(await new FileCredentialStore(join(dir, "missing.json")).ensurePrivate()).toBe(false);
	});

	it("honours an already-aborted signal", async () => {
		const store = new FileCredentialStore(path);
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));

		await expect(store.read("openai", { signal: controller.signal })).rejects.toThrow("cancelled");
		await expect(store.modify("openai", async () => oauth(1), { signal: controller.signal })).rejects.toThrow(
			"cancelled",
		);
	});
});
