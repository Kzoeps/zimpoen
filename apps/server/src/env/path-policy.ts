import { dirname } from "node:path";
import { isInside } from "../paths.ts";

/**
 * Always denied, wherever they are, in any letter case (PLAN rule 4 names the first three; the rest are the credential
 * files that routinely sit in `~/Downloads` or a home directory). `<data>/secrets/**` is added from the configuration.
 */
export const DEFAULT_DENY_GLOBS: readonly string[] = [
	"**/.ssh/**",
	"**/.env*",
	"**/auth.json",
	"**/*.pem",
	"**/*.key",
	"**/.netrc",
	"**/.npmrc",
	"**/.aws/**",
	"**/.git-credentials",
	"**/.gnupg/**",
	"**/id_*",
];

export type FileAccess = "read" | "write";

export type Denial = {
	allowed: false;
	/** `protected`: a deny glob matched. `outside`: not under any allowed root. */
	reason: "protected" | "outside";
	/** Written for the model: says what was refused and what is allowed instead. */
	message: string;
};

export type PolicyDecision = { allowed: true } | Denial;

export type PathPolicyOptions = {
	/** Canonical absolute directories that may be read. */
	readRoots: readonly string[];
	/** Canonical absolute directory that may be written. It may also be read. */
	writeRoot: string;
	denyGlobs: readonly string[];
};

/**
 * Which files an agent's environment may touch.
 *
 * - Read: inside a read root or the write root (an agent must be able to read back what it wrote, for `edit`).
 * - Write: inside the write root only.
 * - Deny globs win over both, ignoring letter case. A glob matches a path when it matches the path itself or any
 *   directory above it, so denying `**\/.ssh/**` also denies everything below a `.ssh` directory.
 *
 * The policy compares path text. Callers pass paths with symlinks already resolved (see `resolveReal`), and check deny
 * globs against the unresolved path too, so a link named `.env` is refused even if it points somewhere harmless.
 */
export class PathPolicy {
	readonly readRoots: readonly string[];
	readonly writeRoot: string;
	readonly denyGlobs: readonly string[];
	readonly #deny: readonly RegExp[];

	constructor(options: PathPolicyOptions) {
		this.readRoots = options.readRoots;
		this.writeRoot = options.writeRoot;
		this.denyGlobs = options.denyGlobs;
		this.#deny = options.denyGlobs.map(globToRegExp);
	}

	isDenied(absolutePath: string): boolean {
		for (let path = absolutePath; ; path = dirname(path)) {
			if (this.#deny.some((pattern) => pattern.test(path))) return true;
			if (dirname(path) === path) return false;
		}
	}

	check(absolutePath: string, access: FileAccess): PolicyDecision {
		if (this.isDenied(absolutePath)) return this.protectedPath(absolutePath);
		if (access === "write") {
			return isInside(this.writeRoot, absolutePath) ? { allowed: true } : this.outsideWorkspace(absolutePath);
		}
		const roots = [...this.readRoots, this.writeRoot];
		return roots.some((root) => isInside(root, absolutePath)) ? { allowed: true } : this.outsideReadable(absolutePath);
	}

	protectedPath(path: string): Denial {
		return {
			allowed: false,
			reason: "protected",
			message: `Access denied: ${path} is protected. SSH keys, .env files, auth.json, private keys, credential files and stored secrets are never available to the assistant.`,
		};
	}

	outsideReadable(path: string): Denial {
		return {
			allowed: false,
			reason: "outside",
			message: `Access denied: ${path} is outside the folders the assistant may read (${[...this.readRoots, this.writeRoot].join(", ")}).`,
		};
	}

	outsideWorkspace(path: string): Denial {
		return {
			allowed: false,
			reason: "outside",
			message: `Access denied: ${path} is outside the assistant's workspace (${this.writeRoot}). Files can only be written there.`,
		};
	}
}

/**
 * Translate the glob syntax used in the plan into an anchored RegExp over absolute paths.
 * Supported: `**` (any depth, also zero directories in `**\/x` and `x/**`), `*` (within one name), `?` (one character).
 */
export function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i] as string;
		if (char === "*" && glob[i + 1] === "*") {
			const followedBySlash = glob[i + 2] === "/";
			const atStart = i === 0 || glob[i - 1] === "/";
			if (followedBySlash && atStart) {
				source += "(?:.*/)?";
				i += 2;
			} else {
				source += ".*";
				i += 1;
			}
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
		}
	}
	// A trailing `/**` also matches the directory itself.
	if (source.endsWith("\\/.*")) source = `${source.slice(0, -"\\/.*".length)}(?:\\/.*)?`;
	// `s`: `.` must also match a newline, or a directory named "a\nb" would hide a protected file from `**`.
	// `i`: the same file is `.SSH` or `.ENV` on a case-insensitive mount (vfat, ntfs, casefolded ext4).
	return new RegExp(`^${source}$`, "si");
}
