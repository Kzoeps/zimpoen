import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { EnvTarget } from "@earendil-works/pi-durable";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileWatcher,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Config } from "../config.ts";
import { DEFAULT_DENY_GLOBS, type Denial, type FileAccess, PathPolicy } from "./path-policy.ts";

/** Build the policy from a loaded config (whose paths `loadConfig` has already resolved through symlinks). */
export function createPathPolicy(config: Pick<Config, "readPaths" | "writePath" | "paths">): PathPolicy {
	return new PathPolicy({
		readRoots: config.readPaths,
		writeRoot: config.writePath,
		denyGlobs: [...DEFAULT_DENY_GLOBS, `${config.paths.secrets}/**`],
	});
}

/**
 * `HarnessOptions.env` for the server: every tool call and prompt section gets a fresh environment that can only touch
 * what the policy allows. Relative paths resolve against the agent's `cwd`, which defaults to the workspace.
 */
export function scopedEnvFor(config: Config): (target: EnvTarget) => ExecutionEnv {
	const policy = createPathPolicy(config);
	return (target) => createScopedEnv(policy, { cwd: target.cwd ?? config.writePath });
}

export function createScopedEnv(policy: PathPolicy, options: { cwd: string }): ExecutionEnv {
	return new ScopedExecutionEnv(policy, new NodeExecutionEnv({ cwd: options.cwd }));
}

/**
 * An {@link ExecutionEnv} that checks every path against a {@link PathPolicy} before delegating to a Node environment.
 *
 * Every path is resolved through symlinks first, and the policy sees the real location, so a link inside Documents that
 * points at `~/.ssh` is refused. The delegate then receives that real path, which keeps the checked path and the used
 * path identical. There is no shell: `exec` always fails, and no tool may run commands (PLAN rule 5).
 *
 * Known limits: a file swapped for a symlink between the check and the use is not caught (nothing the agents can call
 * creates links), and temporary files, file watching and `listFiles` are unavailable.
 */
class ScopedExecutionEnv implements ExecutionEnv {
	/** Scoped environments see one file namespace, so `edit` and `write` serialize per file across them. */
	readonly id = "assistant:scoped-local";
	cwd: string;
	readonly #policy: PathPolicy;
	readonly #inner: NodeExecutionEnv;

	constructor(policy: PathPolicy, inner: NodeExecutionEnv) {
		this.#policy = policy;
		this.#inner = inner;
		this.cwd = inner.cwd;
	}

	// Pure path arithmetic: no file is touched, so there is nothing to check.
	absolutePath(path: string, context: Context) {
		return this.#inner.absolutePath(path, context);
	}

	joinPath(parts: string[], context: Context) {
		return this.#inner.joinPath(parts, context);
	}

	// Reads

	readTextFile(path: string, context: Context) {
		return this.#read(path, context, (real) => this.#inner.readTextFile(real, context));
	}

	openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		return this.#read(path, context, (real) => this.#inner.openTextLineReader(real, context));
	}

	readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
		return this.#read(path, context, (real) => this.#inner.readTextLines(real, options, context));
	}

	readBinaryFile(path: string, context: Context) {
		return this.#read(path, context, (real) => this.#inner.readBinaryFile(real, context));
	}

	openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		return this.#read(path, context, (real) => this.#inner.openBinaryReader(real, options, context));
	}

	fileInfo(path: string, context: Context) {
		return this.#read(path, context, (real) => this.#inner.fileInfo(real, context));
	}

	canonicalPath(path: string, context: Context) {
		return this.#read(path, context, (real) => this.#inner.canonicalPath(real, context));
	}

	exists(path: string, context: Context) {
		return this.#read(path, context, (real) => this.#inner.exists(real, context));
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const listed = await this.#read(path, context, (real) => this.#inner.listDir(real, context));
		return listed.ok ? ok(listed.value.filter((entry) => !this.#policy.isDenied(entry.path))) : listed;
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const opened = await this.#read(path, context, (real) => this.#inner.openDirReader(real, context));
		return opened.ok ? ok(this.#hideProtected(opened.value)) : opened;
	}

	// Writes

	writeFile(path: string, content: string | Uint8Array, context: Context) {
		return this.#write(path, context, (real) => this.#inner.writeFile(real, content, context));
	}

	appendFile(path: string, content: string | Uint8Array, context: Context) {
		return this.#write(path, context, (real) => this.#inner.appendFile(real, content, context));
	}

	truncateFile(path: string, size: number, context: Context) {
		return this.#write(path, context, (real) => this.#inner.truncateFile(real, size, context));
	}

	flushFile(path: string, context: Context) {
		return this.#write(path, context, (real) => this.#inner.flushFile(real, context));
	}

	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
		return this.#write(path, context, (real) => this.#inner.createDir(real, options, context));
	}

	remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
		return this.#write(path, context, (real) => this.#inner.remove(real, options, context));
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context) {
		const source = await this.#guard(sourcePath, "write", context);
		if (!source.ok) return source;
		return this.#write(destinationPath, context, (destination) =>
			this.#inner.renameFile(source.value, destination, context),
		);
	}

	// Not available

	async createTempDir(_prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
		return err(unavailable("Temporary directories"));
	}

	async createTempFile(
		_options: { prefix?: string; suffix?: string } | undefined,
		_context: Context,
	): Promise<Result<string, FileError>> {
		return err(unavailable("Temporary files"));
	}

	async watch(
		_targets: readonly WatchTarget[],
		_onChange: (change: WatchChange) => void,
		_context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		return err(new FileError("not_supported", "File watching is not available to the assistant."));
	}

	async exec(
		_command: string | readonly string[],
		_options: ShellExecOptions | undefined,
		_context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		return err(new ExecutionError("shell_unavailable", "The assistant cannot run commands: no shell is available."));
	}

	async cleanup(context: Context): Promise<void> {
		await this.#inner.cleanup(context);
	}

	async #read<T>(
		path: string,
		context: Context,
		operation: (realPath: string) => Promise<Result<T, FileError>>,
	): Promise<Result<T, FileError>> {
		const guarded = await this.#guard(path, "read", context);
		return guarded.ok ? operation(guarded.value) : guarded;
	}

	async #write<T>(
		path: string,
		context: Context,
		operation: (realPath: string) => Promise<Result<T, FileError>>,
	): Promise<Result<T, FileError>> {
		const guarded = await this.#guard(path, "write", context);
		return guarded.ok ? operation(guarded.value) : guarded;
	}

	/** Resolve `path`, apply the policy, and return the real path to use, or why access is refused. */
	async #guard(path: string, access: FileAccess, context: Context): Promise<Result<string, FileError>> {
		const absolute = await this.#inner.absolutePath(path, context);
		if (!absolute.ok) return absolute;
		// Checked before resolving as well: a link named `.env` is protected whatever it points at.
		if (this.#policy.isDenied(absolute.value)) {
			return denied(this.#policy.protectedPath(absolute.value), absolute.value);
		}
		const real = await resolveReal(absolute.value);
		if (!real.ok) return real;
		const decision = this.#policy.check(real.value, access);
		return decision.allowed ? ok(real.value) : denied(decision, absolute.value);
	}

	#hideProtected(reader: DirReader): DirReader {
		return {
			next: async (maxEntries, context) => {
				const page = await reader.next(maxEntries, context);
				if (!page.ok) return page;
				const entries = page.value.entries.filter((entry) => !this.#policy.isDenied(entry.path));
				return ok({ entries, done: page.value.done });
			},
			close: (context) => reader.close(context),
		};
	}
}

function denied(decision: Denial, path: string): Result<never, FileError> {
	return err(new FileError("permission_denied", decision.message, path));
}

function unavailable(what: string): FileError {
	return new FileError(
		"permission_denied",
		`${what} are not available to the assistant. Write generated files into the workspace instead.`,
	);
}

/**
 * `realpath` that also works for paths that do not exist yet (a file about to be created): the deepest existing
 * ancestor is resolved through symlinks and the missing names are appended. A dangling symlink is refused, because
 * writing through it would create its target at a location nobody checked.
 */
export async function resolveReal(path: string): Promise<Result<string, FileError>> {
	const missing: string[] = [];
	for (let current = path; ; current = dirname(current)) {
		try {
			const real = await realpath(current);
			return ok(missing.length === 0 ? real : join(real, ...missing));
		} catch (error) {
			if (code(error) !== "ENOENT") return err(toFileError(error, path));
		}
		try {
			await lstat(current);
			return err(new FileError("invalid", "Refusing to follow a dangling symbolic link", path));
		} catch (error) {
			if (code(error) !== "ENOENT") return err(toFileError(error, path));
		}
		if (dirname(current) === current)
			return err(new FileError("not_found", `No such file or directory: ${path}`, path));
		missing.unshift(basename(current));
	}
}

function toFileError(error: unknown, path: string): FileError {
	const cause = error instanceof Error ? error : new Error(String(error));
	switch (code(error)) {
		case "ENOENT":
			return new FileError("not_found", cause.message, path, cause);
		case "EACCES":
		case "EPERM":
			return new FileError("permission_denied", cause.message, path, cause);
		case "ENOTDIR":
			return new FileError("not_directory", cause.message, path, cause);
		case "EISDIR":
			return new FileError("is_directory", cause.message, path, cause);
		case "ELOOP":
			return new FileError("invalid", cause.message, path, cause);
		default:
			return new FileError("unknown", cause.message, path, cause);
	}
}

function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}
