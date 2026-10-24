import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { createPathPolicy, createScopedEnv, resolveReal, scopedEnvFor } from "../../src/env/scoped-env.ts";

const ctx = BACKGROUND_CONTEXT;

type Layout = {
	root: string;
	docs: string;
	files: string;
	workspace: string;
	secrets: string;
	outside: string;
	env: ExecutionEnv;
};

let layout: Layout;
const roots: string[] = [];

beforeEach(async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "assistant-env-")));
	roots.push(root);
	const dirs = {
		docs: join(root, "docs"),
		files: join(root, "data", "files"),
		workspace: join(root, "data", "workspace"),
		secrets: join(root, "data", "secrets"),
		outside: join(root, "outside"),
	};
	for (const dir of [...Object.values(dirs), join(dirs.docs, "sub", ".ssh")]) await mkdir(dir, { recursive: true });
	await writeFile(join(dirs.docs, "note.txt"), "a note");
	await writeFile(join(dirs.docs, ".env"), "TOKEN=1");
	await writeFile(join(dirs.docs, "auth.json"), "{}");
	await writeFile(join(dirs.docs, "sub", ".ssh", "id_rsa"), "PRIVATE");
	await writeFile(join(dirs.files, "bill.csv"), "a,b");
	await writeFile(join(dirs.secrets, "credentials.json"), "{}");
	await writeFile(join(dirs.outside, "secret.txt"), "outside");
	await symlink(dirs.outside, join(dirs.docs, "link-out"));
	await symlink(join(dirs.docs, "sub", ".ssh"), join(dirs.docs, "link-ssh"));
	await symlink(join(dirs.docs, "note.txt"), join(dirs.docs, ".env.link"));
	await symlink(dirs.outside, join(dirs.workspace, "escape"));
	await symlink(join(dirs.outside, "not-created-yet.txt"), join(dirs.workspace, "dangling"));

	const policy = createPathPolicy({
		readPaths: [dirs.docs, dirs.files],
		writePath: dirs.workspace,
		paths: { secrets: dirs.secrets } as never,
	});
	layout = { root, ...dirs, env: createScopedEnv(policy, { cwd: dirs.workspace }) };
});

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The error code of a failed result, or `ok`. */
function outcome(result: { ok: true } | { ok: false; error: { code: string } }): string {
	return result.ok ? "ok" : result.error.code;
}

describe("reads", () => {
	it("allows read roots, the uploads folder and the workspace, resolving relative paths against the cwd", async () => {
		const { env, docs, files, workspace } = layout;
		await writeFile(join(workspace, "mine.md"), "mine");

		expect(await env.readTextFile(join(docs, "note.txt"), ctx)).toStrictEqual({ ok: true, value: "a note" });
		expect(await env.readTextFile(join(files, "bill.csv"), ctx)).toStrictEqual({ ok: true, value: "a,b" });
		expect(await env.readTextFile("mine.md", ctx)).toStrictEqual({ ok: true, value: "mine" });
		expect(await env.readTextFile(join("..", "..", "docs", "note.txt"), ctx)).toStrictEqual({
			ok: true,
			value: "a note",
		});
	});

	it("refuses anything outside the allowed folders and says which folders are allowed", async () => {
		const { env, outside, docs, root } = layout;

		const result = await env.readTextFile(join(outside, "secret.txt"), ctx);

		expect(outcome(result)).toBe("permission_denied");
		expect(result.ok ? "" : result.error.message).toContain(`outside the folders the assistant may read (${docs}`);
		expect(outcome(await env.readTextFile(join(root, "data", "app.sqlite"), ctx))).toBe("permission_denied");
		expect(outcome(await env.readBinaryFile("/etc/passwd", ctx))).toBe("permission_denied");
	});

	it("refuses .ssh, .env*, auth.json and the secrets directory even inside an allowed folder", async () => {
		const { env, docs, secrets } = layout;

		for (const protectedPath of [
			join(docs, ".env"),
			join(docs, "auth.json"),
			join(docs, "sub", ".ssh", "id_rsa"),
			join(secrets, "credentials.json"),
		]) {
			const result = await env.readTextFile(protectedPath, ctx);
			expect(outcome(result), protectedPath).toBe("permission_denied");
			expect(result.ok ? "" : result.error.message).toContain("never available to the assistant");
		}
	});

	it("follows symlinks before deciding, so a link cannot smuggle a protected or outside file in", async () => {
		const { env, docs } = layout;

		expect(outcome(await env.readTextFile(join(docs, "link-out", "secret.txt"), ctx))).toBe("permission_denied");
		expect(outcome(await env.readTextFile(join(docs, "link-ssh", "id_rsa"), ctx))).toBe("permission_denied");
		expect(outcome(await env.openBinaryReader(join(docs, "link-out", "secret.txt"), undefined, ctx))).toBe(
			"permission_denied",
		);
		// A link whose own name is protected is refused even though its target is harmless.
		expect(outcome(await env.readTextFile(join(docs, ".env.link"), ctx))).toBe("permission_denied");
	});

	it("does not reveal whether a refused path exists", async () => {
		const { env, outside } = layout;

		expect(outcome(await env.exists(join(outside, "secret.txt"), ctx))).toBe("permission_denied");
		expect(outcome(await env.exists(join(outside, "nothing-here.txt"), ctx))).toBe("permission_denied");
		expect(await env.exists(join(layout.docs, "note.txt"), ctx)).toStrictEqual({ ok: true, value: true });
		expect(await env.exists(join(layout.docs, "missing.txt"), ctx)).toStrictEqual({ ok: true, value: false });
	});

	it("hides protected entries from directory listings", async () => {
		const { env, docs } = layout;

		const listed = await env.listDir(docs, ctx);
		expect(listed.ok && listed.value.map((entry) => entry.name).sort()).toStrictEqual(
			["link-out", "link-ssh", "note.txt", "sub"].sort(),
		);

		const reader = await env.openDirReader(docs, ctx);
		expect(reader.ok).toBe(true);
		if (!reader.ok) return;
		const page = await reader.value.next(100, ctx);
		expect(page.ok && page.value.entries.map((entry) => entry.name).sort()).toStrictEqual(
			["link-out", "link-ssh", "note.txt", "sub"].sort(),
		);
		await reader.value.close(ctx);
		expect(outcome(await env.listDir(layout.outside, ctx))).toBe("permission_denied");
	});
});

describe("writes", () => {
	it("creates files and parent directories in the workspace only", async () => {
		const { env, workspace, docs, files } = layout;

		expect(outcome(await env.writeFile(join("reports", "2025", "invoice.md"), "# invoice", ctx))).toBe("ok");
		expect(await readFile(join(workspace, "reports", "2025", "invoice.md"), "utf8")).toBe("# invoice");
		expect(outcome(await env.appendFile(join(workspace, "reports", "2025", "invoice.md"), "\nmore", ctx))).toBe("ok");

		for (const target of [join(docs, "new.txt"), join(files, "new.csv"), join(layout.root, "data", "app.sqlite")]) {
			expect(outcome(await env.writeFile(target, "x", ctx)), target).toBe("permission_denied");
		}
		expect(outcome(await env.writeFile(join(workspace, "..", "files", "sneaky.txt"), "x", ctx))).toBe(
			"permission_denied",
		);
	});

	it("refuses to write through a link that leaves the workspace or dangles", async () => {
		const { env, workspace, outside } = layout;

		expect(outcome(await env.writeFile(join(workspace, "escape", "pwned.txt"), "x", ctx))).toBe("permission_denied");
		expect(outcome(await env.writeFile(join(workspace, "dangling"), "x", ctx))).toBe("invalid");
		await expect(readFile(join(outside, "pwned.txt"), "utf8")).rejects.toThrow();
		await expect(readFile(join(outside, "not-created-yet.txt"), "utf8")).rejects.toThrow();
	});

	it("protects secrets and env files inside the workspace too", async () => {
		const { env, workspace } = layout;

		expect(outcome(await env.writeFile(join(workspace, ".env"), "TOKEN=1", ctx))).toBe("permission_denied");
		expect(outcome(await env.writeFile(join(workspace, "auth.json"), "{}", ctx))).toBe("permission_denied");
	});

	it("checks both ends of a rename and only deletes inside the workspace", async () => {
		const { env, workspace, docs } = layout;
		await writeFile(join(workspace, "a.txt"), "a");

		expect(outcome(await env.renameFile("a.txt", "b.txt", ctx))).toBe("ok");
		expect(outcome(await env.renameFile("b.txt", join(docs, "b.txt"), ctx))).toBe("permission_denied");
		expect(outcome(await env.renameFile(join(docs, "note.txt"), join(workspace, "stolen.txt"), ctx))).toBe(
			"permission_denied",
		);
		expect(outcome(await env.remove(join(docs, "note.txt"), undefined, ctx))).toBe("permission_denied");
		expect(outcome(await env.remove("b.txt", undefined, ctx))).toBe("ok");
		expect(await readFile(join(docs, "note.txt"), "utf8")).toBe("a note");
	});
});

describe("capabilities that do not exist", () => {
	it("has no shell: exec always fails", async () => {
		const result = await layout.env.exec("echo hi", undefined, ctx);

		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.error.code).toBe("shell_unavailable");
		expect((await layout.env.exec(["ls"], undefined, ctx)).ok).toBe(false);
	});

	it("offers no temporary files, file watching or recursive listing", async () => {
		const { env, docs } = layout;

		expect(outcome(await env.createTempFile(undefined, ctx))).toBe("permission_denied");
		expect(outcome(await env.createTempDir("x-", ctx))).toBe("permission_denied");
		expect(outcome(await env.watch([{ path: docs }], () => {}, ctx))).toBe("not_supported");
		expect(env.listFiles).toBeUndefined();
	});

	it("shares one file-namespace id across environments so file mutations serialize", () => {
		expect(layout.env.id).toBe("assistant:scoped-local");
	});
});

describe("resolveReal", () => {
	it("resolves the deepest existing ancestor and appends the names that do not exist yet", async () => {
		const { workspace } = layout;

		const result = await resolveReal(join(workspace, "new", "deep", "file.txt"));

		expect(result).toStrictEqual({ ok: true, value: join(workspace, "new", "deep", "file.txt") });
	});
});

describe("a data directory behind a symlink (the data folder lives on another disk)", () => {
	it("still lets agents write their workspace and still protects the secrets, using the loaded config", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "assistant-env-link-")));
		roots.push(root);
		await mkdir(join(root, "disk2", "assistant"), { recursive: true });
		await mkdir(join(root, "docs"));
		await symlink(join(root, "disk2"), join(root, "data-link"));
		const viaLink = join(root, "data-link", "assistant");
		const config = await loadConfig({
			ASSISTANT_DATA_DIR: viaLink,
			ASSISTANT_READ_PATHS: join(root, "docs"),
			ASSISTANT_AUTH: "off",
		});
		await writeFile(join(config.paths.credentials), "{}");
		const env = scopedEnvFor(config)({} as never);

		// Relative to the cwd, which is the workspace, and spelled through the link: both reach the real workspace.
		expect((await env.writeFile("note.md", "hello", ctx)).ok).toBe(true);
		expect((await env.writeFile(join(viaLink, "workspace", "second.md"), "again", ctx)).ok).toBe(true);
		expect(await readFile(join(root, "disk2", "assistant", "workspace", "note.md"), "utf8")).toBe("hello");
		expect(await readFile(join(root, "disk2", "assistant", "workspace", "second.md"), "utf8")).toBe("again");

		// The secrets stay protected whichever way they are named.
		for (const path of [config.paths.credentials, join(viaLink, "secrets", "credentials.json")]) {
			expect(outcome(await env.readTextFile(path, ctx)), path).toBe("permission_denied");
		}
	});
});
