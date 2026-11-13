export const REDACTED = "[REDACTED]";

/** Shorter secrets would be scrubbed out of ordinary words; the stores refuse them. */
export const MIN_SECRET_LENGTH = 8;

/**
 * Token shapes redacted even when they are not the secret the action used: a program can print another credential it
 * found (a config file, an error that echoes a header).
 */
const KNOWN_TOKENS: readonly RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bsk-[A-Za-z0-9_-]{16,}/g,
];
/** The password of a Postgres connection URL: `postgres://user:<password>@host`. */
const POSTGRES_URL = /\b(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/g;

/** The forms a secret can take in output: as is, base64 (standard and URL-safe, with and without padding), URL-encoded. */
export function secretVariants(secret: string): string[] {
	const base64 = Buffer.from(secret, "utf8").toString("base64");
	const variants = [
		secret,
		base64,
		base64.replace(/=+$/, ""),
		Buffer.from(secret, "utf8").toString("base64url"),
		encodeURIComponent(secret),
		JSON.stringify(secret).slice(1, -1),
		Buffer.from(secret, "utf8").toString("hex"),
		Buffer.from(secret, "utf8").toString("hex").toUpperCase(),
	];
	// Longest first, so a variant that contains another is replaced whole. Stores refuse secrets under MIN_SECRET_LENGTH.
	return [...new Set(variants.filter((v) => v.length > 0))].sort((a, b) => b.length - a.length);
}

/** Replace every known form of `secrets` and every known token pattern. `redacted` says whether anything was. */
export function scrub(text: string, secrets: readonly string[]): { text: string; redacted: boolean } {
	let out = text;
	for (const secret of secrets) {
		for (const variant of secretVariants(secret)) out = out.split(variant).join(REDACTED);
	}
	for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, REDACTED);
	out = out.replace(POSTGRES_URL, `$1${REDACTED}@`);
	return { text: out, redacted: out !== text };
}

/** At most `maxBytes` of UTF-8, cut on a character boundary, with a marker when cut. */
export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return { text, truncated: false };
	// Decoding a cut buffer may end in a replacement character for a split code point; drop it.
	const cut = bytes
		.subarray(0, maxBytes)
		.toString("utf8")
		.replace(/\uFFFD$/, "");
	return { text: `${cut}\n[output truncated at ${maxBytes} bytes]`, truncated: true };
}
