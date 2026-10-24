import { isAbsolute, relative, sep } from "node:path";

/**
 * True when `child` is `parent` or lies below it. Both must be absolute and normalized; this compares path text, so
 * resolve symlinks first (`realpath`) when the answer protects something.
 */
export function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
