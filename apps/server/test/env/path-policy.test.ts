import { describe, expect, it } from "vitest";
import { DEFAULT_DENY_GLOBS, globToRegExp, PathPolicy } from "../../src/env/path-policy.ts";

const policy = new PathPolicy({
	readRoots: ["/home/dorje/Documents", "/srv/data/files"],
	writeRoot: "/srv/data/workspace",
	denyGlobs: [...DEFAULT_DENY_GLOBS, "/srv/data/secrets/**"],
});

describe("globToRegExp", () => {
	it.each([
		["**/.ssh/**", "/home/u/.ssh", true],
		["**/.ssh/**", "/home/u/.ssh/id_rsa", true],
		["**/.ssh/**", "/.ssh/config", true],
		["**/.ssh/**", "/home/u/.sshfoo/x", false],
		["**/.ssh/**", "/home/u/notes/ssh/x", false],
		["**/.env*", "/a/b/.env", true],
		["**/.env*", "/a/b/.env.local", true],
		["**/.env*", "/a/.envrc", true],
		["**/.env*", "/a/b/x.env", false],
		["**/.env*", "/a/.env/nested", false],
		["**/auth.json", "/a/auth.json", true],
		["**/auth.json", "/auth.json", true],
		["**/auth.json", "/a/oauth.json", false],
		["/srv/data/secrets/**", "/srv/data/secrets", true],
		["/srv/data/secrets/**", "/srv/data/secrets/credentials.json", true],
		["/srv/data/secrets/**", "/srv/data/secrets-backup/x", false],
		["/a/*.txt", "/a/b.txt", true],
		["/a/*.txt", "/a/b/c.txt", false],
		["/a/?.txt", "/a/bc.txt", false],
	])("%s against %s is %s", (glob, path, expected) => {
		expect(globToRegExp(glob).test(path)).toBe(expected);
	});
});

describe("PathPolicy", () => {
	it("denies a protected file and everything below a protected directory", () => {
		expect(policy.isDenied("/home/dorje/Documents/project/.env.production")).toBe(true);
		expect(policy.isDenied("/home/dorje/Documents/keys/.ssh/id_ed25519")).toBe(true);
		expect(policy.isDenied("/home/dorje/Documents/.env.d/anything")).toBe(true);
		expect(policy.isDenied("/srv/data/secrets/credentials.json")).toBe(true);
		expect(policy.isDenied("/home/dorje/Documents/report.pdf")).toBe(false);
	});

	it.each([
		"/home/dorje/Downloads/server.pem",
		"/home/dorje/Downloads/tls.key",
		"/home/dorje/Documents/.netrc",
		"/home/dorje/Documents/.npmrc",
		"/home/dorje/Documents/.aws/credentials",
		"/home/dorje/Documents/.git-credentials",
		"/home/dorje/Documents/.gnupg/private-keys-v1.d/abc.key",
		"/home/dorje/Documents/backup/id_ed25519",
	])("denies the credential file %s", (path) => {
		expect(policy.isDenied(path)).toBe(true);
		expect(policy.check(path, "read")).toMatchObject({ allowed: false, reason: "protected" });
	});

	it("ignores letter case, because the same file is .SSH on a case-insensitive mount", () => {
		for (const path of [
			"/home/dorje/Documents/.SSH/id_rsa",
			"/home/dorje/Documents/.ENV",
			"/home/dorje/Documents/Auth.JSON",
		]) {
			expect(policy.isDenied(path), path).toBe(true);
		}
		expect(policy.isDenied("/home/dorje/Documents/CERT.PEM")).toBe(true);
	});

	it("cannot be bypassed by a newline in a directory name above the protected file", () => {
		expect(policy.isDenied("/home/dorje/Documents/k\nk/.ssh/id_rsa")).toBe(true);
		expect(policy.isDenied("/home/dorje/Documents/k\nk/.env")).toBe(true);
		expect(policy.isDenied("/home/dorje/Documents/k\nk/report.pdf")).toBe(false);
	});

	it("lets agents read their read roots and workspace, but write only the workspace", () => {
		expect(policy.check("/home/dorje/Documents/a/b.txt", "read")).toStrictEqual({ allowed: true });
		expect(policy.check("/srv/data/files/bill.jpg", "read")).toStrictEqual({ allowed: true });
		expect(policy.check("/srv/data/workspace/notes.md", "read")).toStrictEqual({ allowed: true });
		expect(policy.check("/srv/data/workspace/notes.md", "write")).toStrictEqual({ allowed: true });
		expect(policy.check("/srv/data/workspace", "write")).toStrictEqual({ allowed: true });

		expect(policy.check("/home/dorje/Documents/a/b.txt", "write").allowed).toBe(false);
		expect(policy.check("/srv/data/files/bill.jpg", "write").allowed).toBe(false);
	});

	it("refuses paths outside every root, including lookalike siblings, with a message naming what is allowed", () => {
		const outside = policy.check("/home/dorje/Documents-private/x.txt", "read");
		const elsewhere = policy.check("/etc/passwd", "read");

		expect(outside.allowed).toBe(false);
		expect(elsewhere).toMatchObject({ allowed: false, reason: "outside" });
		expect((elsewhere as { message: string }).message).toContain("/home/dorje/Documents");
		expect(policy.check("/srv/data/workspace-old/x", "write").allowed).toBe(false);
	});

	it("lets a deny glob win over a root that contains the path", () => {
		const wide = new PathPolicy({
			readRoots: ["/srv/data"],
			writeRoot: "/srv/data/workspace",
			denyGlobs: ["/srv/data/secrets/**"],
		});

		expect(wide.check("/srv/data/secrets/credentials.json", "read")).toMatchObject({
			allowed: false,
			reason: "protected",
		});
		expect(wide.check("/srv/data/files/x", "read")).toStrictEqual({ allowed: true });
	});
});
